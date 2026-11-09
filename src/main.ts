import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { loadEnv } from "./infrastructure/config/env";
import { AppLogger } from "./infrastructure/observability/logger";

async function bootstrap() {
  const env = loadEnv();
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(env.port);
  app.get(AppLogger).info("app.started", { port: env.port });
}

void bootstrap();
