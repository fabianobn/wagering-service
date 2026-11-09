import type { MoneyProps } from "../money/money";
import type { WagerTransaction } from "../wager-transaction/wager-transaction";
import { IntegrationEvent, type EventContext } from "./integration-event";

export interface WagerTransactionRejectedData {
  transactionId: string;
  walletId: string;
  providerId: string;
  kind: string;
  failureCode: string;
  balance: MoneyProps;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  static from(tx: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
    return new WagerTransactionRejected({
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
        failureCode: tx.failureCode!,
        balance: tx.observedBalance!.toJSON(),
      },
    });
  }
}
