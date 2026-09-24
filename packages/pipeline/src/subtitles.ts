/**
 * Субтитры в формате ASS: плавно прокручивающаяся лента.
 *
 * На экране пять строк - две прошлые фразы, текущая и две будущие. Все
 * одного цвета, но чем дальше от центра, тем прозрачнее: получается
 * мягкое затухание к краям блока. В текущей фразе подсвечено слово,
 * которое звучит прямо сейчас.
 *
 * Три решения, которые определяют поведение.
 *
 * **Лента никогда не пропадает.** События нарезаны встык и покрывают
 * весь клип от нулевой секунды до конца, включая паузы в речи. Раньше
 * слот обрывался через несколько секунд, и при долгом молчании текст
 * исчезал.
 *
 * **Подсветка живёт ровно столько, сколько звучит слово.** На каждое
 * слово приходится два события: подсвеченное на отрезке [начало, конец]
 * и обычное - до начала следующего слова. Если слот тянуть до
 * следующего слова целиком, слово остаётся подсвеченным всю паузу.
 *
 * **Прокрутка плавная, а не перещёлкивание.** При смене фразы блок
 * въезжает снизу на высоту строки за 250 мс (тег \move). Внутри фразы
 * позиция постоянна, поэтому движение видно только в момент перехода.
 *
 * Штатный караоке-тег ASS (\k) не подошёл: он закрашивает всё уже
 * сказанное, а выделить нужно ровно одно текущее слово.
 */
import { maskProfanity } from "@clipforge/contracts/text";
import type { Transcript, TranscriptWord } from "./transcript.js";
import { allWords } from "./transcript.js";
import {
  headerEvent,
  headerStyle,
  isOutroEmpty,
  measureText,
  outroEvents,
  outroStyles,
  type BrandAssets,
  type HeaderLockup,
  type OutroCard,
} from "./twitch.js";

/**
 * Границы фразы. Лимит символов - под ОДНУ строку экрана: перенос ломает
 * высоту ленты, и строки начинают прыгать при прокрутке.
 */
export const MAX_PHRASE_SECONDS = 3.6;
export const MAX_PHRASE_CHARS = 32;
const MIN_PHRASE_WORDS = 2;
const PAUSE_BREAK = 0.55;
const SENTENCE_END = /[.!?…]\s*$/;

/** Сколько фраз показывать выше и ниже текущей. */
const CONTEXT_LINES = 2;

/** Длительность въезда блока при смене фразы, миллисекунды. */
const SCROLL_MS = 250;

export interface SubtitleStyle {
  font: string;
  size: number;
  /** Цвет всего текста ленты. */
  idle: string;
  /** Цвет текущего слова: Twitch Purple. */
  active: string;
  outlineColour: string;
  backColour: string;
  outline: number;
  shadow: number;
  marginH: number;
  /** Верх зоны субтитров на холсте. */
  topY: number;
  lineSpacing: number;
  bold: number;
  /**
   * Маскировать мат звёздочками. Звук запикивается отдельно - это
   * независимые вещи, и включать их можно порознь.
   */
  censor: boolean;
  maxPhraseSeconds: number;
  maxPhraseChars: number;
  /**
   * Предел ширины строки в пикселях холста.
   *
   * Лимит по числу символов не знает ширины букв: 42 символа Arial
   * Black при кегле 66 - это до полутора тысяч пикселей, и строка
   * вылезала за клип. Когда предел задан, фразы режутся по фактической
   * ширине текста, замеренной по метрикам шрифта.
   */
  maxLineWidth: number | null;
  /**
   * Прозрачность по удалению от текущей строки: 0 - непрозрачно. Даёт
   * мягкое затухание к краям блока вместо резкой границы.
   */
  fade: readonly string[];
  /**
   * Не давать подсветке гореть дольше, чем слово может звучать.
   *
   * Whisper приписывает тишину после фразы первому слову следующей: по
   * его временам слово «начинается» сразу за предыдущим предложением, а
   * звучит через несколько секунд. Подсветка по таким временам
   * загоралась заранее и висела всю паузу. Слово физически не звучит
   * дольше пары секунд, поэтому подсветка прижимается к КОНЦУ
   * интервала, а проглоченная тишина в начале остаётся без подсветки.
   */
  capHighlight: boolean;
}

