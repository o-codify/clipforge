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
 *  - фактические квоты проверяются в Google Cloud для своего проекта;
 *  - у непроверенного (не прошедшего аудит) проекта Google Cloud все
 *    загруженные через API ролики принудительно остаются приватными.
 */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { validateVideoMetadata } from "./metadata.js";
export * from "./metadata.js";

const OAUTH_BASE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
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
    const error=await response.json().catch(()=>({})) as {error?:string};
    if(response.status===400&&error.error==="invalid_grant"&&body.grant_type==="refresh_token") throw new YoutubeAccessRevokedError();
    throw new Error(`Google OAuth: ошибка доступа (${response.status})`);
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
  file?: string;
  source?: { body: Readable; size: number; reopen?: (offset:number)=>Promise<Readable> };
  session?: {url:string;size:number};
  saveSession?: (session:{url:string;size:number})=>Promise<void>;
  title: string;
  description: string;
  tags: string[];
  privacy: "private" | "unlisted" | "public";
}

/**
 * Загрузить ролик. Возвращает id видео.
 *
 * Сессия сохраняется до отправки байтов. После обрыва сначала проверяем
 * её состояние и продолжаем с подтверждённого Google смещения.
 */
export async function uploadVideo(
  accessToken: string,
  options: UploadOptions,
): Promise<string> {
  if ((!options.file && !options.source) || (options.file && options.source)) throw new Error('Exactly one video source is required');
  const size = options.source?.size ?? (await stat(options.file!)).size;
  let body = options.source?.body ?? createReadStream(options.file!);
  if (!Number.isSafeInteger(size) || size <= 0) throw new Error('Video source must have a positive byte length');
  try {
  validateVideoMetadata(options);

  let session=options.session?.url;
  let offset=0;
  if(options.session && options.session.size!==size)throw new Error('Upload source size changed');
  if(!session) {
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
        title: options.title,
        description: options.description,
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
  session = init.headers.get("location") ?? undefined;
  if (!session) throw new Error("youtube не вернул адрес сессии загрузки");
  validateSession(session);
  await options.saveSession?.({url:session,size});
  } else {
    validateSession(session);
    const status=await fetch(session,{method:'PUT',redirect:'manual',signal:AbortSignal.timeout(20_000),
      headers:{authorization:`Bearer ${accessToken}`,'content-length':'0','content-range':`bytes */${size}`}});
    if(status.ok) return uploadedId(await status.json());
    if(status.status===404 || status.status===410)throw new UploadSessionExpiredError();
    if(status.status!==308)throw new Error(`YouTube upload status ${status.status}`);
    const range=status.headers.get('range');
    if(range && !/^bytes=0-\d+$/.test(range))throw new Error('Invalid upload offset');
    offset=range ? Number(range.slice(8))+1 : 0;
    if(!Number.isSafeInteger(offset)||offset<0||offset>=size)throw new Error('Invalid upload offset');
    body.destroy();
    body=options.source ? await options.source.reopen?.(offset) ?? (()=>{throw new Error('Source cannot be resumed');})() : createReadStream(options.file!,{start:offset});
  }

  const put = await fetch(session, {
    signal: AbortSignal.timeout(600_000),
    method: "PUT",
    redirect:'manual',
    headers: {
      authorization:`Bearer ${accessToken}`,
      "content-length": String(size-offset),
      "content-range":`bytes ${offset}-${size-1}/${size}`,
      "content-type": "video/mp4",
    },
    // Файл уходит потоком: клип целиком в памяти держать незачем.
    body: Readable.toWeb(body) as unknown as RequestInit["body"],
    duplex: "half",
  } as RequestInit);
  if (!put.ok) {
    throw new Error(`youtube upload ${put.status}: ${(await put.text()).slice(0, 400)}`);
  }
  return uploadedId(await put.json());
  } finally { body.destroy(); }
}

function validateSession(value:string):void {
  const url=new URL(value);
  if(url.origin!=='https://www.googleapis.com' || url.pathname!=='/upload/youtube/v3/videos')throw new Error('Invalid YouTube upload session');
}
function uploadedId(value:unknown):string {
  const id=(value as {id?:unknown})?.id;
  if(typeof id!=='string'||!id)throw new Error('YouTube did not return a video ID');
  return id;
}
export class UploadSessionExpiredError extends Error {
  constructor(){super('Сессия YouTube истекла. Проверьте канал перед новой отправкой.');this.name='UploadSessionExpiredError';}
}

export class YoutubeAccessRevokedError extends Error {
  constructor(){super("Разрешение YouTube отозвано или истекло");this.name="YoutubeAccessRevokedError";}
}

/** Never includes credentials in the URL or error text. Failed requests can be retried. */
export async function revokeToken(token:string):Promise<void> {
  const response=await fetch(REVOKE_URL,{method:"POST",signal:AbortSignal.timeout(20_000),
    headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token}).toString()});
  if(response.ok)return;
  const error=await response.json().catch(()=>({})) as {error?:string};
  if(response.status===400&&error.error==="invalid_token")return;
  throw new Error(`Google: не удалось отозвать доступ (${response.status})`);
}

/** Состояние обработки ролика: залит, обрабатывается, готов. */
export async function videoStatus(
  accessToken: string,
  videoId: string,
): Promise<{ uploadStatus: string; privacyStatus: string } | null> {
  const response = await fetch(
    `${API}/videos?part=status&id=${encodeURIComponent(videoId)}`,
    { signal:AbortSignal.timeout(20_000),headers: { authorization: `Bearer ${accessToken}` } },
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
