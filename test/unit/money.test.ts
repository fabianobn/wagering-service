import { describe, expect, test } from "bun:test";
import { CurrencyMismatchError, InvalidMoneyError } from "../../src/domain/errors";
import { Money } from "../../src/domain/money/money";

describe("Money", () => {
  test("normalizes 25 and 25.0 to 25.00", () => {
    expect(Money.from({ amount: "25", currency: "brl" }).toJSON()).toEqual({ amount: "25.00", currency: "BRL" });
    expect(Money.from({ amount: "25.0", currency: "BRL" }).toString()).toBe("25.00");
  });

  test("rejects more than 2 decimal places", () => {
    expect(() => Money.from({ amount: "25.001", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("rejects scientific notation, empty, NaN, Infinity and negatives", () => {
    expect(() => Money.from({ amount: "1e2", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "NaN", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "Infinity", currency: "BRL" })).toThrow(InvalidMoneyError);
    expect(() => Money.from({ amount: "-1.00", currency: "BRL" })).toThrow(InvalidMoneyError);
  });

  test("add and subtract stay in the same currency and remain immutable", () => {
    const a = Money.from({ amount: "10.00", currency: "BRL" });
    const b = Money.from({ amount: "2.50", currency: "BRL" });
    expect(a.add(b).toString()).toBe("12.50");
    expect(a.toString()).toBe("10.00");
    expect(a.subtract(b).toString()).toBe("7.50");
  });

  test("rejects mixed currencies", () => {
    const brl = Money.from({ amount: "10.00", currency: "BRL" });
    const usd = Money.from({ amount: "10.00", currency: "USD" });
    expect(() => brl.add(usd)).toThrow(CurrencyMismatchError);
  });

  test("zero and rehydrate", () => {
    expect(Money.zero("BRL").isZero()).toBe(true);
    const rehydrated = Money.rehydrate({ amount: "3.00", currency: "BRL" });
    expect(rehydrated.equals(Money.from({ amount: "3.00", currency: "BRL" }))).toBe(true);
  });
});
