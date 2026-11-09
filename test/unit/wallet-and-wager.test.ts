import { describe, expect, test } from "bun:test";
import { InsufficientBalanceError, InvalidTransactionStateError } from "../../src/domain/errors";
import { LedgerDirection } from "../../src/domain/ledger/wallet-ledger-entry";
import { Money } from "../../src/domain/money/money";
import { applyWager } from "../../src/domain/wager-transaction/apply-wager";
import { FailureCode } from "../../src/domain/wager-transaction/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wager-transaction/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";

const now = new Date("2026-07-29T15:00:00.000Z");

function wallet(balance = "100.00") {
  return Wallet.open({
    id: "wallet-1",
    playerId: "player-1",
    initialBalance: Money.from({ amount: balance, currency: "BRL" }),
    createdAt: now,
  });
}

function tx(
  kind: WagerTransactionKind,
  amount: string,
  extra: {
    id?: string;
    externalTransactionId?: string;
    idempotencyKey?: string;
    payloadHash?: string;
    referenceExternalTransactionId?: string;
    moneyCurrency?: string;
  } = {},
) {
  return WagerTransaction.create({
    id: extra.id ?? "tx-1",
    providerId: "provider-a",
    externalTransactionId: extra.externalTransactionId ?? "ext-1",
    idempotencyKey: extra.idempotencyKey ?? "provider-a:ext-1",
    payloadHash: extra.payloadHash ?? "hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: Money.from({ amount, currency: extra.moneyCurrency ?? "BRL" }),
    referenceExternalTransactionId: extra.referenceExternalTransactionId,
    createdAt: now,
  });
}

describe("Wallet", () => {
  test("opens at version 1 and increments version only when balance changes", () => {
    const w = wallet("100.00");
    expect(w.version).toBe(1);
    w.debit(Money.from({ amount: "10.00", currency: "BRL" }), now);
    expect(w.version).toBe(2);
    expect(w.balance.toString()).toBe("90.00");
  });

  test("rejects overdraft", () => {
    const w = wallet("10.00");
    expect(() => w.debit(Money.from({ amount: "10.01", currency: "BRL" }), now)).toThrow(InsufficientBalanceError);
  });

  test("rehydrate does not re-validate transitions", () => {
    const w = Wallet.rehydrate({
      id: "w",
      playerId: "p",
      currency: "BRL",
      balance: { amount: "5.00", currency: "BRL" },
      version: 4,
      createdAt: now,
      updatedAt: now,
    });
    expect(w.version).toBe(4);
    expect(w.balance.toString()).toBe("5.00");
  });
});

