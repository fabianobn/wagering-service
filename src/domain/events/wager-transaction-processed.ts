import type { MoneyProps } from "../money/money";
import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import { IntegrationEvent, type EventContext } from "./integration-event";

export interface WagerTransactionProcessedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  kind: string;
  status: string;
  balance: MoneyProps;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
    return new WagerTransactionProcessed({
      eventId: ctx.eventId,
      aggregateId: tx.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId,
      occurredAt: ctx.occurredAt,
      data: {
        transactionId: tx.id,
        walletId: tx.walletId,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
        balance: tx.observedBalance!.toJSON(),
      },
    });
  }
}
