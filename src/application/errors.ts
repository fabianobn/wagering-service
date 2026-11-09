import type { FailureCode } from "../domain/wager-transaction/failure-code";

export class ApplicationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class WalletNotFoundError extends ApplicationError {}

export class TransactionNotFoundError extends ApplicationError {}

export class DuplicateWalletError extends ApplicationError {}

export class IdempotencyConflictError extends ApplicationError {
  constructor(public readonly failureCode: FailureCode) {
    super("Idempotency key reused with a different payload");
  }
}

export class InvalidRequestError extends ApplicationError {}

export class TransientInfrastructureError extends ApplicationError {}