export const defaultStyle = (overrides: Partial<SubtitleStyle> = {}): SubtitleStyle => ({
  font: "Arial Black",
  size: 46,
  idle: "&H00FFFFFF",
  active: "&H00FF4691",
  outlineColour: "&H00000000",
  backColour: "&H90000000",
  outline: 4,
  shadow: 2,
  marginH: 40,
  topY: 1560,
  lineSpacing: 2,
  bold: 1,
  censor: false,
  maxPhraseSeconds: MAX_PHRASE_SECONDS,
  maxPhraseChars: MAX_PHRASE_CHARS,
  maxLineWidth: null,
  fade: ["&H00&", "&H55&", "&HA0&"],
  capHighlight: true,
  ...overrides,
});

export const lineHeight = (style: SubtitleStyle): number =>
  Math.trunc(style.size * 1.35) + style.lineSpacing;

const alphaFor = (style: SubtitleStyle, distance: number): string =>
  style.fade[Math.min(Math.abs(distance), style.fade.length - 1)]!;

/** ASS хочет ч:мм:сс.цс (сотые доли). */
export function formatTime(seconds: number): string {
  const value = Math.max(0, seconds);
  const h = Math.trunc(value / 3600);
  const m = Math.trunc((value % 3600) / 60);
  const s = value % 60;
  return `${h}:${String(m).padStart(2, "0")}:${s.toFixed(2).padStart(5, "0")}`;
}

/** Убрать символы, которые ASS воспримет как разметку. */
const clean = (text: string): string =>
  text.replaceAll("\\", "").replaceAll("{", "(").replaceAll("}", ")").trim();

/**
 * Сколько секунд слово может звучать на самом деле. Грубая оценка по
 * длине: короткое «да» - полсекунды, длинное слово - до полутора.
 */
export const highlightCap = (text: string): number =>
  Math.min(1.5, 0.4 + 0.08 * text.length);

const phraseLength = (words: readonly TranscriptWord[]): number =>
  words.reduce((sum, w) => sum + w.text.length + 1, 0);

const textOf = (words: readonly TranscriptWord[]): string =>
  words.map((w) => w.text).join(" ");

/**
 * Собрать слова во фразы по паузам и знакам конца предложения.
 *
 * fits - проверка, помещается ли строка в клип по фактической ширине.
 * Когда она передана, лимит символов не используется: он лишь грубое
 * приближение ширины и на широких буквах врёт.
 */
export function groupPhrases(
  words: readonly TranscriptWord[],
  maxSeconds = MAX_PHRASE_SECONDS,
  maxChars = MAX_PHRASE_CHARS,
  fits?: (text: string) => boolean,
): TranscriptWord[][] {
  const phrases: TranscriptWord[][] = [];
  let current: TranscriptWord[] = [];

  for (const word of words) {
    if (current.length > 0) {
      const last = current.at(-1)!;
      const pause = word.start - last.end;
      const sentenceOver = SENTENCE_END.test(last.text);
      const tooLong = word.end - current[0]!.start > maxSeconds;
      const tooWide = fits
        ? !fits(`${textOf(current)} ${word.text}`)
        : phraseLength(current) + word.text.length > maxChars;

      if (pause > PAUSE_BREAK || sentenceOver || tooLong || tooWide) {
        phrases.push(current);
        current = [];
      }
    }
    current.push(word);
  }
  if (current.length > 0) phrases.push(current);

  return mergeOrphans(phrases.filter((p) => p.length > 0), maxChars, fits);
}

/**
 * Приклеить одиночные слова к соседям.
 *
 * Разрыв по лимиту символов оставлял хвост предложения из одного слова,
 * и оно всплывало отдельной строкой - читается как ошибка распознавания,
 * хотя это продолжение мысли.
 */
