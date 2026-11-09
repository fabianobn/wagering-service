import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { applyWager } from "../domain/wager-transaction/apply-wager";
import { FailureCode } from "../domain/wager-transaction/failure-code";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed";
import { WagerTransactionRejected } from "../domain/events/wager-transaction-rejected";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import { Money } from "../domain/money/money";
import { OutboxMessage } from "../domain/outbox/outbox-message";
import { WagerTransaction } from "../domain/wager-transaction/wager-transaction";
import { Persistence } from "../infrastructure/persistence/repositories";
import { SystemClock } from "../infrastructure/clock";
import { UuidV7Generator } from "../infrastructure/id-generator";
import { loadEnv } from "../infrastructure/config/env";
import { nextReferenceAttempt } from "./submit-wager-transaction.use-case";
import { AppLogger } from "../infrastructure/observability/logger";
import { MetricsService } from "../infrastructure/observability/metrics.service";

const BATCH = 20;

@Injectable()
export class ProcessPendingReferencesUseCase {
  private readonly maxAttempts: number;
  private readonly ttlMs: number;

  constructor(
    private readonly em: EntityManager,
    private readonly clock: SystemClock,
    private readonly ids: UuidV7Generator,
    private readonly logger: AppLogger,
    private readonly metrics: MetricsService,
  ) {
    const env = loadEnv();
    this.maxAttempts = env.pendingReferenceMaxAttempts;
    this.ttlMs = env.pendingReferenceTtlMs;
  }

  async execute(): Promise<number> {
    let processed = 0;
    for (let i = 0; i < BATCH; i++) {
      const did = await this.processOne();
      if (!did) {
        break;
      }
      processed += 1;
    }
    return processed;
  }

  private async processOne(): Promise<boolean> {
    const now = this.clock.now();
    const result = await this.em.fork().transactional(async (em) => {
      const store = new Persistence(em);
      const [tx] = await store.claimPendingReferences(now, 1);
      if (!tx) {
        return false;
      }

      const wallet = await store.getWalletForUpdate(tx.walletId);
      if (!wallet) {
        await this.reject(store, tx, FailureCode.WALLET_NOT_FOUND, Money.zero(tx.money.currency), now);
        this.metrics.incrementStatus(tx.status);
        return true;
      }

      const expired =
        now.getTime() - tx.createdAt.getTime() >= this.ttlMs || tx.referenceRetryAttempts >= this.maxAttempts;
      const reference = tx.referenceExternalTransactionId
        ? ((await store.findByProviderExternal(tx.providerId, tx.referenceExternalTransactionId)) ?? undefined)
        : undefined;
      const existingReversal = reference ? ((await store.findProcessedReversal(reference.id)) ?? undefined) : undefined;

      if (expired && !reference) {
        await this.reject(store, tx, FailureCode.REFERENCE_NOT_FOUND, wallet.balance, now);
        this.metrics.incrementStatus(tx.status);
        return true;
      }

      const applied = applyWager({
        wallet,
        tx,
        reference,
        existingReversal,
        now,
        ledgerId: this.ids.uuid(),
      });

      if (applied.outcome === "pending_reference") {
        if (expired) {
          await this.reject(store, tx, FailureCode.REFERENCE_NOT_FOUND, wallet.balance, now);
          this.metrics.incrementStatus(tx.status);
          return true;
        }
        tx.markPendingReference(now, nextReferenceAttempt(now, tx.referenceRetryAttempts + 1));
        await store.saveTransaction(tx);
        this.metrics.incrementRetries();
        return true;
      }

      if (applied.outcome === "processed") {
        await store.saveWallet(wallet);
        if (applied.ledger) {
          store.insertLedger(applied.ledger);
          store.insertOutbox(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, applied.ledger, {
                eventId: this.ids.uuid(),
                correlationId: tx.id,
                causationId: tx.id,
                occurredAt: now,
              }),
            ),
          );
        }
        await store.saveTransaction(tx);
        store.insertOutbox(
          OutboxMessage.enqueue(
            WagerTransactionProcessed.from(tx, {
              eventId: this.ids.uuid(),
              correlationId: tx.id,
              causationId: tx.id,
              occurredAt: now,
            }),
          ),
        );
      } else {
        await store.saveTransaction(tx);
        store.insertOutbox(
          OutboxMessage.enqueue(
            WagerTransactionRejected.from(tx, {
              eventId: this.ids.uuid(),
              correlationId: tx.id,
              causationId: tx.id,
              occurredAt: now,
            }),
          ),
        );
      }
      this.metrics.incrementStatus(tx.status);
      return { transactionId: tx.id, walletId: tx.walletId, status: tx.status, failureCode: tx.failureCode };
    });

    if (result && typeof result === "object") {
      this.logger.info("pending_reference.reprocessed", result);
    }
    return Boolean(result);
  }

  private async reject(
    store: Persistence,
    tx: WagerTransaction,
    code: FailureCode,
    observedBalance: Money,
    now: Date,
  ): Promise<void> {
    tx.reject(code, observedBalance, now);
    await store.saveTransaction(tx);
    store.insertOutbox(
      OutboxMessage.enqueue(
        WagerTransactionRejected.from(tx, {
          eventId: this.ids.uuid(),
          correlationId: tx.id,
          causationId: tx.id,
          occurredAt: now,
        }),
      ),
    );
  }
}
