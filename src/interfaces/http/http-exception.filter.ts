import {
  ArgumentsHost,
  Catch,
  ExceptionFilter,
  HttpStatus,
} from "@nestjs/common";
import type { Response } from "express";
import {
  DuplicateWalletError,
  IdempotencyConflictError,
  InvalidRequestError,
  TransactionNotFoundError,
  TransientInfrastructureError,
  WalletNotFoundError,
} from "../../application/errors";
import { InvalidMoneyError, InvalidTransactionStateError } from "../../domain/errors";

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    if (exception instanceof InvalidRequestError || exception instanceof InvalidMoneyError || exception instanceof InvalidTransactionStateError) {
      res.status(HttpStatus.BAD_REQUEST).json({ error: exception.message });
      return;
    }
    if (exception instanceof WalletNotFoundError || exception instanceof TransactionNotFoundError) {
      res.status(HttpStatus.NOT_FOUND).json({ error: exception.message });
      return;
    }
    if (exception instanceof DuplicateWalletError || exception instanceof IdempotencyConflictError) {
      res.status(HttpStatus.CONFLICT).json({
        error: exception.message,
        failureCode: exception instanceof IdempotencyConflictError ? exception.failureCode : "DUPLICATE_WALLET",
      });
      return;
    }
    if (exception instanceof TransientInfrastructureError) {
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({ error: exception.message });
      return;
    }
    const message = exception instanceof Error ? exception.message : "Internal error";
    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({ error: message });
  }
}
