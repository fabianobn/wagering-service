import { Decimal } from "decimal.js";
import { CurrencyMismatchError, InvalidMoneyError } from "../errors";

export interface MoneyProps {
  amount: string;
  currency: string;
}

const SCALE = 2;
const CURRENCY_RE = /^[A-Z]{3}$/;
const AMOUNT_RE = /^\d+(\.\d+)?$/;

Decimal.set({ precision: 40, rounding: Decimal.ROUND_DOWN });

export class Money {
  private constructor(
    private readonly value: Decimal,
    public readonly currency: string,
  ) {}

  static from(props: MoneyProps): Money {
    return new Money(parseAmount(props.amount, { allowNegative: false }), parseCurrency(props.currency));
  }

  static zero(currency: string): Money {
    return new Money(new Decimal("0.00"), parseCurrency(currency));
  }

  static rehydrate(props: MoneyProps): Money {
    return new Money(new Decimal(props.amount), parseCurrency(props.currency));
  }

  add(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.plus(other.value), this.currency);
  }

  subtract(other: Money): Money {
    this.assertSameCurrency(other);
    return new Money(this.value.minus(other.value), this.currency);
  }

  negate(): Money {
    return new Money(this.value.negated(), this.currency);
  }

  isZero(): boolean {
    return this.value.isZero();
  }

  isPositive(): boolean {
    return this.value.gt(0);
  }

  isNegative(): boolean {
    return this.value.lt(0);
  }

  isLessThan(other: Money): boolean {
    this.assertSameCurrency(other);
    return this.value.lt(other.value);
  }

  equals(other: Money): boolean {
    return this.currency === other.currency && this.value.eq(other.value);
  }

  toJSON(): MoneyProps {
    return { amount: this.toString(), currency: this.currency };
  }

  toString(): string {
    return this.value.toFixed(SCALE);
  }

  private assertSameCurrency(other: Money): void {
    if (this.currency !== other.currency) {
      throw new CurrencyMismatchError(`Currency mismatch: ${this.currency} vs ${other.currency}`);
    }
  }
}

function parseCurrency(raw: string): string {
  const currency = raw.trim().toUpperCase();
  if (!CURRENCY_RE.test(currency)) {
    throw new InvalidMoneyError(`Invalid currency: ${raw}`);
  }
  return currency;
}

function parseAmount(raw: string, opts: { allowNegative: boolean }): Decimal {
  if (typeof raw !== "string") {
    throw new InvalidMoneyError("Amount must be a decimal string");
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    throw new InvalidMoneyError("Amount cannot be empty");
  }
  if (/[eE]/.test(trimmed)) {
    throw new InvalidMoneyError("Scientific notation is not allowed");
  }
  if (trimmed === "NaN" || trimmed === "Infinity" || trimmed === "-Infinity") {
    throw new InvalidMoneyError("Non-finite amount");
  }
  if (!opts.allowNegative && trimmed.startsWith("-")) {
    throw new InvalidMoneyError("Negative amounts are not allowed in input contracts");
  }
  if (!AMOUNT_RE.test(trimmed)) {
    throw new InvalidMoneyError(`Invalid amount: ${raw}`);
  }
  const parts = trimmed.split(".");
  const fraction = parts[1];
  if (fraction !== undefined && fraction.length > SCALE) {
    throw new InvalidMoneyError("More than 2 decimal places");
  }
  const value = new Decimal(trimmed);
  if (!value.isFinite()) {
    throw new InvalidMoneyError("Non-finite amount");
  }
  return new Decimal(value.toFixed(SCALE));
}
