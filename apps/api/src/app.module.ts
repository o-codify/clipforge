import { Inject, Module, type OnApplicationBootstrap, type OnApplicationShutdown } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";

import { createDatabase, type Database } from "@clipforge/db";
import { TwitchClient } from "@clipforge/twitch";

import { TwitchController } from "./auth/twitch.controller.js";
import { OperationsController } from "./operations.controller.js";
import { ShortsController } from './shorts.controller.js';
import { PublicationProcessController } from './publication-process.controller.js';
import {WorkersController} from './workers.controller.js';
import {WorkerGatewayService} from './worker-gateway.service.js';
import {WorkerGatewayController} from './worker-gateway.controller.js';
import { HealthController } from "./health.controller.js";
import { AuthController } from "./auth/auth.controller.js";
import { AuthGuard } from "./auth/auth.guard.js";
import { AuthService } from "./auth/auth.service.js";
import { CandidatesService } from "./catalog/candidates.service.js";
import { CatalogController } from "./catalog/catalog.controller.js";
import { CatalogService } from "./catalog/catalog.service.js";
import { CONFIG, DATABASE, TWITCH, loadConfig, type ApiConfig } from "./config.js";
import { DiscoveryController } from "./discovery/discovery.controller.js";
import { DiscoveryService } from "./discovery/discovery.service.js";
import { JobsController } from "./jobs/jobs.controller.js";
import { JobsService } from "./jobs/jobs.service.js";
import { MediaController } from "./media/media.controller.js";
import { PlatformsController } from "./platforms/platforms.controller.js";
import { PlatformsService } from "./platforms/platforms.service.js";
import { WebAssetsController } from "./web-assets.controller.js";

@Module({
  controllers: [
    WorkerGatewayController,HealthController, TwitchController, OperationsController, ShortsController, PublicationProcessController, WorkersController, AuthController, CatalogController, JobsController,
    MediaController, DiscoveryController, PlatformsController, WebAssetsController,
  ],
  providers: [
    { provide: CONFIG, useFactory: loadConfig },
    {
      provide: DATABASE,
      inject: [CONFIG],
      useFactory: (config: ApiConfig) => createDatabase({ url: config.databaseUrl }),
    },
    {
      // Ключей может не быть - тогда площадка работает, но поиск
      // стримеров отвечает понятной ошибкой, а не падает при старте.
      provide: TWITCH,
      useFactory: () => TwitchClient.fromEnv(),
    },
    {
      provide: AuthService,
      inject: [DATABASE],
      useFactory: (db: Database) => new AuthService(db),
    },
    CatalogService,
    CandidatesService,
    JobsService,WorkerGatewayService,
    DiscoveryService,
    PlatformsService,
    // Защита включена для всего сразу: маршрут открыт, только если
    // помечен явно. Закрывать по списку - значит однажды забыть.
    { provide: APP_GUARD, useClass: AuthGuard },
  ],
})
export class AppModule implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(private readonly auth: AuthService, @Inject(DATABASE) private readonly db: Database) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.auth.bootstrap();
  }

  async onApplicationShutdown(): Promise<void> { await this.db.close(); }
}
