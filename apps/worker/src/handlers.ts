/**
 * Обработчики заданий.
 *
 * Каждый шаг конвейера - отдельное задание, и каждое из них:
 *   - читает и пишет состояние в базу, а не в файлы рядом с видео;
 *   - идемпотентно: повторный запуск не переделывает готовое;
 *   - ничего не знает про очередь, кроме того, что может поставить
 *     следующее задание.
 *
 * Python вызывается только там, где он нужен: распознавание, сигналы,
 * поиск камеры. Всё остальное - yt-dlp, ffmpeg, детекция, субтитры -
 * делается здесь же, в TypeScript.
 */
import { createHash } from "node:crypto";
import { cpus } from "node:os";
import { stat } from "node:fs/promises";
import { join } from "node:path";

import { and, eq, isNull, sql } from "drizzle-orm";

import {
  clips as clipsTable,
  games,
  runs,
  streamerGames,
  streamers,
  transcripts,
  vods,
  vodAudioSettings, vodAdSettings,
  type VodChapter,
} from "@clipforge/db";
import {disjointMoments,renderCount} from './render-options.js';
import {ensureAdProfile} from './ad-protection.js';
import {
  buildAss,
  clipFileName,
  OUT_WIDTH,
  clipId,
  computeGrid,
  defaultStyle,
  describeGrid,
  detect,
  downloadAudio,
  downloadVideo,
  fetchVodInfo,
  fingerprint,
  labelTrigger,
  listArchives,
  mainGame,
  gameAt,
  newRunId,
  probeMedia,
  probeSize,
  readSignals,
  renderClip,
  safeName,
  segmentKey,
  selectDiverse,
  Workspace,
  headerLockup,
  outroCard,
  beepSpans,
  findProfanity,
  mergeSpans,
  allWords,
  type Candidate,
  type Transcript,
  type Signals,
} from "@clipforge/pipeline";
import { SIGNAL_SERIES } from "@clipforge/contracts";

import { applyFeedback } from "./feedback.js";
import { storeClip } from "./media-storage.js";
import type { Context } from "./context.js";

/** Ход выполнения задания: пишется в журнал, позже уйдёт в интерфейс. */
export interface JobReport {
  id?: string;
  log: (message: string) => void;
  /**
   * Снято ли задание. Проверяется на естественных границах - между
   * шагами конвейера и между клипами: там остановка ничего не портит.
   */
  cancelled: () => Promise<boolean>;
}

// --- вспомогательное ----------------------------------------------------

/** Строка эфира вместе с рабочей папкой. Без неё шаг делать нечего. */
async function loadVod(ctx: Context, vodId: string) {
  const [row] = await ctx.db.select().from(vods).where(eq(vods.id, vodId));
  if (!row) throw new Error(`эфира ${vodId} нет в базе`);

  const workspace = new Workspace(
    { data: ctx.config.data, out: ctx.config.out },
    { game: row.game ?? "unknown", streamer: row.streamer, vodId },
  );
  await workspace.prepare();
  return { row, workspace };
}

/**
 * Завести игру, если её ещё нет.
 *
 * Обложка тянется с Twitch один раз: без неё в меню серые квадраты
 * вместо игр, а узнать игру по названию в списке из десяти штук трудно.
 */
async function ensureGame(ctx: Context, title: string): Promise<string | null> {
  const clean = title.trim();
  if (!clean) return null;
  const slug = safeName(clean);

  const [existing] = await ctx.db
    .select({ boxArt: games.boxArt })
    .from(games)
    .where(eq(games.slug, slug));

  let boxArt = existing?.boxArt ?? null;
  if (!boxArt && ctx.twitch) {
    try {
      const [found] = await ctx.twitch.games([clean]);
      // Twitch отдаёт шаблон с {width}x{height} - подставляем размер,
      // в котором обложка показывается в меню.
      boxArt = found?.boxArt.replace("{width}x{height}", "144x192") ?? null;
    } catch {
      // Обложка - украшение, из-за неё обход канала падать не должен.
    }
  }

  await ctx.db
    .insert(games)
    .values({ slug, title: clean, boxArt })
    .onConflictDoUpdate({
      target: games.slug,
      set: boxArt ? { title: clean, boxArt } : { title: clean },
    });
  return slug;
}

/**
 * Подтянуть профиль канала: имя, аватарка, число фолловеров.
 *
 * Делается при обходе архивов, а не отдельной кнопкой. Иначе стример
 * заводится безымянным серым кружком, и нажимать «обновить профиль»
 * руками приходится на каждого.
 */
async function ensureProfile(ctx: Context, login: string, report: JobReport): Promise<void> {
  if (!ctx.twitch) return;
  try {
    const [user] = await ctx.twitch.users([login]);
    if (!user) return;
    const followers = await ctx.twitch.followerCount(user.id);
    await ctx.db
      .update(streamers)
      .set({
        displayName: user.displayName, twitchId: user.id,
        avatar: user.avatar, description: user.description,
        followers, checkedAt: new Date(),
      })
      .where(eq(streamers.login, login));
    report.log(`профиль: ${user.displayName}, ${followers} фолловеров`);
  } catch (error) {
    report.log(`профиль не получен: ${String(error)}`);
  }
}

/** Запомнить, что стример играл в эту игру и сколько. */
async function noteStreamerGame(
  ctx: Context,
  streamer: string,
  slug: string,
  seconds: number,
): Promise<void> {
  await ctx.db
    .insert(streamerGames)
    .values({ streamer, game: slug, seconds, streams: 1, lastSeen: new Date() })
    .onConflictDoUpdate({
      target: [streamerGames.streamer, streamerGames.game],
      set: {
        seconds: sql`${streamerGames.seconds} + ${seconds}`,
        streams: sql`${streamerGames.streams} + 1`,
        lastSeen: new Date(),
      },
    });
}

