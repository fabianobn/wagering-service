import { Body, Controller, Get, Headers, Param, Post, Req, Res, UseGuards } from "@nestjs/common";
import type { Request, Response } from "express";
import { InvalidRequestError } from "../../application/errors";
import { GetTransactionUseCase } from "../../application/query.use-cases";
import { SubmitWagerTransactionUseCase } from "../../application/submit-wager-transaction.use-case";
import { WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction/wager-transaction";
import { NoOpAuthGuard } from "../../infrastructure/auth/noop-auth.guard";
import { UuidV7Generator } from "../../infrastructure/id-generator";
import { correlationId, parseMoney, requiredString } from "./wallets.controller";

@Controller()
@UseGuards(NoOpAuthGuard)
export class WageringController {
  constructor(
    private readonly submit: SubmitWagerTransactionUseCase,
    private readonly getTransaction: GetTransactionUseCase,
    private readonly ids: UuidV7Generator,
  ) {}

  @Post("/wagering/transactions")
  async create(
    @Body() body: Record<string, unknown>,
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
  ) {
    if (!idempotencyKey) {
      throw new InvalidRequestError("Idempotency-Key header is required");
    }
    const kind = requiredString(body.kind, "kind") as WagerTransactionKind;
    if (!Object.values(WagerTransactionKind).includes(kind)) {
      throw new InvalidRequestError("Invalid kind");
    }
    if (kind === WagerTransactionKind.Opening) {
      throw new InvalidRequestError("OPENING cannot be submitted via API or queue");
    }
    const result = await this.submit.execute({
      providerId: requiredString(body.providerId, "providerId"),
      externalTransactionId: requiredString(body.externalTransactionId, "externalTransactionId"),
      idempotencyKey,
      playerId: requiredString(body.playerId, "playerId"),
      walletId: requiredString(body.walletId, "walletId"),
      roundId: requiredString(body.roundId, "roundId"),
      gameId: requiredString(body.gameId, "gameId"),
      kind,
      money: parseMoney(body.money as Record<string, unknown> | undefined, "money"),
      referenceExternalTransactionId: optionalString(body.referenceExternalTransactionId),
      correlationId: correlationId(req, this.ids),
    });
    const status = httpStatusFor(result.status);
    res.status(status).json(result);
  }

  @Get("/wagering/transactions/:transactionId")
  async byId(@Param("transactionId") transactionId: string) {
    return this.getTransaction.byId(transactionId);
  }

  @Get("/providers/:providerId/wagering/transactions/:externalTransactionId")
  async byProvider(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return this.getTransaction.byProvider(providerId, externalTransactionId);
  }
}

function optionalString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) {
    return undefined;
  }
  return value;
}

function httpStatusFor(status: WagerTransactionStatus): number {
  switch (status) {
    case WagerTransactionStatus.Processed:
      return 200;
    case WagerTransactionStatus.PendingReference:
      return 202;
    case WagerTransactionStatus.Rejected:
      return 422;
    case WagerTransactionStatus.Failed:
      return 503;
    default:
      return 200;
  }
}
