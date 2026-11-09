import { Module } from "@nestjs/common";
import { APP_FILTER, APP_GUARD } from "@nestjs/core";
import { MikroOrmModule } from "@mikro-orm/nestjs";
import { CreateWalletUseCase } from "./application/create-wallet.use-case";
import { ProcessPendingReferencesUseCase } from "./application/process-pending-references.use-case";
import { PublishOutboxUseCase } from "./application/publish-outbox.use-case";
import {
  GetLedgerUseCase,
  GetTransactionUseCase,
  GetWalletUseCase,
  ReconcileWalletUseCase,
} from "./application/query.use-cases";
import { SubmitWagerTransactionUseCase } from "./application/submit-wager-transaction.use-case";
import { NoOpAuthGuard } from "./infrastructure/auth/noop-auth.guard";
import { NoOpProviderIdentity, ProviderIdentityPort } from "./infrastructure/auth/provider-identity.port";
import { SystemClock } from "./infrastructure/clock";
import { UuidV7Generator } from "./infrastructure/id-generator";
import { SqsConsumer } from "./infrastructure/messaging/sqs.consumer";
import { SqsService } from "./infrastructure/messaging/sqs.client";
import { SqsPublisher } from "./infrastructure/messaging/sqs.publisher";
import { AppLogger } from "./infrastructure/observability/logger";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { ormEntities } from "./infrastructure/persistence/orm-entities";
import { Sha256PayloadHasher } from "./infrastructure/payload-hasher";
import { BackgroundWorkers } from "./infrastructure/workers/workers";
import { DomainExceptionFilter } from "./interfaces/http/http-exception.filter";
import { HealthController } from "./interfaces/http/health.controller";
import { WageringController } from "./interfaces/http/wagering.controller";
import { WalletsController } from "./interfaces/http/wallets.controller";
import config from "../mikro-orm.config";

@Module({
  imports: [
    MikroOrmModule.forRoot({
      ...config,
      entities: ormEntities,
      registerRequestContext: true,
    }),
  ],
  controllers: [WalletsController, WageringController, HealthController],
  providers: [
    SystemClock,
    UuidV7Generator,
    Sha256PayloadHasher,
    AppLogger,
    MetricsService,
    CreateWalletUseCase,
    SubmitWagerTransactionUseCase,
    GetWalletUseCase,
    GetLedgerUseCase,
    GetTransactionUseCase,
    ReconcileWalletUseCase,
    ProcessPendingReferencesUseCase,
    PublishOutboxUseCase,
    SqsService,
    SqsPublisher,
    SqsConsumer,
    BackgroundWorkers,
    { provide: APP_GUARD, useClass: NoOpAuthGuard },
    { provide: APP_FILTER, useClass: DomainExceptionFilter },
    { provide: ProviderIdentityPort, useClass: NoOpProviderIdentity },
  ],
})
export class AppModule {}
