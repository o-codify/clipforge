/**
 * Каталог площадки: игры, стримеры, эфиры, прогоны, клипы.
 *
 * Один слой поверх базы, из которого кормится всё меню интерфейса.
 * Главное здесь - **область видимости**: стример видит только себя, и
 * это решается тут, а не в каждом обработчике по отдельности. Забытая
 * проверка в одном маршруте означала бы, что чужой канал видно целиком.
 */
import { BadRequestException, Inject, Injectable, NotFoundException } from "@nestjs/common";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { PgColumn } from "drizzle-orm/pg-core";

import {
  clips, games, publications, runs, streamerGames, streamers, transcripts, vods,
  vodAudioSettings, vodAdSettings, type AudioMode, type Database,
} from "@clipforge/db";

import { DATABASE } from "../config.js";
import type { Viewer } from "../auth/auth.service.js";

/**
 * Ограничение выборки по тому, чей это взгляд.
 *
 * Колонка приходит из разных таблиц (vods, runs, clips), поэтому тип
 * общий - PgColumn, а не колонка конкретной таблицы.
 */
const only = (viewer: Viewer | null, column: PgColumn) =>
  viewer?.actingAs ? eq(column, viewer.actingAs) : undefined;

/** Internal rendering/storage details are only part of the administrator view. */
function visibleClip<T extends Record<string, unknown>>(viewer: Viewer | null, row: T) {
  if (viewer?.isAdmin) return row;
  const { file, mediaStorage, version, segmentKey, parts, score, archiveReason, ...visible } = row;
  return visible;
}

