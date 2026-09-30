/**
 * Рендер одного вертикального клипа.
 *
 * Сетка считается автоматически (layout.ts), субтитры собираются с
 * караоке-подсветкой (subtitles.ts), здесь остаётся вызов ffmpeg.
 */
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { activeTimeout, waitForResources, wasPreempted } from '@clipforge/resources';

import {
  buildFilter,
  OUT_HEIGHT,
  OUT_WIDTH,
  type Grid,
  type Overlay,
  type Scrim,
} from "./layout.js";
import type { Span } from "./profanity.js";
import { buildAss, defaultStyle, type SubtitleStyle } from "./subtitles.js";
import type { Transcript } from "./transcript.js";
import {
  headerGeometry,
  headerLogoPath,
  isOutroEmpty,
  outroLayout,
  outroLogoPath,
  type BrandAssets,
  type HeaderLockup,
  type OutroCard,
} from "./twitch.js";

/**
 * Длительность проявления слоёв концовки. Одна на всех, чтобы подложка,
 * логотип и текст входили синхронно, а не вразнобой.
 */
const FADE_SECONDS = 0.45;

/**
 * Частота и громкость писка. 1000 Гц - привычный «телевизионный» тон,
 * который ухо однозначно читает как цензуру, а не как артефакт.
 */
const BEEP_HZ = 1000;
const BEEP_LEVEL = 0.18;

/**
 * Заглушить голос на интервалах и подмешать писк.
 *
 * Времена в spans абсолютные по исходнику, а фильтры работают от начала
 * клипа, поэтому вычитается смещение.
 *
 * Оба слоя управляются выражением с between(): у фильтра volume есть
 * режим eval=frame, где громкость пересчитывается на каждом кадре. Это
 * проще и точнее, чем нарезать дорожку на куски и склеивать.
 */
export function buildAudioFilter(
  spans: readonly Span[],
  offset: number,
  duration: number,
  beep = true,
  source = '0:a',
): { graph: string; output: string } {
  if (spans.length === 0) return { graph: "", output: source };

  const local = spans
    .filter(([a, b]) => b > offset && a < offset + duration)
    .map(([a, b]): Span => [Math.max(0, a - offset), Math.min(duration, b - offset)])
    .filter(([a, b]) => b > a);

  if (local.length === 0) return { graph: "", output: source };

  const inside = local
    .map(([a, b]) => `between(t,${a.toFixed(3)},${b.toFixed(3)})`)
    .join("+");
  // min(1,...) на случай, если интервалы всё же перекрылись.
  const gate = `min(1,${inside})`;

  if (!beep) {
    // Только заглушить. Провал в тишину слышится как дефект записи,
    // поэтому вариант хуже писка, но иногда его и просят.
    return {
      graph: `[${source}]volume='1-${gate}':eval=frame[aout]`,
      output: "[aout]",
    };
  }

  return {
    graph:
      `[${source}]volume='1-${gate}':eval=frame[voice];` +
      `sine=frequency=${BEEP_HZ}:sample_rate=48000:duration=${duration.toFixed(3)},` +
      `volume='${BEEP_LEVEL}*${gate}':eval=frame[beep];` +
      `[voice][beep]amix=inputs=2:duration=first:normalize=0[aout]`,
    output: "[aout]",
  };
}

/**
 * Экранировать путь для фильтра subtitles.
 *
 * Фильтр разбирает строку сам, и windows-путь ломает его дважды:
 * обратными слэшами и двоеточием после буквы диска.
 */
export const escapeAssPath = (path: string): string =>
  path.replaceAll("\\", "/").replaceAll(":", "\\:");

export async function runMediaCommand(
  command: string,
  args: readonly string[],
  timeoutMs: number,
  headroomMb = 0,
): Promise<{ code: number; stdout: string; stderr: string }> {
  for (;;) {
  await waitForResources(undefined, headroomMb);
  const started = Date.now();
  const result = await new Promise<{ code: number; stdout: string; stderr: string; pid?: number }>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));

    const timer = activeTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`таймаут ${command}`));
    }, timeoutMs);

    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, pid: child.pid });
    });
  });
  if (!wasPreempted(result.pid, started)) return result;
  }
}

