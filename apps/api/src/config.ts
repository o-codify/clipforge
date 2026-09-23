/**
 * Настройки бэкенда.
 *
 * Всё, что берётся из окружения, читается здесь и один раз. Разбросанные
 * по коду обращения к process.env - верный способ узнать в бою, что
 * где-то читалась переменная, которой нет.
 */
import { config as loadEnv } from "dotenv";

import { appFromEnv, type YoutubeApp } from "@clipforge/youtube";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
/** Корень монорепы: apps/api/dist -> apps/api -> apps -> корень. */
export const REPO_ROOT = resolve(here, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env"), quiet: true });
loadEnv({ path: join(REPO_ROOT, ".env.s3.local"), quiet: true });

const underRoot = (value: string): string =>
  isAbsolute(value) ? value : join(REPO_ROOT, value);

export interface ApiConfig {
  databaseUrl: string;
  port: number;
  data: string;
  out: string;
  assets: string;
  videoFormat: string;
  clipsPerRun: number;
  /** Языки, с которыми работает площадка: остальные отсекаются при поиске. */
  languages: string[];
  /** Ключи YouTube-приложения. null - публикация не настроена. */
  youtube: YoutubeApp | null;
  /** Свой адрес - для OAuth-редиректа Google. */
  apiOrigin: string;
  /** Адрес интерфейса - туда возвращается админ после подключения. */
  webOrigin: string;
}

export function loadConfig(): ApiConfig {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("не задана переменная окружения DATABASE_URL");

  return {
    databaseUrl,
    port: Number(process.env.API_PORT ?? 8420),
    data: underRoot(process.env.DATA_ROOT ?? "data"),
    out: underRoot(process.env.OUT_ROOT ?? "out"),
    assets: join(underRoot(process.env.ASSETS_ROOT ?? "assets"), "twitch"),
    videoFormat: process.env.VIDEO_FORMAT ?? "720p60",
    clipsPerRun: Number(process.env.CLIPS_PER_RUN ?? 24),
    languages: (process.env.LANGUAGES ?? "ru").split(",").map((s) => s.trim()),
    youtube: appFromEnv(),
    apiOrigin:
      process.env.API_ORIGIN ?? `http://localhost:${process.env.API_PORT ?? 8420}`,
    webOrigin:
      process.env.WEB_ORIGIN ?? `http://localhost:${process.env.WEB_PORT ?? 3000}`,
  };
}

export const CONFIG = Symbol("CONFIG");
export const DATABASE = Symbol("DATABASE");
export const QUEUE = Symbol("QUEUE");
export const TWITCH = Symbol("TWITCH");
