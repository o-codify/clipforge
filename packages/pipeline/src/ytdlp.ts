/**
 * Получение эфиров с Twitch через yt-dlp.
 *
 * yt-dlp остался в проекте несмотря на переезд с Python: это отдельный
 * исполняемый файл, а не библиотека, и запускать его может кто угодно.
 * Аналога такого качества в экосистеме Node нет, писать свой разбор HLS
 * от Twitch - заведомо проигранная гонка с их изменениями.
 *
 * Для детекции скачивается ТОЛЬКО аудиодорожка: четыре часа звука - это
 * десятки мегабайт против десятков гигабайт видео. Картинка нужна позже
 * и только под те куски, что пойдут в рендер.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import { createInterface } from "node:readline";
import { dirname, extname, join } from "node:path";

export interface YtDlpOptions {
  /** Как запускать: "yt-dlp" или python -m yt_dlp. */
  command?: string;
  args?: string[];
}

const base = (options: YtDlpOptions = {}): [string, string[]] => [
  options.command ?? "yt-dlp",
  [...(options.args ?? []), "--no-update"],
];

export interface RunResult {
  code: number;
  lines: string[];
}

/** Запустить yt-dlp, отдавая строки вывода по мере появления. */
function run(
  command: string,
  args: string[],
  onLine?: (line: string) => void,
  timeoutMs = 7_200_000,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const tail: string[] = [];

    const reader = createInterface({ input: child.stdout });
    reader.on("line", (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;
      tail.push(trimmed);
      if (tail.length > 200) tail.shift();
      onLine?.(trimmed);
    });
    createInterface({ input: child.stderr }).on("line", (line) => {
      const trimmed = line.trim();
      if (trimmed) tail.push(trimmed);
    });

    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`таймаут yt-dlp (${timeoutMs} мс)`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, lines: tail });
    });
  });
}

/** Принять и id (v123), и полную ссылку. */
export const vodUrl = (video: string): string =>
  video.startsWith("http")
    ? video
    : `https://www.twitch.tv/videos/${video.replace(/^v/, "")}`;

export const channelUrl = (login: string): string =>
  `https://www.twitch.tv/${login.replace(/\/+$/, "").split("/").pop()}/videos?filter=archives`;

// --- список архивов ----------------------------------------------------

export interface ArchiveEntry {
  id: string;
  title: string;
  duration: number;
  uploadDate: string;
  url: string;
}

/**
 * Архивы канала, свежие первыми.
 *
 * Плоский список: он быстрый и не требует запроса на каждый эфир. Главы
 * тут недоступны - за ними нужен отдельный запрос по эфиру (fetchVodInfo).
 */
export async function listArchives(
  login: string,
  limit = 20,
  options: YtDlpOptions = {},
): Promise<ArchiveEntry[]> {
  const [command, args] = base(options);
  const found: ArchiveEntry[] = [];

  const result = await run(
    command,
    [
      ...args,
      "--flat-playlist",
      "--playlist-end", String(limit),
      "--print", "%(id)s\t%(title)s\t%(duration)s\t%(upload_date)s\t%(url)s",
      channelUrl(login),
    ],
    (line) => {
      const parts = line.split("\t");
      if (parts.length < 5 || !parts[0]!.startsWith("v")) return;
      const [id, title, duration, uploadDate, url] = parts as [string, string, string, string, string];
      found.push({
        id,
        title,
        duration: Number.parseFloat(duration) || 0,
        // Twitch нередко отдаёт "NA" вместо даты.
        uploadDate: /^\d{8}$/.test(uploadDate) ? uploadDate : "",
        url,
      });
    },
    180_000,
  );

  if (found.length === 0 && result.code !== 0) {
    throw new Error(`не удалось получить архивы ${login}:\n${result.lines.slice(-5).join("\n")}`);
  }
  return found;
}

// --- метаданные эфира ---------------------------------------------------

export interface VodChapter {
  title: string;
  start: number;
  end: number;
}

export interface VodInfo {
  id: string;
  uploader: string;
  login: string;
  title: string;
  duration: number;
  /** Во что играли и когда. На эфире игр может быть несколько. */
  chapters: VodChapter[];
  url: string;
  publishedAt: string | null;
}

/** Игра эфира: та, в которую играли дольше всего. */
export function mainGame(info: VodInfo): string {
  if (info.chapters.length === 0) return "";
  return info.chapters.reduce((best, chapter) =>
    chapter.end - chapter.start > best.end - best.start ? chapter : best,
  ).title;
}

/** Игра на конкретной секунде эфира. */
export function gameAt(info: VodInfo, moment: number): string {
  const chapter = info.chapters.find((c) => c.start <= moment && moment < c.end);
  return chapter?.title ?? mainGame(info);
}

/**
 * Метаданные эфира вместе с главами.
 *
 * Именно `-J` с разбором полного JSON: через `--print` главы недоступны,
 * а без них неизвестно, во что играли - то есть неизвестен верхний
 * уровень всей раскладки.
 */
