/**
 * Поиск мата в расшифровке.
 *
 * Главная сложность не в списке слов, а в ложных срабатываниях. Русский
 * мат сильно склоняется, и наивный поиск подстроки ловит совершенно
 * безобидные слова:
 *
 *     «бля»   ->  упо-БЛЯ-ть, осла-БЛЯ-ет, за-БЛУ-ждение
 *     «муд»   ->  МУДрый, МУДрость
 *     «сук»   ->  СУКно
 *     «ху»    ->  ХУдожник, ХУдой, ХУтор
 *     «манда» ->  МАНДАрин, МАНДАт
 *
 * Поэтому здесь не список корней, а набор явных шаблонов с привязкой к
 * границе слова, а рядом - список слов, которые НЕ должны срабатывать.
 * Он проверяется тестом: любое изменение шаблонов сразу видно.
 *
 * Совсем без ошибок не выйдет: «сука» как ругательство и «сука» как
 * самка собаки - одно и то же слово, различить их без разбора смысла
 * нельзя. Для звёздочек в субтитрах это приемлемо: лишняя звёздочка
 * безобиднее пропущенного мата.
 */
import type { TranscriptWord } from "./transcript.js";

import { isProfane } from "@clipforge/contracts/text";
export { CLEAN_WORDS, normalize, isProfane, mask } from "@clipforge/contracts/text";

export interface ProfanityHit {
  word: TranscriptWord;
  start: number;
  end: number;
  text: string;
}

/** Найти мат в отрезке записи. Границы - фактические границы слова. */
export function findProfanity(
  words: readonly TranscriptWord[],
  start = 0,
  end?: number,
): ProfanityHit[] {
  const hits: ProfanityHit[] = [];
  for (const word of words) {
    if (word.start < start) continue;
    if (end !== undefined && word.start >= end) break;
    if (isProfane(word.text)) {
      hits.push({ word, start: word.start, end: word.end, text: word.text });
    }
  }
  return hits;
}

export type Span = [start: number, end: number];

/**
 * Короткие интервалы писка по центру каждого ругательства.
 *
 * Накрывать слово целиком не нужно: длинный писк режет слух и съедает
 * соседние звуки, а для цензуры достаточно заглушить середину - смысл
 * слова уже не собирается.
 *
 * Длительность ограничена сверху долей самого слова: на коротких словах
 * фиксированные 0.22 с вылезли бы за границы и задели соседей.
 */
export function beepSpans(
  hits: readonly ProfanityHit[],
  seconds = 0.22,
  minRatio = 0.9,
): Span[] {
  const spans: Span[] = [];
  for (const hit of hits) {
    const length = Math.max(0, hit.end - hit.start);
    if (length <= 0) continue;
    const width = Math.min(seconds, length * minRatio);
    const centre = (hit.start + hit.end) / 2;
    spans.push([centre - width / 2, centre + width / 2]);
  }
  return spans;
}

/**
 * Слить интервалы, которые почти соприкасаются.
 *
 * Мат идёт очередью, и писки, разделённые парой кадров, звучат как
 * треск. Порог небольшой: при коротких сигналах слипание соседних слов
 * в один длинный писк как раз не нужно - оно вернуло бы ту самую
 * длинную заглушку.
 */
export function mergeSpans(spans: readonly Span[], gap = 0.06): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged: Span[] = [[sorted[0]![0], sorted[0]![1]]];
  for (const [begin, finish] of sorted.slice(1)) {
    const last = merged.at(-1)!;
    if (begin - last[1] <= gap) {
      last[1] = Math.max(last[1], finish);
    } else {
      merged.push([begin, finish]);
    }
  }
  return merged;
}
