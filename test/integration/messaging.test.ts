import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { INestApplication } from "@nestjs/common";
import { EntityManager } from "@mikro-orm/postgresql";
import { PublishOutboxUseCase } from "../../src/application/publish-outbox.use-case";
import { SqsPublisher } from "../../src/infrastructure/messaging/sqs.publisher";
import { ReceiveMessageCommand } from "@aws-sdk/client-sqs";
import { SqsService } from "../../src/infrastructure/messaging/sqs.client";
import { resetDatabase, startApp } from "../helpers/app";
import { json, money } from "../helpers/http";

const PORT = 3103;
const BASE = `http://127.0.0.1:${PORT}`;
let app: INestApplication;

describe("messaging integration", () => {
  beforeAll(async () => {
    process.env.SKIP_BACKGROUND = "1";
    app = await startApp(PORT);
  });
  beforeEach(async () => {
    await resetDatabase(app);
  });
  afterAll(async () => {
    await app.close();
  });

  test("inbox + outbox are written atomically with the financial transaction", async () => {
    const walletRes = await json(`${BASE}/wallets`, {
      method: "POST",
      body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: money("100.00") }),
    });
    const wallet = walletRes.body;
    await app.get(SqsPublisher).sendWager(
      {
        messageId: "msg-atomic-1",
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "provider-a",
          externalTransactionId: "sqs-1",
          idempotencyKey: "provider-a:sqs-1",
          playerId: wallet.playerId,
          walletId: wallet.id,
          roundId: "r",
          gameId: "g",
          kind: "BET",
          money: money("10.00"),
        },
      },
      wallet.id,
      Bun.randomUUIDv7(),
    );

    const { SubmitWagerTransactionUseCase } = await import(
      "../../src/application/submit-wager-transaction.use-case"
    );
    await app.get(SubmitWagerTransactionUseCase).execute({
      providerId: "provider-a",
      externalTransactionId: "sqs-1",
      idempotencyKey: "provider-a:sqs-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET" as never,
      money: money("10.00"),
      correlationId: "c1",
      inbox: { messageId: "msg-atomic-1", consumerName: "wager-transactions" },
    });

    const em = app.get(EntityManager).fork();
    const inbox = await em.execute("select * from inbox_messages where message_id = 'msg-atomic-1'");
    const outbox = await em.execute("select event_type from outbox_messages");
    const ledger = await em.execute("select count(*)::int as n from wallet_ledger_entries");
    expect(inbox.length).toBe(1);
    expect(outbox.some((row) => (row as { event_type: string }).event_type === "WagerTransactionProcessed")).toBe(true);
    expect((ledger[0] as { n: number }).n).toBe(2);

    const replay = await app.get(SubmitWagerTransactionUseCase).execute({
      providerId: "provider-a",
      externalTransactionId: "sqs-1",
      idempotencyKey: "provider-a:sqs-1",
      playerId: wallet.playerId,
      walletId: wallet.id,
      roundId: "r",
      gameId: "g",
      kind: "BET" as never,
      money: money("10.00"),
      correlationId: "c1",
      inbox: { messageId: "msg-atomic-1", consumerName: "wager-transactions" },
    });
    expect(replay.idempotentReplay).toBe(true);
    const ledger2 = await em.execute("select count(*)::int as n from wallet_ledger_entries");
    expect((ledger2[0] as { n: number }).n).toBe(2);
  });

  test("two outbox publishers do not double-publish indefinitely", async () => {
    const walletRes = await json(`${BASE}/wallets`, {
      method: "POST",
      body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: money("20.00") }),
    });
    await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "k-outbox" },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "tx-outbox",
        playerId: walletRes.body.playerId,
        walletId: walletRes.body.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: money("1.00"),
      }),
    });
    const uc = app.get(PublishOutboxUseCase);
    await Promise.all([uc.execute(), uc.execute()]);
    const sqs = app.get(SqsService);
    let received = 0;
    for (let i = 0; i < 5; i++) {
      const res = await sqs.client.send(
        new ReceiveMessageCommand({
          QueueUrl: sqs.eventsQueueUrl,
          MaxNumberOfMessages: 10,
          WaitTimeSeconds: 1,
        }),
      );
      received += res.Messages?.length ?? 0;
    }
    expect(received).toBeGreaterThan(0);
    const em = app.get(EntityManager).fork();
    const unpublished = await em.execute("select count(*)::int as n from outbox_messages where published_at is null");
    expect((unpublished[0] as { n: number }).n).toBe(0);
  });
});
