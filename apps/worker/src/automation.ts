/** Автономный поиск каналов, индексация, обработка с бюджетом ресурсов и сбор статистики. */
import { enqueueUnique, runtimeValue, youtubeDestination } from "@clipforge/db";
import { pruneSources } from "./storage.js";
import { collectMetrics } from "./metrics.js";
import { schedulePipelines } from "./autopilot.js";
import type PgBoss from "pg-boss";
import { and, eq, isNull, sql } from "drizzle-orm";

import { randomUUID } from "node:crypto";

import { clips, discovery, platformAccounts, publications, streamers } from "@clipforge/db";
import { PAYLOADS, QUEUES, singletonKey, type QueueName } from "@clipforge/jobs";
import { scoreCandidate } from "@clipforge/twitch";

import { numberEnv } from "./context.js";
import type { Context } from "./context.js";

export interface AutomationOptions {
  /** Как часто обходить активных стримеров, минуты. */
  everyMinutes: number;
  /** Как часто искать новых стримеров в каталоге, минуты. */
  discoveryMinutes: number;
  /** Список эфиров устарел, если обновлялся раньше, чем эти минуты назад. */
  indexStaleMinutes: number;
  /** С какой оценки кандидат подключается сам. */
  autoAddScore: number;
  /** Сколько стримеров можно подключить за один проход каталога. */
  autoAddLimit: number;
  language: string;
  /** Внутренний дневной бюджет публикаций; квоты API проверяются отдельно. */
  publishDailyLimit: number;
}

export const automationDefaults = (env: NodeJS.ProcessEnv): AutomationOptions => ({
  everyMinutes: numberEnv(env, "AUTOMATION_MINUTES", 10, 1, 1440),
  discoveryMinutes: numberEnv(env, "DISCOVERY_MINUTES", 30, 5, 1440),
  indexStaleMinutes: numberEnv(env, "INDEX_STALE_MINUTES", 30, 5, 10080),
  autoAddScore: numberEnv(env, "AUTO_ADD_SCORE", 0.55, 0, 1),
  autoAddLimit: numberEnv(env, "AUTO_ADD_LIMIT", 1, 0, 20),
  language: (env.LANGUAGES ?? "ru").split(",")[0]?.trim() || "ru",
  publishDailyLimit: numberEnv(env, "YOUTUBE_DAILY_LIMIT", 100, 0, 100),
});

