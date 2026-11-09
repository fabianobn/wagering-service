import { Injectable } from "@nestjs/common";
import { EntityManager, UniqueConstraintViolationException } from "@mikro-orm/postgresql";
import { WagerTransactionProcessed } from "../domain/events/wager-transaction-processed";
import { WalletBalanceChanged } from "../domain/events/wallet-balance-changed";
import { LedgerDirection, WalletLedgerEntry } from "../domain/ledger/wallet-ledger-entry";
import { Money, type MoneyProps } from "../domain/money/money";
import { OutboxMessage } from "../domain/outbox/outbox-message";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../domain/wager-transaction/wager-transaction";
import { Wallet } from "../domain/wallet/wallet";
import { Persistence } from "../infrastructure/persistence/repositories";
import { DuplicateWalletError } from "./errors";
import { SystemClock } from "../infrastructure/clock";
import { UuidV7Generator } from "../infrastructure/id-generator";

export interface CreateWalletCommand {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId: string;
}

export interface CreateWalletResult {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: SystemClock,
    private readonly ids: UuidV7Generator,
  ) {}

  async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
    const initialBalance = Money.from(command.initialBalance);
    const now = this.clock.now();
    try {
      return await this.em.fork().transactional(async (em) => {
        const store = new Persistence(em);
        const wallet = Wallet.open({
          id: this.ids.uuid(),
          playerId: command.playerId,
          initialBalance,
          createdAt: now,
        });
        await store.insertWallet(wallet);

        if (!initialBalance.isZero()) {
          const tx = WagerTransaction.create({
            id: this.ids.uuid(),
            providerId: "internal",
            externalTransactionId: `opening:${wallet.id}`,
            idempotencyKey: `internal:opening:${wallet.id}`,
            payloadHash: "opening",
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: `opening:${wallet.id}`,
            gameId: "internal",
            kind: WagerTransactionKind.Opening,
            money: initialBalance,
            createdAt: now,
          });
          tx.markProcessed(undefined, now, wallet.balance);
          const ledger = WalletLedgerEntry.create({
            id: this.ids.uuid(),
            walletId: wallet.id,
            transactionId: tx.id,
            direction: LedgerDirection.Credit,
            money: initialBalance,
            balanceBefore: Money.zero(wallet.currency),
            balanceAfter: wallet.balance,
            createdAt: now,
          });
          await store.insertTransaction(tx);
          store.insertLedger(ledger);
          const ctx = {
            eventId: this.ids.uuid(),
            correlationId: command.correlationId,
            causationId: tx.id,
            occurredAt: now,
          };
          store.insertOutbox(OutboxMessage.enqueue(WagerTransactionProcessed.from(tx, ctx)));
          store.insertOutbox(
            OutboxMessage.enqueue(
              WalletBalanceChanged.from(wallet, ledger, { ...ctx, eventId: this.ids.uuid() }),
            ),
          );
        }

        return {
          id: wallet.id,
          playerId: wallet.playerId,
          balance: wallet.balance.toJSON(),
          version: wallet.version,
        };
      });
    } catch (error) {
      if (error instanceof UniqueConstraintViolationException) {
        throw new DuplicateWalletError("Wallet already exists for playerId + currency");
      }
      throw error;
    }
  }
}
