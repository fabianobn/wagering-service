# Como rodar

O enunciado do desafio está na pasta `docs/README_INSTRUÇÃO.md`. Aqui é o serviço: como eu subi, o que eu testo e o que você vai ver se clonar.

Não use Node/npm/Jest. É **Bun** no runtime, no install e no `bun:test`. Eu fechei em `1.4.4` (`packageManager` no `package.json`). Docker Desktop tem que estar no ar — Postgres 16 e MiniStack (SQS). LocalStack eu não usei.

```bash
cp .env.example .env
docker compose up -d postgres ministack
bun install
bun run migration:up
bun src/main.ts
```

API em `http://localhost:3000`. Health: `GET /health/live` (processo) e `GET /health/ready` (Postgres + SQS). Se o ready vier 503, o MiniStack ainda não ficou healthy — espera uns segundos e tenta de novo.

Auth não está ligada. Guard no-op, ponto de extensão no código. O que eu faria depois está no `ARCHITECTURE.md`.

`bun start` e `bun src/main.ts` são a mesma coisa. `bun test` **só roda unitário**. Integração e concorrência são script separado de propósito: os dois batem no mesmo Postgres/SQS e eu travei `--max-concurrency 1` pra um arquivo não limpar a tabela no meio do outro.

## Testes

```bash
bun run typecheck
bun run test:unit            # Money, carteira, máquina de estados — sem I/O
bun run test:integration     # HTTP + SQS de verdade
bun run test:concurrency     # race, 3 processos, crash entre commit e ack
bun run test:load            # a API precisa estar no ar
```

O que cada suíte está provando, em uma linha:

- unitário: `"25"` vira `"25.00"`, BET sem saldo não mexe ledger, REFUND e ROLLBACK não passam os dois, LOSS não muda versão.
- integração: wallet abre com lançamento `OPENING`, replay devolve o saldo da primeira execução, payload diferente na mesma key dá 409, REFUND antes da BET volta **202 com o saldo atual da carteira** (não zero) e o worker fecha quando a BET chega.
- concorrência: 50 BET iguais debitam uma vez; duas de `80.00` em cima de `100.00` — uma `PROCESSED`, outra `REJECTED`, saldo `20.00`; três processos HTTP na mesma carteira; processo morre depois do commit e a reentrega não debita de novo.

Integração e concorrência **não mockam** Postgres nem SQS. Se o Compose não estiver up, eles quebram. É o esperado.

## Bater na API na mão

`Idempotency-Key` é obrigatório. Valor é string, sempre duas casas.

```bash
PLAYER=$(uuidgen | tr '[:upper:]' '[:lower:]')

WALLET=$(curl -s -X POST http://localhost:3000/wallets \
  -H 'content-type: application/json' \
  -d "{\"playerId\":\"$PLAYER\",\"initialBalance\":{\"amount\":\"100.00\",\"currency\":\"BRL\"}}")
echo "$WALLET"

ID=$(echo "$WALLET" | python3 -c "import sys,json; print(json.load(sys.stdin)['id'])")

curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER\",\"walletId\":\"$ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

# mesma key de novo — 200, saldo 75.00, idempotentReplay true
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H 'content-type: application/json' \
  -H 'Idempotency-Key: provider-a:transaction-123' \
  -d "{\"providerId\":\"provider-a\",\"externalTransactionId\":\"transaction-123\",\"playerId\":\"$PLAYER\",\"walletId\":\"$ID\",\"roundId\":\"round-987\",\"gameId\":\"fortune-chimp\",\"kind\":\"BET\",\"money\":{\"amount\":\"25.00\",\"currency\":\"BRL\"}}"

curl -s -X POST http://localhost:3000/wallets/$ID/reconciliation
```

Reconciliação tem que vir `consistent: true`. Ledger em `GET /wallets/:id/ledger`. Métrica em `GET /metrics` — é **por processo**, não soma cluster. `lockConflicts` fica 0 porque o lock espera na linha, não aborta.

## Três instâncias

```bash
docker compose up --build --scale app=3 -d
```

Nginx em `localhost:3000` espalha. O teste automatizado de três instâncias (`test/concurrency/multi-instance.test.ts`) sobe três processos Bun na máquina, não o Compose; só um liga consumer/workers. A prova ali é a serialização da carteira no Postgres.

Pra parar: `docker compose down`. Pra apagar volume do Postgres: `docker compose down -v`.

## Carga

Com a API no ar (Compose ou `bun src/main.ts`):

```bash
bun run test:load
```

200 BET de `1.00` na mesma carteira, 20 workers. No meu Mac deu ~141 rps, p99 ~293 ms, 0 erro, reconciliação fechando em `99800.00`. Número desta máquina e deste lock — carteira quente enfileira. Detalhe no `ARCHITECTURE.md`.

## Se travar

- MiniStack não healthy: o healthcheck bate em `http://127.0.0.1:4566/_ministack/health`. Sem isso o Compose não sobe o `app`.
- Porta 3000 ocupada: ou mata o processo local ou usa o proxy do Compose, os dois não juntos.
- `npm start` / `npx nest`: não é o caminho. É `bun`.
- `bun test` verde e você acha que cobriu integração: não cobriu. Roda `test:integration` e `test:concurrency`.

Decisão de modelagem, o que ficou de fora e por quê: `ARCHITECTURE.md`.