export function startAutomation(
  boss: PgBoss,
  ctx: Context,
  options: AutomationOptions,
): () => void {
  const send = async <Q extends QueueName>(queue: Q, payload: unknown) => {
    const parsed = PAYLOADS[queue].parse(payload);
    // Дубли отбрасываются по singletonKey: планировщик может дёрнуться
    // раньше, чем доработал прошлый обход того же канала.
    const key = singletonKey(queue, parsed as never);
    await enqueueUnique(ctx.db, queue, key, () => boss.send(queue, parsed as object, {
      singletonKey: singletonKey(queue, parsed as never),
      retryLimit: 2, retryDelay: 60, retryBackoff: true,
      expireInSeconds: 6 * 3600,
    }));
  };

  // --- регулярный обход активных каналов -----------------------------

  const sweep = async (): Promise<void> => {
    const active = await ctx.db
      .select()
      .from(streamers)
      .where(eq(streamers.state, "active"));
    if (active.length === 0) return;

    // Кто сейчас в эфире - одним запросом на сотню каналов.
    if (ctx.twitch) {
      try {
        const live = new Map<string, { game: string; viewers: number }>();
        for (let i = 0; i < active.length; i += 100) {
          const batch = active.slice(i, i + 100).map((s) => s.login);
          for (const stream of await ctx.twitch.streams({ logins: batch })) {
            live.set(stream.userLogin, {
              game: stream.gameName,
              viewers: stream.viewerCount,
            });
          }
        }
        await ctx.db
          .update(streamers)
          .set({ live: false, liveViewers: null, checkedAt: new Date() })
          .where(eq(streamers.state, "active"));
        for (const [login, info] of live) {
          await ctx.db
            .update(streamers)
            .set({
              live: true, liveGame: info.game,
              liveViewers: info.viewers, lastGame: info.game,
            })
            .where(eq(streamers.login, login));
        }
      } catch (error) {
        ctx.log(`автоматика: статус эфиров не получен (${String(error)})`);
      }
    }

    // Свежие эфиры. Обход заводит их в каталоге со статусом known -
    // дальше они видны в «ждут одобрения», и нарезка ждёт кнопки.
    const staleBefore = Date.now() - options.indexStaleMinutes * 60_000;
    for (const streamer of active) {
      const indexedAt = streamer.indexedAt?.getTime() ?? 0;
      if (indexedAt < staleBefore) {
        await send(QUEUES.indexChannel, {
          login: streamer.login,
          limit: 10,
          withChapters: true,
        });
      }
    }
  };

  // --- поиск новых стримеров ------------------------------------------

  const discover = async (): Promise<void> => {
    if (!ctx.twitch) return;

    // Где искать: игры, в которые активные стримеры играют больше всего.
    // Площадка расширяется внутри своей ниши, а не наугад по каталогу.
    const niches = await ctx.db.execute<{ title: string }>(sql`
      select g.title, sum(sg.seconds) as total
      from streamer_games sg
        join streamers st on st.login = sg.streamer and st.state = 'active'
        join games g on g.slug = sg.game
      group by g.title
      order by total desc
      limit 3
    `);
    // Bootstrap from the current Twitch catalog, and explore beyond existing niches.
    const top = await ctx.twitch.topGames(8);
    for (const game of top) if (!niches.some(n => n.title === game.name)) niches.push({ title: game.name });

    const connected = new Set(
      (await ctx.db.select({ login: streamers.login }).from(streamers)).map(
        (row) => row.login,
      ),
    );

    let added = 0;
    let inspected = 0;
    for (const niche of niches) {
      let liveStreams;
      try {
        const [game] = await ctx.twitch.games([niche.title]);
        if (!game) continue;
        liveStreams = await ctx.twitch.streams({
          gameId: game.id,
          language: options.language,
          first: 10,
        });
      } catch (error) {
        ctx.log(`автоматика: каталог ${niche.title} не получен (${String(error)})`);
        continue;
      }

      for (const stream of liveStreams) {
        if (connected.has(stream.userLogin)) continue;
        inspected++;
        const [ignored] = await ctx.db.select().from(discovery).where(eq(discovery.login, stream.userLogin));
        if (ignored?.status === "ignored") continue;

        let followers = 0;
        let archives: { viewCount: number }[] = [];
        try {
          followers = await ctx.twitch.followerCount(stream.userId).catch(() => 0);
          archives = await ctx.twitch.archives(stream.userId, 3);
        } catch {
          continue;
        }

        const archiveViews = archives.length
          ? Math.round(
              archives.reduce((sum, a) => sum + a.viewCount, 0) / archives.length,
            )
          : 0;
        const { score, reason } = scoreCandidate(
          {
            viewers: stream.viewerCount,
            followers,
            language: stream.language,
            archiveViews,
            archives: archives.length,
          },
          { languages: [options.language] },
        );

        await ctx.db
          .insert(discovery)
          .values({
            login: stream.userLogin, displayName: stream.userName,
            game: stream.gameName, language: stream.language,
            viewers: stream.viewerCount, followers, score, reason,
            checkedAt: new Date(),
          })
          .onConflictDoUpdate({
            target: discovery.login,
            set: {
              displayName: stream.userName, game: stream.gameName,
              viewers: stream.viewerCount, followers, score, reason,
              checkedAt: new Date(),
            },
          });

        // Порог высокий и лимит на проход маленький: подключение - это
        // обходы, аватарки и будущие предложения нарезки, и лавина
        // новых каналов за один проход никому не нужна.
        if (score >= options.autoAddScore && added < options.autoAddLimit) {
          await ctx.db
            .insert(streamers)
            .values({
              login: stream.userLogin,
              displayName: stream.userName,
              state: "active",
              source: "discovery", followers, language: stream.language,
              liveViewers: stream.viewerCount, lastGame: stream.gameName,
            })
            .onConflictDoNothing();
          await ctx.db
            .update(discovery)
            .set({ status: "added" })
            .where(eq(discovery.login, stream.userLogin));
          await send(QUEUES.indexChannel, {
            login: stream.userLogin,
            limit: 10,
            withChapters: true,
          });
          connected.add(stream.userLogin);
          added += 1;
          ctx.log(
            `автоматика: подключён ${stream.userLogin} ` +
              `(оценка ${score.toFixed(2)}: ${reason})`,
          );
        }
      }
    }
    await runtimeValue(ctx.db, "discovery", { state: "ok", inspected, added, categories: niches.length });
  };

  // --- автопубликация --------------------------------------------------

  /**
   * Разослать лучшие неопубликованные клипы стримеров, у которых
   * включена автопубликация.
   *
   * Сбойные публикации автоматика не перезапускает: без разбора причины
   * повтор каждые десять минут просто сжигал бы квоту. Для повтора есть
   * кнопка в окне клипа.
   */
  const publishSweep = async (): Promise<void> => {
    const [mode] = await ctx.db.execute<{value:{developmentMode?:boolean}}>(sql`select value from platform_runtime where key='settings'`);
    if (mode?.value.developmentMode) return;
    if (!ctx.youtube || process.env.AUTO_PUBLISH_ENABLED !== "true") return;

    // Бюджет считается скользящими сутками по всем попыткам, включая
    // сбойные: квота площадки тратится и на них.
    const [used] = await ctx.db.execute<{ n: number }>(sql`
      select count(*)::int as n from publications
      where platform = 'youtube' and created_at > now() - interval '24 hours'
    `);
    const budget = options.publishDailyLimit - (used?.n ?? 0);
    if (budget <= 0) return;

    const fresh = await ctx.db.execute<{ id: string; streamer:string }>(sql`
      select c.id,c.streamer
      from clips c
        join streamers s on s.login = c.streamer
        join runs r on r.id = c.run_id
      where s.auto_publish
        and c.state = 'ready'
        and c.media_released_at is null
        and coalesce(r.settings #>> array['renderedClips',c.id,'protection','autoVerifiedAt'], r.settings #>> array['renderedClips',c.id,'protection','reviewedAt'],r.settings #>> array['renderedClips',c.id,'protection','disabledAt']) is not null
        and c.archived_at is null
        and not exists (
          select 1 from publications p
          where p.clip_id = c.id and p.platform = 'youtube'
        )
      order by c.score desc nulls last, c.created_at desc
      limit ${budget}
    `);
    if (fresh.length === 0) return;

    for (const clip of fresh) {
      const {account}=await youtubeDestination(ctx.db,clip.streamer);
      if(!account)continue;
      const publicationId = randomUUID();
      const inserted=await ctx.db.transaction(async tx=>{
      const [media]=await tx.select({releasedAt:clips.mediaReleasedAt}).from(clips).where(eq(clips.id,clip.id)).for('update');
      if(!media||media.releasedAt)return false;
      const [active]=await tx.select({id:platformAccounts.id}).from(platformAccounts)
        .where(and(eq(platformAccounts.id,account.id),isNull(platformAccounts.disconnectRequestedAt))).for("update");
      if(!active)return false;
      await tx.insert(publications).values({
        id: publicationId,
        clipId: clip.id,
        platform: "youtube",
        account: account.externalId,
        status: "queued",
      });
      return true;
      });
      if(!inserted)break;
      await send(QUEUES.publishClip, { publicationId });
    }
    ctx.log(
      `автопубликация: поставлено ${fresh.length}, ` +
        `осталось на сутки ${budget - fresh.length}`,
    );
  };

  const running = new Set<string>();
  let stopping = false;
  const guard = (name: string, task: () => Promise<unknown>) => async () => {
    if (stopping || ctx.worker?.draining || running.has(name) || name === "поиск" && !ctx.twitch) return;
    running.add(name);
    let runId: string | null = null;
    const kind = name === "поиск" ? "discovery" : name === "статистика" ? "metrics" : "sweep";
    try {
      const [setting] = await ctx.db.execute<{value: {paused?: boolean}}>(sql`select value from platform_runtime where key = 'settings'`);
      // Access revocation and retention keep running while scheduling is paused.
      if (name === "статистика" || !setting?.value.paused) {
        runId = randomUUID();
        await ctx.db.execute(sql`insert into automation_runs(id,name,state) values (${runId}::uuid,${'platform.'+kind},'active')`);
        await ctx.worker?.claim(runId);
        await ctx.worker?.stage(runId,name==='статистика'?'Обновление статистики YouTube':name==='поиск'?'Поиск стримеров':'Проверка каналов и планирование');
        await task();
        const [result] = await ctx.db.execute<{value:{state?:string}}>(sql`select value from platform_runtime where key=${kind==='sweep'?'scheduler':kind}
          and updated_at >= (select started_at from automation_runs where id=${runId}::uuid)`);
        await ctx.db.execute(sql`update automation_runs set state=${result?.value.state==='error'?'failed':'completed'},completed_at=now(),output=${JSON.stringify(result?.value??{})}::jsonb where id=${runId}::uuid`);
      }
    } catch (error) {
      ctx.log(`автоматика (${name}): ${String(error)}`);
      await runtimeValue(ctx.db, name === "поиск" ? "discovery" : name === "статистика" ? "metrics" : "scheduler", {state:"error", reason:String(error)}).catch(() => {});
      if (runId) await ctx.db.execute(sql`update automation_runs set state='failed',completed_at=now() where id=${runId}::uuid`).catch(()=>{});
    } finally {
      if(runId)await ctx.worker?.finish(runId).catch(()=>{});
      running.delete(name);
      // Only recent execution details are retained; the UI displays a single recurring task.
      await ctx.db.execute(sql`delete from automation_runs where started_at < now()-interval '14 days'`).catch(()=>{});
    }
  };

  // Первый обход сразу: после запуска не должно быть получаса тишины.
  const sweepTimer = setInterval(
    guard("обход", async () => {
      await sweep();
      if (ctx.config.role !== "control") await pruneSources(ctx);
      await schedulePipelines(boss, ctx);
      await publishSweep();
    }),
    options.everyMinutes * 60_000,
  );
  const metricsTimer = setInterval(guard("статистика", () => collectMetrics(ctx)), 60 * 60_000);
  void guard("статистика", () => collectMetrics(ctx))();
  const discoveryTimer = setInterval(
    guard("поиск", discover),
    options.discoveryMinutes * 60_000,
  );
  guard("обход", async () => {
    await sweep();
    if (ctx.config.role !== "control") await pruneSources(ctx);
    await schedulePipelines(boss, ctx);
    await publishSweep();
  })();
  void guard("поиск", discover)();

  ctx.log(
    `автоматика: обход каждые ${options.everyMinutes} мин, ` +
      `поиск каждые ${options.discoveryMinutes} мин, ` +
      `автоподключение от ${options.autoAddScore}` +
      (ctx.twitch ? "" : " (без ключей Twitch - только обход каналов)"),
  );

  return () => {
    stopping = true;
    clearInterval(metricsTimer);
    clearInterval(sweepTimer);
    clearInterval(discoveryTimer);
  };
}
