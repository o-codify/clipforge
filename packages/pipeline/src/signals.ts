/**
 * Сигналы звука на стороне TypeScript.
 *
 * Считает их python-воркер (numpy: БПФ, скользящие окна,
 * автокорреляция), а сюда они приходят одним бинарником float32 и
 * читаются без копирования - через представление над буфером.
 *
 * Дальше с ними работает обычная арифметика по массивам, и держать её в
 * Python не за чем: сглаживание, поиск пиков и взвешивание одинаково
 * пишутся в обоих языках, а рядом с ними должны лежать настройки
 * детекции, которые живут в базе.
 */
import { readFile } from "node:fs/promises";

import { SIGNAL_SERIES, type SignalSeries } from "@clipforge/contracts";

export type SignalMap = Record<SignalSeries, Float32Array>;

export interface Signals extends SignalMap {
  hopSeconds: number;
  frames: number;
  duration: number;
}

/**
 * Прочитать бинарник, который написал воркер.
 *
 * Раскладка: ряды подряд, каждый по frames значений, float32
 * little-endian. Порядок задан в contracts и продублирован в воркере -
 * файл не самоописателен.
 */
export async function readSignals(
  file: string,
  meta: { frames: number; hopSeconds: number; duration: number; series: readonly SignalSeries[] },
): Promise<Signals> {
  const buffer = await readFile(file);
  const expected = meta.frames * meta.series.length * 4;
  if (buffer.byteLength !== expected) {
    throw new Error(
      `сигналы ${file}: ожидалось ${expected} байт (${meta.series.length} рядов по ${meta.frames}), получено ${buffer.byteLength}`,
    );
  }

  // Представление над тем же буфером: копии на 3 МБ здесь ни к чему.
  const all = new Float32Array(
    buffer.buffer,
    buffer.byteOffset,
    buffer.byteLength / 4,
  );

  const map = {} as SignalMap;
  meta.series.forEach((name, index) => {
    map[name] = all.subarray(index * meta.frames, (index + 1) * meta.frames);
  });

  for (const name of SIGNAL_SERIES) {
    if (!(name in map)) {
      throw new Error(`сигналы ${file}: нет ряда ${name}`);
    }
  }

  return {
    ...map,
    hopSeconds: meta.hopSeconds,
    frames: meta.frames,
    duration: meta.duration,
  };
}

/**
 * Сгладить сигнал скользящим средним.
 *
 * Свёртка в режиме "same": длина сохраняется, края считаются по
 * укороченному окну. Реализовано через префиксные суммы - на восьмидесяти
 * тысячах кадров прямая свёртка окном в сотни отсчётов заметно медленнее.
 */
export function smooth(
  values: Float32Array,
  seconds: number,
  hopSeconds: number,
): Float32Array {
  const window = Math.max(1, Math.trunc(seconds / hopSeconds));
  if (window <= 1 || values.length === 0) return Float32Array.from(values);

  const n = values.length;
  const prefix = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) prefix[i + 1] = prefix[i]! + values[i]!;

  // Центрирование как у np.convolve(mode="same"): из полной свёртки
  // берётся середина со сдвигом (window-1)//2. При ЧЁТНОМ окне это даёт
  // несимметричный охват - назад на один отсчёт больше, чем вперёд.
  // Окно сглаживания здесь 2 с при шаге 0.05 с, то есть ровно 40
  // отсчётов, и перепутанные стороны сдвинули бы весь сигнал на кадр.
  const forward = Math.trunc((window - 1) / 2);
  const back = window - 1 - forward;

  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - back);
    const hi = Math.min(n, i + forward + 1);
    // Делится на полное окно, а не на число попавших отсчётов: так же
    // ведёт себя свёртка с ядром 1/window, и края закономерно проседают.
    out[i] = (prefix[hi]! - prefix[lo]!) / window;
  }
  return out;
}

/** Номер кадра для момента времени. */
export const frameAt = (seconds: number, hopSeconds: number): number =>
  Math.max(0, Math.round(seconds / hopSeconds));

/** Момент времени для номера кадра. */
export const timeAt = (frame: number, hopSeconds: number): number =>
  frame * hopSeconds;

/** Среднее по отрезку сигнала, заданному в секундах. */
export function meanOver(
  values: Float32Array,
  from: number,
  to: number,
  hopSeconds: number,
): number {
  const lo = Math.max(0, frameAt(from, hopSeconds));
  const hi = Math.min(values.length, frameAt(to, hopSeconds));
  if (hi <= lo) return 0;
  let total = 0;
  for (let i = lo; i < hi; i++) total += values[i]!;
  return total / (hi - lo);
}

/** Максимум по отрезку и момент, где он достигнут. */
export function peakOver(
  values: Float32Array,
  from: number,
  to: number,
  hopSeconds: number,
): { value: number; at: number } {
  const lo = Math.max(0, frameAt(from, hopSeconds));
  const hi = Math.min(values.length, frameAt(to, hopSeconds));
  let best = -Infinity;
  let bestAt = lo;
  for (let i = lo; i < hi; i++) {
    if (values[i]! > best) {
      best = values[i]!;
      bestAt = i;
    }
  }
  return {
    value: best === -Infinity ? 0 : best,
    at: timeAt(bestAt, hopSeconds),
  };
}
