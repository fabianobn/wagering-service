import { CurrencyMismatchError, InsufficientBalanceError } from "../errors";
import { LedgerDirection, WalletLedgerEntry } from "../ledger/wallet-ledger-entry";
import type { Wallet } from "../wallet/wallet";
import { FailureCode } from "./failure-code";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus } from "./wager-transaction";

export type ApplyWagerResult =
  | { outcome: "processed"; ledger?: WalletLedgerEntry }
  | { outcome: "rejected"; code: FailureCode }
  | { outcome: "pending_reference" };

const ROLLBACK_TARGETS = new Set<WagerTransactionKind>([
  WagerTransactionKind.Bet,
  WagerTransactionKind.Win,
  WagerTransactionKind.Refund,
]);

export function sameFinancialContext(tx: WagerTransaction, reference: WagerTransaction): boolean {
  return (
    tx.providerId === reference.providerId &&
    tx.playerId === reference.playerId &&
    tx.walletId === reference.walletId &&
    tx.roundId === reference.roundId &&
    tx.money.currency === reference.money.currency
  );
}

export function applyWager(params: {
  wallet: Wallet;
  tx: WagerTransaction;
  reference?: WagerTransaction;
  existingReversal?: WagerTransaction;
  now: Date;
  ledgerId: string;
}): ApplyWagerResult {
  const { wallet, tx, reference, existingReversal, now, ledgerId } = params;

  if (tx.money.currency !== wallet.currency) {
    tx.reject(FailureCode.CURRENCY_MISMATCH, wallet.balance, now);
    return { outcome: "rejected", code: FailureCode.CURRENCY_MISMATCH };
  }

  if (tx.kind === WagerTransactionKind.Opening) {
    tx.reject(FailureCode.OPENING_NOT_ALLOWED, wallet.balance, now);
    return { outcome: "rejected", code: FailureCode.OPENING_NOT_ALLOWED };
  }

  if (tx.kind !== WagerTransactionKind.Loss && !tx.money.isPositive()) {
    tx.reject(FailureCode.ZERO_AMOUNT, wallet.balance, now);
    return { outcome: "rejected", code: FailureCode.ZERO_AMOUNT };
  }

  switch (tx.kind) {
    case WagerTransactionKind.Bet:
      return debit(wallet, tx, now, ledgerId, FailureCode.INSUFFICIENT_BALANCE);
    case WagerTransactionKind.Win:
      return applyWin(wallet, tx, reference, now, ledgerId);
    case WagerTransactionKind.Loss:
      tx.markProcessed(reference?.id, now, wallet.balance);
      return { outcome: "processed" };
    case WagerTransactionKind.Refund:
      return applyRefund(wallet, tx, reference, existingReversal, now, ledgerId);
    case WagerTransactionKind.Rollback:
      return applyRollback(wallet, tx, reference, existingReversal, now, ledgerId);
  }
}

function applyWin(
  wallet: Wallet,
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  now: Date,
  ledgerId: string,
): ApplyWagerResult {
  if (tx.referenceExternalTransactionId) {
    if (!reference) {
      tx.reject(FailureCode.REFERENCE_NOT_FOUND, wallet.balance, now);
      return { outcome: "rejected", code: FailureCode.REFERENCE_NOT_FOUND };
    }
    if (
      reference.kind !== WagerTransactionKind.Bet ||
      reference.status !== WagerTransactionStatus.Processed ||
      !sameFinancialContext(tx, reference)
    ) {
      tx.reject(FailureCode.REFERENCE_NOT_ELIGIBLE, wallet.balance, now);
      return { outcome: "rejected", code: FailureCode.REFERENCE_NOT_ELIGIBLE };
    }
  }
  return credit(wallet, tx, now, ledgerId, reference?.id);
}

function applyRefund(
  wallet: Wallet,
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  existingReversal: WagerTransaction | undefined,
  now: Date,
  ledgerId: string,
): ApplyWagerResult {
  if (!reference) {
    return { outcome: "pending_reference" };
  }
  const eligibility = reversalEligibility(tx, reference, existingReversal, WagerTransactionKind.Bet);
  if (eligibility) {
    tx.reject(eligibility, wallet.balance, now);
    return { outcome: "rejected", code: eligibility };
  }
  return credit(wallet, tx, now, ledgerId, reference.id);
}