// --- индексация канала --------------------------------------------------

/**
 * Обойти архивы канала и завести их в каталоге.
 *
 * Эфир появляется в базе сразу, со статусом known - ещё до того, как
 * что-то скачано. Раньше строка возникала только после первого прогона,
 * и список архивов не знал, что уже добавлено.
 */
export async function indexChannel(
  ctx: Context,
  payload: { login: string; limit: number; withChapters: boolean },
  report: JobReport,
): Promise<{ found: number; added: number }> {
  const login = safeName(payload.login);
  if (ctx.config.role === 'control') {
    if (!ctx.twitch) throw new Error('Twitch API не настроен');
    const [user] = await ctx.twitch.users([login]);
    if (!user) throw new Error('Канал Twitch не найден');
    const archives = await ctx.twitch.archives(user.id, payload.limit);
    await ctx.db.insert(streamers).values({login, displayName:user.displayName, source:'manual'})
      .onConflictDoNothing();
    await ensureProfile(ctx, login, report);
    let added = 0;
    for (const archive of archives) {
      const id = `v${archive.id.replace(/^v/, '')}`;
      const [existing] = await ctx.db.select({id:vods.id}).from(vods).where(eq(vods.id,id));
      const metadata = {title:archive.title,duration:archive.durationSeconds,publishedAt:new Date(archive.publishedAt)};
      await ctx.db.insert(vods).values({id,streamer:login,...metadata,state:'known'})
        .onConflictDoUpdate({target:vods.id,set:metadata});
      if (!existing) added++;
    }
    await ctx.db.update(streamers).set({indexedAt:new Date()}).where(eq(streamers.login,login));
    report.log(`Найдено эфиров: ${archives.length}, новых: ${added}. Главы выбранного эфира уточняются перед скачиванием.`);
    return {found:archives.length,added};
  }
  const ytdlp = { command: ctx.config.pythonBin, args: [join(ctx.config.workerRoot, 'clipforge_worker', 'download.py')] };

  report.log(`архивы канала ${login}`);
  const archives = await listArchives(login, payload.limit, ytdlp);
  report.log(`найдено эфиров: ${archives.length}`);

  await ctx.db
    .insert(streamers)
    .values({ login, displayName: login, source: "manual" })
    .onConflictDoUpdate({
      target: streamers.login,
      set: { indexedAt: new Date() },
    });

  await ensureProfile(ctx, login, report);

  let added = 0;
  for (const archive of archives) {
    const existing = await ctx.db
      .select({ id: vods.id })
      .from(vods)
      .where(eq(vods.id, archive.id));

    if (existing.length > 0 && !payload.withChapters) continue;

    let game: string | null = null;
    let chapters: VodChapter[] = [];
    let publishedAt: Date | null = null;
    let title = archive.title;
    let duration = archive.duration;

    if (payload.withChapters || existing.length === 0) {
      // Главы доступны только отдельным запросом по эфиру. Без них
      // неизвестна игра, то есть верхний уровень всей раскладки.
      try {
        const info = await fetchVodInfo(archive.id, ytdlp);
        chapters = info.chapters;
        title = info.title || title;
        duration = info.duration || duration;
        publishedAt = info.publishedAt ? new Date(info.publishedAt) : null;
        game = await ensureGame(ctx, mainGame(info));

      } catch (error) {
        report.log(`  ${archive.id}: метаданные не получены (${String(error)})`);
        if (existing.length) continue;
      }
    }

    await ctx.db
      .insert(vods)
      .values({
        id: archive.id, streamer: login, game, title, duration,
        chapters, publishedAt, state: "known",
      })
      .onConflictDoUpdate({
        target: vods.id,
        set: { title, duration, chapters, game, publishedAt },
      });

    if (existing.length === 0) added += 1;
    report.log(`  ${archive.id} ${game ?? "игра неизвестна"} · ${Math.round(duration / 60)} мин`);
  }

  await ctx.db.execute(sql`insert into streamer_games(streamer,game,seconds,streams,last_seen)
    select streamer,game,sum(coalesce(duration,0)),count(*)::int,now() from vods
    where streamer=${login} and game is not null group by streamer,game
    on conflict(streamer,game) do update set seconds=excluded.seconds,streams=excluded.streams,last_seen=excluded.last_seen`);
  await ctx.db.update(streamers).set({indexedAt:new Date()}).where(eq(streamers.login,login));
  return { found: archives.length, added };
}

// --- загрузка -----------------------------------------------------------

