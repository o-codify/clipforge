/**
 * Протокол общения с python-воркером.
 *
 * Python оставлен ровно там, где он действительно сильнее: распознавание
 * речи (faster-whisper на CUDA), спектральный анализ звука (numpy) и
 * поиск вебки (OpenCV). Всё остальное - оркестрация, ffmpeg, субтитры,
 * детекция - живёт в TypeScript, потому что там нет ни одной задачи, где
 * Python давал бы преимущество.
 *
 * Воркер - долгоживущий процесс, а не запуск на задание. Модель
 * large-v3 грузится двадцать секунд и занимает пару гигабайт видеопамяти;
 * поднимать её заново на каждый эфир бессмысленно.
 *
 * Обмен - NDJSON по stdin/stdout: строка на сообщение. Числовые массивы
 * через трубу не гоняются: восемьдесят тысяч кадров на девять рядов в
 * JSON - это десятки мегабайт на разбор. Воркер кладёт их в бинарный
 * файл, а сюда возвращает путь и раскладку.
 *
 * Воркер НЕ ходит в базу и ничего не знает о доменной модели. Он получает
 * пути к файлам и возвращает числа. Решает, что с ними делать, бэкенд.
 */
import { z } from "zod";

// --- общие части ----------------------------------------------------

export const workerErrorSchema = z.object({
  type: z.string(),
  message: z.string(),
  traceback: z.string().optional(),
});
export type WorkerError = z.infer<typeof workerErrorSchema>;

/** Сообщения, приходящие по ходу работы, а не в конце. */
export const workerEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal("log"),
    id: z.string(),
    level: z.enum(["debug", "info", "warning", "error"]),
    message: z.string(),
  }),
  z.object({
    event: z.literal("progress"),
    id: z.string(),
    stage: z.string(),
    /** Доля выполнения. null - неизвестна: врать процентами не нужно. */
    value: z.number().min(0).max(1).nullable(),
  }),
]);
export type WorkerEvent = z.infer<typeof workerEventSchema>;

// --- ping -----------------------------------------------------------

export const pingResultSchema = z.object({
  worker: z.string(),
  python: z.string(),
  torchCuda: z.boolean(),
  device: z.string(),
  loaded: z.array(z.string()),
});
export type PingResult = z.infer<typeof pingResultSchema>;

// --- распознавание речи ---------------------------------------------

export const transcribeParamsSchema = z.object({
  audio: z.string(),
  language: z.string().default("ru"),
  model: z.string().default("large-v3"),
  batchSize: z.number().int().min(1).max(64).default(32),
  /** Замер на игровом жаргоне: beam=5 хуже, чем beam=1. См. DECISIONS. */
  beamSize: z.number().int().min(1).max(5).default(1),
  /** Словарь терминов игры: смещает декодер в их сторону. */
  glossary: z.array(z.string()).default([]),
});
export type TranscribeParams = z.input<typeof transcribeParamsSchema>;

export const wordSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
});

export const segmentSchema = z.object({
  start: z.number(),
  end: z.number(),
  text: z.string(),
  words: z.array(wordSchema),
});

export const transcribeResultSchema = z.object({
  language: z.string(),
  duration: z.number(),
  segments: z.array(segmentSchema),
  /** Сколько повторяющихся кусков выкинул фильтр петель. */
  droppedLoops: z.number().int().default(0),
});
export type TranscribeResult = z.infer<typeof transcribeResultSchema>;

// --- сигналы звука ---------------------------------------------------

/**
 * Порядок рядов в бинарном файле. Менять только вместе с воркером:
 * файл не самоописателен, раскладка задаётся здесь.
 */
export const SIGNAL_SERIES = [
  "times",
  "rmsDb",
  "loudnessRel",
  "flux",
  "onsetRate",
  "hfRatio",
  "voiceRatio",
  "rhythm",
  "combat",
] as const;
export type SignalSeries = (typeof SIGNAL_SERIES)[number];

export const audioSignalsParamsSchema = z.object({
  audio: z.string(),
  /** Куда положить бинарник с рядами. */
  out: z.string(),
  hopSeconds: z.number().positive().default(0.05),
  baselineSeconds: z.number().positive().default(45),
});
export type AudioSignalsParams = z.input<typeof audioSignalsParamsSchema>;

export const audioSignalsResultSchema = z.object({
  file: z.string(),
  frames: z.number().int(),
  hopSeconds: z.number(),
  duration: z.number(),
  /** float32, little-endian, ряд за рядом в порядке series. */
  series: z.array(z.enum(SIGNAL_SERIES)),
  dtype: z.literal("float32"),
});
export type AudioSignalsResult = z.infer<typeof audioSignalsResultSchema>;

// --- поиск вебки -----------------------------------------------------

export const rectSchema = z.object({
  x: z.number().int(),
  y: z.number().int(),
  w: z.number().int(),
  h: z.number().int(),
});
export type Rect = z.infer<typeof rectSchema>;

