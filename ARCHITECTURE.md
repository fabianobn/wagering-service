# Arquitetura

Processa aposta em cima de Postgres e SQS. Reentrega, mensagem fora de ordem e mais de um processo na mesma carteira eu tratei como caminho normal. Saldo e idempotência ficam no banco; a fila só entrega o envelope. Valor monetário eu recusei em `number` na borda — nem no ORM.

## Stack

Bun 1.x no runtime, no install e nos testes um binário só. HTTP no Nest com Express. Não troquei o adapter por `Bun.serve()`: o Nest já cobre o que a API precisa e o restante da stack (MikroORM, shutdown, módulos) encaixa nele.

MikroORM em vez de TypeORM porque Unit of Work e `LockMode` são explícitos, o que combina com transação financeira e lock por carteira.

SQS local no MiniStack: FIFO, DLQ, pé-leve, sem licença. A API aponta para o endpoint e não distingue emulador de AWS.

## Dinheiro

`Money` é imutável, `decimal.js`, sempre duas casas. Na entrada, `"25"` e `"25.0"` viram `"25.00"`. Recuso notação científica, `NaN`, `Infinity`, string vazia, mais de duas casas e negativo.

No Postgres a coluna é `NUMERIC(19,2)` e o MikroORM lê como **string** (`DecimalType('string')`). `number` em valor monetário não entra nem na borda do ORM.

Operamos em `BRL` no dia a dia. O modelo continua multi-moeda e rejeita operação em moeda diferente da carteira.

## Concorrência

A unidade de disputa é a `walletId`. Cada alteração faz `SELECT FOR UPDATE` na linha da carteira. Carteiras distintas não se bloqueiam. Não há lock global.

No caso clássico: saldo `100.00`, duas apostas de `80.00` ao mesmo tempo — uma entra, a outra espera, lê o saldo novo e sai `REJECTED`. Optimistic lock também funcionaria, mas retry no meio de débito é fácil de errar. Prefiro esperar na linha a perder update.

Custo: carteira quente serializa. Não é falta de CPU, é a invariante. O teste de carga mostra isso.

## O que o banco garante

- uma carteira por `player_id + currency`
- `balance >= 0`
- `idempotency_key` única e `(provider_id, external_transaction_id)` único
- no máximo um `REFUND` ou `ROLLBACK` `PROCESSED` por transação referenciada (índice único parcial)
- ledger fecha: `balance_before ± amount = balance_after`
- ledger não atualiza nem apaga — trigger barra `UPDATE`/`DELETE`

As FKs são UUID, sem relation do MikroORM. Sem o grafo de associação o UoW não ordena o insert, então o flush é explícito: carteira, transação, lançamento.

## Autenticação

Não está no ar. O gancho existe: `NoOpAuthGuard` no guard global e `ProviderIdentityPort` no-op.

O desenho que eu colocaria depois: Keycloak no Compose, bearer OIDC na API, health aberto, fila como canal interno. O `providerId` do payload ainda passaria pelas regras de domínio, canal confiável não significa mensagem honesta.

## Regras que precisei fechar

**WIN sem BET.** Referência de ganho é opcional. Sem referência, credita na hora. Se a referência vier preenchida e não bater (não existe, não é BET, rodada/jogador/carteira diferentes), rejeito. WIN não espera em `PENDING_REFERENCE`.

**REFUND e ROLLBACK na mesma BET.** Se os dois passarem, a aposta é creditada duas vezes. Tratei como mutuamente excludentes: referência processada só reverte uma vez. O índice único no banco segura a corrida.

**Replay.** A mesma key com o mesmo payload devolve o saldo **da primeira execução**, não o saldo atual. A transação guarda snapshot em `observed_balance_*`. `PENDING_REFERENCE` ainda não tem snapshot: o `202` devolve o saldo corrente da carteira, nunca `0.00`.

**version.** Começa em `1` na abertura. Só anda quando o saldo muda. `LOSS` não mexe saldo, não gera ledger, não incrementa versão, ainda assim publica `WagerTransactionProcessed`.

**OPENING.** Só no `POST /wallets`, saldo inicial maior que zero, na mesma transação SQL. API e fila recusam `kind=OPENING`.

## Inbox, outbox e fora de ordem

HTTP e SQS passam pelo mesmo use case. Na fila, a inbox `(consumerName, messageId)` entra na mesma transação que carteira, ledger e outbox. Ack só depois do commit. Se o processo morrer entre o commit e o ack, a mensagem volta; inbox + idempotency key impedem o segundo débito.

