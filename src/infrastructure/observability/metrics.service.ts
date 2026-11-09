import { Injectable } from "@nestjs/common";

@Injectable()
export class MetricsService {
  private readonly statusCounts = new Map<string, number>();
  private duplicates = 0;
  private retries = 0;
  private dlq = 0;
  private reconciliationMismatches = 0;
  private outboxLagMs = 0;
  private readonly latencies: number[] = [];

  incrementStatus(status: string): void {
    this.statusCounts.set(status, (this.statusCounts.get(status) ?? 0) + 1);
  }

  incrementDuplicates(): void {
    this.duplicates += 1;
  }

  incrementRetries(): void {
    this.retries += 1;
  }

  incrementDlq(): void {
    this.dlq += 1;
  }

  incrementReconciliationMismatch(): void {
    this.reconciliationMismatches += 1;
  }

  setOutboxLag(ms: number): void {
    this.outboxLagMs = ms;
  }

  recordProcessing(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 5000) {
      this.latencies.shift();
    }
  }

  snapshot() {
    const sorted = [...this.latencies].sort((a, b) => a - b);
    return {
      transactionsByStatus: Object.fromEntries(this.statusCounts),
      duplicatesDetected: this.duplicates,
      retries: this.retries,
      dlqMessages: this.dlq,
      lockConflicts: 0, // SELECT FOR UPDATE waits; it does not abort
      reconciliationMismatches: this.reconciliationMismatches,
      outboxLagMs: this.outboxLagMs,
      processingLatencyMs: {
        count: sorted.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        p99: percentile(sorted, 0.99),
      },
    };
  }
}

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * p));
  return sorted[index] ?? 0;
}