export async function fetchVod(
  ctx: Context,
  payload: { vodId: string; audioOnly: boolean },
  report: JobReport,
): Promise<{ audio: string; video: string | null }> {
  const ytdlp = { command: ctx.config.pythonBin, args: [join(ctx.config.workerRoot, 'clipforge_worker', 'download.py')] };
  const cached=await loadVod(ctx,payload.vodId);
  const cachedVideo=cached.workspace.video(ctx.config.videoFormat);
  const present=async(file:string)=>(await stat(file).catch(()=>null))?.size??0;
  if(await present(cached.workspace.audio) && (payload.audioOnly || await present(cachedVideo))) {
    report.log('Использую сохранённые исходники эфира.');
    return {audio:cached.workspace.audio,video:payload.audioOnly?null:cachedVideo};
  }
  // Server discovery uses Helix only. The downloader resolves the selected
  // archive's chapters before choosing its cache path and starting analysis.
  if (ctx.config.role === 'media') {
    const info = await fetchVodInfo(payload.vodId, ytdlp);
    const game = await ensureGame(ctx, mainGame(info));
    await ctx.db.update(vods).set({chapters:info.chapters,title:info.title,duration:info.duration,
      publishedAt:info.publishedAt ? new Date(info.publishedAt) : null,...(game ? {game} : {})})
      .where(eq(vods.id,payload.vodId));
  }
  const { row, workspace } = await loadVod(ctx, payload.vodId);

  await ctx.db.update(vods).set({ state: "fetching", error: null }).where(eq(vods.id, row.id));

  try {
    let lastPercent = -1;
    const onProgress = (label: string) => (progress: { percent: number | null }) => {
      if (progress.percent === null) return;
      const whole = Math.trunc(progress.percent);
      // yt-dlp пишет прогресс по нескольку раз в секунду; в журнал
      // попадает одна строка на пять процентов.
      if (whole !== lastPercent && whole % 5 === 0) {
        lastPercent = whole;
        report.log(`${label}: ${whole}%`);
      }
    };

    report.log("аудио");
    const audio = await downloadAudio(row.id, workspace.audio, {
      ...ytdlp,
      rateLimitKbps: ctx.config.mediaNetworkKbps,
      onProgress: onProgress("аудио"),
    });

    let video: string | null = null;
    if (!payload.audioOnly) {
      report.log("видео");
      lastPercent = -1;
      video = await downloadVideo(
        row.id,
        workspace.video(ctx.config.videoFormat),
        ctx.config.videoFormat,
        8,
        { ...ytdlp, rateLimitKbps: ctx.config.mediaNetworkKbps, onProgress: onProgress("видео") },
      );
    }

    await ctx.db
      .update(vods)
      .set({ state: "ready", fetchedAt: new Date() })
      .where(eq(vods.id, row.id));
    return { audio, video };
  } catch (error) {
    await ctx.db
      .update(vods)
      .set({ state: "failed", error: String(error).slice(0, 500) })
      .where(eq(vods.id, row.id));
    throw error;
  }
}

// --- расшифровка --------------------------------------------------------

export async function transcribeVod(
  ctx: Context,
  payload: { vodId: string; force: boolean },
  report: JobReport,
): Promise<{ words: number; segments: number }> {
  const { row, workspace } = await loadVod(ctx, payload.vodId);

  if (!payload.force) {
    const [existing] = await ctx.db
      .select({ vodId: transcripts.vodId })
      .from(transcripts)
      .where(eq(transcripts.vodId, row.id));
    if (existing) {
      report.log("расшифровка уже есть");
      const [full] = await ctx.db.select().from(transcripts).where(eq(transcripts.vodId, row.id));
      const segments = full?.segments ?? [];
      return {
        words: segments.reduce((sum, s) => sum + s.words.length, 0),
        segments: segments.length,
      };
    }
  }

  const result = await ctx.python.call("transcribe", {
    audio: workspace.audio,
    model: ctx.config.speechModel,
    language: ctx.config.speechLanguage,
    batchSize: ctx.config.speechBatchSize,
    glossary: ctx.config.glossary,
  }, {onEvent:e=>report.log(e.event === "log" ? e.message : `${e.stage}${e.value === null ? "" : ` ${Math.round(e.value*100)}%`}`)});

  await ctx.db
    .insert(transcripts)
    .values({
      vodId: row.id,
      language: result.language,
      duration: result.duration,
      model: ctx.config.speechModel,
      segments: result.segments,
      droppedLoops: result.droppedLoops,
    })
    .onConflictDoUpdate({
      target: transcripts.vodId,
      set: {
        language: result.language, duration: result.duration,
        model: ctx.config.speechModel, segments: result.segments,
        droppedLoops: result.droppedLoops, createdAt: new Date(),
      },
    });

  const words = result.segments.reduce((sum, s) => sum + s.words.length, 0);
  report.log(`фраз ${result.segments.length}, слов ${words}`);
  if (result.droppedLoops) report.log(`вырезано зацикленных повторов: ${result.droppedLoops}`);
  return { words, segments: result.segments.length };
}

// --- сигналы звука ------------------------------------------------------

export async function analyzeVod(
  ctx: Context,
  payload: { vodId: string; force: boolean },
  report: JobReport,
): Promise<{ frames: number }> {
  const { row, workspace } = await loadVod(ctx, payload.vodId);

  if (!payload.force && row.signals && await stat(row.signals.file).then(s => s.size === row.signals!.frames * row.signals!.series.length * 4).catch(() => false)) {
    report.log("сигналы уже посчитаны");
    return { frames: row.signals.frames };
  }

  const result = await ctx.python.call("audioSignals", {
    audio: workspace.audio,
    out: workspace.signals,
  }, {onEvent:e=>report.log(e.event === "log" ? e.message : e.stage)});

  await ctx.db
    .update(vods)
    .set({
      signals: {
        file: result.file, frames: result.frames,
        hopSeconds: result.hopSeconds, duration: result.duration,
        series: [...result.series],
      },
    })
    .where(eq(vods.id, row.id));

  report.log(`кадров ${result.frames}, ${Math.round(result.duration / 60)} мин`);
  return { frames: result.frames };
}

// --- поиск камеры -------------------------------------------------------

const CAMERA_HINT_VERSION = "yunet-roi-v3-ignore-dota-portraits";

