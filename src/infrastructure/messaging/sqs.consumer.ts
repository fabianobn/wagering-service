import {
  ChangeMessageVisibilityCommand,
  DeleteMessageCommand,
  ReceiveMessageCommand,
  type Message,
} from "@aws-sdk/client-sqs";
import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import {
  SubmitWagerTransactionUseCase,
  WAGER_CONSUMER_NAME,
} from "../../application/submit-wager-transaction.use-case";
import { WagerTransactionKind } from "../../domain/wager-transaction/wager-transaction";
import { InvalidRequestError, WalletNotFoundError } from "../../application/errors";
import { InvalidMoneyError, InvalidTransactionStateError } from "../../domain/errors";
import { AppLogger } from "../observability/logger";
import { MetricsService } from "../observability/metrics.service";
import { SqsService } from "./sqs.client";

@Injectable()
export class SqsConsumer implements OnModuleInit, OnApplicationShutdown {
  private running = false;
  private inFlight = 0;
  private loopPromise?: Promise<void>;
  private readonly unacked = new Map<string, Message>();

  constructor(
    private readonly sqs: SqsService,
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly logger: AppLogger,
    private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (process.env.SKIP_BACKGROUND === "1") {
      return;
    }
    this.running = true;
    this.loopPromise = this.loop();
  }

  async onApplicationShutdown(): Promise<void> {
    this.running = false;
    const deadline = Date.now() + 10_000;
    while (this.inFlight > 0 && Date.now() < deadline) {
      await Bun.sleep(50);
    }
    await this.nackAll();
    await this.loopPromise;
  }

  private async loop(): Promise<void> {
    while (this.running) {
      try {
        if (!this.sqs.wagerQueueUrl) {
          await Bun.sleep(200);
          continue;
        }
        const response = await this.sqs.client.send(
          new ReceiveMessageCommand({
            QueueUrl: this.sqs.wagerQueueUrl,
            MaxNumberOfMessages: 5,
            WaitTimeSeconds: 5,
            VisibilityTimeout: 30,
            MessageSystemAttributeNames: ["ApproximateReceiveCount"],
          }),
        );
        const messages = response.Messages ?? [];
        if (!this.running) {
          for (const message of messages) {
            this.track(message);
          }
          await this.nackAll();
          break;
        }
        await Promise.all(messages.map((message) => this.handle(message)));
      } catch (error) {
        if (this.running) {
          this.logger.error("sqs.receive.failed", {
            error: error instanceof Error ? error.message : "unknown",
          });
          await Bun.sleep(1000);
        }
      }
    }
  }

  private async handle(message: Message): Promise<void> {
    this.inFlight += 1;
    this.track(message);
    try {
      const parsed = parseWagerMessage(message);
      await this.submit.execute({
        ...parsed,
        inbox: { messageId: parsed.messageId, consumerName: WAGER_CONSUMER_NAME },
      });
      if (process.env.FAULT_CRASH_AFTER_COMMIT_KEY) {
        const { crashAfterCommitIfMatch } = await import("../testing/crash-after-commit");
        crashAfterCommitIfMatch(parsed.idempotencyKey);
      }
      await this.ack(message);
    } catch (error) {
      if (isBusinessError(error)) {
        await this.ack(message);
        return;
      }
      this.logger.error("sqs.handle.failed", {
        error: error instanceof Error ? error.message : "unknown",
        messageId: message.MessageId,
      });
      const receives = Number(message.Attributes?.ApproximateReceiveCount ?? "1");
      if (receives >= this.sqs.env.sqsMaxReceiveCount) {
        this.metrics.incrementDlq();
      } else {
        this.metrics.incrementRetries();
      }
    } finally {
      this.inFlight -= 1;
    }
  }

  private track(message: Message): void {
    if (message.ReceiptHandle) {
      this.unacked.set(message.ReceiptHandle, message);
    }
  }

  private async ack(message: Message): Promise<void> {
    if (!message.ReceiptHandle || !this.sqs.wagerQueueUrl) {
      return;
    }
    await this.sqs.client.send(
      new DeleteMessageCommand({
        QueueUrl: this.sqs.wagerQueueUrl,
        ReceiptHandle: message.ReceiptHandle,
      }),
    );
    this.unacked.delete(message.ReceiptHandle);
  }

  private async nackAll(): Promise<void> {
    const pending = [...this.unacked.values()];
    this.unacked.clear();
    if (!this.sqs.wagerQueueUrl) {
      return;
    }
    await Promise.all(
      pending.map(async (message) => {
        if (!message.ReceiptHandle || !this.sqs.wagerQueueUrl) {
          return;
        }
        try {
          await this.sqs.client.send(
            new ChangeMessageVisibilityCommand({
              QueueUrl: this.sqs.wagerQueueUrl,
              ReceiptHandle: message.ReceiptHandle,
              VisibilityTimeout: 0,
            }),
          );
        } catch (error) {
          this.logger.error("sqs.nack.failed", {
            error: error instanceof Error ? error.message : "unknown",
            messageId: message.MessageId,
          });
        }
      }),
    );
  }
}

function isBusinessError(error: unknown): boolean {
  return (
    error instanceof InvalidRequestError ||
    error instanceof WalletNotFoundError ||
    error instanceof InvalidMoneyError ||
    error instanceof InvalidTransactionStateError
  );
}

function parseWagerMessage(message: Message) {
  const body = JSON.parse(message.Body ?? "{}") as {
    messageId?: string;
    type?: string;
    occurredAt?: string;
    data?: Record<string, unknown>;
  };
  const data = body.data ?? {};
  return {
    messageId: body.messageId ?? message.MessageId ?? "",
    providerId: String(data.providerId ?? ""),
    externalTransactionId: String(data.externalTransactionId ?? ""),
    idempotencyKey: String(data.idempotencyKey ?? ""),
    playerId: String(data.playerId ?? ""),
    walletId: String(data.walletId ?? ""),
    roundId: String(data.roundId ?? ""),
    gameId: String(data.gameId ?? ""),
    kind: String(data.kind ?? "") as WagerTransactionKind,
    money: data.money as { amount: string; currency: string },
    referenceExternalTransactionId: data.referenceExternalTransactionId
      ? String(data.referenceExternalTransactionId)
      : undefined,
    correlationId: String(data.idempotencyKey ?? message.MessageId ?? ""),
  };
}
