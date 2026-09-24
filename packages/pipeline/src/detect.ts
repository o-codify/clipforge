/**
 * Поиск кандидатов на клип.
 *
 * Стратегия - массовость, а не точность: задача не выбрать десять лучших
 * моментов, а выдать много кандидатов и отсеять заведомо мёртвые. Что из
 * них работает, решит аналитика по опубликованному, а не порог здесь.
 *
 * Сигналы сводятся на общую сетку кадров, дальше ищутся пики с
 * подавлением соседей, чтобы один затяжной бой не превратился в тридцать
 * почти одинаковых клипов.
 */
import { smooth } from "./signals.js";
import type { Signals } from "./signals.js";
import type { Transcript, TranscriptWord } from "./transcript.js";
import { allWords } from "./transcript.js";
import { normalizeRussianText } from "@clipforge/contracts/text";

/**
 * Слова-маркеры. Вес - насколько сильно слово намекает на интересный
 * момент. Мат у большинства стримеров - самый честный индикатор всплеска
 * эмоций.
 *
 * Ключ - НАЧАЛО слова, сопоставление идёт от границы слова. Наивный
 * поиск подстроки здесь недопустим: маркер «го» ловится внутри «доГОн»,
 * «дороГО», «второГО», и мусор всплывает на первые места. Отсюда же
 * выброшены слишком общие маркеры - в русской речи они встречаются
 * постоянно и не несут информации.
 *
 * Порядок важен: при совпадении берётся первый подошедший.
 */
export const REACTION_WORDS: ReadonlyMap<string, number> = new Map([
  // сильная реакция
  ["пиздец", 1.0], ["ебан", 1.0], ["ебат", 1.0], ["охуе", 1.0], ["нихуя", 1.0],
  ["заеб", 0.8], ["уебо", 0.9], ["хуйн", 0.8],
  ["блядь", 0.8], ["блять", 0.8], ["бля", 0.7], ["сука", 0.7], ["нахуй", 0.8],
  // удивление
  ["ого", 0.8], ["воу", 0.8], ["вау", 0.8], ["боже", 0.7], ["офигет", 0.9],
  ["серьезно", 0.6], ["серьёзно", 0.6], ["жесть", 0.8],
  // оценка происходящего
  ["имба", 0.8], ["красав", 0.8], ["жестко", 0.7], ["жёстко", 0.7],
  ["капец", 0.7], ["лол", 0.5], ["изи", 0.6],
  // провал
  ["умер", 0.7], ["сдох", 0.8], ["слил", 0.7], ["проеб", 0.9],
]);

/** Устойчивые сочетания - ищутся по тексту сегмента, а не по словам. */
export const REACTION_PHRASES: ReadonlyMap<string, number> = new Map([
  ["да ладно", 0.9], ["что за", 0.7], ["как так", 0.8],
  ["не может быть", 0.9], ["о нет", 0.9], ["нет нет", 0.9],
  ["ты видел", 0.8], ["что это было", 1.0],
]);

/** Воздух вокруг речи: клип начинается картинкой, а не первым словом. */
export const PAD_BEFORE = 1.0;
export const PAD_AFTER = 1.3;

/** Верхняя граница тишины в начале: воздух нужен, пустота - нет. */
export const MAX_LEADING_SILENCE = 2.5;

export const DEFAULT_WEIGHTS: Readonly<Record<string, number>> = {
  combat: 1.8,
  reaction: 0.9,
  speech: 0.3,
  loudness: 0.6,
};

export interface Candidate {
  /** Секунда пика. */
  peak: number;
  start: number;
  end: number;
  score: number;
  /** Вклад каждого сигнала в момент пика. */
  parts: Record<string, number>;
  /** Что говорилось внутри окна. */
  text: string;
  keywords: string[];
}

export const duration = (c: Candidate): number => c.end - c.start;

