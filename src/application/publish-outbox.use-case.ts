import { Injectable } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { Persistence } from "../infrastructure/persistence/repositories";
import { SystemClock } from "../infrastructure/clock";
import { SqsPublisher } from "../infrastructure/messaging/sqs.publisher";
import { MetricsService } from "../infrastructure/observability/metrics.service";
import { AppLogger } from "../infrastructure/observability/logger";
import type { OutboxMessage } from "../domain/outbox/outbox-message";

@Injectable()
export class PublishOutboxUseCase {
  constructor(
    private readonly em: EntityManager,
    private readonly clock: SystemClock,
    private readonly publisher: SqsPublisher,
    private readonly metrics: MetricsService,
    private readonly logger: AppLogger,
  ) {}

  async execute(): Promise<number> {
    const now = this.clock.now();
    const claimed = await this.em.fork().transactional(async (em) => {
      const store = new Persistence(em);
      const messages = await store.claimOutbox(now, 20);
      for (const message of messages) {
        message.scheduleRetry(now);
        await store.saveOutbox(message);
      }
      return messages;
    });

    const oldest = await new Persistence(this.em.fork()).oldestUnpublishedOccurredAt();
    this.metrics.setOutboxLag(oldest ? now.getTime() - oldest.getTime() : 0);

    for (const message of claimed) {
      await this.publishOne(message);
    }
    return claimed.length;
  }

  private async publishOne(message: OutboxMessage): Promise<void> {
    try {
      await this.publisher.publishIntegrationEvent(message);
      message.markPublished(this.clock.now());
      await this.em.fork().transactional(async (em) => {
        await new Persistence(em).saveOutbox(message);
      });
    } catch (error) {
      this.metrics.incrementRetries();
      this.logger.error("outbox.publish.failed", {
        eventType: message.eventType,
        aggregateId: message.aggregateId,
        error: error instanceof Error ? error.message : "unknown",
      });
    }
  }
}
