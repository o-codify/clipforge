/**
 * Запуск бэкенда.
 *
 * Fastify, а не express: он заметно быстрее на отдаче файлов, а клипы
 * здесь отдаются постоянно.
 */
import "reflect-metadata";

import cookie from "@fastify/cookie";
import { Logger } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { FastifyAdapter, type NestFastifyApplication } from "@nestjs/platform-fastify";

import { AppModule } from "./app.module.js";
import { loadConfig } from "./config.js";
import { ZodExceptionFilter } from "./zod.filter.js";

async function bootstrap(): Promise<void> {
  const config = loadConfig();
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ bodyLimit: 8 * 1024 * 1024 }),
    { logger: ["log", "warn", "error"] },
  );

  await app.register(cookie as never);
  app.enableShutdownHooks();
  app.useGlobalFilters(new ZodExceptionFilter());

  // Глобального ValidationPipe нет намеренно: он тянет class-validator, а
  // тела запросов разбираются схемами zod прямо в обработчиках - теми же,
  // что используют воркер и очередь. Двух систем проверки быть не должно.

  // Фронт живёт на своём порту в разработке; в бою он за тем же адресом.
  app.enableCors({
    origin: [`http://localhost:${process.env.WEB_PORT ?? 3000}`],
    credentials: true,
  });

  await app.listen(config.port, "0.0.0.0");
  new Logger("api").log(`бэкенд слушает http://127.0.0.1:${config.port}`);
}

bootstrap().catch((error) => {
  process.stderr.write(`бэкенд не запустился: ${String(error)}\n`);
  process.exit(1);
});