export const facecamParamsSchema = z.object({
  video: z.string(),
  game: z.string().optional(),
  /** Модель YuNet. Путь даёт бэкенд: воркер раскладку проекта не знает. */
  modelPath: z.string(),
  samples: z.number().int().min(5).max(200).default(40),
  minHitRatio: z.number().min(0).max(1).default(0.7),
  referenceRect: rectSchema.optional(),
  start: z.number().nonnegative().optional(),
  end: z.number().positive().optional(),
});
export type FacecamParams = z.input<typeof facecamParamsSchema>;

export const facecamResultSchema = z.object({
  found: z.boolean(),
  rect: rectSchema.nullable(),
  face: rectSchema.nullable(),
  confidence: z.number(),
  samples: z.number().int(),
  hits: z.number().int(),
  tracked: z.number().int().default(0),
  safeWindows: z.array(z.object({start:z.number(),end:z.number()})).default([]),
  note: z.string(),
});
export type FacecamResult = z.infer<typeof facecamResultSchema>;

export const minimapParamsSchema = z.object({
  video: z.string(), game: z.string(), start: z.number().nonnegative(), end: z.number().positive(),
  samples: z.number().int().min(3).max(200).default(12),
  excludeRect: rectSchema.optional(),
});
export const minimapResultSchema = z.object({
  found: z.boolean(), rect: rectSchema.nullable(), confidence: z.number(),
  hits: z.number().int(), samples: z.number().int(), profile: z.string(), note: z.string(),
  evidence: z.record(z.unknown()),
});

// --- реестр операций --------------------------------------------------
export const prepareMediaParamsSchema = z.object({
  video:z.string(), start:z.number().nonnegative(), end:z.number().positive(), transcript:z.string().default(''),
  regions:z.array(rectSchema).max(32).default([]),
  adProfile:z.record(z.unknown()).optional(),
  adCheckEnabled:z.boolean().default(true),
  speechSpans:z.array(z.tuple([z.number().nonnegative(),z.number().positive()])).optional(),
  audioMode:z.enum(['original','dtln','dtln-gated']).optional(),
  audioOut:z.string().optional(), models:z.string().optional(),
});
export const prepareMediaResultSchema = z.object({
  audio:z.discriminatedUnion('method',[
    z.object({method:z.literal('original')}),
    z.object({method:z.literal('dtln'),file:z.string().min(1),speechGated:z.boolean(),
      duration:z.number(),rmsBefore:z.number(),rmsAfter:z.number()}),
  ]),
  ads:z.object({regions:z.array(rectSchema),qrHits:z.number(),bannerHits:z.number(),frames:z.number(),coverage:z.number(),
    reject:z.boolean(),reason:z.string().nullable(),requiresReview:z.boolean(),sampleFps:z.number(),ocrFps:z.number(),
    profileId:z.string().optional(),profileFrames:z.number().optional(),automatic:z.boolean().optional(),enabled:z.boolean().optional()}),
});

export const adProfileSchema = z.object({signature:z.string(),version:z.string(),model:z.string(),
  reviewVersion:z.number().int(),
  complete:z.literal(true),width:z.number(),height:z.number(),duration:z.number(),
  samples:z.number().int().min(6),regions:z.array(rectSchema).max(32),
  qrHits:z.number(),bannerHits:z.number(),coverage:z.number().max(.3),
  evidence:z.array(z.unknown()),framesDirectory:z.string()});

export const workerOps = {
  profileAds: {params:z.object({video:z.string(),directory:z.string(),cached:z.record(z.unknown()).nullable().optional()}),result:adProfileSchema},
  ping: { params: z.object({}), result: pingResultSchema },
  transcribe: { params: transcribeParamsSchema, result: transcribeResultSchema },
  cachedTranscript: { params: transcribeParamsSchema, result: transcribeResultSchema.nullable() },
  audioSignals: { params: audioSignalsParamsSchema, result: audioSignalsResultSchema },
  facecam: { params: facecamParamsSchema, result: facecamResultSchema },
  minimap: { params: minimapParamsSchema, result: minimapResultSchema },
  prepareMedia: { params: prepareMediaParamsSchema, result: prepareMediaResultSchema },
  cleanClip: { params:prepareMediaParamsSchema.extend({out:z.string()}), result:prepareMediaResultSchema.extend({file:z.string()}) },
} as const;

export type WorkerOp = keyof typeof workerOps;

export const workerRequestSchema = z.object({
  id: z.string(),
  op: z.enum(["ping", "transcribe", "cachedTranscript", "audioSignals", "facecam", "minimap", "prepareMedia", "cleanClip", "profileAds"]),
  params: z.record(z.unknown()),
});
export type WorkerRequest = z.infer<typeof workerRequestSchema>;

export const workerResponseSchema = z.union([
  z.object({ id: z.string(), ok: z.literal(true), result: z.unknown() }),
  z.object({ id: z.string(), ok: z.literal(false), error: workerErrorSchema }),
]);
export type WorkerResponse = z.infer<typeof workerResponseSchema>;

/** Строка от воркера: либо событие по ходу дела, либо итог. */
export const workerMessageSchema = z.union([
  workerEventSchema,
  workerResponseSchema,
]);
export type WorkerMessage = z.infer<typeof workerMessageSchema>;
