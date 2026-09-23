/**
 * Расшифровка речи в том виде, в каком с ней работает конвейер.
 *
 * Сам разбор делает python-воркер (faster-whisper), сюда приходит
 * готовая структура. Здесь только то, что нужно остальным шагам:
 * плоский список слов, куски по времени, доля речи.
 */
import type { TranscribeResult } from "@clipforge/contracts";

export interface TranscriptWord {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
  words: TranscriptWord[];
}

export interface Transcript {
  language: string;
  duration: number;
  segments: TranscriptSegment[];
}

export const fromWorker = (result: TranscribeResult): Transcript => ({
  language: result.language,
  duration: result.duration,
  segments: result.segments.map((s) => ({
    start: s.start,
    end: s.end,
    text: s.text,
    words: s.words.map((w) => ({ start: w.start, end: w.end, text: w.text })),
  })),
});

/** Плоский список слов. Считается один раз и передаётся дальше. */
export const allWords = (transcript: Transcript): TranscriptWord[] =>
  transcript.segments.flatMap((s) => s.words);

/** Сколько секунд из записи вообще занята речь. */
export const speechSeconds = (transcript: Transcript): number =>
  transcript.segments.reduce((sum, s) => sum + (s.end - s.start), 0);

/** Слова, попавшие в окно. Границы по началу слова. */
export function wordsBetween(
  words: readonly TranscriptWord[],
  start: number,
  end: number,
): TranscriptWord[] {
  return words.filter((w) => w.end > start && w.start < end);
}