describe("wager rules", () => {
  test("BET debits and creates a ledger entry", () => {
    const w = wallet("100.00");
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    const result = applyWager({ wallet: w, tx: bet, now, ledgerId: "led-1" });
    expect(result.outcome).toBe("processed");
    expect(w.balance.toString()).toBe("75.00");
    expect(result.outcome === "processed" && result.ledger?.direction).toBe(LedgerDirection.Debit);
  });

  test("BET with insufficient funds is rejected without moving balance", () => {
    const w = wallet("10.00");
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    const result = applyWager({ wallet: w, tx: bet, now, ledgerId: "led-1" });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.INSUFFICIENT_BALANCE });
    expect(w.balance.toString()).toBe("10.00");
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
  });

  test("WIN without BET credits", () => {
    const w = wallet("100.00");
    const win = tx(WagerTransactionKind.Win, "40.00");
    const result = applyWager({ wallet: w, tx: win, now, ledgerId: "led-1" });
    expect(result.outcome).toBe("processed");
    expect(w.balance.toString()).toBe("140.00");
  });

  test("LOSS does not move balance or create ledger", () => {
    const w = wallet("100.00");
    const loss = tx(WagerTransactionKind.Loss, "25.00");
    const result = applyWager({ wallet: w, tx: loss, now, ledgerId: "led-1" });
    expect(result).toEqual({ outcome: "processed" });
    expect(w.balance.toString()).toBe("100.00");
    expect(w.version).toBe(1);
  });

  test("REFUND of BET credits once", () => {
    const w = wallet("100.00");
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    applyWager({ wallet: w, tx: bet, now, ledgerId: "led-1" });
    const refund = tx(WagerTransactionKind.Refund, "25.00", {
      id: "tx-2",
      externalTransactionId: "ext-2",
      idempotencyKey: "provider-a:ext-2",
      referenceExternalTransactionId: "ext-1",
    });
    const result = applyWager({ wallet: w, tx: refund, reference: bet, now, ledgerId: "led-2" });
    expect(result.outcome).toBe("processed");
    expect(w.balance.toString()).toBe("100.00");
  });

  test("REFUND and ROLLBACK are mutually exclusive", () => {
    const w = wallet("100.00");
    const bet = tx(WagerTransactionKind.Bet, "25.00");
    applyWager({ wallet: w, tx: bet, now, ledgerId: "led-1" });
    const refund = tx(WagerTransactionKind.Refund, "25.00", {
      id: "tx-2",
      externalTransactionId: "ext-2",
      idempotencyKey: "k2",
      referenceExternalTransactionId: "ext-1",
    });
    applyWager({ wallet: w, tx: refund, reference: bet, now, ledgerId: "led-2" });
    const rollback = tx(WagerTransactionKind.Rollback, "25.00", {
      id: "tx-3",
      externalTransactionId: "ext-3",
      idempotencyKey: "k3",
      referenceExternalTransactionId: "ext-1",
    });
    const result = applyWager({
      wallet: w,
      tx: rollback,
      reference: bet,
      existingReversal: refund,
      now,
      ledgerId: "led-3",
    });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.REFERENCE_ALREADY_REVERSED });
  });

  test("ROLLBACK of WIN debits and uses a distinct insufficient-funds code", () => {
    const w = wallet("10.00");
    const win = tx(WagerTransactionKind.Win, "40.00");
    applyWager({ wallet: w, tx: win, now, ledgerId: "led-1" });
    w.debit(Money.from({ amount: "50.00", currency: "BRL" }), now);
    const rollback = tx(WagerTransactionKind.Rollback, "40.00", {
      id: "tx-2",
      externalTransactionId: "ext-2",
      idempotencyKey: "k2",
      referenceExternalTransactionId: "ext-1",
    });
    const result = applyWager({ wallet: w, tx: rollback, reference: win, now, ledgerId: "led-2" });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.REVERSAL_INSUFFICIENT_BALANCE });
  });

  test("currency mismatch is rejected", () => {
    const w = wallet("100.00");
    const bet = tx(WagerTransactionKind.Bet, "10.00", { moneyCurrency: "USD" });
    const result = applyWager({ wallet: w, tx: bet, now, ledgerId: "led-1" });
    expect(result).toEqual({ outcome: "rejected", code: FailureCode.CURRENCY_MISMATCH });
  });

  test("idempotency payload hash mismatch is detected by matchesPayload", () => {
    const bet = tx(WagerTransactionKind.Bet, "10.00", { payloadHash: "aaa" });
    expect(bet.matchesPayload("aaa")).toBe(true);
    expect(bet.matchesPayload("bbb")).toBe(false);
  });

  test("terminal states cannot transition", () => {
    const w = wallet("100.00");
    const bet = tx(WagerTransactionKind.Bet, "10.00");
    applyWager({ wallet: w, tx: bet, now, ledgerId: "led-1" });
    expect(() => bet.reject(FailureCode.INVALID_KIND, w.balance, now)).toThrow(InvalidTransactionStateError);
  });

  test("reject records processedAt at rejection time", () => {
    const w = wallet("100.00");
    const refund = tx(WagerTransactionKind.Refund, "25.00", {
      referenceExternalTransactionId: "missing",
    });
    const rejectedAt = new Date("2026-07-29T15:05:00.000Z");
    refund.reject(FailureCode.REFERENCE_NOT_FOUND, w.balance, rejectedAt);
    expect(refund.processedAt).toEqual(rejectedAt);
    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
  });

  test("REFUND without reference stays pending", () => {
    const w = wallet("100.00");
    const refund = tx(WagerTransactionKind.Refund, "25.00", {
      referenceExternalTransactionId: "missing",
    });
    const result = applyWager({ wallet: w, tx: refund, now, ledgerId: "led-1" });
    expect(result).toEqual({ outcome: "pending_reference" });
  });
});
