/**
 * Раскладка файлов: игра -> стример -> эфир.
 *
 *     data/games/<игра>/<стример>/<vod>/
 *         audio.m4a
 *         video_720p60.mp4
 *         signals.f32
 *
 *     out/<игра>/<стример>/<vod>/<прогон>/
 *         001_combat_28.mp4
 *
 * Игра идёт верхним уровнем не для красоты: у шутера и MOBA разные
 * триггеры, разный словарь терминов и разная аудитория. Смешивать их в
 * одной куче значит потом не суметь сравнить, что работает.
 *
 * **На диске лежит только тяжёлое.** Метаданные эфира, расшифровка,
 * результат поиска камеры и реестр клипов живут в базе - ими владеет
 * бэкенд. Раньше рядом с видео валялись info.json, transcript.json и
 * facecam.json, и правда о состоянии эфира была размазана между файлами
 * и базой.
 *
 * Пути нигде не собираются вручную, только здесь. Иначе при следующем
 * изменении раскладки придётся искать склейки строк по всему коду.
 */
import { randomBytes } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

/** Имя, пригодное для файловой системы. */
export function safeName(value: string): string {
  const cleaned = (value ?? "")
    .trim()
    .toLowerCase()
    // \w в JavaScript не знает кириллицы, поэтому явные классы Unicode.
    .replace(/[^\p{L}\p{N}._-]+/gu, "_")
    .replace(/^_+|_+$/g, "");
  return cleaned || "unknown";
}

export interface Roots {
  data: string;
  out: string;
}

export interface WorkspaceKey {
  game: string;
  streamer: string;
  vodId: string;
}

export class Workspace {
  readonly game: string;
  readonly streamer: string;
  readonly vodId: string;
  readonly root: string;
  readonly outRoot: string;

  constructor(roots: Roots, key: WorkspaceKey) {
    this.game = safeName(key.game || "unknown");
    this.streamer = safeName(key.streamer);
    this.vodId = key.vodId;
    this.root = join(roots.data, "games", this.game, this.streamer, this.vodId);
    this.outRoot = join(roots.out, this.game, this.streamer, this.vodId);
  }

  get audio(): string {
    return join(this.root, "audio.m4a");
  }

  video(format: string): string {
    return join(this.root, `video_${safeName(format)}.mp4`);
  }

  /** Бинарник с рядами сигналов - его пишет python-воркер. */
  get signals(): string {
    return join(this.root, "signals.f32");
  }

  runDir(runId: string): string {
    return join(this.outRoot, runId);
  }

  clipPath(runId: string, file: string): string {
    return join(this.outRoot, runId, file);
  }

  async prepare(): Promise<this> {
    await mkdir(this.root, { recursive: true });
    await mkdir(this.outRoot, { recursive: true });
    return this;
  }
}

/**
 * Идентификатор прогона - его время. По нему видно, когда он был, и
 * порядок прогонов не зависит от отдельного поля.
 */
export function newRunId(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}` +
    `-${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}-${randomBytes(3).toString("hex")}`
  );
}

/** Имя файла клипа: номер, триггер и секунда пика. */
export const clipFileName = (index: number, trigger: string, peak: number): string =>
  `${String(index).padStart(3, "0")}_${trigger}_${Math.trunc(peak)}.mp4`;
