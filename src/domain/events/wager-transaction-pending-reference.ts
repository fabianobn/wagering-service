import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import { IntegrationEvent, type EventContext } from "./integration-event";

export interface WagerTransactionPendingReferenceData {
  transactionId: string;
  walletId: string;
  providerId: string;
  referenceExternalTransactionId: string;
  attempt: number;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
  readonly eventType = "WagerTransactionPendingReference";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
    return new WagerTransactionPendingReference({
      eventId: ctx.eventId,
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        referenceExternalTransactionId: tx.referenceExternalTransactionId!,
        attempt: tx.referenceRetryAttempts,
      },
    });
  }
}
