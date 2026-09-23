/**
 * Клиент YouTube Data API v3: OAuth и загрузка роликов.
 *
 * Публикация от имени канала работает только через OAuth-согласие
 * владельца: сервисные аккаунты YouTube для загрузки не поддерживает.
 * Поэтому схема такая: админ один раз проходит согласие в браузере,
 * платформа сохраняет refresh token и дальше обновляет access token
 * сама перед каждой загрузкой.
 *
 * Про Shorts отдельного API нет: YouTube сам помечает вертикальный
 * ролик до трёх минут как Shorts. Наши клипы 1080×1920 и до минуты -
 * подходят как есть.
 *
 * Два ограничения площадки, о которых надо помнить:
 *  - квота по умолчанию 10 000 единиц в день, загрузка стоит 1600 -
 *    это ~6 роликов в сутки, пока Google не расширит квоту по заявке;
 *  - у непроверенного (не прошедшего аудит) проекта Google Cloud все
 *    загруженные через API ролики принудительно остаются приватными.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";

const OAUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const API = "https://www.googleapis.com/youtube/v3";
const UPLOAD = "https://www.googleapis.com/upload/youtube/v3/videos";

export interface VideoSnapshot {
  id: string;
  status: { uploadStatus: string; privacyStatus: string; rejectionReason?: string };
  statistics?: { viewCount?: string; likeCount?: string; commentCount?: string };
}

export async function videoSnapshots(accessToken: string, ids: string[]): Promise<VideoSnapshot[]> {
  if (!ids.length) return [];
  const response = await fetch(`${API}/videos?part=status,statistics&id=${encodeURIComponent(ids.slice(0,50).join(","))}`, {
    signal: AbortSignal.timeout(20_000), headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new Error(`YouTube: получение статистики завершилось с кодом ${response.status}`);
  return ((await response.json()) as { items?: VideoSnapshot[] }).items ?? [];
}

/** Право загружать ролики + прочитать, что это за канал. */
export const SCOPES = [
  "https://www.googleapis.com/auth/youtube.upload",
  "https://www.googleapis.com/auth/youtube.readonly",
];

export interface YoutubeApp {
  clientId: string;
  clientSecret: string;
}

/** Прочитать ключи из окружения. null - публикация не настроена. */
export function appFromEnv(env: NodeJS.ProcessEnv = process.env): YoutubeApp | null {
  const clientId = env.YOUTUBE_CLIENT_ID;
  const clientSecret = env.YOUTUBE_CLIENT_SECRET;
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** Куда отправить админа за согласием. */
export function authUrl(app: YoutubeApp, redirectUri: string, state: string): string {
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: SCOPES.join(" "),
    // Без offline не будет refresh token, без consent Google выдаёт
    // его только при самом первом согласии - а нам нужен всегда.
    access_type: "offline",
    prompt: "consent",
    state,
  });
  return `${OAUTH_BASE}?${params}`;
}

