import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { MikroORM } from "@mikro-orm/postgresql";
import { AppModule } from "../../src/app.module";

export async function startApp(port: number): Promise<INestApplication> {
  process.env.SKIP_BACKGROUND = process.env.SKIP_BACKGROUND ?? "1";
  const app = await NestFactory.create(AppModule, { logger: false });
  app.enableShutdownHooks();
  await app.listen(port);
  return app;
}

export async function resetDatabase(app: INestApplication): Promise<void> {
  const orm = app.get(MikroORM);
  await orm.em.execute(`
    TRUNCATE inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets
    RESTART IDENTITY CASCADE
  `);
}