function mergeOrphans(
  phrases: TranscriptWord[][],
  maxChars = MAX_PHRASE_CHARS,
  fits?: (text: string) => boolean,
): TranscriptWord[][] {
  if (phrases.length === 0) return phrases;

  // Влезет ли склейка двух фраз в одну строку.
  const joinable = (a: readonly TranscriptWord[], b: readonly TranscriptWord[]) =>
    fits
      ? fits(`${textOf(a)} ${textOf(b)}`)
      : phraseLength(a) + phraseLength(b) <= maxChars + 8;

  const result: TranscriptWord[][] = [];
  for (const phrase of phrases) {
    const previous = result.at(-1);
    if (
      previous &&
      phrase.length < MIN_PHRASE_WORDS &&
      joinable(previous, phrase) &&
      !SENTENCE_END.test(previous.at(-1)!.text)
    ) {
      previous.push(...phrase);
    } else {
      result.push([...phrase]);
    }
  }

  const merged: TranscriptWord[][] = [];
  let index = 0;
  while (index < result.length) {
    const phrase = result[index]!;
    const next = result[index + 1];
    if (phrase.length < MIN_PHRASE_WORDS && next && joinable(phrase, next)) {
      merged.push([...phrase, ...next]);
      index += 2;
      continue;
    }
    merged.push(phrase);
    index += 1;
  }
  return merged;
}

/** Текст фразы. active - индекс слова, которое надо подсветить. */
function phraseText(
  words: readonly TranscriptWord[],
  active: number | null,
  style: SubtitleStyle,
): string {
  const chunks: string[] = [];
  words.forEach((word, i) => {
    let text = clean(word.text);
    if (!text) return;
    if (style.censor) {
      // Первая буква остаётся: полностью скрытое слово читается как
      // ошибка распознавания, а не как цензура.
      text = maskProfanity(text);
    }
    chunks.push(
      active !== null && i === active
        ? `{\\c${style.active}&}${text}{\\c${style.idle}&}`
        : text,
    );
  });
  return chunks.join(" ");
}

export interface BuildAssOptions {
  style?: SubtitleStyle;
  header?: HeaderLockup | null;
  outro?: OutroCard | null;
  /**
   * Где лежат официальные логотипы. Путь даёт вызывающая сторона: из
   * размеров файла считаются пропорции карточки и ширина знака в шапке.
   */
  assets?: BrandAssets;
}

