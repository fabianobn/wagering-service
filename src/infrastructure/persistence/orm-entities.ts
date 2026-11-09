import { defineEntity, p, type InferEntity } from "@mikro-orm/core";

export const WalletOrm = defineEntity({
  name: "WalletOrm",
  tableName: "wallets",
  properties: {
    id: p.uuid().primary(),
    playerId: p.uuid().fieldName("player_id"),
    currency: p.string().length(3),
    balance: p.decimal("string").precision(19).scale(2),
    version: p.integer(),
    createdAt: p.datetime().fieldName("created_at"),
    updatedAt: p.datetime().fieldName("updated_at"),
  },
  uniques: [{ name: "wallets_player_currency_unique", properties: ["playerId", "currency"] }],
});

export type WalletOrmEntity = InferEntity<typeof WalletOrm>;

export const WagerTransactionOrm = defineEntity({
  name: "WagerTransactionOrm",
  tableName: "wager_transactions",
  properties: {
    id: p.uuid().primary(),
    providerId: p.text().fieldName("provider_id"),
    externalTransactionId: p.text().fieldName("external_transaction_id"),
    idempotencyKey: p.text().fieldName("idempotency_key").unique(),
    payloadHash: p.text().fieldName("payload_hash"),
    walletId: p.uuid().fieldName("wallet_id"),
    playerId: p.uuid().fieldName("player_id"),
    roundId: p.text().fieldName("round_id"),
    gameId: p.text().fieldName("game_id"),
    kind: p.string().length(32),
    amount: p.decimal("string").precision(19).scale(2),
    currency: p.string().length(3),
    referenceExternalTransactionId: p.text().fieldName("reference_external_transaction_id").nullable(),
    createdAt: p.datetime().fieldName("created_at"),
    status: p.string().length(32),
    referenceTransactionId: p.uuid().fieldName("reference_transaction_id").nullable(),
    failureCode: p.string().length(64).fieldName("failure_code").nullable(),
    processedAt: p.datetime().fieldName("processed_at").nullable(),
    observedBalanceAmount: p.decimal("string").precision(19).scale(2).fieldName("observed_balance_amount").nullable(),
    observedBalanceCurrency: p.string().length(3).fieldName("observed_balance_currency").nullable(),
    referenceRetryAttempts: p.integer().fieldName("reference_retry_attempts"),
    nextReferenceAttemptAt: p.datetime().fieldName("next_reference_attempt_at").nullable(),
  },
  uniques: [
    { name: "wager_transactions_provider_external_unique", properties: ["providerId", "externalTransactionId"] },
  ],
});

export type WagerTransactionOrmEntity = InferEntity<typeof WagerTransactionOrm>;

export const LedgerOrm = defineEntity({
  name: "LedgerOrm",
  tableName: "wallet_ledger_entries",
  properties: {
    id: p.uuid().primary(),
    walletId: p.uuid().fieldName("wallet_id"),
    transactionId: p.uuid().fieldName("transaction_id").unique(),
    direction: p.string().length(16),
    amount: p.decimal("string").precision(19).scale(2),
    currency: p.string().length(3),
    balanceBeforeAmount: p.decimal("string").precision(19).scale(2).fieldName("balance_before_amount"),
    balanceBeforeCurrency: p.string().length(3).fieldName("balance_before_currency"),
    balanceAfterAmount: p.decimal("string").precision(19).scale(2).fieldName("balance_after_amount"),
    balanceAfterCurrency: p.string().length(3).fieldName("balance_after_currency"),
    createdAt: p.datetime().fieldName("created_at"),
  },
});

export type LedgerOrmEntity = InferEntity<typeof LedgerOrm>;

export const InboxOrm = defineEntity({
  name: "InboxOrm",
  tableName: "inbox_messages",
  primaryKeys: ["consumerName", "messageId"],
  properties: {
    messageId: p.text().fieldName("message_id").primary(),
    consumerName: p.text().fieldName("consumer_name").primary(),
    payloadHash: p.text().fieldName("payload_hash"),
    receivedAt: p.datetime().fieldName("received_at"),
    processedAt: p.datetime().fieldName("processed_at").nullable(),
  },
});

export type InboxOrmEntity = InferEntity<typeof InboxOrm>;

export const OutboxOrm = defineEntity({
  name: "OutboxOrm",
  tableName: "outbox_messages",
  properties: {
    id: p.uuid().primary(),
    aggregateId: p.text().fieldName("aggregate_id"),
    eventType: p.text().fieldName("event_type"),
    payload: p.json<Record<string, unknown>>(),
    occurredAt: p.datetime().fieldName("occurred_at"),
    attempts: p.integer(),
    nextAttemptAt: p.datetime().fieldName("next_attempt_at").nullable(),
    publishedAt: p.datetime().fieldName("published_at").nullable(),
  },
});

export type OutboxOrmEntity = InferEntity<typeof OutboxOrm>;

export const ormEntities = [WalletOrm, WagerTransactionOrm, LedgerOrm, InboxOrm, OutboxOrm];
