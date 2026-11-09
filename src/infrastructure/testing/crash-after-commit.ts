export function crashAfterCommitIfMatch(idempotencyKey: string): void {
  const crashKey = process.env.FAULT_CRASH_AFTER_COMMIT_KEY;
  if (crashKey && crashKey === idempotencyKey) {
    process.exit(1);
  }
}