O worker de outbox pega lote com `FOR UPDATE SKIP LOCKED`, empurra `next_attempt_at`, commita, publica em `integration-events.fifo` e marca publicado. Publicar duas vezes pode acontecer; o consumidor precisa ser idempotente. `MessageGroupId = walletId` no FIFO ajuda a ordenar. Quem garante invariante é o Postgres.

`PENDING_REFERENCE`: worker a cada 2s, uma transação SQL por item (`FOR UPDATE SKIP LOCKED` + lock da carteira), backoff 1s → 2s → 4s (teto 60s), no máximo 10 tentativas ou 15 minutos. Esgotou: `REJECTED` com `REFERENCE_NOT_FOUND`. Carteira sumida: `REJECTED` com `WALLET_NOT_FOUND`.

No SIGTERM o consumer espera o in-flight e devolve a visibilidade (`VisibilityTimeout = 0`) das mensagens que ainda não tiveram ack. Erro permanente de infra não grava `FAILED` no banco: a mensagem vai para a DLQ da SQS. `FAILED` existe no domínio e no CHECK do schema; o caminho operacional é a fila.

## HTTP

| O que aconteceu | Status |
|---|---|
| Processou ou é replay da mesma operação | 200 |
| Entrou, mas a referência ainda não chegou | 202 |
| Payload inválido | 400 |
| Carteira ou transação não existe | 404 |
| Carteira duplicada, ou a mesma idempotency key com payload diferente | 409 |
| Regra de negócio (`failureCode`) | 422 |
| Infraestrutura permanente | 503 |

Ledger pagina com cursor opaco (base64url de `{ createdAt, id }`). Offset quebra com inserção concorrente.

## `failureCode`

`INSUFFICIENT_BALANCE`, `REVERSAL_INSUFFICIENT_BALANCE`, `CURRENCY_MISMATCH`, `IDEMPOTENCY_PAYLOAD_CONFLICT`, `REFERENCE_NOT_FOUND`, `REFERENCE_NOT_ELIGIBLE`, `REFERENCE_ALREADY_REVERSED`, `AMOUNT_MISMATCH`, `OPENING_NOT_ALLOWED`, `WALLET_NOT_FOUND`, `INVALID_MONEY`, `INVALID_KIND`, `ZERO_AMOUNT`.

Estourar saldo ao desfazer um crédito (`ROLLBACK` de `WIN`/`REFUND`) não é a mesma coisa que apostar sem saldo. O código é `REVERSAL_INSUFFICIENT_BALANCE`.

## Observabilidade

Log JSON com `correlationId`, `transactionId`, `walletId`, `providerId`, `messageId`. Valor e payload financeiro ficam de fora.

`GET /metrics` é por processo: transações por status, duplicata, retry, DLQ, reconciliação divergente, atraso da outbox, latência. `lockConflicts` fica em 0 porque o lock pessimista espera na linha, não aborta. Três réplicas não somam contador. `GET /health/live` é o processo. `GET /health/ready` fala com Postgres e SQS. Health não autentica.

## Fora de escopo

Redis, Kafka, partidas dobradas e OpenTelemetry não entram neste serviço. A correção está no Postgres, no lock por carteira e no outbox. O resto seria outro sistema.

Hash do payload: SHA-256 de JSON canônico (chaves ordenadas), só campo de negócio. Header e metadado de transporte ficam de fora. IDs: UUIDv7.

## Carga

`bun run test:load` contra a API em `http://127.0.0.1:3000`, Postgres 16 e MiniStack na máquina, um processo Bun, macOS.

Uma carteira com `100000.00 BRL`, 200 `BET` de `1.00` em paralelo (20 workers), cada uma com idempotency key própria.

| | |
|---|---|
| Throughput | 141,24 rps |
| p50 / p95 / p99 | 116,41 / 271,91 / 292,64 ms |
| Erros | 0 |
| Processadas | 200 |
| Reconciliação | ok (`99800.00`, 201 lançamentos, o primeiro é o `OPENING`) |
| Atraso da outbox no fim | 139 ms |
| Conflito de lock | 0 (espera na linha, não aborta) |

Número desta máquina e deste lock. Carteira quente enfileira e é isso que impede o segundo débito.

O teste de três instâncias sobe três processos HTTP contra o mesmo Postgres. Só um deles liga consumer e workers (`SKIP_BACKGROUND`); a prova é a serialização da carteira, não três consumidores de fila.
