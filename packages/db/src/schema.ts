/**
 * Схема площадки.
 *
 * Сущности и связь между ними:
 *
 *     account          кто зашёл: админ или стример
 *     streamer         канал: кандидат, подключён или на паузе
 *      ├── streamerGame   во что играет и сколько
 *      └── vod         эфир: известен, качается или готов
 *           └── run          прогон нарезки
 *                └── clip    отрендеренный клип
 *                     └── publication   публикация на одной площадке
 *                          └── metrics  снимок статистики
 *
 *     game             игра, в которую играет кто-то из стримеров
 *     automation       настройки автоматики на разных уровнях
 *     discovery        кандидаты, найденные на Twitch
 *
 * Три решения, которые стоит держать в голове при правках.
 *
 * **vod - каталог, а не «скачанное».** Раньше строка появлялась только
 * после первого прогона, поэтому список архивов канала не знал, что уже
 * добавлено, и предлагал добавить одно и то же по второму разу. Теперь
 * эфир заводится сразу при индексации канала и живёт со статусом.
 *
 * **Клип опознаётся парой (segmentKey, version), а не прогоном.** Версия -
 * отпечаток оформления. Повторный прогон с теми же настройками попадает в
 * ту же строку и ничего не дублирует; изменение дизайна заводит новую
 * версию того же момента. Когда id включал прогон, семь прогонов по
 * одному стриму давали семь копий каждого момента.
 *
 * **Метрики пишутся снимками и не перезаписываются.** По одному числу
 * просмотров нельзя понять, набрал клип половину за шесть часов или за
 * неделю, а это лучший предсказатель качества, чем итоговая сумма.
 */
