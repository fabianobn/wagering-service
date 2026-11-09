export interface AppEnv {
  port: number;
  databaseUrl: string;
  awsEndpointUrl: string;
  awsRegion: string;
  awsAccessKeyId: string;
  awsSecretAccessKey: string;
  wagerQueue: string;
  wagerDlq: string;
  eventsQueue: string;
  eventsDlq: string;
  logLevel: string;
  pendingReferenceIntervalMs: number;
  outboxIntervalMs: number;
  sqsMaxReceiveCount: number;
  pendingReferenceMaxAttempts: number;
  pendingReferenceTtlMs: number;
}

export function loadEnv(): AppEnv {
  return {
    port: Number(process.env.PORT ?? 3000),
    databaseUrl: required("DATABASE_URL"),
    awsEndpointUrl: process.env.AWS_ENDPOINT_URL ?? "http://localhost:4566",
    awsRegion: process.env.AWS_REGION ?? "us-east-1",
    awsAccessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
    awsSecretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
    wagerQueue: process.env.SQS_WAGER_QUEUE ?? "wager-transactions.fifo",
    wagerDlq: process.env.SQS_WAGER_DLQ ?? "wager-transactions-dlq.fifo",
    eventsQueue: process.env.SQS_EVENTS_QUEUE ?? "integration-events.fifo",
    eventsDlq: process.env.SQS_EVENTS_DLQ ?? "integration-events-dlq.fifo",
    logLevel: process.env.LOG_LEVEL ?? "info",
    pendingReferenceIntervalMs: Number(process.env.PENDING_REFERENCE_INTERVAL_MS ?? 2000),
    outboxIntervalMs: Number(process.env.OUTBOX_INTERVAL_MS ?? 500),
    sqsMaxReceiveCount: Number(process.env.SQS_MAX_RECEIVE_COUNT ?? 5),
    pendingReferenceMaxAttempts: Number(process.env.PENDING_REFERENCE_MAX_ATTEMPTS ?? 10),
    pendingReferenceTtlMs: Number(process.env.PENDING_REFERENCE_TTL_MS ?? 15 * 60 * 1000),
  };
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required env ${name}`);
  }
  return value;
}