export function timecode(seconds: number): string {
  const total = Math.trunc(seconds);
  const h = Math.trunc(total / 3600);
  const m = Math.trunc((total % 3600) / 60);
  const s = total % 60;
  return `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;

/** Убрать пунктуацию и привести к нижнему регистру. */
const plainWord = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}_\s]/gu, "");

/**
 * Найти сочетание в тексте с привязкой к границе слова.
 *
 * Через регулярное выражение это не выразить: в JavaScript \b работает
 * только по латинице, и для кириллицы граница определяется вручную.
 */
function findPhrase(text: string, phrase: string): number {
  let from = 0;
  for (;;) {
    const at = text.indexOf(phrase, from);
    if (at < 0) return -1;
    const before = at > 0 ? text[at - 1]! : "";
    if (!before || !WORD_CHAR.test(before)) return at;
    from = at + 1;
  }
}

export interface KeywordHit {
  at: number;
  word: string;
  weight: number;
}

/**
 * Сигнал по словам-маркерам: всплеск в момент слова, плавный спад.
 *
 * Хвост экспоненциальный: реакция относится к тому, что было ДО неё, но
 * и несколько секунд после тоже входят в клип.
 */
export function keywordSignal(
  transcript: Transcript,
  frames: number,
  hop: number,
  decaySeconds = 3.0,
): { signal: Float32Array; hits: KeywordHit[] } {
  const signal = new Float32Array(frames);
  const hits: KeywordHit[] = [];

  for (const segment of transcript.segments) {
    for (const word of segment.words) {
      const plain = plainWord(word.text);
      if (!plain) continue;
      for (const [stem, weight] of REACTION_WORDS) {
        if (plain.startsWith(stem)) {
          const idx = Math.trunc(word.start / hop);
          if (idx >= 0 && idx < signal.length) {
            signal[idx] = Math.max(signal[idx]!, weight);
            hits.push({ at: word.start, word: plain, weight });
          }
          break;
        }
      }
    }

    // Сочетания ищутся по тексту сегмента, время берётся у первого слова.
    const lowered = segment.text.toLowerCase();
    for (const [phrase, weight] of REACTION_PHRASES) {
      if (findPhrase(lowered, phrase) < 0) continue;
      const head = phrase.split(" ")[0]!;
      let when = segment.start;
      for (const word of segment.words) {
        if (plainWord(word.text).startsWith(head)) {
          when = word.start;
          break;
        }
      }
      const idx = Math.trunc(when / hop);
      if (idx >= 0 && idx < signal.length) {
        signal[idx] = Math.max(signal[idx]!, weight);
        hits.push({ at: when, word: phrase, weight });
      }
    }
  }

  const tail = Math.trunc(decaySeconds / hop);
  if (tail <= 1) return { signal, hits };

  // exp(-linspace(0, 3, tail)), затем полная свёртка с обрезкой по длине.
  const kernel = new Float32Array(tail);
  for (let k = 0; k < tail; k++) {
    kernel[k] = Math.exp(-(3 * k) / (tail - 1));
  }

  const decayed = new Float32Array(frames);
  for (let n = 0; n < frames; n++) {
    let sum = 0;
    const from = Math.max(0, n - tail + 1);
    for (let k = from; k <= n; k++) {
      const value = signal[k]!;
      if (value !== 0) sum += value * kernel[n - k]!;
    }
    decayed[n] = sum;
  }
  return { signal: decayed, hits };
}

/** Слов в секунду по скользящему окну. Быстрая речь = стример завёлся. */
export function speechDensity(
  words: readonly TranscriptWord[],
  frames: number,
  hop: number,
  windowSeconds = 10.0,
): Float32Array {
  const counts = new Float32Array(frames);
  for (const word of words) {
    const idx = Math.trunc(word.start / hop);
    if (idx >= 0 && idx < frames) counts[idx] = counts[idx]! + 1;
  }

  const window = Math.max(1, Math.trunc(windowSeconds / hop));
  const prefix = new Float64Array(frames + 1);
  for (let i = 0; i < frames; i++) prefix[i + 1] = prefix[i]! + counts[i]!;

  // Та же центровка, что у np.convolve(mode="same").
  const forward = Math.trunc((window - 1) / 2);
  const back = window - 1 - forward;

  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    const lo = Math.max(0, i - back);
    const hi = Math.min(frames, i + forward + 1);
    out[i] = (prefix[hi]! - prefix[lo]!) / windowSeconds;
  }
  return out;
}

/** Процентиль с линейной интерполяцией - как np.percentile по умолчанию. */
export function percentile(values: Float32Array, q: number): number {
  if (values.length === 0) return 0;
  const sorted = Float32Array.from(values).sort();
  const position = ((sorted.length - 1) * q) / 100;
  const lo = Math.floor(position);
  const hi = Math.ceil(position);
  if (lo === hi) return sorted[lo]!;
  return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (position - lo);
}

export interface ScoreResult {
  total: Float32Array;
  parts: Record<string, Float32Array>;
}

/**
 * Свести сигналы в одну оценку.
 *
 * Здесь именно СЛОЖЕНИЕ, в отличие от combat-score внутри аудио. Там
 * перемножение отсеивало ложный бой, а тут наоборот: любой сильный
 * сигнал сам по себе достаточен, чтобы момент стал кандидатом. Громкий
 * бой без слов - кандидат. Тихая фраза «да ладно, что это было» - тоже.
 */
export function combinedScore(
  audio: Signals,
  transcript: Transcript | null,
  weights: Record<string, number> = DEFAULT_WEIGHTS,
): ScoreResult {
  const hop = audio.hopSeconds;
  const frames = audio.frames;

  const loudness = smooth(audio.loudnessRel, 2.0, hop);
  const clipped = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    clipped[i] = Math.min(1, Math.max(0, loudness[i]! / 12));
  }

  const parts: Record<string, Float32Array> = {
    combat: smooth(audio.combat, 2.0, hop),
    loudness: clipped,
  };

  if (transcript) {
    parts.reaction = keywordSignal(transcript, frames, hop).signal;
    const density = speechDensity(allWords(transcript), frames, hop);
    // Нормируем на 90-й процентиль: абсолютная скорость речи у всех разная.
    const reference = percentile(density, 90) || 1;
    const speech = new Float32Array(frames);
    for (let i = 0; i < frames; i++) {
      speech[i] = Math.min(1, Math.max(0, density[i]! / reference));
    }
    parts.speech = speech;
  } else {
    parts.reaction = new Float32Array(frames);
    parts.speech = new Float32Array(frames);
  }

  const total = new Float32Array(frames);
  // Порядок слагаемых тот же, что в python-версии: сложение чисел с
  // плавающей точкой не ассоциативно, и перестановка меняет последние
  // разряды, а по ним потом сортируются пики.
  for (const name of ["combat", "loudness", "reaction", "speech"]) {
    const values = parts[name];
    const weight = weights[name] ?? 0;
    if (!values || weight === 0) continue;
    for (let i = 0; i < frames; i++) total[i] = total[i]! + weight * values[i]!;
  }
  return { total, parts };
}

/**
 * Пики с подавлением соседей.
 *
 * Без подавления затяжной бой даёт десятки почти одинаковых клипов:
 * оценка держится высокой минуту подряд, и каждый кадр формально пик.
 */
export function findPeaks(
  score: Float32Array,
  hop: number,
  minGapSeconds = 25.0,
  maxCount = 200,
  minScore = 0,
): number[] {
  if (score.length === 0) return [];

  // Сортировка по убыванию оценки, при равенстве - по возрастанию
  // индекса. Порядок задан явно: без этого равные оценки разбирались бы
  // в произвольном порядке и набор кандидатов «плавал» от запуска к запуску.
  const order = Array.from({ length: score.length }, (_, i) => i).sort(
    (a, b) => score[b]! - score[a]! || a - b,
  );

  const gap = Math.trunc(minGapSeconds / hop);
  const blocked = new Uint8Array(score.length);
  const taken: number[] = [];

  for (const idx of order) {
    if (taken.length >= maxCount) break;
    if (blocked[idx] || score[idx]! < minScore) continue;
    taken.push(idx);
    const from = Math.max(0, idx - gap);
    const to = Math.min(score.length, idx + gap);
    blocked.fill(1, from, to);
  }
  return taken.sort((a, b) => a - b);
}

// --- границы клипа ----------------------------------------------------

export type Gap = [start: number, end: number];

/** Промежутки тишины между словами. */
export function silenceGaps(words: readonly TranscriptWord[]): Gap[] {
  const gaps: Gap[] = [];
  for (let i = 1; i < words.length; i++) {
    const a = words[i - 1]!;
    const b = words[i]!;
    if (b.start > a.end) gaps.push([a.end, b.start]);
  }
  return gaps;
}

/**
 * Самая длинная пауза в окне вокруг цели.
 *
 * Именно самая длинная, а не ближайшая: ближайшая часто оказывается
 * разрывом между словами внутри предложения, и клип всё равно начинается
 * с середины мысли.
 */
function longestPauseNear(
  words: readonly TranscriptWord[],
  target: number,
  back: number,
  forward: number,
): number | null {
  let bestGap = 0;
  let bestAt: number | null = null;
  const lo = target - back;
  const hi = target + forward;

  for (let i = 1; i < words.length; i++) {
    const current = words[i]!;
    if (current.start < lo) continue;
    if (current.start > hi) break;
    const gap = current.start - words[i - 1]!.end;
    if (gap > bestGap) {
      bestGap = gap;
      bestAt = current.start;
    }
  }
  return bestGap > 0.4 ? bestAt : null;
}

/** Слово, внутри которого оказался момент. null - момент в паузе. */
function wordAt(
  words: readonly TranscriptWord[],
  moment: number,
): TranscriptWord | null {
  for (const word of words) {
    if (word.start < moment && moment < word.end) return word;
    if (word.start > moment) break;
  }
  return null;
}

/** Ближайшая к цели пауза длиной не меньше заданной. */
function nearestGap(
  gaps: readonly Gap[],
  target: number,
  minLength: number,
  budget: number,
): Gap | null {
  let best: Gap | null = null;
  let bestDistance = budget;

  for (const gap of gaps) {
    const [from, to] = gap;
    if (to - from < minLength) continue;
    if (from <= target && target <= to) return gap;
    const distance = from > target ? from - target : target - to;
    if (distance < bestDistance) {
      best = gap;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Развести края клипа и речь.
 *
 * Край ставится ВНУТРЬ подходящей паузы, а не «отодвигается на pad
 * секунд». Наращивание не сходится: речь идёт почти непрерывно, и каждый
 * сдвиг на секунду с лишним снова попадает в следующее слово. Поэтому
 * ищется ближайший промежуток тишины нужной длины, и разрез делается в нём.
 */
function addAir(
  words: readonly TranscriptWord[],
  start: number,
  end: number,
  padBefore: number,
  padAfter: number,
  maxLeadingSilence: number,
  minLead: number,
  minLen: number,
  maxLen: number,
  peakTime: number,
  budget = 8.0,
): [number, number] {
  const gaps = silenceGaps(words);

  const head = nearestGap(gaps, start, padBefore, budget);
  if (head) {
    // Встать так, чтобы до первого слова осталось ровно padBefore, но не
    // залезть в предыдущее слово.
    start = Math.max(0, Math.max(head[0], head[1] - padBefore));
  }

  const first = words.find((w) => w.start >= start);
  if (first && first.start - start > maxLeadingSilence) {
    // Долгая тишина в начале тоже плохо, но подрезать её можно лишь до
    // minLead: событию нужна подводка.
    start = Math.max(
      0,
      Math.min(first.start - maxLeadingSilence, peakTime - minLead),
    );
  }

  const tail = nearestGap(gaps, end, padAfter, budget);
  if (tail) {
    const candidate = Math.min(tail[0] + padAfter, tail[1]);
    if (candidate - start <= maxLen) end = candidate;
  }

  // Если подходящей паузы рядом не нашлось, край мог остаться внутри
  // слова. Тогда режем перед ним - хуже по воздуху, но не рвёт речь.
  const inside = wordAt(words, end);
  if (inside) end = Math.max(start + minLen, inside.start - 0.15);

  return [start, end];
}

/**
 * Дотянуть слишком короткий клип до минимальной длины.
 *
 * Расширяемся по паузам: сначала вперёд, потом назад. Слепой сдвиг
 * границы дал бы обрыв на полуслове - ровно то, от чего мы уходили.
 */
function ensureMinLength(
  words: readonly TranscriptWord[],
  start: number,
  end: number,
  minLen: number,
  maxLen: number,
  padAfter: number,
  peakTime: number,
  budget = 20.0,
): [number, number] {
  if (end - start >= minLen) return [start, end];

  // Только паузы, в которых поместится воздух: короткие дают хвост в
  // доли секунды, то есть тот же обрыв, от которого мы уходили.
  const gaps = silenceGaps(words).filter(([a, b]) => b - a >= padAfter);

  for (const [gapStart, gapEnd] of gaps) {
    if (gapStart <= end) continue;
    if (gapStart - end > budget) break;
    const candidate = Math.min(gapStart + padAfter, gapEnd);
    if (candidate - start >= minLen && candidate - start <= maxLen) {
      return [start, candidate];
    }
  }

  for (const [gapStart, gapEnd] of [...gaps].reverse()) {
    if (gapEnd >= start) continue;
    if (start - gapEnd > budget) break;
    const candidate = Math.max(gapStart, gapEnd - padAfter);
    if (end - candidate >= minLen && end - candidate <= maxLen) {
      return [Math.max(0, candidate), end];
    }
  }

  // Подходящих пауз рядом не нашлось - раздвигаем принудительно, но край
  // всё равно не должен встать посреди слова.
  end = Math.max(end, start + minLen);
  let inside = wordAt(words, end);
  if (inside) end = inside.end + 0.2; // договорить слово целиком
  start = Math.max(0, Math.min(start, peakTime - minLen / 2));
  inside = wordAt(words, start);
  if (inside) start = Math.max(0, inside.start - 0.2);
  return [start, end];
}

export interface SnapOptions {
  lead?: number;
  tail?: number;
  minLen?: number;
  maxLen?: number;
  minLead?: number;
  minTail?: number;
  padBefore?: number;
  padAfter?: number;
  maxLeadingSilence?: number;
}

/**
 * Границы клипа вокруг пика.
 *
 * Порядок действий важен, каждый шаг решает свою задачу:
 *   1. грубое окно по lead/tail;
 *   2. подтянуть края к паузам - чтобы не резать на полуслове;
 *   3. жёсткие гарантии вокруг пика;
 *   4. привести длину в допустимые пределы;
 *   5. добавить воздух вокруг речи.
 *
 * Шаг 5 идёт ПОСЛЕДНИМ, и это принципиально. Раньше воздух добавлялся до
 * гарантий и подгонки длины, а те снова въезжали в речь: у части клипов
 * хвост схлопывался до нуля, и последнее слово обрывалось ровно на выходе.
 */
export function snapToSpeech(
  peakTime: number,
  transcript: Transcript | null,
  options: SnapOptions = {},
): [number, number] {
  const {
    lead = 12,
    tail = 6,
    minLen = 12,
    maxLen = 55,
    minLead = 4,
    minTail = 3,
    padBefore = PAD_BEFORE,
    padAfter = PAD_AFTER,
    maxLeadingSilence = MAX_LEADING_SILENCE,
  } = options;

  let start = Math.max(0, peakTime - lead);
  let end = peakTime + tail;

  const words = transcript ? allWords(transcript) : [];

  if (words.length > 0) {
    const pauseAt = longestPauseNear(words, start, 7.0, 3.0);
    if (pauseAt !== null) start = Math.max(0, pauseAt);

    for (let i = 0; i < words.length - 1; i++) {
      if (words[i]!.end >= end) {
        const gapAfter = words[i + 1]!.start - words[i]!.end;
        if (gapAfter > 0.35 && words[i]!.end - end < 5.0) end = words[i]!.end;
        break;
      }
    }
  }

  // Подгонка к речи уточняет границы, но не имеет права отменить смысл
  // клипа: до события нужна подводка, после - реакция.
  start = Math.min(start, Math.max(0, peakTime - minLead));
  end = Math.max(end, peakTime + minTail);

  const length = end - start;
  if (length < minLen) {
    end = start + minLen;
  } else if (length > maxLen) {
    start = Math.max(0, peakTime - maxLen * 0.7);
    end = start + maxLen;
  }

  if (words.length > 0) {
    [start, end] = addAir(
      words, start, end, padBefore, padAfter,
      maxLeadingSilence, minLead, minLen, maxLen, peakTime,
    );
    // Доводка краёв к паузам может укоротить клип: подходящая тишина
    // нашлась ближе, чем хотелось. Возвращаем длину, снова опираясь на
    // паузы, а не просто раздвигая границы.
    [start, end] = ensureMinLength(
      words, start, end, minLen, maxLen, padAfter, peakTime,
    );
  }

  return [start, end];
}

/** Текст окна. Слово считается внутри, если внутри его начало. */
export function textBetween(
  words: readonly TranscriptWord[],
  start: number,
  end: number,
): string {
  return normalizeRussianText(words
    .filter((w) => start <= w.start && w.start <= end)
    .map((w) => w.text)
    .join(" "));
}

export interface DetectOptions extends SnapOptions {
  maxCount?: number;
  minGapSeconds?: number;
  weights?: Record<string, number>;
}

/** Полный проход: сигналы -> оценка -> пики -> окна кандидатов. */
export function detect(
  audio: Signals,
  transcript: Transcript | null = null,
  options: DetectOptions = {},
): Candidate[] {
  const {
    maxCount = 200,
    minGapSeconds = 25,
    weights = DEFAULT_WEIGHTS,
    ...snap
  } = options;

  const { total, parts } = combinedScore(audio, transcript, weights);
  const hop = audio.hopSeconds;
  const hits = transcript
    ? keywordSignal(transcript, audio.frames, hop).hits
    : [];
  const words = transcript ? allWords(transcript) : [];

  const candidates: Candidate[] = [];
  for (const idx of findPeaks(total, hop, minGapSeconds, maxCount)) {
    const peak = audio.times[idx]!;
    const [start, end] = snapToSpeech(peak, transcript, snap);
    const keywords = [
      ...new Set(
        hits.filter((h) => start <= h.at && h.at <= end).map((h) => h.word),
      ),
    ].sort();

    candidates.push({
      peak,
      start,
      end,
      score: total[idx]!,
      parts: Object.fromEntries(
        Object.entries(parts).map(([name, values]) => [name, values[idx]!]),
      ),
      text: textBetween(words, start, end),
      keywords,
    });
  }

  // Стабильный порядок: при равных оценках раньше идёт ранний момент.
  candidates.sort((a, b) => b.score - a.score || a.peak - b.peak);
  return candidates;
}

// --- отбор для рендера --------------------------------------------------

/**
 * Какой сигнал сделал этот момент кандидатом.
 *
 * Метка идёт в имя файла и в отчёт. Без неё аналитика по опубликованным
 * клипам бессмысленна: нельзя понять, какой тип триггера приносит
 * просмотры, а какой только тратит загрузки.
 */
export function labelTrigger(
  candidate: Candidate,
  weights: Record<string, number> = DEFAULT_WEIGHTS,
): string {
  let best = "";
  let bestValue = 0;
  for (const [name, value] of Object.entries(candidate.parts)) {
    const contribution = (weights[name] ?? 0) * value;
    if (contribution > bestValue) {
      bestValue = contribution;
      best = name;
    }
  }
  return bestValue > 0 ? best : "misc";
}

/**
 * Выбрать разнообразную подборку, а не топ по оценке.
 *
 * Топ по оценке даёт однобокую выдачу: все клипы одного типа и часто из
 * одного получаса стрима. Для стратегии «много клипов, потом смотрим
 * статистику» это худший вариант - сравнивать будет не с чем.
 *
 * Ограничения ослабляются в три захода, если иначе не набрать количество.
 */
export function selectDiverse(
  candidates: readonly Candidate[],
  count: number,
  streamDuration: number,
  weights: Record<string, number> = DEFAULT_WEIGHTS,
  bins = 12,
): Candidate[] {
  if (candidates.length === 0 || count <= 0) return [];

  const labels = new Map<Candidate, string>(
    candidates.map((c) => [c, labelTrigger(c, weights)]),
  );
  const kinds = new Set(labels.values());
  const perKind = Math.max(1, Math.trunc(count / Math.max(1, kinds.size)));
  const binSeconds = Math.max(1, streamDuration / Math.max(1, bins));
  const perBin = Math.max(1, Math.trunc(count / Math.max(1, bins)));

  const ranked = [...candidates].sort((a, b) => b.score - a.score || a.peak - b.peak);
  const chosen: Candidate[] = [];
  const inChosen = new Set<Candidate>();

  for (const stage of ["strict", "time_only", "free"] as const) {
    const kindUsed = new Map<string, number>();
    const binUsed = new Map<number, number>();
    for (const c of chosen) {
      const kind = labels.get(c)!;
      kindUsed.set(kind, (kindUsed.get(kind) ?? 0) + 1);
      const slot = Math.trunc(c.peak / binSeconds);
      binUsed.set(slot, (binUsed.get(slot) ?? 0) + 1);
    }

    for (const candidate of ranked) {
      if (chosen.length >= count) break;
      if (inChosen.has(candidate)) continue;

      const kind = labels.get(candidate)!;
      const slot = Math.trunc(candidate.peak / binSeconds);

      if (stage === "strict" && (kindUsed.get(kind) ?? 0) >= perKind) continue;
      if (stage !== "free" && (binUsed.get(slot) ?? 0) >= perBin) continue;

      chosen.push(candidate);
      inChosen.add(candidate);
      kindUsed.set(kind, (kindUsed.get(kind) ?? 0) + 1);
      binUsed.set(slot, (binUsed.get(slot) ?? 0) + 1);
    }

    if (chosen.length >= count) break;
  }

  return chosen.sort((a, b) => a.peak - b.peak);
}
