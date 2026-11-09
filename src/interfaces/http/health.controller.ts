import { Controller, Get, Res } from "@nestjs/common";
import type { Response } from "express";
import { EntityManager } from "@mikro-orm/postgresql";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { SqsService } from "../../infrastructure/messaging/sqs.client";

@Controller()
export class HealthController {
  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsService,
    private readonly metrics: MetricsService,
  ) {}

  @Get("/health/live")
  live() {
    return { status: "ok" };
  }

  @Get("/health/ready")
  async ready(@Res() res: Response) {
    let postgres = false;
    let sqs = false;
    try {
      await this.em.execute("select 1");
      postgres = true;
    } catch {
      postgres = false;
    }
    sqs = await this.sqs.ping();
    const ready = postgres && sqs;
    res.status(ready ? 200 : 503).json({
      status: ready ? "ok" : "unavailable",
      postgres,
      sqs,
    });
  }

  @Get("/metrics")
  metricsSnapshot() {
    return this.metrics.snapshot();
  }
}
