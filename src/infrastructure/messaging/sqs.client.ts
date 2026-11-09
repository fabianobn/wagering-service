import {
  CreateQueueCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  SQSClient,
  SetQueueAttributesCommand,
} from "@aws-sdk/client-sqs";
import { Injectable, OnModuleInit } from "@nestjs/common";
import { loadEnv, type AppEnv } from "../config/env";
import { AppLogger } from "../observability/logger";

@Injectable()
export class SqsService implements OnModuleInit {
  readonly client: SQSClient;
  readonly env: AppEnv;
  wagerQueueUrl?: string;
  wagerDlqUrl?: string;
  eventsQueueUrl?: string;
  eventsDlqUrl?: string;

  constructor(private readonly logger: AppLogger) {
    this.env = loadEnv();
    this.client = new SQSClient({
      endpoint: this.env.awsEndpointUrl,
      region: this.env.awsRegion,
      credentials: {
        accessKeyId: this.env.awsAccessKeyId,
        secretAccessKey: this.env.awsSecretAccessKey,
      },
    });
  }

  async onModuleInit(): Promise<void> {
    this.wagerDlqUrl = await this.ensureFifoQueue(this.env.wagerDlq);
    this.wagerQueueUrl = await this.ensureFifoQueue(this.env.wagerQueue, this.wagerDlqUrl);
    this.eventsDlqUrl = await this.ensureFifoQueue(this.env.eventsDlq);
    this.eventsQueueUrl = await this.ensureFifoQueue(this.env.eventsQueue, this.eventsDlqUrl);
    this.logger.info("sqs.ready", {
      wagerQueue: this.env.wagerQueue,
      eventsQueue: this.env.eventsQueue,
    });
  }

  async ping(): Promise<boolean> {
    try {
      await this.client.send(new GetQueueUrlCommand({ QueueName: this.env.wagerQueue }));
      return true;
    } catch {
      return false;
    }
  }

  private async ensureFifoQueue(name: string, dlqUrl?: string): Promise<string> {
    try {
      const created = await this.client.send(
        new CreateQueueCommand({
          QueueName: name,
          Attributes: {
            FifoQueue: "true",
            ContentBasedDeduplication: "false",
          },
        }),
      );
      const url = created.QueueUrl!;
      if (dlqUrl) {
        await this.attachDlq(url, dlqUrl);
      }
      return url;
    } catch (error) {
      const existing = await this.client.send(new GetQueueUrlCommand({ QueueName: name }));
      const url = existing.QueueUrl!;
      if (dlqUrl) {
        await this.attachDlq(url, dlqUrl);
      }
      return url;
    }
  }

  private async attachDlq(queueUrl: string, dlqUrl: string): Promise<void> {
    const attrs = await this.client.send(
      new GetQueueAttributesCommand({ QueueUrl: dlqUrl, AttributeNames: ["QueueArn"] }),
    );
    const arn = attrs.Attributes?.QueueArn;
    if (!arn) {
      return;
    }
    await this.client.send(
      new SetQueueAttributesCommand({
        QueueUrl: queueUrl,
        Attributes: {
          RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: arn,
            maxReceiveCount: String(this.env.sqsMaxReceiveCount),
          }),
        },
      }),
    );
  }
}