/** Собрать ASS для отрезка [start, end]. Времена сдвигаются к нулю. */
export function buildAss(
  transcript: Transcript,
  start: number,
  end: number,
  width: number,
  height: number,
  options: BuildAssOptions = {},
): string {
  const style = options.style ?? defaultStyle();
  const header = options.header ?? null;
  const outro = options.outro ?? null;
  const assets = options.assets ?? { root: "assets/twitch" };
  const duration = end - start;

  // Субтитры и плашка обрываются на входе концовки: поверх слайда они
  // выглядели бы мусором от предыдущей сцены. Концовка идёт ПОСЛЕ видео,
  // поэтому содержание клипа занимает всю его длительность.
  const hasOutro = outro !== null && !isOutroEmpty(outro);
  const contentEnd = duration;

  let extraStyles: string[] = [];
  let extraEvents: string[] = [];
  if (hasOutro) {
    extraStyles = outroStyles();
    extraEvents = outroEvents(outro, duration, width, height, formatTime, assets);
  }

  // Шапка висит только над содержанием: на карточке канала она лишняя,
  // там уже есть и знак, и имя, и адрес.
  const brandEvents: string[] = [];
  if (header) {
    extraStyles = [headerStyle(), ...extraStyles];
    brandEvents.push(headerEvent(header, contentEnd, width, formatTime, assets));
  }

  const speechEnd = start + contentEnd;
  const words = allWords(transcript).filter(
    (w) => start <= w.start && w.start < speechEnd && clean(w.text),
  );
  const fits = style.maxLineWidth
    ? (text: string) =>
        measureText(text, style.font, style.size) <= (style.maxLineWidth as number)
    : undefined;
  const phrases = groupPhrases(words, style.maxPhraseSeconds, style.maxPhraseChars, fits);

  if (phrases.length === 0) {
    // Речи в окне нет - остаётся только плашка источника.
    return (
      assHeader(width, height, style, extraStyles) +
      [...brandEvents, ...extraEvents].join("\n") +
      "\n"
    );
  }

  // Плоский список слов с указанием фразы.
  const flat: { phrase: number; word: number; value: TranscriptWord }[] = [];
  phrases.forEach((phrase, pi) =>
    phrase.forEach((value, wi) => flat.push({ phrase: pi, word: wi, value })),
  );

  const centreX = Math.trunc(width / 2);
  const lineH = lineHeight(style);
  // Текущая строка всегда на этой высоте, список ездит относительно неё.
  const focusY = style.topY + CONTEXT_LINES * lineH;

  // Окно просмотра. Список рисуется целиком, поэтому за пределами зоны
  // субтитров он налезал бы на геймплей - лишнее срезается \clip.
  const viewTop = style.topY;
  const viewBottom = Math.min(height, style.topY + (2 * CONTEXT_LINES + 1) * lineH);
  const clipTag = `\\clip(0,${viewTop},${width},${viewBottom})`;

  const events: string[] = [];
  let previousPhrase = -1;

  /**
   * Выложить видимые строки ленты на отрезок [t0, t1].
   *
   * Каждая строка - отдельное событие со СВОЕЙ абсолютной координатой.
   * Раньше весь список шёл одним блоком, а позиция задавалась только его
   * верхнему краю: дальше libass раскладывал строки сам, по своей высоте
   * строки. Она не совпадала с расчётной, и ошибка копилась - чем дальше
   * по клипу, тем сильнее лента уезжала вверх.
   */
  const emit = (t0: number, rawT1: number, phraseIndex: number, active: number | null): void => {
    const t1 = Math.min(rawT1, start + contentEnd);
    if (t1 <= t0) return;

    const changed = phraseIndex !== previousPhrase && previousPhrase >= 0;

    // На одну строку шире окна с каждой стороны: крайние строки должны
    // въезжать и уезжать за границей видимой зоны, а не возникать и
    // пропадать в кадре.
    for (let offset = -CONTEXT_LINES - 1; offset <= CONTEXT_LINES + 1; offset++) {
      const index = phraseIndex + offset;
      if (index < 0 || index >= phrases.length) continue;

      const y = focusY + offset * lineH;
      const move = changed
        ? // При смене фразы строка была на строку ниже.
          `\\move(${centreX},${y + lineH},${centreX},${y},0,${SCROLL_MS})`
        : `\\pos(${centreX},${y})`;

      const body = phraseText(
        phrases[index]!,
        index === phraseIndex ? active : null,
        style,
      );
      events.push(
        `Dialogue: 0,${formatTime(t0 - start)},${formatTime(t1 - start)},` +
          `Main,,0,0,0,,{\\an8${move}${clipTag}` +
          `\\alpha${alphaFor(style, offset)}}${body}`,
      );
    }

    previousPhrase = phraseIndex;
  };

  // Пауза перед первым словом: лента уже на экране, ничего не подсвечено.
  if (flat[0]!.value.start > start) emit(start, flat[0]!.value.start, 0, null);

  flat.forEach((item, i) => {
    const nextStart = flat[i + 1]?.value.start ?? start + contentEnd;
    const wordEnd = Math.min(item.value.end, nextStart);
    // Начало подсветки: конец интервала минус правдоподобная
    // длительность слова. Тишина, проглоченная Whisper'ом в начало
    // интервала, остаётся без подсветки - лента уже прокрутилась,
    // но слово загорается тогда, когда его произносят.
    const litFrom = style.capHighlight
      ? Math.max(item.value.start, wordEnd - highlightCap(item.value.text))
      : item.value.start;
    emit(item.value.start, litFrom, item.phrase, null);
    // Пока слово звучит - оно подсвечено.
    emit(litFrom, wordEnd, item.phrase, item.word);
    // После него и до следующего слова подсветки нет, но текст остаётся.
    emit(wordEnd, nextStart, item.phrase, null);
  });

  return (
    assHeader(width, height, style, extraStyles) +
    [...brandEvents, ...events, ...extraEvents].join("\n") +
    "\n"
  );
}

function assHeader(
  width: number,
  height: number,
  style: SubtitleStyle,
  extraStyles: readonly string[] = [],
): string {
  const extra = extraStyles.length ? `\n${extraStyles.join("\n")}` : "";
  // Alignment 8 - привязка к ВЕРХУ строки: блок растёт вниз от заданной
  // точки, поэтому его положение не зависит от числа строк.
  // WrapStyle 2 - без автопереноса: фразы уже ограничены по длине, а
  // неожиданный перенос сдвинул бы всю ленту.
  return `[Script Info]
ScriptType: v4.00+
PlayResX: ${width}
PlayResY: ${height}
WrapStyle: 2
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Main,${style.font},${style.size},${style.idle},${style.idle},${style.outlineColour},${style.backColour},${style.bold},0,0,0,100,100,${style.lineSpacing},0,1,${style.outline},${style.shadow},8,${style.marginH},${style.marginH},0,204
${extra}
[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}