function applyRollback(
  wallet: Wallet,
  tx: WagerTransaction,
  reference: WagerTransaction | undefined,
  existingReversal: WagerTransaction | undefined,
  now: Date,
  ledgerId: string,
): ApplyWagerResult {
  if (!reference) {
    return { outcome: "pending_reference" };
  }
  if (!ROLLBACK_TARGETS.has(reference.kind)) {
    tx.reject(FailureCode.REFERENCE_NOT_ELIGIBLE, wallet.balance, now);
    return { outcome: "rejected", code: FailureCode.REFERENCE_NOT_ELIGIBLE };
  }
  const eligibility = reversalEligibility(tx, reference, existingReversal);
  if (eligibility) {
    tx.reject(eligibility, wallet.balance, now);
    return { outcome: "rejected", code: eligibility };
  }
  const direction = tx.ledgerDirectionFor(reference);
  if (direction === LedgerDirection.Debit) {
    return debit(wallet, tx, now, ledgerId, FailureCode.REVERSAL_INSUFFICIENT_BALANCE, reference.id);
  }
  return credit(wallet, tx, now, ledgerId, reference.id);
}

function reversalEligibility(
  tx: WagerTransaction,
  reference: WagerTransaction,
  existingReversal: WagerTransaction | undefined,
  requiredKind?: WagerTransactionKind,
): FailureCode | undefined {
  if (requiredKind && reference.kind !== requiredKind) {
    return FailureCode.REFERENCE_NOT_ELIGIBLE;
  }
  if (reference.status !== WagerTransactionStatus.Processed) {
    return FailureCode.REFERENCE_NOT_ELIGIBLE;
  }
  if (!sameFinancialContext(tx, reference)) {
    return FailureCode.REFERENCE_NOT_ELIGIBLE;
  }
  if (existingReversal) {
    return FailureCode.REFERENCE_ALREADY_REVERSED;
  }
  if (!tx.money.equals(reference.money)) {
    return FailureCode.AMOUNT_MISMATCH;
  }
  return undefined;
}

function debit(
  wallet: Wallet,
  tx: WagerTransaction,
  now: Date,
  ledgerId: string,
  insufficientCode: FailureCode,
  referenceId?: string,
): ApplyWagerResult {
  try {
    const movement = wallet.debit(tx.money, now);
    tx.markProcessed(referenceId, now, movement.balanceAfter);
    return {
      outcome: "processed",
      ledger: WalletLedgerEntry.create({
        id: ledgerId,
        walletId: wallet.id,
        transactionId: tx.id,
        direction: LedgerDirection.Debit,
        money: tx.money,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
        createdAt: now,
      }),
    };
  } catch (error) {
    if (error instanceof InsufficientBalanceError) {
      tx.reject(insufficientCode, wallet.balance, now);
      return { outcome: "rejected", code: insufficientCode };
    }
    if (error instanceof CurrencyMismatchError) {
      tx.reject(FailureCode.CURRENCY_MISMATCH, wallet.balance, now);
      return { outcome: "rejected", code: FailureCode.CURRENCY_MISMATCH };
    }
    throw error;
  }
}

function credit(
  wallet: Wallet,
  tx: WagerTransaction,
  now: Date,
  ledgerId: string,
  referenceId?: string,
): ApplyWagerResult {
  try {
    const movement = wallet.credit(tx.money, now);
    tx.markProcessed(referenceId, now, movement.balanceAfter);
    return {
      outcome: "processed",
      ledger: WalletLedgerEntry.create({
        id: ledgerId,
        walletId: wallet.id,
        transactionId: tx.id,
        direction: LedgerDirection.Credit,
        money: tx.money,
        balanceBefore: movement.balanceBefore,
        balanceAfter: movement.balanceAfter,
        createdAt: now,
      }),
    };
  } catch (error) {
    if (error instanceof CurrencyMismatchError) {
      tx.reject(FailureCode.CURRENCY_MISMATCH, wallet.balance, now);
      return { outcome: "rejected", code: FailureCode.CURRENCY_MISMATCH };
    }
    throw error;
  }
}