export async function fetchVodInfo(
  video: string,
  options: YtDlpOptions = {},
): Promise<VodInfo> {
  const [command, args] = base(options);
  const chunks: string[] = [];
  const result = await run(
    command,
    [...args, "--skip-download", "-J", vodUrl(video)],
    (line) => chunks.push(line),
    300_000,
  );

  if (result.code !== 0 && chunks.length === 0) {
    throw new Error(`не удалось получить метаданные ${video}:\n${result.lines.slice(-5).join("\n")}`);
  }

  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(chunks.join(""));
  } catch (error) {
    throw new Error(`yt-dlp вернул не JSON для ${video}: ${String(error)}`);
  }

  const chapters = Array.isArray(raw.chapters)
    ? (raw.chapters as Record<string, unknown>[]).map((c) => ({
        title: String(c.title ?? ""),
        start: Number(c.start_time ?? 0),
        end: Number(c.end_time ?? 0),
      }))
    : [];

  const timestamp = Number(raw.timestamp ?? 0);
  return {
    id: String(raw.id ?? video),
    uploader: String(raw.uploader ?? ""),
    login: String(raw.uploader_id ?? raw.channel_id ?? raw.uploader ?? "").toLowerCase(),
    title: String(raw.title ?? ""),
    duration: Number(raw.duration ?? 0),
    chapters,
    url: String(raw.webpage_url ?? vodUrl(video)),
    publishedAt: timestamp > 0 ? new Date(timestamp * 1000).toISOString() : null,
  };
}

// --- загрузка ------------------------------------------------------------

export interface DownloadProgress {
  percent: number | null;
  line: string;
}

/** Разобрать строку прогресса yt-dlp. */
function parseProgress(line: string): DownloadProgress {
  const match = /(\d+(?:\.\d+)?)%/.exec(line);
  return { percent: match ? Number(match[1]) : null, line };
}

async function findDownloaded(
  target: string,
  extensions: readonly string[],
): Promise<string | null> {
  if (existsSync(target)) return target;
  // yt-dlp мог сохранить под другим расширением.
  const dir = dirname(target);
  const stem = target.slice(dir.length + 1).replace(/\.[^.]+$/, "");
  try {
    for (const name of await readdir(dir)) {
      if (name.startsWith(stem) && extensions.includes(extname(name).toLowerCase())) {
        return join(dir, name);
      }
    }
  } catch {
    // Каталога может не быть, если загрузка не началась.
  }
  return null;
}

export interface DownloadOptions extends YtDlpOptions {
  /** Decimal kilobits per second, shared heavy lane uses one media download. */
  rateLimitKbps?: number;
  onProgress?: (progress: DownloadProgress) => void;
  /** Отрезок в секундах - удобно гонять конвейер на десяти минутах. */
  section?: [number, number];
}

/** Скачать аудиодорожку эфира в m4a. */
export async function downloadAudio(
  video: string,
  target: string,
  options: DownloadOptions = {},
): Promise<string> {
  const existing = await fileIfReady(target);
  if (existing) return existing;

  await mkdir(dirname(target), { recursive: true });
  const [command, args] = base(options);
  const stem = target.replace(/\.[^.]+$/, "");

  const extra: string[] = [];
  if (options.section) {
    const [from, to] = options.section;
    extra.push("--download-sections", `*${from}-${to}`, "--force-keyframes-at-cuts");
  }

  const result = await run(
    command,
    [
      ...args,
      "-f", "bestaudio",
      "--limit-rate", String(Math.floor((options.rateLimitKbps ?? 40000) * 1000 / 8)),
      "-N", "1",
      "--extract-audio", "--audio-format", "m4a",
      "-o", `${stem}.%(ext)s`,
      "--newline",
      ...extra,
      vodUrl(video),
    ],
    (line) => {
      if (line.includes("%") || line.includes("Destination")) {
        options.onProgress?.(parseProgress(line));
      }
    },
  );

  const found = await findDownloaded(target, [".m4a", ".mp4", ".webm", ".opus", ".aac"]);
  if (!found) {
    throw new Error(`не удалось скачать аудио ${video}:\n${result.lines.slice(-5).join("\n")}`);
  }
  return found;
}

/**
 * Скачать видеодорожку эфира целиком.
 *
 * Целиком, а не кусками под каждый клип: Twitch отдаёт HLS, и тридцать
 * отдельных загрузок с перемоткой выходят кратно дольше одной сплошной.
 * Нарезка потом делается локально, ffmpeg-ом.
 */
export async function downloadVideo(
  video: string,
  target: string,
  format = "720p60",
  _concurrentFragments = 1,
  options: DownloadOptions = {},
): Promise<string> {
  const existing = await fileIfReady(target);
  if (existing) return existing;

  await mkdir(dirname(target), { recursive: true });
  const [command, args] = base(options);

  const result = await run(
    command,
    [
      ...args,
      "-f", format,
      // Один фрагмент за раз: лимит скорости не умножается числом соединений.
      "-N", "1",
      "--limit-rate", String(Math.floor((options.rateLimitKbps ?? 40000) * 1000 / 8)),
      "-o", target,
      "--newline",
      vodUrl(video),
    ],
    (line) => {
      if (line.includes("%") || line.includes("Destination")) {
        options.onProgress?.(parseProgress(line));
      }
    },
  );

  const found = await findDownloaded(target, [".mp4", ".mkv", ".ts", ".webm"]);
  if (!found) {
    throw new Error(
      `не удалось скачать видео ${video} в формате ${format}:\n${result.lines.slice(-5).join("\n")}`,
    );
  }
  return found;
}

/** Файл уже скачан и не пуст? */
async function fileIfReady(path: string): Promise<string | null> {
  try {
    const info = await stat(path);
    return info.size > 0 ? path : null;
  } catch {
    return null;
  }
}
