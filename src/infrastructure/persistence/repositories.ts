import { LockMode, type EntityManager } from "@mikro-orm/postgresql";
import { InboxMessage } from "../../domain/inbox/inbox-message";
import type { WalletLedgerEntry } from "../../domain/ledger/wallet-ledger-entry";
import { OutboxMessage } from "../../domain/outbox/outbox-message";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wager-transaction/wager-transaction";
import type { Wallet } from "../../domain/wallet/wallet";
import {
  applyTransaction,
  applyWallet,
  inboxToDomain,
  ledgerToDomain,
  outboxToDomain,
  transactionToDomain,
  walletToDomain,
} from "./mappers";
import {
  InboxOrm,
  LedgerOrm,
  OutboxOrm,
  WagerTransactionOrm,
  WalletOrm,
  type InboxOrmEntity,
  type OutboxOrmEntity,
  type WagerTransactionOrmEntity,
  type WalletOrmEntity,
} from "./orm-entities";

export class Persistence {
  constructor(private readonly em: EntityManager) {}

  async getWalletForUpdate(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletOrm, { id }, { lockMode: LockMode.PESSIMISTIC_WRITE });
    return row ? walletToDomain(row) : null;
  }

  async findWallet(id: string): Promise<Wallet | null> {
    const row = await this.em.findOne(WalletOrm, { id });
    return row ? walletToDomain(row) : null;
  }

  async insertWallet(wallet: Wallet): Promise<void> {
    this.em.create(WalletOrm, {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toString(),
      version: wallet.version,
      createdAt: wallet.createdAt,
      updatedAt: wallet.updatedAt,
    });
    await this.em.flush();
  }

  async saveWallet(wallet: Wallet): Promise<void> {
    const row = await this.em.findOneOrFail(WalletOrm, { id: wallet.id });
    applyWallet(row as WalletOrmEntity, wallet);
  }

  async findByIdempotencyKey(key: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionOrm, { idempotencyKey: key });
    return row ? transactionToDomain(row) : null;
  }

  async findByProviderExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionOrm, { providerId, externalTransactionId });
    return row ? transactionToDomain(row) : null;
  }

  async findTransaction(id: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionOrm, { id });
    return row ? transactionToDomain(row) : null;
  }

  async findProcessedReversal(referenceTransactionId: string): Promise<WagerTransaction | null> {
    const row = await this.em.findOne(WagerTransactionOrm, {
      referenceTransactionId,
      status: WagerTransactionStatus.Processed,
      kind: { $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback] },
    });
    return row ? transactionToDomain(row) : null;
  }

  async insertTransaction(tx: WagerTransaction): Promise<void> {
    const snap = tx.snapshot();
    this.em.create(WagerTransactionOrm, {
      id: snap.id,
      providerId: snap.providerId,
      externalTransactionId: snap.externalTransactionId,
      idempotencyKey: snap.idempotencyKey,
      payloadHash: snap.payloadHash,
      walletId: snap.walletId,
      playerId: snap.playerId,
      roundId: snap.roundId,
      gameId: snap.gameId,
      kind: snap.kind,
      amount: snap.money.amount,
      currency: snap.money.currency,
      referenceExternalTransactionId: snap.referenceExternalTransactionId ?? null,
      createdAt: snap.createdAt,
      status: snap.status,
      referenceTransactionId: snap.referenceTransactionId ?? null,
      failureCode: snap.failureCode ?? null,
      processedAt: snap.processedAt ?? null,
      observedBalanceAmount: snap.observedBalance?.amount ?? null,
      observedBalanceCurrency: snap.observedBalance?.currency ?? null,
      referenceRetryAttempts: snap.referenceRetryAttempts,
      nextReferenceAttemptAt: snap.nextReferenceAttemptAt ?? null,
    });
    await this.em.flush();
  }

  async saveTransaction(tx: WagerTransaction): Promise<void> {
    const row = await this.em.findOneOrFail(WagerTransactionOrm, { id: tx.id });
    applyTransaction(row as WagerTransactionOrmEntity, tx);
  }

  insertLedger(entry: WalletLedgerEntry): void {
    this.em.create(LedgerOrm, {
      id: entry.id,
      walletId: entry.walletId,
      transactionId: entry.transactionId,
      direction: entry.direction,
      amount: entry.money.toString(),
      currency: entry.money.currency,
      balanceBeforeAmount: entry.balanceBefore.toString(),
      balanceBeforeCurrency: entry.balanceBefore.currency,
      balanceAfterAmount: entry.balanceAfter.toString(),
      balanceAfterCurrency: entry.balanceAfter.currency,
      createdAt: entry.createdAt,
    });
  }

  async listLedger(walletId: string, limit: number, cursor?: { createdAt: Date; id: string }) {
    const where: Record<string, unknown> = { walletId };
    if (cursor) {
      where.$or = [
        { createdAt: { $lt: cursor.createdAt } },
        { createdAt: cursor.createdAt, id: { $lt: cursor.id } },
      ];
    }
    const rows = await this.em.find(LedgerOrm, where, {
      orderBy: { createdAt: "DESC", id: "DESC" },
      limit: limit + 1,
    });
    return rows.map(ledgerToDomain);
  }

  async allLedger(walletId: string) {
    const rows = await this.em.find(LedgerOrm, { walletId }, { orderBy: { createdAt: "ASC", id: "ASC" } });
    return rows.map(ledgerToDomain);
  }

  async insertInbox(message: InboxMessage): Promise<void> {
    this.em.create(InboxOrm, {
      messageId: message.messageId,
      consumerName: message.consumerName,
      payloadHash: message.payloadHash,
      receivedAt: message.receivedAt,
      processedAt: message.processedAt ?? null,
    });
  }

  async findInbox(consumerName: string, messageId: string): Promise<InboxMessage | null> {
    const row = await this.em.findOne(InboxOrm, { consumerName, messageId });
    return row ? inboxToDomain(row) : null;
  }

  async saveInbox(message: InboxMessage): Promise<void> {
    const row = await this.em.findOneOrFail(InboxOrm, {
      consumerName: message.consumerName,
      messageId: message.messageId,
    });
    (row as InboxOrmEntity).processedAt = message.processedAt ?? null;
  }

  insertOutbox(message: OutboxMessage): void {
    this.em.create(OutboxOrm, {
      id: message.id,
      aggregateId: message.aggregateId,
      eventType: message.eventType,
      payload: { ...message.payload },
      occurredAt: message.occurredAt,
      attempts: message.attempts,
      nextAttemptAt: message.nextAttemptAt ?? null,
      publishedAt: message.publishedAt ?? null,
    });
  }

  async claimOutbox(now: Date, limit: number): Promise<OutboxMessage[]> {
    const rows = await this.em.find(
      OutboxOrm,
      {
        publishedAt: null,
        $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
      },
      {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: { occurredAt: "ASC" },
        limit,
      },
    );
    return rows.map(outboxToDomain);
  }

  async saveOutbox(message: OutboxMessage): Promise<void> {
    const row = await this.em.findOneOrFail(OutboxOrm, { id: message.id });
    const entity = row as OutboxOrmEntity;
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt ?? null;
    entity.publishedAt = message.publishedAt ?? null;
  }

  async oldestUnpublishedOccurredAt(): Promise<Date | null> {
    const row = await this.em.findOne(OutboxOrm, { publishedAt: null }, { orderBy: { occurredAt: "ASC" } });
    return row?.occurredAt ?? null;
  }

  async claimPendingReferences(now: Date, limit: number): Promise<WagerTransaction[]> {
    const rows = await this.em.find(
      WagerTransactionOrm,
      {
        status: WagerTransactionStatus.PendingReference,
        $or: [{ nextReferenceAttemptAt: null }, { nextReferenceAttemptAt: { $lte: now } }],
      },
      {
        lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
        orderBy: { createdAt: "ASC" },
        limit,
      },
    );
    return rows.map(transactionToDomain);
  }
}
