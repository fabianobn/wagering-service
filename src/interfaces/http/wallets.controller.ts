import { Body, Controller, Get, Param, Post, Query, Req, UseGuards } from "@nestjs/common";
import type { Request } from "express";
import { CreateWalletUseCase } from "../../application/create-wallet.use-case";
import { InvalidRequestError } from "../../application/errors";
import { GetLedgerUseCase, GetWalletUseCase, ReconcileWalletUseCase } from "../../application/query.use-cases";
import { Money } from "../../domain/money/money";
import { NoOpAuthGuard } from "../../infrastructure/auth/noop-auth.guard";
import { UuidV7Generator } from "../../infrastructure/id-generator";

@Controller()
@UseGuards(NoOpAuthGuard)
export class WalletsController {
  constructor(
    private readonly createWallet: CreateWalletUseCase,
    private readonly getWallet: GetWalletUseCase,
    private readonly getLedger: GetLedgerUseCase,
    private readonly reconcile: ReconcileWalletUseCase,
    private readonly ids: UuidV7Generator,
  ) {}

  @Post("/wallets")
  async create(@Body() body: Record<string, unknown>, @Req() req: Request) {
    const playerId = requiredString(body.playerId, "playerId");
    const initialBalance = parseMoney((body.initialBalance as Record<string, unknown> | undefined) ?? undefined, "initialBalance");
    return this.createWallet.execute({
      playerId,
      initialBalance,
      correlationId: correlationId(req, this.ids),
    });
  }

  @Get("/wallets/:walletId")
  async show(@Param("walletId") walletId: string) {
    return this.getWallet.execute(walletId);
  }

  @Get("/wallets/:walletId/ledger")
  async ledger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    const parsedLimit = Math.min(100, Math.max(1, Number(limit ?? 50) || 50));
    return this.getLedger.execute(walletId, parsedLimit, cursor);
  }

  @Post("/wallets/:walletId/reconciliation")
  async reconciliation(@Param("walletId") walletId: string) {
    return this.reconcile.execute(walletId);
  }
}

export function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new InvalidRequestError(`${field} is required`);
  }
  return value;
}

export function parseMoney(value: Record<string, unknown> | undefined, field: string) {
  if (!value || typeof value.amount !== "string" || typeof value.currency !== "string") {
    throw new InvalidRequestError(`${field} must be { amount: string, currency: string }`);
  }
  return Money.from({ amount: value.amount, currency: value.currency }).toJSON();
}

export function correlationId(req: Request, ids: UuidV7Generator): string {
  const header = req.header("x-correlation-id");
  return header && header.length > 0 ? header : ids.uuid();
}
