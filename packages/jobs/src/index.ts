/**
 * Очередь заданий.
 *
 * Очередь живёт в том же Postgres, что и данные (pg-boss). Отдельный
 * Redis на одной машине - это лишний демон и лишний источник отказов, а
 * выигрыш появился бы только на нагрузке, которой здесь нет.
 *
 * Здесь только имена очередей и формы полезной нагрузки. Их импортируют
 * обе стороны: бэкенд, который ставит задания, и воркер, который их
 * выполняет. Схема одна, поэтому расхождение всплывает при сборке, а не
 * в рантайме.
 */
import { z } from "zod";

/**
 * Очереди разведены по тому, за что борются задания.
 *
 * heavy - загрузка, распознавание, рендер: упираются в диск, сеть и
 * видеокарту. Префикс не даёт последовательности сам по себе: это
 * РАЗНЫЕ очереди, и pg-boss обслуживает их независимо. Порядок
 * обеспечивают две вещи - общий замок в воркере (одно тяжёлое задание в
 * процессе) и очередь pipeline, которая вызывает шаги по очереди.
 *
 * Первая версия полагалась на «очередь одна, значит по порядку», и все
 * пять шагов стартовали одновременно: рендер упал через ноль секунд,
 * потому что сигналов ещё не было.
 *
 * light - метаданные, индексация канала, опрос статуса: секунды работы,
 * и они не должны стоять за часовой загрузкой.
 */
export const QUEUES = {
  indexChannel: "light.index-channel",
  fetchVodInfo: "light.fetch-vod-info",
  refreshStreamer: "light.refresh-streamer",

  /** Весь конвейер по эфиру: шаги вызываются по порядку, внутри одного задания. */
  pipeline: "heavy.pipeline",
  fetchVod: "heavy.fetch-vod",
  transcribeVod: "heavy.transcribe-vod",
  analyzeVod: "heavy.analyze-vod",
  facecamVod: "heavy.facecam-vod",
  renderRun: "heavy.render-run",
  // Separate queue: older workers silently strip unknown render options.
  renderVariant: "heavy.render-variant",
  cleanClip: "heavy.clean-clip",
  inspectAds: "heavy.inspect-ads",

  /**
   * Публикация клипа на площадку. Лёгкая очередь: загрузка ждёт сеть,
   * а не видеокарту, и не должна стоять за часовым рендером.
   */
  publishClip: "light.publish-clip",
  refreshYoutube: "light.refresh-youtube",
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export const isHeavy = (queue: QueueName): boolean => queue.startsWith("heavy.");

// --- полезная нагрузка --------------------------------------------------

export const indexChannelPayload = z.object({
  login: z.string().min(1),
  limit: z.number().int().min(1).max(100).default(20),
  /**
   * Запрашивать ли главы у каждого эфира. Это отдельный запрос на эфир,
   * поэтому при первом обходе канала он не делается: сначала дёшево
   * узнаём, что вообще есть, потом уточняем.
   */
  withChapters: z.boolean().default(false),
});
export type IndexChannelPayload = z.input<typeof indexChannelPayload>;

export const fetchVodInfoPayload = z.object({
  vodId: z.string().min(1),
});

export const refreshStreamerPayload = z.object({
  login: z.string().min(1),
});

export const fetchVodPayload = z.object({
  vodId: z.string().min(1),
  audioOnly: z.boolean().default(false),
});

export const transcribeVodPayload = z.object({
  vodId: z.string().min(1),
  force: z.boolean().default(false),
});

export const analyzeVodPayload = z.object({
  vodId: z.string().min(1),
  force: z.boolean().default(false),
});

export const facecamVodPayload = z.object({
  vodId: z.string().min(1),
  force: z.boolean().default(false),
});

/**
 * count не обязателен и по умолчанию не задан.
 *
 * Без него режется каждый найденный момент - в этом и смысл: много
 * клипов по разным триггерам, чтобы потом было что сравнивать. Число
 * ставится только для быстрой пробы.
 */
export const renderRunPayload = z.object({
  vodId: z.string().min(1),
  count: z.number().int().min(1).max(500).optional(),
  skipExisting: z.boolean().optional(),
  /** Optional per-run override; otherwise resolve VOD, then streamer settings. */
  audioMode: z.enum(['original','dtln']).optional(),
  /** Explicit administrator preview, bounded independently of development mode. */
  testBatch: z.boolean().optional(),
});

export const pipelinePayload = z.object({
  vodId: z.string().min(1),
  count: z.number().int().min(1).max(500).optional(),
  /** Пропустить шаги, результат которых уже есть. По умолчанию да. */
  reuse: z.boolean().default(true),
});

export const publishClipPayload = z.object({
  /** Ряд publications: создаётся бэкендом до постановки задания. */
  publicationId: z.string().min(1),
});
export const refreshYoutubePayload = z.object({
  publicationId: z.string().min(1).max(200).optional(),
}).strict();
export const cleanClipPayload = z.object({
  clipId:z.string().min(1), vodId:z.string().min(1),
  regions:z.array(z.object({x:z.number().int().nonnegative(),y:z.number().int().nonnegative(),
    w:z.number().int().positive(),h:z.number().int().positive()})).max(32).default([]),
});

export const PAYLOADS = {
  [QUEUES.pipeline]: pipelinePayload,
  [QUEUES.indexChannel]: indexChannelPayload,
  [QUEUES.fetchVodInfo]: fetchVodInfoPayload,
  [QUEUES.refreshStreamer]: refreshStreamerPayload,
  [QUEUES.fetchVod]: fetchVodPayload,
  [QUEUES.transcribeVod]: transcribeVodPayload,
  [QUEUES.analyzeVod]: analyzeVodPayload,
  [QUEUES.facecamVod]: facecamVodPayload,
  [QUEUES.renderRun]: renderRunPayload,
  [QUEUES.renderVariant]: renderRunPayload,
  [QUEUES.publishClip]: publishClipPayload,
  [QUEUES.refreshYoutube]: refreshYoutubePayload,
  [QUEUES.cleanClip]: cleanClipPayload,
  [QUEUES.inspectAds]: z.object({vodId:z.string().min(1)}),
} as const;

export type PayloadOf<Q extends QueueName> = z.infer<(typeof PAYLOADS)[Q]>;
export type PayloadInput<Q extends QueueName> = z.input<(typeof PAYLOADS)[Q]>;

/**
 * Ключ, по которому задание считается уже стоящим в очереди.
 *
 * Без него двойной клик по кнопке ставит вторую загрузку того же файла в
 * ту же папку. pg-boss умеет отбрасывать дубли по singletonKey.
 */
export function singletonKey<Q extends QueueName>(
  queue: Q,
  payload: PayloadOf<Q>,
): string {
  if((queue===QUEUES.renderRun || queue===QUEUES.renderVariant) && 'vodId' in payload && ('audioMode' in payload || 'skipExisting' in payload || 'testBatch' in payload)) {
    const render=payload as PayloadOf<typeof QUEUES.renderRun>;
    return `${queue}:${render.vodId}:${render.audioMode??'inherit'}:${render.skipExisting?'fresh':'all'}:${render.count??'default'}:${render.testBatch?'test':'normal'}`;
  }
  const target =
    "clipId" in payload ? `${payload.clipId}:ads-only:${'regions' in payload ? JSON.stringify(payload.regions) : ''}` : "vodId" in payload
      ? payload.vodId
      : "login" in payload
        ? payload.login
        : "publicationId" in payload
          ? payload.publicationId
          : "";
  return `${queue}:${target}`;
}
