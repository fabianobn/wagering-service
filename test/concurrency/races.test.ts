import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { resetDatabase, startApp } from "../helpers/app";
import { json, money } from "../helpers/http";

const PORT = 3104;
const BASE = `http://127.0.0.1:${PORT}`;
let app: INestApplication;

async function wallet(amount: string) {
  const res = await json(`${BASE}/wallets`, {
    method: "POST",
    body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: money(amount) }),
  });
  expect(res.status).toBe(201);
  return res.body as { id: string; playerId: string };
}

describe("concurrency", () => {
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

  test("50 identical bets in parallel debit once", async () => {
    const w = await wallet("100.00");
    const payload = {
      providerId: "provider-a",
      externalTransactionId: "same-bet",
      playerId: w.playerId,
      walletId: w.id,
      roundId: "r",
      gameId: "g",
      kind: "BET",
      money: money("40.00"),
    };
    const results = await Promise.all(
      Array.from({ length: 50 }, () =>
        json(`${BASE}/wagering/transactions`, {
          method: "POST",
          headers: { "Idempotency-Key": "provider-a:same-bet" },
          body: JSON.stringify(payload),
        }),
      ),
    );
    const processed = results.filter((r) => r.status === 200);
    expect(processed.length).toBe(50);
    expect(processed.every((r) => r.body.transactionId === processed[0]?.body.transactionId)).toBe(true);
    const recon = await json(`${BASE}/wallets/${w.id}/reconciliation`, { method: "POST" });
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.storedBalance.amount).toBe("60.00");
    expect(recon.body.checkedEntries).toBe(2);
  });

  test("two concurrent 80 bets on 100: one processed, one rejected, balance 20", async () => {
    const w = await wallet("100.00");
    const bet = (id: string) =>
      json(`${BASE}/wagering/transactions`, {
        method: "POST",
        headers: { "Idempotency-Key": `provider-a:${id}` },
        body: JSON.stringify({
          providerId: "provider-a",
          externalTransactionId: id,
          playerId: w.playerId,
          walletId: w.id,
          roundId: "r",
          gameId: "g",
          kind: "BET",
          money: money("80.00"),
        }),
      });
    const [a, b] = await Promise.all([bet("bet-a"), bet("bet-b")]);
    const statuses = [a.body.status, b.body.status].sort();
    expect(statuses).toEqual(["PROCESSED", "REJECTED"]);
    const recon = await json(`${BASE}/wallets/${w.id}/reconciliation`, { method: "POST" });
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.storedBalance.amount).toBe("20.00");
    expect(recon.body.checkedEntries).toBe(2);
  });

  test("distinct wallets process in parallel", async () => {
    const wallets = await Promise.all([wallet("50.00"), wallet("50.00"), wallet("50.00")]);
    const results = await Promise.all(
      wallets.map((w, i) =>
        json(`${BASE}/wagering/transactions`, {
          method: "POST",
          headers: { "Idempotency-Key": `k-${i}` },
          body: JSON.stringify({
            providerId: "provider-a",
            externalTransactionId: `tx-${i}`,
            playerId: w.playerId,
            walletId: w.id,
            roundId: "r",
            gameId: "g",
            kind: "BET",
            money: money("10.00"),
          }),
        }),
      ),
    );
    expect(results.every((r) => r.body.status === "PROCESSED")).toBe(true);
    for (const w of wallets) {
      const recon = await json(`${BASE}/wallets/${w.id}/reconciliation`, { method: "POST" });
      expect(recon.body.consistent).toBe(true);
      expect(recon.body.storedBalance.amount).toBe("40.00");
    }
  });
});