/** Разрешение исходника - от него зависит расчёт сетки. */
export async function probeSize(
  path: string,
): Promise<{ width: number; height: number }> {
  try {
    const { stdout } = await runMediaCommand(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries",
       "stream=width,height", "-of", "json", path],
      30_000,
    );
    const stream = JSON.parse(stdout).streams?.[0];
    return { width: Number(stream.width), height: Number(stream.height) };
  } catch {
    return { width: 1280, height: 720 };
  }
}

/** Параметры контейнера готового клипа - их проверяют площадки. */
export async function probeMedia(path: string): Promise<{
  width: number;
  height: number;
  fps: number;
  duration: number;
} | null> {
  try {
    const { stdout } = await runMediaCommand(
      "ffprobe",
      ["-v", "error", "-select_streams", "v:0", "-show_entries",
       "stream=width,height,r_frame_rate,duration", "-of", "json", path],
      30_000,
    );
    const stream = JSON.parse(stdout).streams?.[0];
    const [num, den] = String(stream.r_frame_rate).split("/");
    return {
      width: Number(stream.width),
      height: Number(stream.height),
      fps: Number((Number(num) / Number(den || 1)).toFixed(3)),
      duration: Number(stream.duration),
    };
  } catch {
    return null;
  }
}

export interface RenderOptions {
  /** Clean PCM covers the complete clip, including the outro. Never mix original audio back in. */
  audioSource?: string;
  sourceMasks?: {x:number;y:number;w:number;h:number}[];
  source: string;
  start: number;
  end: number;
  out: string;
  grid: Grid;
  assets: BrandAssets;

  transcript?: Transcript | null;
  style?: SubtitleStyle;
  censorSpans?: readonly Span[];
  censorBeep?: boolean;
  header?: HeaderLockup | null;
  outro?: OutroCard | null;

  crf?: number;
  preset?: string;
  fps?: number;
  audioBitrate?: string;
  /**
   * Потоки кодирования на ОДИН процесс ffmpeg.
   *
   * При параллельном рендере нескольких клипов каждому процессу отдаётся
   * доля ядер, а не все сразу: N процессов по 16 потоков дерутся за
   * планировщик, N по 16/N - работают.
   */
  threads?: number;
  timeoutMs?: number;
}

export interface RenderResult {
  path: string;
  ok: boolean;
  seconds: number;
  error: string;
  /** Команда целиком - её удобно повторить руками при разборе сбоя. */
  command: string[];
}

