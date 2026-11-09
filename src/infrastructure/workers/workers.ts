import { Injectable, OnApplicationShutdown, OnModuleInit } from "@nestjs/common";
import { ProcessPendingReferencesUseCase } from "../../application/process-pending-references.use-case";
import { PublishOutboxUseCase } from "../../application/publish-outbox.use-case";
import { loadEnv } from "../config/env";
import { AppLogger } from "../observability/logger";

@Injectable()
export class BackgroundWorkers implements OnModuleInit, OnApplicationShutdown {
  private running = false;
  private readonly env = loadEnv();

  constructor(
    private readonly outbox: PublishOutboxUseCase,
    private readonly pending: ProcessPendingReferencesUseCase,
    private readonly logger: AppLogger,
  ) {}

  onModuleInit(): void {
    if (process.env.SKIP_BACKGROUND === "1") {
      return;
    }
    this.running = true;
    void this.outboxLoop();
    void this.pendingLoop();
  }

  onApplicationShutdown(): void {
    this.running = false;
  }

  private async outboxLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.outbox.execute();
      } catch (error) {
        this.logger.error("outbox.worker.failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
      await Bun.sleep(this.env.outboxIntervalMs);
    }
  }

  private async pendingLoop(): Promise<void> {
    while (this.running) {
      try {
        await this.pending.execute();
      } catch (error) {
        this.logger.error("pending_reference.worker.failed", {
          error: error instanceof Error ? error.message : "unknown",
        });
      }
      await Bun.sleep(this.env.pendingReferenceIntervalMs);
    }
  }
}