@Injectable()
export class CatalogService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  /**
   * Игры с числом стримеров и клипов.
   *
   * Считаются по streamer_games, а не по скачанному: список игр площадки
   * не должен ограничиваться тем, что уже обработано. Иначе в меню видна
   * ровно одна игра - та, до которой дошли руки.
   */
  async games(viewer: Viewer | null) {
    const scope = viewer?.actingAs;
    return this.db.execute(sql`
      with channel_counts as (
        select game, count(*)::int as streamers from streamer_games
        ${scope ? sql`where streamer = ${scope}` : sql``} group by game
      ), vod_counts as (
        select game, count(*)::int as vods, count(*) filter (where state='ready')::int as ready
        from vods ${scope ? sql`where streamer = ${scope}` : sql``} group by game
      ), clip_counts as (
        select game, count(*)::int as clips from clips where archived_at is null
        ${scope ? sql`and streamer = ${scope}` : sql``} group by game
      )
      select g.slug, g.title, g.box_art as "boxArt", g.state,
        coalesce(s.streamers,0)::int as streamers, coalesce(v.vods,0)::int as vods,
        coalesce(v.ready,0)::int as "readyVods", coalesce(c.clips,0)::int as clips
      from games g left join channel_counts s on s.game=g.slug
        left join vod_counts v on v.game=g.slug left join clip_counts c on c.game=g.slug
      ${scope ? sql`where s.game is not null or v.game is not null or c.game is not null` : sql``}
      order by clips desc, streamers desc, g.title
    `);
  }

  async streamers(viewer: Viewer | null, game?: string) {
    const scope = viewer?.actingAs;
    return this.db.execute(sql`
      with vod_counts as (
        select streamer, count(*)::int as vods, count(*) filter(where state='ready')::int as ready
        from vods ${scope ? sql`where streamer=${scope}` : sql``} group by streamer
      ), clip_counts as (
        select streamer, count(*)::int as clips from clips where archived_at is null
        ${scope ? sql`and streamer=${scope}` : sql``} group by streamer
      )
      select s.login, s.display_name as "displayName", s.avatar, s.state,
        s.live, s.live_game as "liveGame", s.live_viewers as "liveViewers", s.followers,
        s.last_game as "lastGame", s.indexed_at as "indexedAt",
        coalesce(v.vods,0)::int as vods, coalesce(v.ready,0)::int as "readyVods", coalesce(c.clips,0)::int as clips
      from streamers s left join vod_counts v on v.streamer=s.login
        left join clip_counts c on c.streamer=s.login
      where true ${scope ? sql`and s.login=${scope}` : sql``}
        ${game ? sql`and exists(select 1 from streamer_games sg where sg.streamer=s.login and sg.game=${game})` : sql``}
      order by s.live desc, clips desc, s.login
    `);
  }

  async streamer(viewer: Viewer | null, login: string) {
    if (viewer?.actingAs && viewer.actingAs !== login) {
      throw new NotFoundException(`нет стримера ${login}`);
    }
    const [row] = await this.db.select().from(streamers).where(eq(streamers.login, login));
    if (!row) throw new NotFoundException(`нет стримера ${login}`);

    const playing = await this.db
      .select({
        game: streamerGames.game,
        title: games.title,
        seconds: streamerGames.seconds,
        streams: streamerGames.streams,
      })
      .from(streamerGames)
      .leftJoin(games, eq(games.slug, streamerGames.game))
      .where(eq(streamerGames.streamer, login))
      .orderBy(desc(streamerGames.seconds));

    return { ...row, games: playing };
  }

  /** Эфиры. Это каталог: known - известен, но ещё не скачан. */
  async vods(viewer: Viewer | null, filters: { streamer?: string; game?: string; state?: string }) {
    const scope = viewer?.actingAs ?? filters.streamer;
    return this.db.execute(sql`
      select v.id, v.streamer, v.game, v.title, v.duration, v.state,
             v.published_at as "publishedAt", v.fetched_at as "fetchedAt",
             (v.facecam is not null) as "hasFacecam",
             (v.signals is not null) as "hasSignals",
             exists(select 1 from transcripts t where t.vod_id = v.id) as "hasTranscript",
             count(distinct r.id)::int as runs,
             count(distinct c.id)::int as clips
      from vods v
        left join runs r on r.vod_id = v.id
        left join clips c on c.vod_id = v.id and c.archived_at is null
      where true
        ${scope ? sql`and v.streamer = ${scope}` : sql``}
        ${filters.game ? sql`and v.game = ${filters.game}` : sql``}
        ${filters.state ? sql`and v.state = ${filters.state}` : sql``}
      group by v.id
      order by v.published_at desc nulls last
      limit 200
    `);
  }

  async vod(viewer: Viewer | null, id: string) {
    const [row] = await this.db
      .select()
      .from(vods)
      .where(and(eq(vods.id, id), only(viewer, vods.streamer)));
    if (!row) throw new NotFoundException(`нет эфира ${id}`);

    const [transcript] = await this.db
      .select({
        language: transcripts.language,
        model: transcripts.model,
        droppedLoops: transcripts.droppedLoops,
        segments: sql<number>`jsonb_array_length(${transcripts.segments})::int`,
      })
      .from(transcripts)
      .where(eq(transcripts.vodId, id));

    const vodRuns = await this.db
      .select({
        id: runs.id, version: runs.version, candidates: runs.candidates,
        startedAt: runs.startedAt, finishedAt: runs.finishedAt,
        settings: runs.settings,
        clips: sql<number>`count(${clips.id})::int`,
      })
      .from(runs)
      .leftJoin(clips, and(eq(clips.runId, runs.id), isNull(clips.archivedAt)))
      .where(eq(runs.vodId, id))
      .groupBy(runs.id)
      .orderBy(desc(runs.startedAt));

    const audio = await vodAudioSettings(this.db, id);
    const ads = await vodAdSettings(this.db,id);
    if(viewer?.isAdmin)return { ...row, audio, ads, transcript: transcript ?? null, runs: vodRuns };
    const {error,facecam,signals,adProtection,...visible}=row;
    return {...visible,audio,ads,facecam:facecam?{found:facecam.found}:null,signals:signals?{ready:true}:null,
      transcript:transcript?{language:transcript.language,segments:transcript.segments}:null,
      runs:vodRuns.map(({version,settings,...run})=>run)};
  }

  async run(viewer: Viewer | null, id: string) {
    const [row] = await this.db
      .select()
      .from(runs)
      .where(and(eq(runs.id, id), only(viewer, runs.streamer)));
    if (!row) throw new NotFoundException(`нет прогона ${id}`);

    const list = await this.db
      .select()
      .from(clips)
      .where(and(eq(clips.runId, id), isNull(clips.archivedAt)))
      .orderBy(clips.peak);
    const {outDir,settings,version,...visible}=row;
    return { run: viewer?.isAdmin ? row : visible, clips: list.map(clip=>visibleClip(viewer,clip)) };
  }

  async clips(
    viewer: Viewer | null,
    filters: { game?: string; streamer?: string; vodId?: string; runId?: string; trigger?: string; state?: string },
    limit = 120,
  ) {
    const scope = viewer?.actingAs ?? filters.streamer;
    const rows = await this.db.execute(sql`
      select c.*,
             -- Именно счётчик, а не список: в карточке клипа
             -- publications - это массив, и одно имя для разных вещей
             -- уже приводило к путанице на стороне интерфейса.
             (select count(*)::int from publications p where p.clip_id = c.id)
               as "publicationCount"
      from clips c
      where c.archived_at is null
        ${scope ? sql`and c.streamer = ${scope}` : sql``}
        ${filters.game ? sql`and c.game = ${filters.game}` : sql``}
        ${filters.vodId ? sql`and c.vod_id = ${filters.vodId}` : sql``}
        ${filters.runId ? sql`and c.run_id = ${filters.runId}` : sql``}
        ${filters.trigger ? sql`and c.trigger = ${filters.trigger}` : sql``}
        ${filters.state ? sql`and c.state = ${filters.state}` : sql``}
      order by c.created_at desc
      limit ${limit}
    `);
    return rows.map(row => visibleClip(viewer, row));
  }

  async clip(viewer: Viewer | null, id: string) {
    const [row] = await this.db
      .select()
      .from(clips)
      .where(and(eq(clips.id, id), isNull(clips.archivedAt), only(viewer, clips.streamer)));
    if (!row) throw new NotFoundException(`нет клипа ${id}`);

    const pubs = await this.db
      .select().from(publications).where(eq(publications.clipId, id));

    // Другие версии того же момента: по ним видно, что клип не
    // продублировался, а был перерисован новым оформлением.
    const versions = await this.db
      .select({
        id: clips.id, version: clips.version, file: clips.file,
        runId: clips.runId, createdAt: clips.createdAt, state: clips.state,
      })
      .from(clips)
      .where(and(eq(clips.vodId, row.vodId), eq(clips.segmentKey, row.segmentKey), isNull(clips.archivedAt)))
      .orderBy(clips.createdAt);

    const [run] = await this.db.select({settings:runs.settings}).from(runs).where(eq(runs.id,row.runId));
    const protection = (run?.settings.renderedClips as Record<string,{protection?:{audio?:{method?:string};ads?:{regions?:unknown[];qrHits?:number;bannerHits?:number;profileId?:string;profileFrames?:number};reviewedAt?:string;autoVerifiedAt?:string;disabledAt?:string}}>|undefined)?.[id]?.protection;
    const safety = protection ? {method:protection.audio?.method,regions:protection.ads?.regions?.length ?? 0,
      qrHits:protection.ads?.qrHits ?? 0,bannerHits:protection.ads?.bannerHits ?? 0,reviewedAt:protection.reviewedAt ?? null,
      autoVerifiedAt:protection.autoVerifiedAt??null,disabledAt:protection.disabledAt??null,profileFrames:protection.ads?.profileFrames??0} : null;
    return { ...visibleClip(viewer, row), safety,
      publications: viewer?.isAdmin ? pubs : pubs.map(({id,platform,url,status,privacy}) => ({id,platform,url,status,privacy})),
      versions: viewer?.isAdmin ? versions : [],
    };
  }

  /**
   * Пометить клип снятым.
   *
   * Блокировка живёт на клипе, а не на публикации: если на момент
   * прилетела жалоба на авторские права, его нельзя заливать и на другие
   * площадки тоже.
   */
  async blockClip(viewer: Viewer | null, id: string, reason: string) {
    await this.clip(viewer, id); // проверка видимости
    await this.db
      .update(clips)
      .set({ state: "blocked", blockedReason: reason })
      .where(eq(clips.id, id));
    return { ok: true };
  }

  async setClipState(viewer: Viewer | null, id: string, state: "draft" | "ready", reviewed = false) {
    const clip = await this.clip(viewer, id);
    if (state === 'ready' && (!clip.safety || (!clip.safety.autoVerifiedAt && !clip.safety.disabledAt && !reviewed))) throw new BadRequestException('Сначала завершите обработку рекламы');
    await this.db.transaction(async tx=>{
    if (state === 'ready' && !clip.safety?.autoVerifiedAt && !clip.safety?.disabledAt) {
      await tx.execute(sql`update runs set settings = jsonb_set(settings,
        array['renderedClips',${id},'protection','reviewedAt'], to_jsonb(now()::text), true) where id=${clip.runId}`);
    }
    const saved=await tx
      .update(clips)
      .set({ state, blockedReason: null })
      .where(and(eq(clips.id, id),eq(clips.runId,clip.runId))).returning({id:clips.id});
    if(!saved.length)throw new BadRequestException('Версия клипа изменилась. Откройте её заново');
    });
    return { ok: true };
  }

  /** Сводка для главной. */
  async summary(viewer: Viewer | null) {
    const scope = viewer?.actingAs;
    const [row] = await this.db.execute<{
      games: number; streamers: number; vods: number; ready: number;
      runs: number; clips: number; published: number; blocked: number;
    }>(sql`
      select
        (select count(distinct game)::int from vods
          where game is not null ${scope ? sql`and streamer = ${scope}` : sql``}) as games,
        (select count(*)::int from streamers
          ${scope ? sql`where login = ${scope}` : sql``}) as streamers,
        (select count(*)::int from vods
          ${scope ? sql`where streamer = ${scope}` : sql``}) as vods,
        (select count(*)::int from vods where state = 'ready'
          ${scope ? sql`and streamer = ${scope}` : sql``}) as ready,
        (select count(*)::int from runs
          ${scope ? sql`where streamer = ${scope}` : sql``}) as runs,
        (select count(*)::int from clips where archived_at is null
          ${scope ? sql`and streamer = ${scope}` : sql``}) as clips,
        (select count(*)::int from publications p join clips c on c.id = p.clip_id
          where p.status = 'published' and p.privacy = 'public' ${scope ? sql`and c.streamer = ${scope}` : sql``}) as published,
        (select count(*)::int from clips where state = 'blocked' and archived_at is null
          ${scope ? sql`and streamer = ${scope}` : sql``}) as blocked
    `);
    return row;
  }

  /** Путь к файлу клипа - нужен отдаче видео. */
  async clipFile(viewer: Viewer | null, id: string): Promise<string | null> {
    const row = await this.clipMedia(viewer, id);
    return row ? `${row.outDir}/${row.file}` : null;
  }

  async clipMedia(viewer: Viewer | null, id: string) {
    const [row] = await this.db
      .select({ file: clips.file, outDir: runs.outDir, storage: clips.mediaStorage })
      .from(clips)
      .innerJoin(runs, eq(runs.id, clips.runId))
      .where(and(eq(clips.id, id), isNull(clips.archivedAt), only(viewer, clips.streamer)));
    return row ?? null;
  }

  /**
   * Эфиры, ждущие одобрения на нарезку.
   *
   * Автоматика заводит новые эфиры активных стримеров сама, но нарезка -
   * это гигабайты на диске, и пока публикация не подключена, она ждёт
   * одной кнопки. Это и есть список того, что система предлагает.
   */
  async proposals(viewer: Viewer | null) {
    const scope = viewer?.actingAs;
    return this.db.execute(sql`
      select v.id, v.streamer, s.display_name as "displayName", s.avatar,
             coalesce(g.title, v.game) as game, v.title, v.duration,
             v.published_at as "publishedAt"
      from vods v
        join streamers s on s.login = v.streamer
        left join games g on g.slug = v.game
      where v.state = 'known' and s.state = 'active'
        and not exists(select 1 from pipeline_attempts a where a.vod_id=v.id and a.state='completed')
        ${scope ? sql`and v.streamer = ${scope}` : sql``}
      order by v.published_at desc nulls last
      limit 30
    `);
  }

  /** Стримеры, у которых включена автоматика - для планировщика. */
  async activeStreamers(): Promise<string[]> {
    const rows = await this.db
      .select({ login: streamers.login })
      .from(streamers)
      .where(eq(streamers.state, "active"));
    return rows.map((r) => r.login);
  }

  async setAutoPublish(login: string, enabled: boolean) {
    await this.db
      .update(streamers)
      .set({ autoPublish: enabled })
      .where(eq(streamers.login, login));
    return { ok: true };
  }

  async setStreamerState(login: string, state: "candidate" | "active" | "paused") {
    await this.db.update(streamers).set({ state }).where(eq(streamers.login, login));
    return { ok: true };
  }

  async setStreamerAudio(login: string, audioMode: AudioMode) {
    const [row] = await this.db.update(streamers).set({audioMode})
      .where(eq(streamers.login, login)).returning({audioMode: streamers.audioMode});
    if (!row) throw new NotFoundException(`нет стримера ${login}`);
    return row;
  }

  async setStreamerAds(login:string, enabled:boolean, applyToAll=false) {
    return this.db.transaction(async tx=>{
      const [row]=await tx.update(streamers).set({adCheckEnabled:enabled}).where(eq(streamers.login,login)).returning({adCheckEnabled:streamers.adCheckEnabled});
      if(!row)throw new NotFoundException(`нет стримера ${login}`);
      if(applyToAll)await tx.update(vods).set({adCheckEnabled:null}).where(eq(vods.streamer,login));
      return row;
    });
  }

  async setVodAds(id:string, enabled:boolean|null) {
    const [row]=await this.db.update(vods).set({adCheckEnabled:enabled}).where(eq(vods.id,id)).returning({id:vods.id});
    if(!row)throw new NotFoundException(`нет эфира ${id}`);
    return vodAdSettings(this.db,id);
  }

  async setVodAudio(id: string, audioMode: AudioMode | null) {
    const [row] = await this.db.update(vods).set({audioMode})
      .where(eq(vods.id, id)).returning({id: vods.id});
    if (!row) throw new NotFoundException(`нет эфира ${id}`);
    return vodAudioSettings(this.db, id);
  }

  /** Эфиры, до которых у автоматики ещё не дошли руки. */
  async pendingVods(logins: string[], limit = 5) {
    if (logins.length === 0) return [];
    return this.db
      .select({ id: vods.id, streamer: vods.streamer, publishedAt: vods.publishedAt })
      .from(vods)
      .where(and(inArray(vods.streamer, logins), eq(vods.state, "known")))
      .orderBy(desc(vods.publishedAt))
      .limit(limit);
  }
}
