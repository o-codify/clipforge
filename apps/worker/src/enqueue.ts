/**
 * Постановка заданий из командной строки.
 *
 * Временная мера на время переноса: когда появится бэкенд, задания будут
 * ставиться из него, а это останется как отладочный вход.
 *
 *     pnpm --filter @clipforge/worker enqueue index sany_jeweler
 *     pnpm --filter @clipforge/worker enqueue pipeline v2859643784 --count 6
 */
import PgBoss from "pg-boss";

import { createDatabase, enqueueUnique } from "@clipforge/db";
import { PAYLOADS, QUEUES, singletonKey, type QueueName } from "@clipforge/jobs";

import { loadConfig } from "./context.js";

const USAGE = `
использование:
  enqueue index <канал> [--limit N] [--chapters]   обойти архивы канала
  enqueue fetch <vod> [--audio-only]               скачать исходники
  enqueue transcribe <vod> [--force]               распознать речь
  enqueue analyze <vod> [--force]                  посчитать сигналы
  enqueue facecam <vod> [--force]                  найти вебку
  enqueue render <vod> [--count N]                 нарезать клипы
  enqueue pipeline <vod> [--count N]               всё подряд одной цепочкой
`.trim();

const flag = (args: string[], name: string): boolean => args.includes(`--${name}`);
const value = (args: string[], name: string): string | undefined => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 ? args[at + 1] : undefined;
};

async function main(): Promise<void> {
  const [command, target, ...rest] = process.argv.slice(2);
  if (!command || !target) {
    process.stdout.write(`${USAGE}\n`);
    process.exit(1);
  }

  const config = loadConfig();
  const db = createDatabase({url:config.databaseUrl});
  const boss = new PgBoss({ connectionString: config.databaseUrl, schema: "jobs" });
  await boss.start();

  const send = async (queue: QueueName, payload: unknown) => {
    await boss.createQueue(queue);
    const parsed = PAYLOADS[queue].parse(payload);
    const id = await enqueueUnique(db, queue, singletonKey(queue, parsed as never), () => boss.send(queue, parsed as object, {
      // Дубль того же задания по тому же эфиру не нужен: без этого
      // двойной вызов ставит вторую загрузку в ту же папку.
      singletonKey: singletonKey(queue, parsed as never),
      retryLimit: 2, retryDelay: 60, retryBackoff: true,
      expireInSeconds: 6 * 3600,
    }));
    process.stdout.write(
      id ? `поставлено ${queue} ${JSON.stringify(parsed)}\n`
         : `уже в очереди: ${queue} ${JSON.stringify(parsed)}\n`,
    );
  };

  const count = value(rest, "count") ? Number(value(rest, "count")) : undefined;

  switch (command) {
    case "index":
      await send(QUEUES.indexChannel, {
        login: target,
        limit: Number(value(rest, "limit") ?? 20),
        withChapters: flag(rest, "chapters"),
      });
      break;
    case "fetch":
      await send(QUEUES.fetchVod, { vodId: target, audioOnly: flag(rest, "audio-only") });
      break;
    case "transcribe":
      await send(QUEUES.transcribeVod, { vodId: target, force: flag(rest, "force") });
      break;
    case "analyze":
      await send(QUEUES.analyzeVod, { vodId: target, force: flag(rest, "force") });
      break;
    case "facecam":
      await send(QUEUES.facecamVod, { vodId: target, force: flag(rest, "force") });
      break;
    case "render":
      await send(QUEUES.renderRun, { vodId: target, ...(count ? { count } : {}) });
      break;
    case "pipeline":
      // Одно задание, а не пять: очереди heavy.* независимы, и пять
      // отдельных заданий стартуют одновременно. Порядок шагов выражен
      // внутри обработчика.
      await send(QUEUES.pipeline, {
        vodId: target, reuse: !flag(rest, "force"),
        ...(count ? { count } : {}),
      });
      break;
    default:
      process.stdout.write(`${USAGE}\n`);
      await boss.stop();
      process.exit(1);
  }

  await boss.stop({ graceful: true, timeout: 5000 });
  await db.close();
}

main().catch((error) => {
  process.stderr.write(`${String(error)}\n`);
  process.exit(1);
});
