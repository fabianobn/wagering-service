import { Injectable } from "@nestjs/common";
import type { PayloadHasher } from "../application/ports";

@Injectable()
export class Sha256PayloadHasher implements PayloadHasher {
  hash(value: unknown): string {
    const hasher = new Bun.CryptoHasher("sha256");
    hasher.update(canonicalJson(value));
    return hasher.digest("hex");
  }
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      const nested = obj[key];
      if (nested !== undefined) {
        sorted[key] = sortKeys(nested);
      }
    }
    return sorted;
  }
  return value;
}

export function businessPayload(input: {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: { amount: string; currency: string };
  referenceExternalTransactionId?: string;
}): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    externalTransactionId: input.externalTransactionId,
    gameId: input.gameId,
    kind: input.kind,
    money: { amount: input.money.amount, currency: input.money.currency },
    playerId: input.playerId,
    providerId: input.providerId,
    roundId: input.roundId,
    walletId: input.walletId,
  };
  if (input.referenceExternalTransactionId) {
    payload.referenceExternalTransactionId = input.referenceExternalTransactionId;
  }
  return payload;
}
