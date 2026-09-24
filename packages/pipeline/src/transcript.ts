/**
 * Расшифровка речи в том виде, в каком с ней работает конвейер.
 *
 * Сам разбор делает python-воркер (faster-whisper), сюда приходит
 * готовая структура. Здесь только то, что нужно остальным шагам:
 * плоский список слов, куски по времени, доля речи.
 */
import type { TranscribeResult } from "@clipforge/contracts";
import { normalizeRussianText } from "@clipforge/contracts/text";

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
    text: normalizeRussianText(s.text),
    words: normalizeTranscriptWords(s.words),
  })),
});

/** Плоский список слов. Считается один раз и передаётся дальше. */
export const allWords = (transcript: Transcript): TranscriptWord[] =>
  normalizeTranscriptWords(transcript.segments.flatMap((s) => s.words));

/** Join detached ASR suffixes before wrapping/highlighting, preserving their time span. */
export function normalizeTranscriptWords(words: readonly TranscriptWord[]): TranscriptWord[] {
  const result: TranscriptWord[] = [];
  for (const source of words) {
    const word = {...source, text: normalizeRussianText(source.text)};
    if (!word.text) continue;
    const previous = result.at(-1);
    if (previous && word.start - previous.end <= 0.3 && (
      (/[\p{L}\p{N}]$/u.test(previous.text) && /^-(?:то|либо|нибудь|ка|таки)(?:[,.!?…])?$/iu.test(word.text)) ||
      (/[\p{L}\p{N}]-$/u.test(previous.text) && /^(?:то|либо|нибудь|ка|таки)(?:[,.!?…])?$/iu.test(word.text)) ||
      /^[,.;:!?…»)]+$/u.test(word.text)
    )) {
      previous.text += word.text;
      previous.end = Math.max(previous.end, word.end);
    } else result.push(word);
  }
  return result;
}

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
