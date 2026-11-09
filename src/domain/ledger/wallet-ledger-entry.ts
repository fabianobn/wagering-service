import { InvalidLedgerEntryError } from "../errors";
import { Money, type MoneyProps } from "../money/money";

export enum LedgerDirection {
  Debit = "DEBIT",
  Credit = "CREDIT",
}

export interface CreateLedgerEntryProps {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: Money;
  balanceBefore: Money;
  balanceAfter: Money;
  createdAt: Date;
}

export interface LedgerEntryState {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: Date;
}

export class WalletLedgerEntry {
  private constructor(
    public readonly id: string,
    public readonly walletId: string,
    public readonly transactionId: string,
    public readonly direction: LedgerDirection,
    public readonly money: Money,
    public readonly balanceBefore: Money,
    public readonly balanceAfter: Money,
    public readonly createdAt: Date,
  ) {}

  static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
    const entry = new WalletLedgerEntry(
      props.id,
      props.walletId,
      props.transactionId,
      props.direction,
      props.money,
      props.balanceBefore,
      props.balanceAfter,
      props.createdAt,
    );
    if (!entry.isBalanced()) {
      throw new InvalidLedgerEntryError("Ledger entry arithmetic does not balance");
    }
    if (!entry.money.isPositive()) {
      throw new InvalidLedgerEntryError("Ledger amount must be positive");
    }
    return entry;
  }

  static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
    return new WalletLedgerEntry(
      state.id,
      state.walletId,
      state.transactionId,
      state.direction,
      Money.rehydrate(state.money),
      Money.rehydrate(state.balanceBefore),
      Money.rehydrate(state.balanceAfter),
      state.createdAt,
    );
  }

  isBalanced(): boolean {
    try {
      if (this.direction === LedgerDirection.Credit) {
        return this.balanceBefore.add(this.money).equals(this.balanceAfter);
      }
      return this.balanceBefore.subtract(this.money).equals(this.balanceAfter);
    } catch {
      return false;
    }
  }
}
