/**
 * Воркер: берёт задания из очереди и выполняет их.
 *
 * Отдельный процесс, а не поток внутри API. Рендер и распознавание
 * занимают минуты и упираются в видеокарту; если они живут в том же
 * процессе, что и HTTP, то любая их заминка становится заминкой
 * интерфейса.
 *
 * Тяжёлая очередь обслуживается в один поток - задания всё равно
 * упираются в одну видеокарту и один диск. Лёгкая идёт параллельно,
 * чтобы запрос метаданных не стоял за часовой загрузкой.
 */
import PgBoss from "pg-boss";
import { writeFile, rename, rm, statfs } from "node:fs/promises";
import { sql } from "drizzle-orm";
import { upgradeRuntime, runtimeValue, withVodLock } from "@clipforge/db";

import { PAYLOADS, QUEUES, type QueueName } from "@clipforge/jobs";

import { automationDefaults, startAutomation } from "./automation.js";
import { createContext, type Context } from "./context.js";
import {
  analyzeVod, facecamVod, fetchVod, indexChannel, renderRun, runPipeline,
  transcribeVod, inspectAds, type JobReport,
} from "./handlers.js";
import { publishClip } from "./publish.js";
import { refreshYoutube } from './metrics.js';
import { cleanClip } from './clean-clip.js';
import { pruneSources } from "./storage.js";
import { servesQueue } from "./routing.js";
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './context.js';
import { resourceState, waitForResources } from '@clipforge/resources';

type Handler = (ctx: Context, payload: never, report: JobReport) => Promise<unknown>;

const HANDLERS: Record<string, Handler> = {
  [QUEUES.inspectAds]: inspectAds as Handler,
  [QUEUES.pipeline]: runPipeline as Handler,
  [QUEUES.preparePreview]: runPipeline as Handler,
  [QUEUES.indexChannel]: indexChannel as Handler,
  [QUEUES.fetchVod]: fetchVod as Handler,
  [QUEUES.transcribeVod]: transcribeVod as Handler,
  [QUEUES.analyzeVod]: analyzeVod as Handler,
  [QUEUES.facecamVod]: facecamVod as Handler,
  [QUEUES.renderRun]: renderRun as Handler,
  [QUEUES.renderVariant]: renderRun as Handler,
  [QUEUES.publishClip]: publishClip as Handler,
  [QUEUES.refreshYoutube]: refreshYoutube as Handler,
  [QUEUES.cleanClip]: cleanClip as Handler,
};

/**
 * Общий замок на тяжёлые задания.
 *
 * Префикс heavy. в имени очереди сам по себе ничего не гарантирует:
 * очереди разные, и pg-boss обслуживает каждую своим циклом. Замок
 * держит в процессе ровно одно тяжёлое задание - иначе распознавание и
 * рендер поделят видеопамять и замедлят друг друга.
 */
function createLane(): <T>(task: () => Promise<T>) => Promise<T> {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    const next = chain.then(task, task);
    // Сбой одного задания не должен рвать очередь следующих.
    chain = next.catch(() => undefined);
    return next;
  };
}

/**
 * Отпустить задания, зависшие в состоянии «выполняется».
 *
 * Воркер один, и если при старте в базе есть активные задания - значит,
 * прошлый процесс умер, не доделав их. Сами они не отвалятся: pg-boss
 * держит их активными до истечения срока, а это часы. В интерфейсе это
 * выглядит как вечно идущая работа, которая блокирует кнопку и врёт про
 * происходящее.
 */