import { relations, sql } from "drizzle-orm";
import {
  boolean,
  bigserial,
  uuid,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

export const platformRuntime = pgTable("platform_runtime", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
export const automationRuns = pgTable("automation_runs", {
  id: uuid("id").primaryKey(),
  name: text("name").notNull(),
  state: text("state").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  output: jsonb("output"),
}, t => [index("automation_runs_name_started_idx").on(t.name, t.startedAt)]);

export const jobEvents = pgTable("job_events", {
  id: bigserial("id", { mode: "number" }).primaryKey(),
  jobId: uuid("job_id").notNull(),
  message: text("message").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, t => [index("job_events_job_idx").on(t.jobId, t.id)]);

// --- перечисления ----------------------------------------------------

export const accountRole = pgEnum("account_role", ["admin", "streamer", "moderator", "user"]);

/** candidate - найден, но не подключён; active - работает автоматика. */
export const streamerState = pgEnum("streamer_state", [
  "candidate",
  "active",
  "paused",
]);

export const gameState = pgEnum("game_state", ["known", "active", "ignored"]);

/** Эфир известен из списка архивов -> качается -> исходники на диске. */
export const vodState = pgEnum("vod_state", [
  "known",
  "fetching",
  "ready",
  "failed",
]);

/**
 * draft   - отрендерен, к публикации не готовили;
 * ready   - одобрен, можно публиковать;
 * blocked - снят: жалоба на авторские права или ручной запрет.
 *
 * Блокировка живёт на клипе, а не на публикации: если на момент прилетела
 * жалоба, его нельзя заливать и на другие площадки тоже.
 */
export const clipState = pgEnum("clip_state", ["draft", "ready", "blocked"]);

/**
 * Загрузка и появление ролика - разные события, между ними площадка
 * обрабатывает файл. Без разделения uploaded и published невозможно
 * отличить «отправили и ждём» от «вышло» и от «обработка упала».
 */
export const publicationStatus = pgEnum("publication_status", [
  "draft",
  "queued",
  "uploading",
  "uploaded",
  "processing",
  "published",
  "failed",
  "takedown",
]);

export const automationScope = pgEnum("automation_scope", [
  "global",
  "game",
  "streamer",
  "pair",
]);

export const discoveryStatus = pgEnum("discovery_status", [
  "new",
  "added",
  "ignored",
]);

// --- аккаунты --------------------------------------------------------

export const accounts = pgTable(
  "accounts",
  {
    id: text("id").primaryKey(),
    login: text("login").notNull(),
    /** scrypt: соль и параметры внутри строки. */
    passwordHash: text("password_hash").notNull(),
    role: accountRole("role").notNull().default("user"),
    /** Для роли streamer: чей канал видит этот аккаунт. */
    streamer: text("streamer"),
    displayName: text("display_name"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
  },
  (t) => [uniqueIndex("accounts_login_key").on(sql`lower(${t.login})`)],
);

export const sessions = pgTable(
  "sessions",
  {
    token: text("token").primaryKey(),
    accountId: text("account_id")
      .notNull()
      .references(() => accounts.id, { onDelete: "cascade" }),
    /**
     * Админ может смотреть площадку глазами стримера. Аккаунт при этом
     * остаётся своим - подменяется только видимость, и в журнале
     * действий видно, кто на самом деле их совершил.
     */
    actingAs: text("acting_as"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [index("sessions_account_idx").on(t.accountId)],
);

// --- стримеры и игры --------------------------------------------------

export const streamers = pgTable(
  "streamers",
  {
    /** Логин на Twitch, он же имя папки. */
    login: text("login").primaryKey(),
    displayName: text("display_name"),
    twitchId: text("twitch_id"),
    avatar: text("avatar"),
    description: text("description"),
    followers: integer("followers"),
    language: text("language"),

    live: boolean("live").notNull().default(false),
    liveGame: text("live_game"),
    liveViewers: integer("live_viewers"),
    lastGame: text("last_game"),

    state: streamerState("state").notNull().default("candidate"),
    /**
     * Публиковать клипы этого стримера самостоятельно. Отдельно от
     * state: обходить канал и резать - одно, выпускать наружу - другое,
     * и включаются они в разные моменты жизни канала.
     */
    autoPublish: boolean("auto_publish").notNull().default(false),
    /** Default for existing and future VODs without their own audio override. */
    audioMode: text("audio_mode").$type<"original" | "dtln">().notNull().default("original"),
    /** manual - завёл админ; discovery - нашла площадка. */
    source: text("source").notNull().default("manual"),

    addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
    /** Когда последний раз спрашивали статус канала. */
    checkedAt: timestamp("checked_at", { withTimezone: true }),
    /** Когда последний раз обновляли список архивов. */
    indexedAt: timestamp("indexed_at", { withTimezone: true }),
  },
  (t) => [index("streamers_state_idx").on(t.state)],
);

export const games = pgTable("games", {
  /** Имя, пригодное для файловой системы: dota_2. */
  slug: text("slug").primaryKey(),
  /** Как называется на Twitch: Dota 2. */
  title: text("title").notNull(),
  twitchId: text("twitch_id"),
  boxArt: text("box_art"),
  state: gameState("state").notNull().default("known"),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Во что играет стример и сколько. Заполняется из глав архивов и из
 * текущего статуса канала: список игр площадки не должен ограничиваться
 * тем, что уже скачано - иначе видно ровно одну игру, ту самую, которую
 * успели обработать.
 */
export const streamerGames = pgTable(
  "streamer_games",
  {
    streamer: text("streamer")
      .notNull()
      .references(() => streamers.login, { onDelete: "cascade" }),
    game: text("game")
      .notNull()
      .references(() => games.slug, { onDelete: "cascade" }),
    seconds: doublePrecision("seconds").notNull().default(0),
    streams: integer("streams").notNull().default(0),
    lastSeen: timestamp("last_seen", { withTimezone: true }),
  },
  (t) => [
    primaryKey({ columns: [t.streamer, t.game] }),
    index("streamer_games_game_idx").on(t.game),
  ],
);

// --- эфиры ------------------------------------------------------------

export const vods = pgTable(
  "vods",
  {
    /** v2859643784 */
    id: text("id").primaryKey(),
    streamer: text("streamer")
      .notNull()
      .references(() => streamers.login, { onDelete: "cascade" }),
    /** Основная игра эфира: та, в которую играли дольше всего. */
    game: text("game").references(() => games.slug, { onDelete: "set null" }),

    title: text("title"),
    duration: doublePrecision("duration"),
    /** Главы VOD: во что играли и когда. На эфире игр может быть несколько. */
    chapters: jsonb("chapters").$type<VodChapter[]>().notNull().default([]),
    /** null inherits the streamer's setting; original explicitly disables DTLN. */
    audioMode: text("audio_mode").$type<"original" | "dtln" | null>(),
    adProtection: jsonb("ad_protection").$type<Record<string, unknown> | null>(),

    state: vodState("state").notNull().default("known"),
    error: text("error"),

    /**
     * Результат поиска вебки: прямоугольник, уверенность, пояснение.
     * Лежит в базе, а не файлом рядом с видео: это решение конвейера, и
     * владеть им должен бэкенд. На диске остаются только те артефакты,
     * которые слишком велики для базы.
     */
    facecam: jsonb("facecam").$type<FacecamInfo | null>(),

    /**
     * Где лежат сигналы звука и какой они формы. Сам массив - бинарный
     * файл: 80 тысяч кадров на девять рядов в jsonb превратились бы в
     * десятки мегабайт текста на каждый разбор.
     */
    signals: jsonb("signals").$type<SignalsInfo | null>(),

    /** Когда эфир прошёл на Twitch, а не когда мы про него узнали. */
    publishedAt: timestamp("published_at", { withTimezone: true }),
    discoveredAt: timestamp("discovered_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    fetchedAt: timestamp("fetched_at", { withTimezone: true }),
  },
  (t) => [
    index("vods_streamer_idx").on(t.streamer),
    index("vods_game_idx").on(t.game),
    index("vods_state_idx").on(t.state),
  ],
);

export interface VodChapter {
  title: string;
  start: number;
  end: number;
}

export interface FacecamInfo {
  detectorVersion?: string;
  found: boolean;
  rect: { x: number; y: number; w: number; h: number } | null;
  confidence: number;
  note: string;
}

export interface SignalsInfo {
  file: string;
  frames: number;
  hopSeconds: number;
  duration: number;
  series: string[];
}

/**
 * Расшифровка речи.
 *
 * Отдельной таблицей, а не файлом: по ней ищут, из неё собираются
 * субтитры и текст клипа, и она должна переживать удаление исходников.
 * Пословные таймкоды - это несколько мегабайт jsonb на эфир, что для
 * Postgres нормально.
 */
export const transcripts = pgTable("transcripts", {
  vodId: text("vod_id")
    .primaryKey()
    .references(() => vods.id, { onDelete: "cascade" }),
  language: text("language").notNull(),
  duration: doublePrecision("duration").notNull(),
  /** Какой моделью распознано: результат от неё заметно зависит. */
  model: text("model").notNull(),
  segments: jsonb("segments").$type<TranscriptSegmentRow[]>().notNull(),
  /** Сколько слов выкинул фильтр зацикливания - диагностика качества. */
  droppedLoops: integer("dropped_loops").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export interface TranscriptSegmentRow {
  start: number;
  end: number;
  text: string;
  words: { start: number; end: number; text: string }[];
}

// --- прогоны и клипы ---------------------------------------------------

export const runs = pgTable(
  "runs",
  {
    id: text("id").primaryKey(),
    vodId: text("vod_id")
      .notNull()
      .references(() => vods.id, { onDelete: "cascade" }),
    streamer: text("streamer").notNull(),
    game: text("game"),

    outDir: text("out_dir").notNull(),
    candidates: integer("candidates").notNull().default(0),
    /** Отпечаток оформления этого прогона. */
    version: text("version").notNull().default(""),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),

    startedAt: timestamp("started_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [index("runs_vod_idx").on(t.vodId)],
);

export const clips = pgTable(
  "clips",
  {
    id: text("id").primaryKey(),
    runId: text("run_id")
      .notNull()
      .references(() => runs.id, { onDelete: "cascade" }),
    vodId: text("vod_id")
      .notNull()
      .references(() => vods.id, { onDelete: "cascade" }),

    /**
     * Стример и игра продублированы сюда намеренно. clips - основная
     * таблица аналитики, и гонять join через runs и vods в каждом
     * разовом запросе неудобно. Пишутся один раз при рендере.
     */
    streamer: text("streamer").notNull(),
    game: text("game"),

    /** Отрезок стрима с точностью до десятой секунды: v123:1160-3920. */
    segmentKey: text("segment_key").notNull(),
    /** Отпечаток оформления. Вместе с segmentKey - настоящий ключ клипа. */
    version: text("version").notNull().default(""),

    file: text("file").notNull(),
    mediaStorage: jsonb("media_storage").$type<{ videoKey: string; posterKey: string } | null>(),
    trigger: text("trigger"),
    peak: doublePrecision("peak"),
    start: doublePrecision("start"),
    end: doublePrecision("end"),
    duration: doublePrecision("duration"),
    score: doublePrecision("score"),
    parts: jsonb("parts").$type<Record<string, number>>().notNull().default({}),
    keywords: jsonb("keywords").$type<string[]>().notNull().default([]),
    text: text("text"),

    width: integer("width"),
    height: integer("height"),
    fps: real("fps"),
    sizeBytes: integer("size_bytes"),

    state: clipState("state").notNull().default("draft"),
    blockedReason: text("blocked_reason"),
    /** Obsolete development renders stay recoverable but leave the catalog. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    archiveReason: text("archive_reason"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    // Настоящий ключ клипа. Повторный прогон с теми же настройками
    // обновляет эту строку, а не заводит соседнюю.
    uniqueIndex("clips_segment_version_key").on(t.vodId, t.segmentKey, t.version),
    index("clips_run_idx").on(t.runId),
    index("clips_streamer_idx").on(t.streamer),
    index("clips_game_idx").on(t.game),
    index("clips_state_idx").on(t.state),
    index("clips_trigger_idx").on(t.trigger),
  ],
);

// --- публикации и метрики ----------------------------------------------

/**
 * Подключённые аккаунты площадок публикации.
 *
 * Один ряд - одно согласие: например, YouTube-канал, на который админ
 * разрешил загрузку. Секреты (refresh token) лежат в credentials -
 * платформа локальная и однопользовательская, отдельное шифрование
 * здесь пока избыточно, но наружу это поле не отдаётся никогда.
 */
export const platformAccounts = pgTable(
  "platform_accounts",
  {
    id: text("id").primaryKey(),
    platform: text("platform").notNull(),
    /** Название канала на площадке - для отображения. */
    label: text("label").notNull().default(""),
    /** Идентификатор канала на площадке. */
    externalId: text("external_id").notNull().default(""),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    disconnectRequestedAt: timestamp("disconnect_requested_at", { withTimezone: true }),
    credentials: jsonb("credentials")
      .$type<Record<string, string>>()
      .notNull()
      .default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [uniqueIndex("platform_accounts_key").on(t.platform, t.externalId)],
);

export const publications = pgTable(
  "publications",
  {
    id: text("id").primaryKey(),
    clipId: text("clip_id")
      .notNull()
      .references(() => clips.id, { onDelete: "cascade" }),

    platform: text("platform").notNull(),
    account: text("account").notNull().default(""),

    /**
     * Идентификаторы разведены намеренно. У Instagram это container_id и
     * media_id, у TikTok publish_id и video_id, у YouTube оба совпадают.
     * Одним полем это не покрыть.
     */
    operationId: text("operation_id"),
    mediaId: text("media_id"),
    url: text("url"),

    status: publicationStatus("status").notNull().default("draft"),
    privacy: text("privacy"),
    title: text("title"),
    caption: text("caption"),

    scheduledAt: timestamp("scheduled_at", { withTimezone: true }),
    publishedAt: timestamp("published_at", { withTimezone: true }),
    error: text("error"),

    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex("publications_target_key").on(t.clipId, t.platform, t.account),
    index("publications_status_idx").on(t.status),
  ],
);

export const publicationMetrics = pgTable(
  "publication_metrics",
  {
    id: text("id").primaryKey(),
    publicationId: text("publication_id")
      .notNull()
      .references(() => publications.id, { onDelete: "cascade" }),
    collectedAt: timestamp("collected_at", { withTimezone: true })
      .notNull()
      .defaultNow(),

    views: integer("views"),
    likes: integer("likes"),
    comments: integer("comments"),
    shares: integer("shares"),

    /** Удержание, досмотры, сохранения - то, что отдают не все площадки. */
    extended: jsonb("extended").$type<Record<string, unknown>>().notNull().default({}),
    /**
     * Ответ API как есть. Площадки меняют поля, и то, что сегодня кажется
     * лишним, через месяц понадобится для ранжирования - пересобрать
     * историю будет уже неоткуда.
     */
    raw: jsonb("raw").$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index("metrics_publication_idx").on(t.publicationId, t.collectedAt)],
);

// --- автоматика --------------------------------------------------------

/**
 * Один и тот же набор полей на разных уровнях: глобально, на игру, на
 * стримера и на пару стример+игра. Действующие значения собираются
 * наложением от общего к частному.
 */
export const automation = pgTable(
  "automation",
  {
    scope: automationScope("scope").notNull(),
    /** '' | game | login | login/game */
    key: text("key").notNull().default(""),
    enabled: boolean("enabled"),
    settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.scope, t.key] })],
);

// --- поиск стримеров ---------------------------------------------------

export const discovery = pgTable(
  "discovery",
  {
    login: text("login").primaryKey(),
    displayName: text("display_name"),
    game: text("game"),
    language: text("language"),
    viewers: integer("viewers"),
    followers: integer("followers"),
    /** Оценка пригодности. Пока формула, потом - обученная модель. */
    score: doublePrecision("score").notNull().default(0),
    reason: text("reason"),
    status: discoveryStatus("status").notNull().default("new"),
    foundAt: timestamp("found_at", { withTimezone: true }).notNull().defaultNow(),
    checkedAt: timestamp("checked_at", { withTimezone: true }),
  },
  (t) => [index("discovery_status_idx").on(t.status, t.score)],
);

// --- связи -------------------------------------------------------------

export const streamerRelations = relations(streamers, ({ many }) => ({
  vods: many(vods),
  games: many(streamerGames),
}));

export const gameRelations = relations(games, ({ many }) => ({
  streamers: many(streamerGames),
  vods: many(vods),
}));

export const streamerGameRelations = relations(streamerGames, ({ one }) => ({
  streamer: one(streamers, {
    fields: [streamerGames.streamer],
    references: [streamers.login],
  }),
  game: one(games, { fields: [streamerGames.game], references: [games.slug] }),
}));

export const vodRelations = relations(vods, ({ one, many }) => ({
  streamer: one(streamers, {
    fields: [vods.streamer],
    references: [streamers.login],
  }),
  game: one(games, { fields: [vods.game], references: [games.slug] }),
  runs: many(runs),
  clips: many(clips),
}));

export const runRelations = relations(runs, ({ one, many }) => ({
  vod: one(vods, { fields: [runs.vodId], references: [vods.id] }),
  clips: many(clips),
}));

export const clipRelations = relations(clips, ({ one, many }) => ({
  run: one(runs, { fields: [clips.runId], references: [runs.id] }),
  vod: one(vods, { fields: [clips.vodId], references: [vods.id] }),
  publications: many(publications),
}));

export const publicationRelations = relations(publications, ({ one, many }) => ({
  clip: one(clips, { fields: [publications.clipId], references: [clips.id] }),
  metrics: many(publicationMetrics),
}));

export const metricRelations = relations(publicationMetrics, ({ one }) => ({
  publication: one(publications, {
    fields: [publicationMetrics.publicationId],
    references: [publications.id],
  }),
}));

export const accountRelations = relations(accounts, ({ many }) => ({
  sessions: many(sessions),
}));

export const sessionRelations = relations(sessions, ({ one }) => ({
  account: one(accounts, {
    fields: [sessions.accountId],
    references: [accounts.id],
  }),
}));

export const pipelineAttempts = pgTable("pipeline_attempts", {
  vodId: text("vod_id").primaryKey().references(() => vods.id, { onDelete: "cascade" }),
  attempts: integer("attempts").notNull().default(0),
  state: text("state").notNull().default("pending"),
  error: text("error"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