export async function facecamVod(
  ctx: Context,
  payload: { vodId: string; force: boolean },
  report: JobReport,
): Promise<{ found: boolean }> {
  const { row, workspace } = await loadVod(ctx, payload.vodId);

  if (!payload.force && row.facecam?.detectorVersion === CAMERA_HINT_VERSION) {
    report.log(`камера уже искалась: ${row.facecam.note}`);
    return { found: row.facecam.found };
  }

  const result = await ctx.python.call("facecam", {
    video: workspace.video(ctx.config.videoFormat),
    game: row.game ?? undefined,
    modelPath: `${ctx.config.models}/face_detection_yunet_2023mar.onnx`,
  });

  // Keep the existing composition when the newly detected head still fits it.
  const previous = row.facecam?.found ? row.facecam.rect : null;
  const face = result.face;
  const rect = result.found && previous && face && face.x >= previous.x && face.y >= previous.y
    && face.x+face.w <= previous.x+previous.w && face.y+face.h <= previous.y+previous.h
    ? previous : result.rect;

  await ctx.db
    .update(vods)
    .set({
      facecam: {
        detectorVersion: CAMERA_HINT_VERSION, found: result.found, rect,
        confidence: result.confidence, note: result.note,
      },
    })
    .where(eq(vods.id, row.id));

  report.log(result.note);
  return { found: result.found };
}

// --- нарезка ------------------------------------------------------------

export async function inspectAds(ctx:Context,payload:{vodId:string},report:JobReport) {
  const {workspace}=await loadVod(ctx,payload.vodId);
  const profile=await ensureAdProfile(ctx,payload.vodId,workspace.video(ctx.config.videoFormat),report);
  return {vodId:payload.vodId,profileId:profile.signature,regions:profile.regions.length,samples:profile.samples};
}

/** A real, bounded source uses the same selection and rendering as a full VOD. */
export interface PreparedRenderSource {
  video: string;
  transcript: Transcript & { model: string };
  signals: Signals;
  offsetSeconds: number;
}