async function tokenRequest(body: Record<string, string>): Promise<{
  access_token: string;
  refresh_token?: string;
}> {
  const response = await fetch(TOKEN_URL, {
    signal: AbortSignal.timeout(20_000),
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });
  if (!response.ok) {
    throw new Error(`google oauth ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  return (await response.json()) as { access_token: string; refresh_token?: string };
}

/** Обменять код согласия на токены. */
export async function exchangeCode(
  app: YoutubeApp,
  redirectUri: string,
  code: string,
): Promise<{ accessToken: string; refreshToken: string }> {
  const data = await tokenRequest({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    grant_type: "authorization_code",
    redirect_uri: redirectUri,
    code,
  });
  if (!data.refresh_token) {
    throw new Error("google не вернул refresh token: согласие давалось раньше без prompt=consent");
  }
  return { accessToken: data.access_token, refreshToken: data.refresh_token };
}

/** Свежий access token из долгоживущего refresh token. */
export async function refreshAccessToken(app: YoutubeApp, refreshToken: string): Promise<string> {
  const data = await tokenRequest({
    client_id: app.clientId,
    client_secret: app.clientSecret,
    grant_type: "refresh_token",
    refresh_token: refreshToken,
  });
  return data.access_token;
}

/** Канал, от имени которого дали согласие. */
export async function myChannel(
  accessToken: string,
): Promise<{ id: string; title: string } | null> {
  const response = await fetch(`${API}/channels?part=snippet&mine=true`, {
    signal: AbortSignal.timeout(20_000),
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) {
    throw new Error(`youtube channels ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    items?: { id: string; snippet: { title: string } }[];
  };
  const item = data.items?.[0];
  return item ? { id: item.id, title: item.snippet.title } : null;
}

export interface UploadOptions {
  file: string;
  title: string;
  description: string;
  tags: string[];
  privacy: "private" | "unlisted" | "public";
}

/**
 * Загрузить ролик. Возвращает id видео.
 *
 * Возобновляемая загрузка в один приём: сначала метаданные, в ответ
 * приходит адрес сессии, туда уходит сам файл. Резюмирование по кускам
 * не делается - клипы весят десятки мегабайт, при обрыве дешевле
 * повторить целиком, чем возить состояние сессии.
 */
export async function uploadVideo(
  accessToken: string,
  options: UploadOptions,
): Promise<string> {
  const size = (await stat(options.file)).size;

  const init = await fetch(`${UPLOAD}?uploadType=resumable&part=snippet,status`, {
    signal: AbortSignal.timeout(20_000),
    method: "POST",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-type": "application/json; charset=utf-8",
      "x-upload-content-length": String(size),
      "x-upload-content-type": "video/mp4",
    },
    body: JSON.stringify({
      snippet: {
        // Название не длиннее 100 знаков - лимит площадки.
        title: options.title.slice(0, 100),
        description: options.description.slice(0, 4800),
        tags: options.tags.slice(0, 30),
        categoryId: "20", // Gaming
        defaultLanguage: "ru",
      },
      status: {
        privacyStatus: options.privacy,
        // Игровые клипы - не детский контент; без явного флага площадка
        // требует ответа при каждой загрузке.
        selfDeclaredMadeForKids: false,
      },
    }),
  });
  if (!init.ok) {
    throw new Error(`youtube upload init ${init.status}: ${(await init.text()).slice(0, 400)}`);
  }
  const session = init.headers.get("location");
  if (!session) throw new Error("youtube не вернул адрес сессии загрузки");

  const put = await fetch(session, {
    signal: AbortSignal.timeout(600_000),
    method: "PUT",
    headers: {
      "content-length": String(size),
      "content-type": "video/mp4",
    },
    // Файл уходит потоком: клип целиком в памяти держать незачем.
    body: Readable.toWeb(createReadStream(options.file)) as unknown as RequestInit["body"],
    duplex: "half",
  } as RequestInit);
  if (!put.ok) {
    throw new Error(`youtube upload ${put.status}: ${(await put.text()).slice(0, 400)}`);
  }
  const video = (await put.json()) as { id: string };
  return video.id;
}

/** Состояние обработки ролика: залит, обрабатывается, готов. */
export async function videoStatus(
  accessToken: string,
  videoId: string,
): Promise<{ uploadStatus: string; privacyStatus: string } | null> {
  const response = await fetch(
    `${API}/videos?part=status&id=${encodeURIComponent(videoId)}`,
    { headers: { authorization: `Bearer ${accessToken}` } },
  );
  if (!response.ok) {
    throw new Error(`youtube videos ${response.status}: ${(await response.text()).slice(0, 300)}`);
  }
  const data = (await response.json()) as {
    items?: { status: { uploadStatus: string; privacyStatus: string } }[];
  };
  const item = data.items?.[0];
  return item
    ? { uploadStatus: item.status.uploadStatus, privacyStatus: item.status.privacyStatus }
    : null;
}
