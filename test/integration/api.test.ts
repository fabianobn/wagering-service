import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { resetDatabase, startApp } from "../helpers/app";
import { json, money } from "../helpers/http";

const PORT = 3101;
const BASE = `http://127.0.0.1:${PORT}`;

let app: INestApplication;

async function createWallet(amount = "1000.00") {
  const playerId = Bun.randomUUIDv7();
  const res = await json(`${BASE}/wallets`, {
    method: "POST",
    body: JSON.stringify({ playerId, initialBalance: money(amount) }),
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string; balance: { amount: string }; version: number };
}

describe("HTTP integration", () => {
  beforeAll(async () => {
    process.env.SKIP_BACKGROUND = "1";
    app = await startApp(PORT);
  });

  beforeEach(async () => {
    await resetDatabase(app);
  });

  afterAll(async () => {
    await app.close();
  });

  test("creates a wallet with OPENING ledger and version 1", async () => {
    const wallet = await createWallet("1000.00");
    expect(wallet.balance.amount).toBe("1000.00");
    expect(wallet.version).toBe(1);
    const recon = await json(`${BASE}/wallets/${wallet.id}/reconciliation`, { method: "POST" });
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.checkedEntries).toBe(1);
  });

  test("duplicate wallet is a conflict", async () => {
    const playerId = Bun.randomUUIDv7();
    const body = { playerId, initialBalance: money("10.00") };
    const first = await json(`${BASE}/wallets`, { method: "POST", body: JSON.stringify(body) });
    const second = await json(`${BASE}/wallets`, { method: "POST", body: JSON.stringify(body) });
    expect(first.status).toBe(201);
    expect(second.status).toBe(409);
  });

  test("BET processes and replay returns original balance", async () => {
    const wallet = await createWallet("1000.00");
    const payload = {
      providerId: "provider-a",
      externalTransactionId: "transaction-123",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "round-987",
      gameId: "fortune-chimp",
      kind: "BET",
      money: money("25.00"),
    };
    const first = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "provider-a:transaction-123" },
      body: JSON.stringify(payload),
    });
    expect(first.status).toBe(200);
    expect(first.body.status).toBe("PROCESSED");
    expect(first.body.balance.amount).toBe("975.00");
    expect(first.body.idempotentReplay).toBe(false);

    const laterBet = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "provider-a:transaction-999" },
      body: JSON.stringify({ ...payload, externalTransactionId: "transaction-999", money: money("50.00") }),
    });
    expect(laterBet.body.balance.amount).toBe("925.00");

    const replay = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "provider-a:transaction-123" },
      body: JSON.stringify(payload),
    });
    expect(replay.status).toBe(200);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.balance.amount).toBe("975.00");
  });

  test("same idempotency key with different payload is 409", async () => {
    const wallet = await createWallet("100.00");
    const payload = {
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: money("10.00"),
    };
    await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "k1" },
      body: JSON.stringify(payload),
    });
    const conflict = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "k1" },
      body: JSON.stringify({ ...payload, money: money("11.00") }),
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.failureCode).toBe("IDEMPOTENCY_PAYLOAD_CONFLICT");
  });

  test("insufficient BET is 422 and does not write ledger", async () => {
    const wallet = await createWallet("10.00");
    const res = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "k-insuf" },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "tx-insuf",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: money("80.00"),
      }),
    });
    expect(res.status).toBe(422);
    expect(res.body.failureCode).toBe("INSUFFICIENT_BALANCE");
    const recon = await json(`${BASE}/wallets/${wallet.id}/reconciliation`, { method: "POST" });
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.storedBalance.amount).toBe("10.00");
  });

  test("LOSS does not change balance", async () => {
    const wallet = await createWallet("100.00");
    const res = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "k-loss" },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "tx-loss",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "r",
        gameId: "g",
        kind: "LOSS",
        money: money("40.00"),
      }),
    });
    expect(res.status).toBe(200);
    const got = await json(`${BASE}/wallets/${wallet.id}`);
    expect(got.body.balance.amount).toBe("100.00");
    expect(got.body.version).toBe(1);
  });

  test("ledger is immutable in the schema", async () => {
    const wallet = await createWallet("10.00");
    const em = app.get(EntityManager).fork();
    try {
      await em.execute("UPDATE wallet_ledger_entries SET amount = 1 WHERE wallet_id = ?", [wallet.id]);
      throw new Error("expected immutability trigger");
    } catch (error) {
      expect(String(error)).toContain("ledger entries are immutable");
    }
  });

  test("health endpoints", async () => {
    const live = await json(`${BASE}/health/live`);
    expect(live.status).toBe(200);
    const ready = await json(`${BASE}/health/ready`);
    expect(ready.status).toBe(200);
    expect(ready.body.postgres).toBe(true);
    expect(ready.body.sqs).toBe(true);
  });

  test("REFUND before BET returns 202 then processes after the BET", async () => {
    const wallet = await createWallet("100.00");
    const refund = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "k-refund" },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "refund-1",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "g",
        kind: "REFUND",
        money: money("40.00"),
        referenceExternalTransactionId: "bet-1",
      }),
    });
    expect(refund.status).toBe(202);
    expect(refund.body.status).toBe("PENDING_REFERENCE");
    expect(refund.body.balance.amount).toBe("100.00");

    const replay = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "k-refund" },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "refund-1",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "g",
        kind: "REFUND",
        money: money("40.00"),
        referenceExternalTransactionId: "bet-1",
      }),
    });
    expect(replay.status).toBe(202);
    expect(replay.body.idempotentReplay).toBe(true);
    expect(replay.body.balance.amount).toBe("100.00");

    const bet = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "k-bet" },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "bet-1",
        playerId: wallet.playerId,
        walletId: wallet.id,
        roundId: "round-1",
        gameId: "g",
        kind: "BET",
        money: money("40.00"),
      }),
    });
    expect(bet.status).toBe(200);

    const { ProcessPendingReferencesUseCase } = await import(
      "../../src/application/process-pending-references.use-case"
    );
    await Bun.sleep(1200);
    await app.get(ProcessPendingReferencesUseCase).execute();
    const recon = await json(`${BASE}/wallets/${wallet.id}/reconciliation`, { method: "POST" });
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.storedBalance.amount).toBe("100.00");
  });
});
