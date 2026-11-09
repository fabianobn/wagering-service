import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { json, money } from "../helpers/http";
import { MikroORM } from "@mikro-orm/postgresql";
import config from "../../mikro-orm.config";

const ports = [3311, 3312, 3313];
const procs: ReturnType<typeof Bun.spawn>[] = [];

async function waitReady(port: number) {
  for (let i = 0; i < 50; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health/live`);
      if (res.ok) return;
    } catch {
      // retry
    }
    await Bun.sleep(100);
  }
  throw new Error(`app on ${port} did not start`);
}

beforeAll(async () => {
  const orm = await MikroORM.init(config);
  await orm.em.execute(`
    TRUNCATE inbox_messages, outbox_messages, wallet_ledger_entries, wager_transactions, wallets
    RESTART IDENTITY CASCADE
  `);
  await orm.close(true);

  for (const port of ports) {
    const proc = Bun.spawn(["bun", "src/main.ts"], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        PORT: String(port),
        SKIP_BACKGROUND: port === 3313 ? "0" : "1",
        FAULT_CRASH_AFTER_COMMIT_KEY: port === 3313 ? "" : "",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    procs.push(proc);
    await waitReady(port);
  }
});

afterAll(() => {
  for (const proc of procs) {
    proc.kill();
  }
});

describe("multiple instances", () => {
  test("three processes serialize the same wallet correctly", async () => {
    const base = `http://127.0.0.1:${ports[0]}`;
    const created = await json(`${base}/wallets`, {
      method: "POST",
      body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: money("100.00") }),
    });
    const wallet = created.body;
    const requests = await Promise.all(
      Array.from({ length: 12 }, (_, i) => {
        const port = ports[i % ports.length];
        return json(`http://127.0.0.1:${port}/wagering/transactions`, {
          method: "POST",
          headers: { "Idempotency-Key": `provider-a:m-${i}` },
          body: JSON.stringify({
            providerId: "provider-a",
            externalTransactionId: `m-${i}`,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: "r",
            gameId: "g",
            kind: "BET",
            money: money("10.00"),
          }),
        });
      }),
    );
    const processed = requests.filter((r) => r.body.status === "PROCESSED");
    const rejected = requests.filter((r) => r.body.status === "REJECTED");
    expect(processed.length).toBe(10);
    expect(rejected.length).toBe(2);
    const recon = await json(`${base}/wallets/${wallet.id}/reconciliation`, { method: "POST" });
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.storedBalance.amount).toBe("0.00");
  });

  test("service restart keeps ledger consistent", async () => {
    const base = `http://127.0.0.1:${ports[0]}`;
    const created = await json(`${base}/wallets`, {
      method: "POST",
      body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: money("30.00") }),
    });
    await json(`${base}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": "restart-bet" },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: "restart-bet",
        playerId: created.body.playerId,
        walletId: created.body.id,
        roundId: "r",
        gameId: "g",
        kind: "BET",
        money: money("5.00"),
      }),
    });
    procs[0]?.kill();
    await Bun.sleep(200);
    const restarted = Bun.spawn(["bun", "src/main.ts"], {
      cwd: process.cwd(),
      env: { ...process.env, PORT: String(ports[0]), SKIP_BACKGROUND: "1" },
      stdout: "pipe",
      stderr: "pipe",
    });
    procs[0] = restarted;
    await waitReady(ports[0]!);
    const recon = await json(`${base}/wallets/${created.body.id}/reconciliation`, { method: "POST" });
    expect(recon.body.consistent).toBe(true);
    expect(recon.body.storedBalance.amount).toBe("25.00");
  });
});
