import { statfs } from "node:fs/promises";
import { sql } from "drizzle-orm";
import type PgBoss from "pg-boss";
import { enqueueUnique, runtimeValue, youtubeDerivedMetricsAllowed } from "@clipforge/db";
import { QUEUES, singletonKey } from "@clipforge/jobs";
import { numberEnv } from "./context.js";
import type { Context } from "./context.js";

export async function schedulePipelines(boss: PgBoss, ctx: Context): Promise<void> {
  const [setting] = await ctx.db.execute<{ value: { paused?: boolean; developmentMode?: boolean } }>(sql`select value from platform_runtime where key = 'settings'`);
  if (setting?.value.developmentMode) {
    await runtimeValue(ctx.db, "scheduler", {state:"waiting", reason:"Режим разработки: автоматическое создание клипов выключено. Ручная проверка — один клип за запуск."});
    return;
  }
  const minimumGb = numberEnv(process.env,"MIN_FREE_GB",20,5,10000);
  let freeGb: number;
  const fleet=await ctx.db.execute<{resources:{freeGb?:number};queues:string[]}>(sql`select resources,queues from worker_instances
    where role in ('media','all') and state='online' and not draining and heartbeat_at>now()-interval '40 seconds'
      and queues ? ${QUEUES.pipeline} and coalesce(resources->>'paused','false')<>'true'`);
  const slots=Math.max(1,fleet.length);
  if (ctx.config.role === "control") {
    const [worker] = await ctx.db.execute<{value:{state?:string;freeGb?:number};fresh:boolean}>(sql`
      select value, updated_at > now() - interval '40 seconds' as fresh from platform_runtime where key='worker'`);
    if (!fleet.length&&(!worker?.fresh || worker.value.state !== "online" || !Number.isFinite(worker.value.freeGb))) {
      await runtimeValue(ctx.db,"scheduler",{state:"waiting",reason:"ПК обработки не подключён. Сайт работает; очередь продолжится после подключения."});
      return;
    }
    freeGb = fleet.length?Math.max(...fleet.map(w=>w.resources.freeGb??0)):worker!.value.freeGb!;
  } else {
    const disks = await Promise.all([statfs(ctx.config.data), statfs(ctx.config.out)]);
    freeGb = Math.min(...disks.map(d => d.bavail * d.bsize)) / 1024 ** 3;
  }
  const [busy] = await ctx.db.execute<{ n: number }>(sql`select count(*)::int n from jobs.job where name like 'heavy.%' and state in ('created','active','retry')`);
  const dailyLimit = Math.floor(numberEnv(process.env,"AUTO_VODS_PER_DAY",3,1,100));
  const [used] = await ctx.db.execute<{ n: number }>(sql`select count(*)::int n from pipeline_attempts where updated_at > now() - interval '24 hours'`);
  const reason = setting?.value.paused ? "Автоматика приостановлена администратором"
    : freeGb < minimumGb ? `Мало места: ${freeGb.toFixed(1)} ГБ, резерв ${minimumGb} ГБ`
    : (busy?.n ?? 0) >= slots ? "Все воркеры обработки заняты"
    : (used?.n ?? 0) >= dailyLimit ? "Достигнут дневной бюджет эфиров" : null;
  if (reason) {
    await runtimeValue(ctx.db, "scheduler", { state: "waiting", reason, freeGb, dailyLimit });
    return;
  }
  // Every fifth completed run explores an underserved channel; the rest exploit
  // audience signals and measured public-video performance (when available).
  const [total] = await ctx.db.execute<{ n: number }>(sql`select count(*)::int n from pipeline_attempts where state = 'completed'`);
  const explore = (total?.n ?? 0) % 5 === 4;
  const derivedMetrics=await youtubeDerivedMetricsAllowed(ctx.db);
  const candidates = await ctx.db.execute<{ id: string; streamer: string; score: number }>(sql`
    select v.id, v.streamer,
      (ln(1 + coalesce(s.live_viewers,0)) + 0.4 * ln(1 + coalesce(s.followers,0))
       + coalesce(d.score,0) * 5 + coalesce(performance.value,0))::float as score
    from vods v join streamers s on s.login = v.streamer
      left join discovery d on d.login = s.login
      left join pipeline_attempts a on a.vod_id = v.id
      ${derivedMetrics ? sql`left join lateral (select avg(ln(1 + greatest(m.views,0))) value from clips c
        join publications p on p.clip_id = c.id
        join lateral (select views from publication_metrics where publication_id = p.id
          and extended->>'privacy' = 'public' order by collected_at desc limit 1) m on true
        where c.streamer = s.login and c.archived_at is null) performance on true` : sql`left join lateral (select 0 as value) performance on true`}
    where s.state = 'active' and not s.live and v.state in ('known','ready','failed')
      and (v.published_at > now() - interval '14 days' or v.state = 'ready')
      and v.duration > 60 and v.duration <= ${numberEnv(process.env,"AUTO_MAX_VOD_HOURS",4,0.1,24) * 3600}
      and (a.vod_id is null or (a.state = 'failed' and a.attempts < 3 and a.updated_at < now() - interval '1 hour'))
      and (a.state = 'failed' or not exists (select 1 from clips c where c.vod_id = v.id and c.archived_at is null))
      and not exists(select 1 from jobs.job j where j.data->>'vodId'=v.id and j.state in ('created','active','retry'))
      and v.duration * 1.2 / 1024 < ${Math.max(0,freeGb-minimumGb)}
    order by ${explore ? sql`(select count(*) from runs r where r.streamer = s.login) asc,` : sql``}
      score desc, v.published_at desc nulls last limit ${Math.max(1,Math.min(slots-(busy?.n??0),dailyLimit-(used?.n??0)))}
  `);
  if (!candidates.length) {
    await runtimeValue(ctx.db, "scheduler", { state: "waiting", reason: "Нет подходящих необработанных эфиров; поиск продолжается", freeGb, dailyLimit });
    return;
  }
  for(const candidate of candidates){
  const payload = { vodId: candidate.id, count: ctx.config.clipsPerRun, reuse: true };
  const key = singletonKey(QUEUES.pipeline, payload);
  const id = await enqueueUnique(ctx.db, QUEUES.pipeline, key, () => boss.send(QUEUES.pipeline, payload,
    { singletonKey: key, retryLimit: 2, retryDelay: 120, retryBackoff: true, expireInSeconds: 6 * 3600 }));
  await runtimeValue(ctx.db, "scheduler", { state: "scheduled", vodId: candidate.id, streamer: candidate.streamer,
    score: candidate.score, explore, freeGb, dailyLimit, reason: explore ? "Эксперимент с менее обработанным каналом" : "Приоритет по аудитории и результатам публикаций", jobId: id });
  }
}
