import { describe, expect, test } from "bun:test";
import { businessPayload, Sha256PayloadHasher } from "../../src/infrastructure/payload-hasher";

describe("payload hash", () => {
  test("is stable for canonical key order", () => {
    const hasher = new Sha256PayloadHasher();
    const a = hasher.hash(
      businessPayload({
        providerId: "provider-a",
        externalTransactionId: "t-1",
        playerId: "p",
        walletId: "w",
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
      }),
    );
    const b = hasher.hash(
      businessPayload({
        gameId: "g",
        kind: "BET",
        money: { amount: "25.00", currency: "BRL" },
        playerId: "p",
        providerId: "provider-a",
        roundId: "r",
        walletId: "w",
        externalTransactionId: "t-1",
      }),
    );
    expect(a).toBe(b);
    expect(a).toHaveLength(64);
  });
});
