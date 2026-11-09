import { Injectable } from "@nestjs/common";
import { EntityManager, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected";
import { WagerTransactionPendingReference } from "../domain/events/wager-transaction-pending-reference";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import type { EventContext } from "../domain/events/integration-event";
import { InboxMessage } from "../domain/inbox/inbox-message";
import type { MoneyProps } from "../domain/money/money";
import { Money } from "../domain/money/money";
import { OutboxMessage } from "../domain/outbox/outbox-message";
import { applyWager } from "../domain/wager-transaction/apply-wager";
import { FailureCode } from "../domain/wager-transaction/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../domain/wager-transaction/wager-transaction";
import { Persistence } from "../infrastructure/persistence/repositories";
import { businessPayload } from "../infrastructure/payload-hasher";
import { MetricsService } from "../infrastructure/observability/metrics.service";
import { AppLogger } from "../infrastructure/observability/logger";
import { IdempotencyConflictError, InvalidRequestError, WalletNotFoundError } from "./errors";
import { SystemClock } from "../infrastructure/clock";
import { UuidV7Generator } from "../infrastructure/id-generator";
import { Sha256PayloadHasher } from "../infrastructure/payload-hasher";

export interface InboxContext {
  messageId: string;
  consumerName: string;
}

export interface SubmitWagerCommand {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId: string;
  inbox?: InboxContext;
}

export interface SubmitWagerResult {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
}

const CONSUMER = "wager-transactions";

@Injectable()
export class SubmitWagerTransactionUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: SystemClock,
    private readonly ids: UuidV7Generator,
    private readonly hasher: Sha256PayloadHasher,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  async execute(command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const started = this.clock.now();
    try {
      const result = await this.em.fork().transactional(async (em) => this.process(new Persistence(em), command));
      this.logger.info("wager.processed", {
        correlationId: command.correlationId,
        transactionId: result.transactionId,
        walletId: command.walletId,
        providerId: command.providerId,
        status: result.status,
        kind: command.kind,
        failureCode: result.failureCode,
        messageId: command.inbox?.messageId,
        idempotentReplay: result.idempotentReplay,
      });
      this.metrics.recordProcessing(this.clock.now().getTime() - started.getTime());
      this.metrics.incrementStatus(result.status);
      if (result.idempotentReplay) {
        this.metrics.incrementDuplicates();
      }
      return result;
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        return this.handleUnique(command, error);
      }
      throw error;
    }
  }

  private payloadHashOf(command: SubmitWagerCommand, money: Money): string {
    return this.hasher.hash(
      businessPayload({
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: money.toJSON(),
        referenceExternalTransactionId: command.referenceExternalTransactionId,
      }),
    );
  }

  private async process(store: Persistence, command: SubmitWagerCommand): Promise<SubmitWagerResult> {
    const now = this.clock.now();
    const money = Money.from(command.money);
    const payloadHash = this.payloadHashOf(command, money);

    if (command.inbox) {
      const existingInbox = await store.findInbox(command.inbox.consumerName, command.inbox.messageId);
      if (existingInbox?.isProcessed()) {
        const original = await store.findByIdempotencyKey(command.idempotencyKey);
        if (original) {
          return this.toResult(store, original, true);
        }
      }
      if (!existingInbox) {
        await store.insertInbox(
          InboxMessage.receive({
            messageId: command.inbox.messageId,
            consumerName: command.inbox.consumerName,
            payloadHash,
            receivedAt: now,
          }),
        );
      }
    }

    const existing = await store.findByIdempotencyKey(command.idempotencyKey);
    if (existing) {
      if (!existing.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError(FailureCode.IDEMPOTENCY_PAYLOAD_CONFLICT);
      }
      return this.toResult(store, existing, true);
    }

    const wallet = await store.getWalletForUpdate(command.walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${command.walletId} not found`);
    }
    const existingAfterLock = await store.findByIdempotencyKey(command.idempotencyKey);
    if (existingAfterLock) {
      if (!existingAfterLock.matchesPayload(payloadHash)) {
        throw new IdempotencyConflictError(FailureCode.IDEMPOTENCY_PAYLOAD_CONFLICT);
      }
      return this.toResult(store, existingAfterLock, true, wallet.balance);
    }
    if (wallet.playerId !== command.playerId) {
      throw new InvalidRequestError("playerId does not match wallet");
    }

    if (command.kind === WagerTransactionKind.Opening) {
      throw new InvalidRequestError("OPENING cannot be submitted via API or queue");
    }

    const tx = WagerTransaction.create({
      id: this.ids.uuid(),
      providerId: command.providerId,
      externalTransactionId: command.externalTransactionId,
      idempotencyKey: command.idempotencyKey,
      payloadHash,
      walletId: command.walletId,
      playerId: command.playerId,
      roundId: command.roundId,
      gameId: command.gameId,
      kind: command.kind,
      money,
      referenceExternalTransactionId: command.referenceExternalTransactionId,
      createdAt: now,
    });

    let reference: WagerTransaction | undefined;
    if (command.referenceExternalTransactionId) {
      reference =
        (await store.findByProviderExternal(command.providerId, command.referenceExternalTransactionId)) ?? undefined;
    }
    const existingReversal = reference ? ((await store.findProcessedReversal(reference.id)) ?? undefined) : undefined;

    const applied = applyWager({
      wallet,
      tx,
      reference,
      existingReversal,
      now,
      ledgerId: this.ids.uuid(),
    });

    if (applied.outcome === "pending_reference") {
      tx.markPendingReference(now, nextReferenceAttempt(now, tx.referenceRetryAttempts));
    }

    await store.insertTransaction(tx);
    if (applied.outcome === "processed") {
      await store.saveWallet(wallet);
      if (applied.ledger) {
        store.insertLedger(applied.ledger);
      }
    }

    const ctx = (_suffix: string): EventContext => ({
      eventId: this.ids.uuid(),
      correlationId: command.correlationId,
      causationId: tx.id,
      occurredAt: now,
    });

    if (tx.status === WagerTransactionStatus.Processed) {
      store.insertOutbox(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx("processed"))));
      if (applied.outcome === "processed" && applied.ledger) {
        store.insertOutbox(OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, applied.ledger, ctx("balance"))));
      }
    } else if (tx.status === WagerTransactionStatus.Rejected) {
      store.insertOutbox(OutboxMessage.enqueue(WagerTransactionRejected.from(tx, ctx("rejected"))));
    } else if (tx.status === WagerTransactionStatus.PendingReference) {
      store.insertOutbox(OutboxMessage.enqueue(WagerTransactionPendingReference.from(tx, ctx("pending"))));
    }

    if (command.inbox) {
      const current = await store.findInbox(command.inbox.consumerName, command.inbox.messageId);
      if (current) {
        current.markProcessed(now);
        await store.saveInbox(current);
      }
    }

    return this.toResult(store, tx, false, wallet.balance);
  }

  private async handleUnique(command: SubmitWagerCommand, error: UniqueConstraintViolationException): Promise<SubmitWagerResult> {
    const store = new Persistence(this.em.fork());
    const existing = await store.findByIdempotencyKey(command.idempotencyKey);
    if (!existing) {
      throw error;
    }
    const payloadHash = this.payloadHashOf(command, Money.from(command.money));
    if (!existing.matchesPayload(payloadHash)) {
      throw new IdempotencyConflictError(FailureCode.IDEMPOTENCY_PAYLOAD_CONFLICT);
    }
    this.metrics.incrementDuplicates();
    return this.toResult(store, existing, true);
  }

  private async toResult(
    store: Persistence,
    tx: WagerTransaction,
    replay: boolean,
    currentBalance?: Money,
  ): Promise<SubmitWagerResult> {
    let balance = tx.observedBalance ?? currentBalance;
    if (!balance && tx.status === WagerTransactionStatus.PendingReference) {
      const wallet = await store.findWallet(tx.walletId);
      balance = wallet?.balance;
    }
    return {
      transactionId: tx.id,
      status: tx.status,
      balance: (balance ?? Money.zero(tx.money.currency)).toJSON(),
      idempotentReplay: replay,
      failureCode: tx.failureCode,
    };
  }
}

export function nextReferenceAttempt(now: Date, attemptsAfterIncrement: number): Date {
  const delay = Math.min(60_000, 1000 * 2 ** Math.min(Math.max(attemptsAfterIncrement - 1, 0), 10));
  return new Date(now.getTime() + delay);
}

export const WAGER_CONSUMER_NAME = CONSUMER;
