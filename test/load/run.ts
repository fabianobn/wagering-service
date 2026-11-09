import { money } from "../helpers/http";

const BASE = process.env.BASE_URL ?? "http://127.0.0.1:3000";
const CONCURRENCY = Number(process.env.LOAD_CONCURRENCY ?? 20);
const REQUESTS = Number(process.env.LOAD_REQUESTS ?? 200);

async function json(url: string, init?: RequestInit) {
  const started = performance.now();
  const response = await fetch(url, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await response.json();
  return { status: response.status, body, ms: performance.now() - started };
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))] ?? 0;
}

const walletRes = await json(`${BASE}/wallets`, {
  method: "POST",
  body: JSON.stringify({ playerId: Bun.randomUUIDv7(), initialBalance: money("100000.00") }),
}) as { status: number; body: { id: string; playerId: string } };
if (walletRes.status >= 300) {
  console.error(JSON.stringify({ error: "failed to create wallet", walletRes }));
  process.exit(1);
}

const latencies: number[] = [];
let errors = 0;
let processed = 0;
const started = performance.now();

async function worker(offset: number) {
  for (let i = offset; i < REQUESTS; i += CONCURRENCY) {
    const result = await json(`${BASE}/wagering/transactions`, {
      method: "POST",
      headers: { "Idempotency-Key": `load:${i}` },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: `load-${i}`,
        playerId: walletRes.body.playerId,
        walletId: walletRes.body.id,
        roundId: `round-${i}`,
        gameId: "fortune-chimp",
        kind: "BET",
        money: money("1.00"),
      }),
    });
    latencies.push(result.ms);
    if (result.status >= 400) errors += 1;
    if ((result.body as { status?: string }).status === "PROCESSED") processed += 1;
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, (_, i) => worker(i)));
const elapsedSec = (performance.now() - started) / 1000;
latencies.sort((a, b) => a - b);
const recon = await json(`${BASE}/wallets/${walletRes.body.id}/reconciliation`, { method: "POST" });
const metrics = await json(`${BASE}/metrics`);

const report = {
  environment: {
    baseUrl: BASE,
    concurrency: CONCURRENCY,
    requests: REQUESTS,
    runtime: "bun",
  },
  throughputRps: Number((REQUESTS / elapsedSec).toFixed(2)),
  elapsedSec: Number(elapsedSec.toFixed(3)),
  p50: Number(percentile(latencies, 0.5).toFixed(2)),
  p95: Number(percentile(latencies, 0.95).toFixed(2)),
  p99: Number(percentile(latencies, 0.99).toFixed(2)),
  errors,
  processed,
  reconciliation: recon.body,
  metrics: metrics.body,
};

console.log(JSON.stringify(report, null, 2));
await Bun.write("tmp/load-report.json", JSON.stringify(report, null, 2));