/** Собрать аргументы ffmpeg. Вынесено отдельно, чтобы их можно было проверить. */
export function buildFfmpegArgs(options: RenderOptions, assPath: string | null): {
  args: string[];
  graph: string;
} {
  const {
    source, start, end, out, grid,
    censorSpans = [], censorBeep = true,
    header = null, outro = null,
    crf = 20, preset = "veryfast", fps = 30, audioBitrate = "160k",
    assets,
  } = options;

  const duration = Math.max(0.5, end - start);

  // Карточка канала кладётся НЕ на основную часть клипа, а на кусок
  // видео, специально дочитанный из исходника сверх содержания. Так
  // ничего не съедается, но переход остаётся живым: под карточкой
  // продолжается игра, а не чёрный экран.
  const outroSeconds = outro && !isOutroEmpty(outro) ? outro.seconds : 0;
  const readDuration = duration + outroSeconds;

  const inputs: string[] = [];
  const threads = Math.max(1, Math.min(4, options.threads ?? 2));
  const overlays: Overlay[] = [];
  const scrim: Scrim | undefined =
    outroSeconds > 0 && outro
      ? { opacity: outro.scrim, from: duration, fade: FADE_SECONDS }
      : undefined;

  if (header) {
    const logo = headerLogoPath(assets, header);
    if (existsSync(logo)) {
      const box = headerGeometry(assets, header, OUT_WIDTH);
      inputs.push("-threads", String(threads), "-loop", "1", "-framerate", String(fps),
                  "-t", readDuration.toFixed(3), "-i", logo);
      overlays.push({
        input: overlays.length + 1,
        w: box.logoW, x: box.logoX, y: box.logoY,
        // Шапка живёт только над содержанием: на карточке канала знак
        // уже есть в составе вордмарка.
        ...(outroSeconds > 0 ? { to: duration } : {}),
        fade: FADE_SECONDS,
      });
    }
  }

  if (outroSeconds > 0 && outro) {
    const logo = outroLogoPath(assets, outro);
    if (existsSync(logo)) {
      const box = outroLayout(assets, outro, OUT_WIDTH, OUT_HEIGHT);
      inputs.push("-threads", String(threads), "-loop", "1", "-framerate", String(fps),
                  "-t", readDuration.toFixed(3), "-i", logo);
      overlays.push({
        input: overlays.length + 1,
        w: outro.logoWidth, x: box.logoX, y: box.logoY,
        from: duration, // появляется там, где кончилось содержание
        fade: FADE_SECONDS,
      });
    }
  }

  const audioInput = options.audioSource ? `${1 + inputs.filter(v => v === '-i').length}:a` : '0:a';
  if (options.audioSource) inputs.push('-threads', String(threads), '-i', options.audioSource);
  const audio = buildAudioFilter(censorSpans, start, readDuration, censorBeep, audioInput);
  let graph = buildFilter(grid, {
    ...(assPath ? { subtitlesPath: assPath } : {}),
    overlays,
    ...(scrim ? { scrim } : {}),
    duration: readDuration,
    fps,
    sourceMasks: options.sourceMasks,
  });
  if (audio.graph) graph = `${graph};${audio.graph}`;

  const args = [
    "-nostdin", "-y", "-loglevel", "error",
    // Encoder threads alone do not constrain decoding or the complex filter
    // graph, which otherwise allocate buffers for every logical CPU.
    "-filter_complex_threads", "1", "-filter_threads", "1",
    // -ss до -i: быстрый поиск по ключевым кадрам.
    "-ss", start.toFixed(3), "-t", readDuration.toFixed(3),
    "-threads", String(threads), "-i", source,
    ...inputs,
    "-filter_complex", graph,
    "-map", "[vout]", "-map", audio.output,
    "-c:v", "libx264", "-preset", preset, "-crf", String(crf),
    "-threads", String(threads),
    "-pix_fmt", "yuv420p", "-profile:v", "high",
    "-r", String(fps),
    "-c:a", "aac", "-b:a", audioBitrate, "-ac", "2",
    "-movflags", "+faststart",
    '-t', readDuration.toFixed(3),
    out,
  ];

  return { args, graph };
}

/** Вырезать отрезок и собрать вертикальный клип. */
export async function renderClip(options: RenderOptions): Promise<RenderResult> {
  const started = Date.now();
  await mkdir(dirname(options.out), { recursive: true });

  // Плашка живёт в том же слое ASS, что и субтитры, поэтому файл нужен и
  // когда субтитры выключены, но брендирование включено.
  const needsAss =
    options.transcript != null ||
    options.header != null ||
    (options.outro != null && !isOutroEmpty(options.outro));

  let tempDir: string | null = null;
  let assPath: string | null = null;

  try {
    if (needsAss) {
      tempDir = await mkdtemp(join(tmpdir(), "clipforge-"));
      const file = join(tempDir, "sub.ass");
      const style = options.style ?? defaultStyle({ topY: options.grid.subTop });
      await writeFile(
        file,
        buildAss(
          options.transcript ?? { language: "", duration: 0, segments: [] },
          options.start, options.end, OUT_WIDTH, OUT_HEIGHT,
          {
            style,
            header: options.header ?? null,
            outro: options.outro ?? null,
            assets: options.assets,
          },
        ),
        "utf8",
      );
      assPath = escapeAssPath(file);
    }

    const { args } = buildFfmpegArgs(options, assPath);
    const result = await runMediaCommand("ffmpeg", args, options.timeoutMs ?? 600_000, 512);
    const seconds = (Date.now() - started) / 1000;

    if (result.code !== 0 || !existsSync(options.out)) {
      return {
        path: options.out,
        ok: false,
        seconds,
        error: result.stderr.length > 4000
          ? `${result.stderr.slice(0, 3000)}\n…\n${result.stderr.slice(-1000)}`
          : result.stderr,
        command: ["ffmpeg", ...args],
      };
    }
    return { path: options.out, ok: true, seconds, error: "", command: ["ffmpeg", ...args] };
  } catch (error) {
    return {
      path: options.out,
      ok: false,
      seconds: (Date.now() - started) / 1000,
      error: error instanceof Error ? error.message : String(error),
      command: [],
    };
  } finally {
    if (tempDir) await rm(tempDir, { recursive: true, force: true });
  }
}