export async function renderRun(
  ctx: Context,
  payload: { vodId: string; count?: number; skipExisting?:boolean; audioMode?:'original'|'dtln'|'dtln-gated';testBatch?:boolean },
  report: JobReport,
  prepared?: PreparedRenderSource,
): Promise<{ runId: string; rendered: number; skipped: number; replaced: number }> {
  const { row, workspace } = await loadVod(ctx, payload.vodId);
  const [resuming] = report.id&&payload.testBatch ? await ctx.db.select().from(runs).where(and(
    eq(runs.vodId,row.id),sql`${runs.settings}->>'jobId' = ${report.id}`)).limit(1) : [];
  const audioSettings=resuming?.settings.audioSettings as Awaited<ReturnType<typeof vodAudioSettings>>|undefined
    ?? await vodAudioSettings(ctx.db,row.id,payload.audioMode);
  const audioMode=audioSettings.mode;
  const adsSettings=resuming?.settings.adsSettings as Awaited<ReturnType<typeof vodAdSettings>>|undefined ?? await vodAdSettings(ctx.db,row.id);
  const skipExisting=payload.skipExisting||payload.testBatch||false;
  const [mode] = await ctx.db.execute<{value:{developmentMode?:boolean}}>(sql`select value from platform_runtime where key='settings'`);
  const count = Number(resuming?.settings.requestedCount??renderCount(payload,!!mode?.value.developmentMode,ctx.config.clipsPerRun));
  const previousClips = resuming ? await ctx.db.select({id:clipsTable.id}).from(clipsTable).where(eq(clipsTable.runId,resuming.id)) : [];
  if(previousClips.length>=count) {
    await ctx.db.update(runs).set({finishedAt:new Date()}).where(eq(runs.id,resuming!.id));
    return {runId:resuming!.id,rendered:previousClips.length,skipped:0,replaced:0};
  }
  if (!prepared && row.facecam?.detectorVersion !== CAMERA_HINT_VERSION) {
    await facecamVod(ctx, {vodId:row.id,force:false}, report);
    const [updated] = await ctx.db.select({facecam:vods.facecam}).from(vods).where(eq(vods.id,row.id));
    row.facecam = updated!.facecam;
  }

  if (!prepared && !row.signals) throw new Error("нет сигналов - сначала analyze");
  const transcriptRow = prepared?.transcript ?? (await ctx.db
    .select().from(transcripts).where(eq(transcripts.vodId, row.id)))[0];
  if (!transcriptRow) throw new Error("нет расшифровки - сначала transcribe");

  const transcript: Transcript = {
    language: transcriptRow.language,
    duration: transcriptRow.duration,
    segments: transcriptRow.segments,
  };
  const words = allWords(transcript);

  const audio = prepared?.signals ?? await readSignals(row.signals!.file, {
    frames: row.signals!.frames,
    hopSeconds: row.signals!.hopSeconds,
    duration: row.signals!.duration,
    series: SIGNAL_SERIES,
  });

  const candidates = detect(audio, transcript, {
    maxCount: 300, minGapSeconds: 22,
    lead: 12, tail: 6, minLen: 25, maxLen: 55,
    minLead: 5, minTail: 4, padBefore: 1.0, padAfter: 1.3,
  });
  report.log(`кандидатов ${candidates.length} (${Math.round((candidates.length / audio.duration) * 3600)} в час)`);

  const feedback = await applyFeedback(ctx, row.streamer, candidates);
  report.log(`Отбор: ${feedback.evidence.mode}, публичных наблюдений ${feedback.evidence.samples}`);
  if (mode?.value.developmentMode&&!payload.testBatch) report.log("Режим разработки: создаю только один проверочный клип.");
  report.log(`Звук новых клипов: ${audioMode==='original'?'исходный':audioMode==='dtln-gated'?'DTLN с паузами':'DTLN'}.`);
  // Camera/layout validation can reject a moment. Try a bounded reserve while
  // still producing at most count clips; never silently omit a visible camera.
  // selectDiverse returns chronological order for batch rendering. A quality
  // reserve must try the strongest moment first, otherwise requesting one clip
  // silently switches to the earliest of five candidates.
  // Archived, unpublished drafts from earlier experiments do not exhaust
  // the VOD. Keep all visible and already-published moments excluded.
  const covered = skipExisting ? await ctx.db.select({start:clipsTable.start,end:clipsTable.end})
    .from(clipsTable).where(and(eq(clipsTable.vodId,row.id),
      sql`(${clipsTable.archivedAt} is null or exists(select 1 from publications p where p.clip_id=${clipsTable.id}))`)) : [];
  const eligible = feedback.candidates.filter(candidate=>!covered.some(range=>range.start!==null&&range.end!==null
    && range.start < (prepared?.offsetSeconds??0)+candidate.end && range.end > (prepared?.offsetSeconds??0)+candidate.start));
  if(!eligible.length)throw new Error('Нет новых моментов, не пересекающихся с существующими клипами');
  const reserve = selectDiverse(eligible, Math.min(300,count*5), audio.duration)
    .sort((a,b) => b.score-a.score || a.peak-b.peak);
  const picked=skipExisting?disjointMoments(reserve):reserve;

  const byTrigger = new Map<string, number>();
  for (const candidate of picked) {
    const kind = labelTrigger(candidate);
    byTrigger.set(kind, (byTrigger.get(kind) ?? 0) + 1);
  }
  report.log(
    `проверю до ${picked.length} кандидатов, нужно ${count} клип(ов): ` +
      [...byTrigger].map(([kind, n]) => `${kind} ${n}`).join(", "),
  );

  const video = prepared?.video ?? workspace.video(ctx.config.videoFormat);
  const sourceOffset = prepared?.offsetSeconds ?? 0;
  if (sourceOffset < 0 || !Number.isFinite(sourceOffset)) throw new Error("Неверное начало исходного фрагмента");
  const source = await probeSize(video);
  const adProfile=adsSettings.enabled?await ensureAdProfile(ctx,row.id,video,report,!!prepared):undefined;
  if(!adsSettings.enabled)report.log("Проверка рекламы выключена в настройках эфира.");
  const grid = computeGrid(source.width, source.height, null);
  report.log(`Исходник ${source.width}×${source.height}. Расположение камеры проверяется отдельно для каждого момента.`);

  // Имя для шапки и концовки берётся из карточки стримера: на Twitch
  // отображаемое имя отличается от логина регистром, а иногда и вовсе.
  const [streamerRow] = await ctx.db
    .select({ displayName: streamers.displayName })
    .from(streamers)
    .where(eq(streamers.login, row.streamer));
  const channelName = streamerRow?.displayName || row.streamer;

  const header = headerLockup({ channel: channelName });
  const outro = outroCard({
    channel: channelName,
    url: `twitch.tv/${row.streamer}`,
    seconds: 3.4,
  });
  const style = defaultStyle({
    size: 66, topY: grid.subTop, maxPhraseSeconds: 3.2,
    maxPhraseChars: 42, censor: true,
    // Строка не шире клипа: холст минус поля и обводка. Лимит символов
    // ширины букв не знает, и субтитры вылезали за границы кадра.
    maxLineWidth: OUT_WIDTH - 2 * 40 - 8,
  });

  // Версия оформления: отпечаток всего, что видно на экране. По ней
  // решается, дубль это или новая версия момента.
  const { version, parts: versionParts } = fingerprint({
    cameraPolicy: "per-clip-roi-v7-ignore-dota-portraits",
    layoutPolicy: "fixed-crop-minimap-v1",
    subtitleTextPolicy: "ru-spacing-and-shared-masking-v1",
    mediaProtection: { version:4, audio:audioMode, ads:adsSettings.enabled?'vod-vision':'disabled', profileId:adProfile?.signature, reviewVersion:adProfile?.reviewVersion, regions:adProfile?.regions??[] },
    grid, subtitles: style, header, outro,
    render: { crf: 20, preset: "veryfast", fps: 30, audioBitrate: "160k" },
    censor: { enabled: true, audio: "off", maskSubtitles: true },
    speechModel: transcriptRow.model,
    transcriptHash: createHash("sha256").update(JSON.stringify(transcript.segments)).digest("hex"),
  });
  report.log(`версия оформления: ${version}`);

  const runId = resuming?.id??newRunId(new Date());
  const outDir = workspace.runDir(runId);
  if(!resuming)await ctx.db.insert(runs).values({
    id: runId, vodId: row.id, streamer: row.streamer, game: row.game,
    outDir, candidates: candidates.length, version,
    settings: { grid: describeGrid(grid), versionParts, speechModel: transcriptRow.model, feedback: feedback.evidence,
      sourceWindow: {start:sourceOffset,end:sourceOffset+audio.duration}, selection:"automatic",
      audioMode,audioSettings,adsSettings,skipExisting,testBatch:payload.testBatch??false,requestedCount:count,jobId:report.id },
  });

  const profanityHits = findProfanity(words);
  let rendered = previousClips.length;
  let skipped = 0;
  let replaced = 0;
  let accepted = previousClips.length;
  let rejected = 0;
  let resourceFailure = false;
  const failures: string[] = [];
  const verifications: Record<string, unknown> = {...resuming?.settings.renderedClips as Record<string,unknown>|undefined};

  /**
   * Рендер идёт в несколько процессов ffmpeg сразу.
   *
   * Стратегия площадки - массовость, а кодирование - работа для CPU:
   * один процесс не загружал и половины ядер (тяжёлые фильтры вроде
   * размытия однопоточны). Каждому процессу отдаётся доля потоков
   * кодирования, иначе N процессов по всем ядрам дерутся за планировщик.
   *
   * По одному остаются только GPU-шаги (распознавание делит видеопамять)
   * и загрузка (Twitch и диск) - там параллельность замедляет.
   */
  const concurrency = Math.max(1, Math.min(ctx.config.renderConcurrency, count));
  const threadsPerProcess = Math.max(2, Math.floor(cpus().length / concurrency));
  if (concurrency > 1) {
    report.log(`рендер в ${concurrency} процесса, по ${threadsPerProcess} потоков`);
  }

  const renderOne = async (index: number): Promise<void> => {
    const original = picked[index]!;
    const candidate = { ...original };
    const trigger = labelTrigger(candidate);
    // Trimming must never turn a blocked moment into a publishable new segment.
    const [blocked] = await ctx.db.select({id:clipsTable.id}).from(clipsTable).where(and(
      eq(clipsTable.vodId,row.id),eq(clipsTable.state,"blocked"),
      sql`${clipsTable.start} < ${sourceOffset+candidate.end}`,
      sql`${clipsTable.end} > ${sourceOffset+candidate.start}`,
    ));
    if (blocked) { skipped++; report.log(`Пропуск заблокированного момента ${sourceOffset+candidate.start}`); return; }
    // A VOD-wide camera hint is never proof that a person is in this clip.
    let cameraRect = null;
    let cameraCheck;
    let trim;
    try {
      const verifyCamera = () => ctx.python.call("facecam", {
        video, modelPath: `${ctx.config.models}/face_detection_yunet_2023mar.onnx`,
        game:gameForMoment(row.chapters,{...candidate,peak:sourceOffset+candidate.peak},row.game),
        start: candidate.start, end: candidate.end,
        samples: Math.min(200, Math.max(5, Math.ceil((candidate.end-candidate.start)*2)+1)),
        minHitRatio: 1,
        ...(row.facecam?.found && row.facecam.rect ? {referenceRect:row.facecam.rect} : {}),
      });
      let camera = await verifyCamera();
      const cameraExpected = row.facecam?.found || camera.hits >= Math.max(3,camera.samples*.1);
      if (!camera.found) {
        // Keep the automatically selected peak, but cut unreliable camera
        // edges only when a useful contiguous interval can be checked again.
        const window = camera.safeWindows
          .filter(w => w.start <= candidate.peak-2 && w.end >= candidate.peak+2 && w.end-w.start >= 12)
          .sort((a,b) => (b.end-b.start)-(a.end-a.start))[0];
        if (window) {
          trim = {originalStart:sourceOffset+original.start,originalEnd:sourceOffset+original.end,
            reason:"Границы сокращены до устойчивой камеры вокруг исходного пика",originalCamera:camera};
          candidate.start = Math.max(original.start,window.start);
          candidate.end = Math.min(original.end,window.end);
          candidate.text = words.filter(w => w.end > candidate.start && w.start < candidate.end).map(w => w.text).join(" ");
          camera = await verifyCamera();
          report.log(`Уточняю границы момента вокруг пика ${sourceOffset+candidate.peak}: ${sourceOffset+candidate.start}–${sourceOffset+candidate.end}. Повторная проверка камеры: ${camera.hits}/${camera.samples}.`);
        }
      }
      cameraCheck = camera;
      if (!camera.found && (cameraExpected || camera.hits >= Math.max(3,camera.samples*.1))) {
        rejected++;
        verifications[`rejected-${index}`]={camera,sourceStart:sourceOffset+candidate.start,
          sourceEnd:sourceOffset+candidate.end,trim,rejected:true,reason:"Камера не подтверждена на всём моменте"};
        report.log(`Пропускаю момент ${sourceOffset+candidate.start}: ${camera.note}. Проверяю следующего кандидата.`);
        return;
      }
      if (camera.found) cameraRect = camera.rect;
      report.log(`Камера клипа ${index+1}: ${camera.found ? "подтверждена на всём проверенном отрезке" : "блок скрыт"}. ${camera.note}`);
    } catch (error) {
      throw new Error(`Проверка камеры клипа ${index+1} не пройдена: ${String(error).slice(0,250)}`);
    }
    const mapCheck = await ctx.python.call("minimap", {
      video, game:gameForMoment(row.chapters,{...candidate,peak:sourceOffset+candidate.peak},row.game),
      start:candidate.start,end:candidate.end,
      samples:Math.min(200,Math.max(5,Math.ceil((candidate.end-candidate.start)*2)+1)),
      ...(cameraRect ? {excludeRect:cameraRect} : {}),
    });
    report.log(mapCheck.note);
    const grid = computeGrid(source.width, source.height, cameraRect,
      {minimapRect:mapCheck.found ? mapCheck.rect : null});
    const segment = segmentKey(row.id, sourceOffset+candidate.start, sourceOffset+candidate.end);
    const clipStyle = { ...style, topY: grid.subTop };
    const { version } = fingerprint({ ...versionParts, grid, subtitles: clipStyle });
    const id = clipId(row.id, segment, version);
    verifications[id] = { camera:cameraCheck, minimap:mapCheck, grid, trim, sourceStart:sourceOffset+candidate.start, sourceEnd:sourceOffset+candidate.end, score:candidate.score, trigger };
    const [existing] = await ctx.db
      .select().from(clipsTable).where(eq(clipsTable.id, id));
    const [existingRun] = existing ? await ctx.db.select().from(runs).where(eq(runs.id, existing.runId)) : [];
    const validFile = existingRun && existing ? await stat(join(existingRun.outDir, existing.file)).then(s => s.size > 0).catch(() => false) : false;
    if (existing && !existing.archivedAt && validFile) {
      if (ctx.storage && !existing.mediaStorage) {
        const mediaStorage = await storeClip(ctx, id, join(existingRun!.outDir, existing.file));
        await ctx.db.update(clipsTable).set({ mediaStorage }).where(eq(clipsTable.id, id));
      }
      // Тот же отрезок в той же версии уже отрендерен - работы нет.
      skipped += 1;
      accepted += 1;
      report.log(`  [${index + 1}/${picked.length}] -- уже есть, версия ${version}`);
      return;
    }

    const name = clipFileName(index + 1, trigger, candidate.peak);
    const spans = mergeSpans(
      beepSpans(
        profanityHits.filter((h) => h.end > candidate.start && h.start < candidate.end),
      ),
    );

    const protection = await ctx.python.call('prepareMedia', {
      video, start:candidate.start, end:candidate.end + (outro?.seconds ?? 0),
      adProfile,adCheckEnabled:adsSettings.enabled,
      transcript:candidate.text ?? '',
      ...(audioMode!=='original'?{audioMode,models:ctx.config.models,audioOut:workspace.clipPath(runId,name+'.dtln.wav'),
        ...(audioMode==='dtln-gated'?{speechSpans:words.filter(w=>w.end>candidate.start&&w.start<candidate.end+(outro?.seconds??0)).map(w=>[Math.max(0,w.start-candidate.start),w.end-candidate.start])}:{})} : {}),
    });
    verifications[id] = {...verifications[id] as object, protection};
    if (protection.ads.reject) {
      rejected++; report.log(`Пропускаю рекламный фрагмент: ${protection.ads.reason}`); return;
    }
    if (audioMode!=='original' && protection.audio.method!=='dtln') {
      throw new Error('DTLN не применён: рендер с исходным звуком отменён');
    }
    const result = await renderClip({
      sourceMasks:protection.ads.regions,
      audioSource:protection.audio.method==='dtln'?protection.audio.file:undefined,
      source: video, start: candidate.start, end: candidate.end,
      out: workspace.clipPath(runId, name),
      grid, assets: { root: ctx.config.assets },
      transcript, style: clipStyle, censorSpans: spans, censorBeep: false,
      header, outro,
      crf: 20, preset: "veryfast", fps: 30, audioBitrate: "160k",
      threads: threadsPerProcess,
    });

    if (!result.ok) {
      // Resource exhaustion affects the whole remaining run, not just this
      // moment. Keep completed clips and retry the stage/run after recovery.
      if (/cannot allocate memory|out of memory|malloc of size|bad_alloc/i.test(result.error)) {
        throw new Error(`Недостаточно памяти для рендера ${name}; готовые клипы сохранены`);
      }
      failures.push(name);
      report.log(`  [${index + 1}/${picked.length}] СБОЙ ${name}: ${result.error.slice(0, 200)}`);
      return;
    }
    report.log(
      `  [${index + 1}/${picked.length}] OK ${name} ` +
      `${Math.round(candidate.end - candidate.start)}с за ${result.seconds.toFixed(1)}с`,
    );


    const file = workspace.clipPath(runId, name);
    const media = await probeMedia(file);
    const size = await stat(file).then((s) => s.size).catch(() => 0);
    // Catalog visibility is committed only after both objects reach S3.
    const mediaStorage = await storeClip(ctx, id, file);
    // Proof is committed only for an actually rendered and stored version.
    const verifiedProtection={...protection,autoVerifiedAt:protection.ads.automatic?new Date().toISOString():null,disabledAt:!adsSettings.enabled?new Date().toISOString():null};
    verifications[id]={...verifications[id] as object,protection:verifiedProtection};
    // Persist proof with each clip, including when a later clip or the worker fails.
    await ctx.db.update(runs).set({settings:sql`jsonb_set(${runs.settings},'{renderedClips}',
      coalesce(${runs.settings}->'renderedClips','{}'::jsonb) || ${JSON.stringify({[id]:verifications[id]})}::jsonb)`}).where(eq(runs.id,runId));
    await ctx.db.insert(clipsTable).values({
      id, runId, vodId: row.id,
      streamer: row.streamer,
      game: await ensureGame(ctx, gameForMoment(row.chapters, {...candidate,peak:sourceOffset+candidate.peak}, row.game)),
      segmentKey: segment, version, file: name, mediaStorage,
      // Explicit test batches remain drafts; ordinary automation no longer
      // needs a human checkbox for every clip. Audio claims are independent.
      state: payload.testBatch || (adsSettings.enabled&&!protection.ads.automatic) ? 'draft' : 'ready',
      trigger, peak: sourceOffset+candidate.peak, start: sourceOffset+candidate.start, end: sourceOffset+candidate.end,
      duration: candidate.end - candidate.start, score: candidate.score,
      parts: candidate.parts, keywords: candidate.keywords, text: candidate.text,
      width: media?.width ?? 1080, height: media?.height ?? 1920,
      fps: media?.fps ?? 30,
      sizeBytes: size,
    }).onConflictDoUpdate({ target: clipsTable.id, set: { runId, file: name, mediaStorage, sizeBytes: size,
      state:payload.testBatch || (adsSettings.enabled&&!protection.ads.automatic)?'draft':'ready', archivedAt:null, archiveReason:null } });
    rendered += 1;
    accepted += 1;
    replaced += await dropSuperseded(ctx, row.id, segment, version, report);
  };

  // Пул: каждый исполнитель берёт следующий индекс, пока не кончатся.
  let cursor = 0;
  let inFlight = 0;
  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      for (;;) {
        if (resourceFailure || await report.cancelled()) return;
        if (accepted+inFlight >= count) return;
        const index = cursor++;
        if (index >= picked.length) return;
        inFlight++;
        try { await renderOne(index); } catch (error) {
          if (/недостаточно памяти|cannot allocate memory|out of memory|MemoryError|malloc of size|bad_alloc/i.test(String(error))) resourceFailure=true;
          failures.push(String(error));
          report.log(`Ошибка клипа ${index + 1}: ${String(error)}`);
        } finally {
          inFlight--;
        }
      }
    }),
  );

  await ctx.db.update(runs).set({ finishedAt: new Date(),
    settings:sql`${runs.settings} || ${JSON.stringify({renderedClips:verifications,qualityRejected:rejected})}::jsonb`,
  }).where(eq(runs.id, runId));
  if (await report.cancelled()) {
    report.log(`остановлено по запросу: успели ${rendered} из ${picked.length}`);
  }
  report.log(`отрендерено ${rendered}, заменено ${replaced}, пропущено ${skipped}`);
  if (failures.length) throw new Error(`Не созданы ${failures.length} из ${picked.length} клипов: ${failures.slice(0, 3).join("; ")}`);
  if (!accepted && rejected) throw new Error(`Проверены ${rejected} моментов: фрагменты не прошли проверку камеры или рекламы. Клипы не созданы.`);
  return { runId, rendered, skipped, replaced };
}