async function releaseStaleJobs(boss: PgBoss, ctx: Context, queues: ReadonlySet<string>): Promise<void> {
  const active = await ctx.db.execute<{ id: string; name: string; data: { publicationId?: string } }>(
    sql`select id::text, name, data from jobs.job where state = 'active'`,
  );
  const stale = active.filter(job => queues.has(job.name));
  if (stale.length === 0) return;

  for (const job of stale) {
    if (job.name === QUEUES.publishClip && job.data.publicationId) {
      await ctx.db.execute(sql`update publications set status = 'failed',
        error = '[upload-uncertain] Процесс прервался во время загрузки. Проверьте канал перед повторной отправкой.'
        where id = ${job.data.publicationId} and status = 'uploading' and media_id is null
          and not exists(select 1 from youtube_upload_sessions s where s.publication_id=publications.id)`);
    }
    await boss.fail(job.name, job.id, {
      message: "воркер был перезапущен во время выполнения",
    });
  }
  ctx.log(`отпущено зависших заданий: ${stale.length}`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--check-runtime')) {
    if (!servesQueue('media', QUEUES.pipeline) || servesQueue('media', QUEUES.publishClip) || servesQueue('media', QUEUES.indexChannel)) throw new Error('Invalid media queue routing');
    if (!servesQueue('control', QUEUES.publishClip) || !servesQueue('control', QUEUES.indexChannel) || servesQueue('control', QUEUES.renderRun)) throw new Error('Invalid control queue routing');
    console.log('PASS: portable worker imports and role isolation');
    return;
  }
  // Local direct starts get the same governor as the packaged scheduled task.
  // The supervised child inherits MEDIA_RESOURCE_STATE, preventing recursion.
  if (process.platform === 'win32' && process.env.WORKER_ROLE !== 'control' && !process.env.MEDIA_RESOURCE_STATE) {
    const limiter = [join(REPO_ROOT,'scripts','run-media-limited.py'),join(REPO_ROOT,'run-media-limited.py')].find(existsSync);
    if (!limiter) throw new Error('Не найден контроллер ресурсов');
    const python = process.env.PYTHON_BIN || join(REPO_ROOT,'.venv','Scripts','python.exe');
    const child = spawn(python,[limiter,'--idle-seconds',process.env.MEDIA_IDLE_SECONDS || '0',
      '--cpu-percent',process.env.MEDIA_CPU_TARGET || '90','--memory-mb',process.env.MEDIA_MEMORY_MB || '0',
      '--state-file',join(REPO_ROOT,'data','media-resource-state.json'),'--',process.execPath,...process.execArgv,...process.argv.slice(1)],
      {cwd:REPO_ROOT,env:process.env,windowsHide:true,stdio:'inherit'});
    child.on('error',error=>{console.error(error);process.exit(1);});
    child.on('exit',code=>process.exit(code ?? 1));
    process.on('SIGINT',()=>child.kill());process.on('SIGTERM',()=>child.kill());
    return;
  }
  const ctx = createContext();
  const role = ctx.config.role;
  const requestedQueues=process.env.WORKER_QUEUES?.split(',').map(name=>name.trim()).filter(Boolean);
  if(requestedQueues?.some(name=>!HANDLERS[name]||!servesQueue(role,name as QueueName)))throw new Error('WORKER_QUEUES содержит недоступную для этой роли очередь');
  const handlers = Object.fromEntries(Object.entries(HANDLERS).filter(([queue]) => servesQueue(role, queue as QueueName)
    && (!requestedQueues || requestedQueues.includes(queue))));
  const selectedQueues=new Set(Object.keys(handlers));
  const runtimeKey = role === "control" ? "control" : "worker";
  // all needs both leases, so it cannot overlap a distributed installation.
  const lockKeys = role === "all" ? [740021, 740023] : [role === "control" ? 740021 : 740023];
  ctx.log(`воркер запускается: ${role}`);
  await upgradeRuntime(ctx.db);
  const lease = await ctx.db.sql.reserve();
  let leasePid = 0;
  const localHeartbeat = async (state: "online" | "standby") => {
    const file = process.env.WORKER_HEARTBEAT_FILE;
    if (!file) return;
    await writeFile(`${file}.tmp`, JSON.stringify({
      instance: process.env.RUNTIME_INSTANCE, pid: process.pid, state, at: Date.now(),
    }));
    await rename(`${file}.tmp`, file);
  };
  // During a deployment the previous container may still be draining jobs.
  // Wait for its lease instead of running a second scheduler or releasing its jobs.
  for (let attempt = 0; role === "control" || attempt < 60; attempt++) {
    const acquired: number[] = [];
    for (const key of lockKeys) {
      const [locked] = await lease`select pg_try_advisory_lock(${key}) as ok, pg_backend_pid() as pid`;
      if (!locked?.ok) break;
      acquired.push(key);
      if (acquired.length === lockKeys.length) leasePid = Number(locked.pid);
    }
    if (leasePid) break;
    for (const key of acquired) await lease`select pg_advisory_unlock(${key})`;
    if (attempt === 0) ctx.log("ожидание остановки предыдущего воркера");
    // A replacement can serve HTTP while the old controller drains. Do not
    // overwrite its shared heartbeat or touch its jobs before owning the lease.
    if (role === "control") await localHeartbeat("standby");
    await new Promise(r => setTimeout(r, 1000));
  }
  if (!leasePid) throw new Error("Другой воркер всё ещё работает");

  const boss = new PgBoss({
    connectionString: ctx.config.databaseUrl,
    // Свою схему: таблицы очереди не должны мешаться с доменными.
    schema: "jobs",
  });
  boss.on("error", (error) => ctx.log(`очередь: ${String(error)}`));

  await boss.start();

  for (const queue of selectedQueues) {
    await boss.createQueue(queue);
  }

  await releaseStaleJobs(boss, ctx,selectedQueues);

  const heavyLane = createLane();
  const activeHeavy = new Set<string>();
  let lastResourceBeat = Date.now();
  let beating = false;
  const heartbeat = async () => {
    if (beating) return;
    beating = true;
    try {
      const [connection] = await lease`select pg_backend_pid() as pid`;
      if (Number(connection?.pid) !== leasePid) throw new Error("Соединение с блокировкой воркера потеряно");
      let freeGb: number | undefined;
      if (role !== "control") {
        const disks = await Promise.all([statfs(ctx.config.data), statfs(ctx.config.out)]);
        freeGb = Math.min(...disks.map(d => d.bavail * d.bsize)) / 1024 ** 3;
      }
      const resources = resourceState();
      const pausedSeconds = Math.min(30, (Date.now()-lastResourceBeat)/1000);
      lastResourceBeat = Date.now();
      // Queue expiry measures working time as well. Extend only jobs owned by
      // this worker; the PostgreSQL lease is still checked above on every beat.
      if (resources.paused) for (const id of activeHeavy) {
        await ctx.db.execute(sql`update jobs.job set expire_in = expire_in + make_interval(secs => ${pausedSeconds})
          where id = ${id}::uuid and state = 'active'`);
      }
      await runtimeValue(ctx.db, runtimeKey, { pid: process.pid, state: "online", role, freeGb, resources });
      await localHeartbeat("online");
      if (process.connected) process.send?.({type:'heartbeat'});
    } catch (error) {
      ctx.log(`потеря работоспособности воркера: ${String(error)}`);
      // A lost session lock must never leave a scheduler running without a lease.
      process.exit(1);
    } finally { beating = false; }
  };
  await heartbeat();
  const heartbeatTimer = setInterval(heartbeat, 10_000);

  for (const [queue, handler] of Object.entries(handlers)) {
    const schema = PAYLOADS[queue as QueueName];
    const heavy = queue.startsWith("heavy.");

    await boss.work(
      queue,
      // Тяжёлые - строго по одному. Лёгкие могут идти по несколько:
      // они ждут сеть, а не железо.
      { batchSize: 1, pollingIntervalSeconds: heavy ? 2 : 1 },
      async ([job]) => {
        if (!job) return;
        const started = Date.now();
        const report: JobReport = {
          id: job.id,
          log: (message) => {
            ctx.log(`  ${message}`);
            void ctx.db.execute(sql`insert into job_events(job_id, message) values (${job.id}::uuid, ${message.slice(0, 2000)})`).catch(e => ctx.log(String(e)));
          },
          cancelled: async () => {
            const [row] = await ctx.db.execute<{ state: string }>(
              sql`select state from jobs.job where id = ${job.id}::uuid`,
            );
            return row?.state === "cancelled";
          },
        };

        ctx.log(`▶ ${queue} ${JSON.stringify(job.data)}`);
        if (heavy) activeHeavy.add(job.id);
        try {
          const payload = schema.parse(job.data);
          const work = async () => {
            if (heavy) await waitForResources(report.cancelled);
            if (await report.cancelled()) return { cancelled: true };
            if (queue === QUEUES.pipeline) {
              const vodId = (payload as {vodId: string}).vodId;
              await ctx.db.execute(sql`insert into pipeline_attempts(vod_id, attempts, state) values (${vodId}, 1, 'running')
                on conflict(vod_id) do update set attempts = pipeline_attempts.attempts + 1, state = 'running', updated_at = now()`);
            }
            return "vodId" in payload
              ? withVodLock(ctx.db, payload.vodId, () => handler(ctx,payload as never,report))
              : handler(ctx, payload as never, report);
          };
          const result = heavy ? await heavyLane(work) : await work();
          if (queue === QUEUES.pipeline) await ctx.db.execute(sql`update pipeline_attempts set state = ${await report.cancelled() ? "cancelled" : "completed"}, error = null, updated_at = now() where vod_id = ${(payload as {vodId:string}).vodId}`);
          const took = ((Date.now() - started) / 1000).toFixed(1);
          report.log(`Результат: ${JSON.stringify(result ?? {})}`);
          return result;

        } catch (error) {
          report.log(`Сбой: ${String(error)}`);
          if (queue === QUEUES.pipeline) await ctx.db.execute(sql`update pipeline_attempts set state = 'failed', error = ${String(error).slice(0,1000)}, updated_at = now() where vod_id = ${(job.data as {vodId:string}).vodId}`);
          const took = ((Date.now() - started) / 1000).toFixed(1);
          ctx.log(`✘ ${queue} за ${took} с: ${String(error)}`);
          throw error;
        } finally {
          activeHeavy.delete(job.id);
        }
      },
    );
  }

  ctx.log(`очередей обслуживается: ${Object.keys(handlers).length}`);

  // Автоматика: активные каналы обходятся сами, кандидаты из каталога
  // подключаются сами, нарезку запускает планировщик.
  const stopAutomation = role === "media" || requestedQueues ? () => {} : startAutomation(boss, ctx, automationDefaults(process.env));
  let pruning = false;
  const pruneTimer = role === "media" && !requestedQueues ? setInterval(async () => {
    if (pruning) return;
    pruning = true;
    try { await pruneSources(ctx); } catch (error) { ctx.log(String(error)); }
    finally { pruning = false; }
  }, 10 * 60_000) : undefined;

  let stopping = false;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    ctx.log("остановка");
    stopAutomation();
    clearInterval(heartbeatTimer);
    clearInterval(pruneTimer);
    if (process.env.WORKER_HEARTBEAT_FILE) await rm(process.env.WORKER_HEARTBEAT_FILE, { force: true });
    await runtimeValue(ctx.db, runtimeKey, { state: "offline", role }).catch(() => {});
    await boss.stop({ graceful: true, timeout: 30_000 });
    for (const key of lockKeys) await lease`select pg_advisory_unlock(${key})`;
    lease.release();
    await ctx.close();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  // Windows has no POSIX SIGTERM delivery. The PC supervisor uses IPC so
  // pg-boss can finish its shutdown before Python/ffmpeg are cleaned up.
  process.on("message", message => { if (message === "shutdown") void stop(); });
}

main().catch((error) => {
  process.stderr.write(`воркер не запустился: ${String(error)}\n`);
  process.exit(1);
});
