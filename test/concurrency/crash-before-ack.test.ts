import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { json, money } from "../helpers/http";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";
import { SQSClient, SendMessageCommand, GetQueueUrlCommand } from "@aws-sdk/client-sqs";

const PORT = 3320;
const FAULT_KEY = "crash-key-1";
let proc: ReturnType<typeof Bun.spawn> | undefined;

async function waitReady() {
  for (let i = 0; i < 50; i++) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/health/live`)).ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(100);
  }
  throw new Error("fault process did not start");
}

beforeAll(async () => {
  const orm = await MikroORM.init(config);
  await orm.em.execute(`
    TRUNCATE inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets
    RESTART IDENTITY CASCADE
  `);
  await orm.close(true);
});

afterAll(() => {
  proc?.kill();
});

describe("crash after commit before ack", () => {
  test("redelivery does not double debit", async () => {
    proc = Bun.spawn(["bun", "src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(PORT),
        SKIP_BACKGROUND: "0",
        FAULT_CRASH_AFTER_COMMIT_KEY: FAULT_KEY,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    await waitReady();
    const created = await json(`http://127.0.0.1:${PORT}/wallets`, {
      method: "POST",
      body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: money("80.00") }),
    });
    const sqs = new SQSClient({
      endpoint: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
      region: "us-east-1",
      credentials: { accessKeyId: "test", secretAccessKey: "test" },
    });
    const queue = await sqs.send(new GetQueueUrlCommand({ QueueName: "wager-transactions.fifo" }));
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl,
        MessageGroupId: created.body.id,
        MessageDeduplicationId: Bun.randomUUIDv7(),
        MessageBody: JSON.stringify({
          messageId: "crash-msg-1",
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "provider-a",
            externalTransactionId: "crash-tx",
            idempotencyKey: FAULT_KEY,
            playerId: created.body.playerId,
            walletId: created.body.id,
            roundId: "r",
            gameId: "g",
            kind: "BET",
            money: money("20.00"),
          },
        }),
      }),
    );
    await Bun.sleep(1500);

    const survivor = Bun.spawn(["bun", "src/main.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: "3321", SKIP_BACKGROUND: "0" },
      stdout: "pipe",
      stderr: "pipe",
    });
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch("http://127.0.0.1:3321/health/live")).ok) break;
      } catch {
        await Bun.sleep(100);
      }
    }
    await sqs.send(
      new SendMessageCommand({
        QueueUrl: queue.QueueUrl,
        MessageGroupId: created.body.id,
        MessageDeduplicationId: Bun.randomUUIDv7(),
        MessageBody: JSON.stringify({
          messageId: "crash-msg-1",
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "provider-a",
            externalTransactionId: "crash-tx",
            idempotencyKey: FAULT_KEY,
            playerId: created.body.playerId,
            walletId: created.body.id,
            roundId: "r",
            gameId: "g",
            kind: "BET",
            money: money("20.00"),
          },
        }),
      }),
    );
    await Bun.sleep(1500);
    const recon = await json(`http://127.0.0.1:3321/wallets/${created.body.id}/reconciliation`, { method: "POST" });
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.storedBalance.amount).toBe("60.00");
    survivor.kill();
  });
});
