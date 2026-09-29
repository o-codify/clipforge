"use client";

/**
 * Обращения к бэкенду.
 *
 * Адрес всегда относительный: запросы идут через собственный адрес
 * фронта и проксируются на бэкенд (см. next.config.ts). Поэтому cookie
 * сессии остаётся своей, и вопрос межисточниковых запросов не встаёт.
 */

export const SESSION_EXPIRED = "clipforge:session-expired";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly issues?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    credentials: "include",
    ...options,
    headers: { "content-type": "application/json", ...options.headers },
  });

  const text = await response.text();
  if (response.status === 401 && path !== "/api/auth/login" && typeof window !== "undefined") {
    window.dispatchEvent(new Event(SESSION_EXPIRED));
  }
  let body: any = null;
  try { body = text ? JSON.parse(text) : null; } catch {
    throw new ApiError("Сервис временно недоступен. Повторите попытку позже.", response.status);
  }

  if (!response.ok) {
    throw new ApiError(
      body?.message ?? response.statusText,
      response.status,
      body?.issues,
    );
  }
  return body as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};

// --- формы данных ------------------------------------------------------

export interface Viewer {
  accountId: string;
  login: string;
  role: "admin" | "moderator" | "user";
  displayName: string;
  actingAs: string | null;
  isAdmin: boolean;
  isPreview?: boolean;
}

export interface GameRow {
  slug: string;
  title: string;
  boxArt: string | null;
  state: string;
  streamers: number;
  vods: number;
  readyVods: number;
  clips: number;
}

export interface StreamerRow {
  login: string;
  displayName: string | null;
  avatar: string | null;
  state: "candidate" | "active" | "paused";
  live: boolean;
  liveGame: string | null;
  liveViewers: number | null;
  followers: number | null;
  lastGame: string | null;
  vods: number;
  readyVods: number;
  clips: number;
}

export interface VodRow {
  id: string;
  streamer: string;
  game: string | null;
  title: string | null;
  duration: number | null;
  state: "known" | "fetching" | "ready" | "failed";
  publishedAt: string | null;
  fetchedAt: string | null;
  hasFacecam: boolean;
  hasSignals: boolean;
  hasTranscript: boolean;
  runs: number;
  clips: number;
}

export interface ClipRow {
  id: string;
  runId: string;
  vodId: string;
  streamer: string;
  game: string | null;
  segmentKey: string;
  version: string;
  file: string;
  trigger: string | null;
  peak: number;
  start: number;
  end: number;
  duration: number;
  score: number;
  parts: Record<string, number>;
  keywords: string[];
  text: string | null;
  width: number;
  height: number;
  fps: number;
  sizeBytes: number;
  state: "draft" | "ready" | "blocked";
  blockedReason: string | null;
  createdAt: string;
  /** Сколько раз опубликован. Список публикаций - только в карточке клипа. */
  publicationCount?: number;
}

export interface JobRow {
  streamer?: string | null;
  avatar?: string | null;
  stage?: string | null;
  objectTitle?: string;
  objectHref?: string | null;
  streamerName?: string | null;
  id: string;
  name: string;
  state: string;
  data: Record<string, unknown>;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  output: unknown;
}

export interface JobGroup extends JobRow {
  runs: number; active:number; waiting:number; completed:number; failed:number; recurring:boolean;
}

export interface Candidate {
  login: string;
  displayName: string;
  viewers: number;
  followers: number;
  archives: number;
  score: number;
  reason: string;
  budget: number;
  connected: boolean;
}

// --- мелкие помощники ---------------------------------------------------

export function hhmm(seconds: number | null | undefined): string {
  const total = Math.max(0, Math.round(seconds ?? 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h
    ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
    : `${m}:${String(s).padStart(2, "0")}`;
}

export function size(bytes: number | null | undefined): string {
  if (!bytes) return "—";
  if (bytes > 1e9) return `${(bytes / 1e9).toFixed(2)} ГБ`;
  if (bytes > 1e6) return `${(bytes / 1e6).toFixed(0)} МБ`;
  if (bytes > 1e3) return `${(bytes / 1e3).toFixed(0)} КБ`;
  return `${bytes} Б`;
}

export function when(iso: string | null | undefined): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString("ru-RU", {
    day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
}

export interface PlatformAccount {
  verifiedAt?: string | null;
  disconnectRequestedAt?: string | null;
  id: string;
  platform: string;
  label: string;
  externalId: string;
  createdAt: string;
}

/** Статусы публикации по-человечески: подпись и тон. */
export const PUB_STATE: Record<string, [string, "" | "ok" | "bad" | "warn"]> = {
  draft: ["Черновик", ""],
  queued: ["В очереди", ""],
  uploading: ["Загружается", "warn"],
  uploaded: ["Загружен", "warn"],
  processing: ["Обрабатывается", "warn"],
  published: ["Опубликован", "ok"],
  failed: ["Сбой", "bad"],
  takedown: ["Снят", "bad"],
};

export const TRIGGERS: Record<string, string> = {
  review: "Проверка оформления",
  combat: "Бой",
  reaction: "Реакция",
  speech: "Речь",
  loudness: "Громко",
  misc: "Разное",
};

/** Идентификатор прогона - это его время: 20260830-213434. */
export function runTime(id: string): string {
  const m = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})(?:-[a-f0-9]+)?$/.exec(id);
  return m ? `${m[3]}.${m[2]} ${m[4]}:${m[5]}` : id;
}

/**
 * Состояние эфира - про исходники на диске, и слова говорят именно это.
 * «В каталоге» и «готов» не читались: готов к чему?
 */
export const VOD_STATE: Record<string, [string, string]> = {
  known: ["Не скачан", ""],
  fetching: ["Скачивается", "warn"],
  ready: ["Скачан", "ok"],
  failed: ["Сбой загрузки", "bad"],
};
