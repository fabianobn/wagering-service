import { SendMessageCommand } from "@aws-sdk/client-sqs";
import { Injectable } from "@nestjs/common";
import type { OutboxMessage } from "../../domain/outbox/outbox-message";
import { SqsService } from "./sqs.client";

@Injectable()
export class SqsPublisher {
  constructor(private readonly sqs: SqsService) {}

  async publishIntegrationEvent(message: OutboxMessage): Promise<void> {
    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: this.sqs.eventsQueueUrl,
        MessageBody: JSON.stringify(message.payload),
        MessageGroupId: message.aggregateId,
        MessageDeduplicationId: `${message.id}:${message.attempts}`,
      }),
    );
  }

  async sendWager(body: unknown, groupId: string, dedupId: string): Promise<void> {
    await this.sqs.client.send(
      new SendMessageCommand({
        QueueUrl: this.sqs.wagerQueueUrl,
        MessageBody: JSON.stringify(body),
        MessageGroupId: groupId,
        MessageDeduplicationId: dedupId,
      }),
    );
  }
}
