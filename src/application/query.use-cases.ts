import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { Money, type MoneyProps } from "../domain/money/money";
import { LedgerDirection } from "../domain/ledger/wallet-ledger-entry";
import { Persistence } from "../infrastructure/persistence/repositories";
import { TransactionNotFoundError, WalletNotFoundError } from "./errors";
import { WagerTransactionStatus } from "../domain/wager-transaction/wager-transaction";
import { MetricsService } from "../infrastructure/observability/metrics.service";
import { AppLogger } from "../infrastructure/observability/logger";

@Injectable()
export class GetWalletUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(walletId: string) {
    const store = new Persistence(this.em.fork());
    const wallet = await store.findWallet(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    }
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }
}

@Injectable()
export class GetLedgerUseCase {
  constructor(private readonly em: EntityManager) {}

  async execute(walletId: string, limit: number, cursor?: string) {
    const store = new Persistence(this.em.fork());
    const wallet = await store.findWallet(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    }
    const decoded = cursor ? decodeCursor(cursor) : undefined;
    const items = await store.listLedger(walletId, limit, decoded);
    const hasMore = items.length > limit;
    const page = hasMore ? items.slice(0, limit) : items;
    const last = page[page.length - 1];
    return {
      items: page.map((entry) => ({
        id: entry.id,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor: hasMore && last ? encodeCursor(last.createdAt, last.id) : null,
    };
  }
}

@Injectable()
export class GetTransactionUseCase {
  constructor(private readonly em: EntityManager) {}

  async byId(transactionId: string) {
    const store = new Persistence(this.em.fork());
    const tx = await store.findTransaction(transactionId);
    if (!tx) {
      throw new TransactionNotFoundError(`Transaction ${transactionId} not found`);
    }
    return serializeTx(tx);
  }

  async byProvider(providerId: string, externalTransactionId: string) {
    const store = new Persistence(this.em.fork());
    const tx = await store.findByProviderExternal(providerId, externalTransactionId);
    if (!tx) {
      throw new TransactionNotFoundError(`Transaction ${externalTransactionId} not found`);
    }
    return serializeTx(tx);
  }
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  async execute(walletId: string) {
    const store = new Persistence(this.em.fork());
    const wallet = await store.findWallet(walletId);
    if (!wallet) {
      throw new WalletNotFoundError(`Wallet ${walletId} not found`);
    }
    const entries = await store.allLedger(walletId);
    let calculated = Money.zero(wallet.currency);
    for (const entry of entries) {
      calculated =
        entry.direction === LedgerDirection.Credit ? calculated.add(entry.money) : calculated.subtract(entry.money);
    }
    const difference = minusAbsolute(wallet.balance, calculated);
    const consistent = wallet.balance.equals(calculated);
    if (!consistent) {
      this.metrics.incrementReconciliationMismatch();
      this.logger.error("wallet.reconciliation.mismatch", {
        walletId,
        storedBalance: wallet.balance.toJSON(),
        calculatedBalance: calculated.toJSON(),
      });
    }
    return {
      walletId: wallet.id,
      storedBalance: wallet.balance.toJSON(),
      calculatedBalance: calculated.toJSON(),
      difference,
      consistent,
      checkedEntries: entries.length,
    };
  }
}

function serializeTx(tx: {
  id: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { toJSON(): MoneyProps };
  status: WagerTransactionStatus;
  failureCode?: string;
  processedAt?: Date;
  observedBalance?: { toJSON(): MoneyProps };
}) {
  return {
    transactionId: tx.id,
    providerId: tx.providerId,
    externalTransactionId: tx.externalTransactionId,
    walletId: tx.walletId,
    playerId: tx.playerId,
    roundId: tx.roundId,
    gameId: tx.gameId,
    kind: tx.kind,
    money: tx.money.toJSON(),
    status: tx.status,
    failureCode: tx.failureCode,
    processedAt: tx.processedAt?.toISOString(),
    balance: tx.observedBalance?.toJSON(),
  };
}

export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(JSON.stringify({ createdAt: createdAt.toISOString(), id }), "utf8").toString("base64url");
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } {
  const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { createdAt: string; id: string };
  return { createdAt: new Date(parsed.createdAt), id: parsed.id };
}

function minusAbsolute(stored: Money, calculated: Money): MoneyProps {
  if (stored.equals(calculated)) {
    return Money.zero(stored.currency).toJSON();
  }
  try {
    if (stored.isLessThan(calculated)) {
      return calculated.subtract(stored).toJSON();
    }
    return stored.subtract(calculated).toJSON();
  } catch {
    return { amount: "0.00", currency: stored.currency };
  }
}
