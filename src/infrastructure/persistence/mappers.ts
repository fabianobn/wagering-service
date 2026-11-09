import { InboxMessage } from "../../domain/inbox/inbox-message";
import { LedgerDirection, WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { Money } from "../../domain/money/money";
import { OutboxMessage } from "../../domain/outbox/outbox-message";
import { FailureCode } from "../../domain/wager-transaction/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import type {
  InboxOrmEntity,
  LedgerOrmEntity,
  OutboxOrmEntity,
  WagerTransactionOrmEntity,
  WalletOrmEntity,
} from "./orm-entities";

export function walletToDomain(row: WalletOrmEntity): Wallet {
  return Wallet.rehydrate({
    id: row.id,
    playerId: row.playerId,
    currency: row.currency,
    balance: { amount: row.balance, currency: row.currency },
    version: row.version,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  });
}

export function applyWallet(row: WalletOrmEntity, wallet: Wallet): void {
  row.balance = wallet.balance.toString();
  row.version = wallet.version;
  row.updatedAt = wallet.updatedAt;
}

export function transactionToDomain(row: WagerTransactionOrmEntity): WagerTransaction {
  return WagerTransaction.rehydrate({
    id: row.id,
    providerId: row.providerId,
    externalTransactionId: row.externalTransactionId,
    idempotencyKey: row.idempotencyKey,
    payloadHash: row.payloadHash,
    walletId: row.walletId,
    playerId: row.playerId,
    roundId: row.roundId,
    gameId: row.gameId,
    kind: row.kind as WagerTransactionKind,
    money: { amount: row.amount, currency: row.currency },
    referenceExternalTransactionId: row.referenceExternalTransactionId ?? undefined,
    createdAt: row.createdAt,
    status: row.status as WagerTransactionStatus,
    referenceTransactionId: row.referenceTransactionId ?? undefined,
    failureCode: (row.failureCode as FailureCode | undefined) ?? undefined,
    processedAt: row.processedAt ?? undefined,
    observedBalance:
      row.observedBalanceAmount && row.observedBalanceCurrency
        ? { amount: row.observedBalanceAmount, currency: row.observedBalanceCurrency }
        : undefined,
    referenceRetryAttempts: row.referenceRetryAttempts,
    nextReferenceAttemptAt: row.nextReferenceAttemptAt ?? undefined,
  });
}

export function applyTransaction(row: WagerTransactionOrmEntity, tx: WagerTransaction): void {
  const snap = tx.snapshot();
  row.status = snap.status;
  row.referenceTransactionId = snap.referenceTransactionId ?? null;
  row.failureCode = snap.failureCode ?? null;
  row.processedAt = snap.processedAt ?? null;
  row.observedBalanceAmount = snap.observedBalance?.amount ?? null;
  row.observedBalanceCurrency = snap.observedBalance?.currency ?? null;
  row.referenceRetryAttempts = snap.referenceRetryAttempts;
  row.nextReferenceAttemptAt = snap.nextReferenceAttemptAt ?? null;
}

export function ledgerToDomain(row: LedgerOrmEntity): WalletLedgerEntry {
  return WalletLedgerEntry.rehydrate({
    id: row.id,
    walletId: row.walletId,
    transactionId: row.transactionId,
    direction: row.direction as LedgerDirection,
    money: { amount: row.amount, currency: row.currency },
    balanceBefore: { amount: row.balanceBeforeAmount, currency: row.balanceBeforeCurrency },
    balanceAfter: { amount: row.balanceAfterAmount, currency: row.balanceAfterCurrency },
    createdAt: row.createdAt,
  });
}

export function inboxToDomain(row: InboxOrmEntity): InboxMessage {
  return InboxMessage.rehydrate({
    messageId: row.messageId,
    consumerName: row.consumerName,
    payloadHash: row.payloadHash,
    receivedAt: row.receivedAt,
    processedAt: row.processedAt ?? undefined,
  });
}

export function outboxToDomain(row: OutboxOrmEntity): OutboxMessage {
  return OutboxMessage.rehydrate({
    id: row.id,
    aggregateId: row.aggregateId,
    eventType: row.eventType,
    payload: row.payload,
    occurredAt: row.occurredAt,
    attempts: row.attempts,
    nextAttemptAt: row.nextAttemptAt ?? undefined,
    publishedAt: row.publishedAt ?? undefined,
  });
}

export function moneyFrom(amount: string, currency: string): Money {
  return Money.rehydrate({ amount, currency });
}
