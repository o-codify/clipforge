/**
 * Общее окружение воркера: настройки, база, python-процесс.
 *
 * Всё, что берётся из окружения, собирается здесь и один раз. Разбросанные
 * по коду process.env - верный способ обнаружить в бою, что где-то читалась
 * переменная, которой нет.
 */
import { config as loadEnv } from "dotenv";
import type PgBoss from 'pg-boss';
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { createDatabase, type Database } from "@clipforge/db";
import { PythonWorker } from "@clipforge/pipeline";
import { TwitchClient } from "@clipforge/twitch";
import { appFromEnv, type YoutubeApp } from "@clipforge/youtube";
import { storageFromEnv, type MediaStorage } from "@clipforge/storage";

const here = dirname(fileURLToPath(import.meta.url));
/** Корень монорепы: apps/worker/dist -> apps/worker -> apps -> корень. */
export const REPO_ROOT = resolve(here, "..", "..", "..");

loadEnv({ path: join(REPO_ROOT, ".env"), quiet: true });
loadEnv({ path: join(REPO_ROOT, ".env.s3.local"), quiet: true });

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`не задана переменная окружения ${name}`);
  return value;
};

const underRoot = (value: string): string =>
  isAbsolute(value) ? value : join(REPO_ROOT, value);

export function numberEnv(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const value = Number(env[name] ?? fallback);
  if (!Number.isFinite(value) || value < min || value > max) throw new Error(`${name}: требуется число от ${min} до ${max}`);
  return value;
}

export interface WorkerConfig {
  role: "all" | "control" | "media";
  databaseUrl: string;
  pythonBin: string;
  workerRoot: string;
  data: string;
  out: string;
  assets: string;
  models: string;
  videoFormat: string;
  mediaNetworkKbps: number;
  /** Сколько клипов рендерить одновременно. */
  renderConcurrency: number;
  speechModel: string;
  speechLanguage: string;
  speechBatchSize: number;
  glossary: string[];
  clipsPerRun: number;
}

export function loadConfig(): WorkerConfig {
  const role = process.env.WORKER_ROLE ?? "all";
  if (role !== "all" && role !== "control" && role !== "media") throw new Error("WORKER_ROLE: all, control или media");
  return {
    role,
    databaseUrl: required("DATABASE_URL"),
    pythonBin: underRoot(process.env.PYTHON_BIN ?? (process.platform === "win32" ? ".venv/Scripts/python.exe" : ".venv/bin/python")),
    workerRoot: join(REPO_ROOT, "workers", "python"),
    data: underRoot(process.env.DATA_ROOT ?? "data"),
    out: underRoot(process.env.OUT_ROOT ?? "out"),
    assets: join(underRoot(process.env.ASSETS_ROOT ?? "assets"), "twitch"),
    models: underRoot(process.env.MODELS_ROOT ?? "models"),
    videoFormat: process.env.VIDEO_FORMAT ?? "720p60",
    mediaNetworkKbps: numberEnv(process.env, 'MEDIA_DOWNLOAD_KBPS', Number(process.env.MEDIA_NETWORK_KBPS || 10000), 100, 1000000),
    renderConcurrency: Math.floor(numberEnv(process.env, 'RENDER_CONCURRENCY', 1, 1, 4)),
    speechModel: process.env.SPEECH_MODEL ?? "large-v3",
    speechLanguage: process.env.SPEECH_LANGUAGE ?? "ru",
    speechBatchSize: Math.floor(numberEnv(process.env, "SPEECH_BATCH_SIZE", 1, 1, 64)),
    glossary: (process.env.SPEECH_GLOSSARY ?? "")
      .split("|")
      .map((s) => s.trim())
      .filter(Boolean),
    clipsPerRun: Math.floor(numberEnv(process.env, "CLIPS_PER_RUN", 24, 1, 500)),
  };
}

export interface Context {
  remote?:import('./remote-access.js').RemoteMediaAccess;
  worker?:import('./registry.js').WorkerRegistry;
  queue?:PgBoss;
  storage: MediaStorage | null;
  config: WorkerConfig;
  db: Database;
  python: PythonWorker;
  /**
   * Клиент Twitch. Может отсутствовать: без ключей площадка работает,
   * но аватарки, обложки игр и число фолловеров остаются пустыми.
   */
  twitch: TwitchClient | null;
  /** Ключи YouTube-приложения. null - публикация не настроена. */
  youtube: YoutubeApp | null;
  log: (message: string) => void;
  close: () => Promise<void>;
}

export function createContext(
  onWorkerEvent?: (message: string) => void,
): Context {
  const config = loadConfig();

  if (config.role !== "control" && !existsSync(config.pythonBin)) {
    throw new Error(
      `нет интерпретатора ${config.pythonBin}. Проверь PYTHON_BIN в .env`,
    );
  }

  const db = createDatabase({ url: config.databaseUrl,max:Math.floor(numberEnv(process.env,'WORKER_DB_POOL_SIZE',6,4,30)) });
  const log = (message: string) => {
    process.stdout.write(`${new Date().toISOString().slice(11, 19)} ${message}\n`);
  };

  const python = new PythonWorker({
    pythonBin: config.pythonBin,
    workerRoot: config.workerRoot,
    cwd: REPO_ROOT,
    env: { CLIPFORGE_YUNET_MODEL: join(config.models, "face_detection_yunet_2023mar.onnx") },
    onEvent: (event) => {
      const text =
        event.event === "log"
          ? `python: ${event.message}`
          : `python: ${event.stage}${event.value === null ? "" : ` ${Math.round(event.value * 100)}%`}`;
      (onWorkerEvent ?? log)(text);
    },
    onStderr: (line) => {
      // Библиотеки шумят в stderr предупреждениями; интересны только сбои.
      if (/error|traceback|exception/i.test(line)) log(`python stderr: ${line}`);
    },
  });

  return {
    storage: storageFromEnv(),
    config,
    db,
    python,
    twitch: TwitchClient.fromEnv(),
    youtube: appFromEnv(),
    log,
    close: async () => {
      await python.stop();
      await db.close();
    },
  };
}
