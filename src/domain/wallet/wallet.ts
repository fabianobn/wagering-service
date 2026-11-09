import { CurrencyMismatchError, InsufficientBalanceError } from "../errors";
import { Money, type MoneyProps } from "../money/money";

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: {
    id: string;
    playerId: string;
    initialBalance: Money;
    createdAt: Date;
  }): Wallet {
    if (props.initialBalance.isNegative()) {
      throw new InsufficientBalanceError("Initial balance cannot be negative");
    }
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      props.createdAt,
      props.createdAt,
    );
  }

  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      Money.rehydrate(state.balance),
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(money: Money, at: Date): { balanceBefore: Money; balanceAfter: Money } {
    this.assertSameCurrency(money);
    if (this._balance.isLessThan(money)) {
      throw new InsufficientBalanceError("Insufficient wallet balance");
    }
    const balanceBefore = this._balance;
    this._balance = this._balance.subtract(money);
    this.touchIfBalanceChanged(balanceBefore, at);
    return { balanceBefore, balanceAfter: this._balance };
  }

  credit(money: Money, at: Date): { balanceBefore: Money; balanceAfter: Money } {
    this.assertSameCurrency(money);
    const balanceBefore = this._balance;
    this._balance = this._balance.add(money);
    this.touchIfBalanceChanged(balanceBefore, at);
    return { balanceBefore, balanceAfter: this._balance };
  }

  private touchIfBalanceChanged(before: Money, at: Date): void {
    if (this._balance.equals(before)) {
      return;
    }
    this._version += 1;
    this._updatedAt = at;
  }

  private assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(`Wallet currency ${this.currency} does not match ${money.currency}`);
    }
  }
}