/** Игра на момент пика: на многоигровом эфире клипы принадлежат разным. */
function gameForMoment(
  chapters: VodChapter[],
  candidate: Candidate,
  fallback: string | null,
): string {
  const chapter = chapters.find((c) => c.start <= candidate.peak && candidate.peak < c.end);
  return chapter?.title ?? fallback ?? "";
}

/**
 * Убрать неопубликованные версии того же отрезка.
 *
 * Неопубликованный клип - черновик, и новая версия его заменяет.
 * Опубликованный трогать нельзя: он уже на площадке, и подменить его
 * локальным файлом невозможно.
 */
async function dropSuperseded(
  ctx: Context,
  vodId: string,
  segment: string,
  version: string,
  report: JobReport,
): Promise<number> {
  const older = await ctx.db
    .select()
    .from(clipsTable)
    .where(and(eq(clipsTable.vodId, vodId), eq(clipsTable.segmentKey, segment), isNull(clipsTable.archivedAt)));

  let removed = 0;
  for (const clip of older) {
    if (clip.version === version) continue;
    const published = await ctx.db.execute(
      sql`SELECT 1 FROM publications WHERE clip_id = ${clip.id} LIMIT 1`,
    );
    if (published.length > 0) continue;

    await ctx.db.delete(clipsTable).where(eq(clipsTable.id, clip.id));
    removed += 1;
    report.log(`      заменена версия ${clip.version || "без версии"}`);
  }
  return removed;
}

// --- весь конвейер одной цепочкой ----------------------------------------

/**
 * Прогнать эфир от загрузки до клипов.
 *
 * Шаги вызываются здесь, а не ставятся пятью заданиями в очередь. Причина
 * в том, что очереди heavy.* - разные, и pg-boss обслуживает их
 * независимо: поставленные разом задания стартуют одновременно, и рендер
 * падает, не дождавшись сигналов. Порядок должен быть выражен явно.
 *
 * Каждый шаг идемпотентен, поэтому повторный запуск по тому же эфиру
 * пропускает готовое и доделывает недостающее.
 */
export async function runPipeline(
  ctx: Context,
  payload: { vodId: string; count?: number; reuse: boolean; skipExisting?:boolean; audioMode?:'original'|'dtln'|'dtln-gated'; testBatch?:boolean },
  report: JobReport,
): Promise<{ runId: string; rendered: number; skipped: number }> {
  const force = !payload.reuse;

  // Между шагами - естественные границы для остановки: ничего не
  // обрывается на середине, уже сделанное остаётся в кэше.
  const stopped = async () => {
    if (!(await report.cancelled())) return false;
    report.log("остановлено по запросу");
    return true;
  };

  report.log("шаг 1/5: исходники");
  await fetchVod(ctx, { vodId: payload.vodId, audioOnly: false }, report);
  if (await stopped()) return { runId: "", rendered: 0, skipped: 0 };

  report.log("шаг 2/5: распознавание речи");
  await transcribeVod(ctx, { vodId: payload.vodId, force }, report);
  if (await stopped()) return { runId: "", rendered: 0, skipped: 0 };

  report.log("шаг 3/5: сигналы звука");
  await analyzeVod(ctx, { vodId: payload.vodId, force }, report);
  if (await stopped()) return { runId: "", rendered: 0, skipped: 0 };

  report.log("шаг 4/5: поиск камеры");
  await facecamVod(ctx, { vodId: payload.vodId, force }, report);
  if (await stopped()) return { runId: "", rendered: 0, skipped: 0 };

  report.log("шаг 5/5: нарезка");
  const result = await renderRun(
    ctx,
    { vodId: payload.vodId, ...(payload.count ? { count: payload.count } : {}),
      ...(payload.audioMode ? {audioMode:payload.audioMode} : {}),
      ...(payload.skipExisting ? {skipExisting:true} : {}),
      ...(payload.testBatch ? {testBatch:true} : {}) },
    report,
  );
  return { runId: result.runId, rendered: result.rendered, skipped: result.skipped };
}
