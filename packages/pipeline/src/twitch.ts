/**
 * Фирменное оформление Twitch по официальным гайдлайнам.
 *
 * Материалы взяты из брендбука Twitch (Logo Usage Guidelines, Speedrun
 * Edition v3.0) и лежат в assets/twitch. Логотип НЕ перерисовывается -
 * подкладываются оригинальные файлы.
 *
 * Что прямо запрещено гайдлайнами и потому здесь не делается:
 *
 *   - рисовать логотип самому или набирать «twitch» шрифтом («Don't make
 *     a font or spell out words using Twitch-like letterforms») - в
 *     первой версии знак отрисовывался вектором, и это была ошибка: у
 *     официального глитча интерьер белый, а не залитый;
 *   - применять цвета вне основной палитры;
 *   - растягивать, поворачивать, обводить и накладывать эффекты;
 *   - использовать логотип в низком разрешении.
 *
 * Основной логотип для внешних материалов - extruded wordmark: по
 * гайдлайнам это «our primary logo... used primarily in outbound comms
 * when we want to be the most expressive». Клип-витрина ровно такой случай.
 */
import { openSync as openFontSync, type Font } from "fontkit";
import { openSync, readSync, closeSync } from "node:fs";
import { join } from "node:path";

/**
 * Основная палитра Twitch - ровно четыре цвета, других быть не должно.
 *
 * ASS хранит цвет как &HAABBGGRR: байты идут в обратном порядке
 * относительно привычного #RRGGBB, поэтому рядом указан исходный HEX.
 */
export const Palette = {
  PURPLE: "&H00FF4691", // #9146FF - Twitch Purple
  BLACK: "&H00000000", // #000000 - Black Ops
  ICE: "&H00FFF0F0", // #F0F0FF - Ice
  WHITE: "&H00FFFFFF", // #FFFFFF - White
  PURPLE_HEX: "0x9146FF",
  BLACK_HEX: "0x000000",
} as const;

export type LogoKind = "extruded" | "flat" | "glitch";
export type LogoVariant = "purple" | "white" | "ice" | "black-ops";

const LOGO_FILES: Record<LogoKind, Record<LogoVariant, string>> = {
  extruded: {
    purple: "twitch_wordmark_extruded_purple.png",
    white: "twitch_wordmark_extruded_white.png",
    ice: "twitch_wordmark_extruded_ice.png",
    "black-ops": "twitch_wordmark_extruded_black-ops.png",
  },
  flat: {
    purple: "twitch_wordmark_flat_purple.png",
    white: "twitch_wordmark_flat_white.png",
    ice: "twitch_wordmark_flat_ice.png",
    "black-ops": "twitch_wordmark_flat_black-ops.png",
  },
  glitch: {
    purple: "glitch_flat_purple.png",
    white: "glitch_flat_white.png",
    ice: "glitch_flat_ice.png",
    "black-ops": "glitch_flat_black-ops.png",
  },
};

/**
 * Каталог с ассетами. Задаётся снаружи - конвейер не должен вычислять
 * раскладку проекта от собственного расположения.
 */
export interface BrandAssets {
  root: string;
}

export function logoPath(
  assets: BrandAssets,
  kind: LogoKind = "extruded",
  variant: LogoVariant = "purple",
): string {
  const table = LOGO_FILES[kind] ?? LOGO_FILES.extruded;
  return join(assets.root, table[variant] ?? LOGO_FILES.extruded.purple);
}

/**
 * Размеры PNG из заголовка файла.
 *
 * Читаются напрямую: IHDR лежит по фиксированному смещению, и тянуть
 * ради двух чисел библиотеку декодирования изображений незачем.
 */
export function pngSize(path: string): { width: number; height: number } {
  const handle = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(24);
    readSync(handle, buffer, 0, 24, 0);
    if (buffer.toString("ascii", 1, 4) !== "PNG") {
      throw new Error(`не PNG: ${path}`);
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  } finally {
    closeSync(handle);
  }
}

// --- метрики текста ---------------------------------------------------

const FONT_FILES: Record<string, string> = {
  "Arial Black": "C:/Windows/Fonts/ariblk.ttf",
  Arial: "C:/Windows/Fonts/arial.ttf",
};

// openSync возвращает Font либо FontCollection (.ttc). Нам нужны метрики
// одного начертания, поэтому коллекции сюда не попадают.
const fontCache = new Map<string, Font | null>();

/**
 * Ширина строки в пикселях.
 *
 * Нужна, чтобы честно отцентровать локап «логотип + имя канала». Без
 * замера пришлось бы ставить логотип по фиксированной координате и
 * надеяться, что имя канала окажется нужной длины.
 *
 * Ширины глифов складываются в единицах шрифта и округляются один раз, а
 * не на каждом символе. От python-версии, где это делал PIL, результат
 * отличается на пару пикселей: PIL округляет каждый глиф отдельно. При
 * центровке это сдвиг меньше двух пикселей на холсте в 1080.
 */
export function measureText(text: string, fontName: string, size: number): number {
  const path = FONT_FILES[fontName] ?? FONT_FILES.Arial!;
  let font = fontCache.get(path);
  if (font === undefined) {
    try {
      const opened = openFontSync(path);
      font = "glyphForCodePoint" in opened ? (opened as Font) : null;
    } catch {
      font = null;
    }
    fontCache.set(path, font);
  }
  if (!font) {
    // Грубая оценка, если шрифт не нашёлся: лучше приблизительный центр,
    // чем падение рендера.
    return Math.trunc(text.length * size * 0.62);
  }

  let units = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0);
    if (code === undefined) continue;
    units += font.glyphForCodePoint(code).advanceWidth;
  }
  return Math.trunc((units * size) / font.unitsPerEm);
}

// --- концовка ---------------------------------------------------------

export interface OutroCard {
  channel: string;
  url: string;
  /** Заголовок стрима или тема. */
  subtitle: string;
  label: string;
  seconds: number;
  logoKind: LogoKind;
  logoVariant: LogoVariant;
  /** Ширина логотипа на холсте 1080. */
  logoWidth: number;
  subtitleLimit: number;
  /**
   * Непрозрачность подложки, 0..1. Карточка ложится на добавленный кусок
   * видео, и сквозь неё должно чуть просвечивать происходящее - так
   * переход читается как продолжение клипа, а не как склейка.
   */
  scrim: number;
}

export const outroCard = (values: Partial<OutroCard> = {}): OutroCard => ({
  channel: "",
  url: "",
  subtitle: "",
  label: "СТРИМ ЦЕЛИКОМ НА",
  seconds: 3.4,
  logoKind: "extruded",
  logoVariant: "purple",
  logoWidth: 640,
  subtitleLimit: 44,
  scrim: 0.88,
  ...values,
});

export const isOutroEmpty = (card: OutroCard): boolean =>
  !(card.channel || card.url);

export const outroLogoPath = (assets: BrandAssets, card: OutroCard): string =>
  logoPath(assets, card.logoKind, card.logoVariant);

/** Заголовок стрима бывает длинным и с эмодзи - обрезаем. */
export function trimmedSubtitle(card: OutroCard): string {
  const text = card.subtitle.split(/\s+/).filter(Boolean).join(" ");
  if (text.length <= card.subtitleLimit) return text;
  return `${text.slice(0, card.subtitleLimit - 1).replace(/[ ,.-]+$/, "")}…`;
}

/** Стили концовки. Цвета - только из основной палитры. */
export function outroStyles(): string[] {
  const base = "0,0,0,100,100,0,0,1";
  return [
    // Подпись над логотипом.
    `Style: OutroLabel,Arial,36,${Palette.ICE},${Palette.ICE},` +
      `${Palette.BLACK},${Palette.BLACK},1,${base},0,0,5,60,60,0,204`,
    // Имя канала.
    `Style: OutroName,Arial Black,78,${Palette.WHITE},${Palette.WHITE},` +
      `${Palette.BLACK},${Palette.BLACK},1,${base},0,0,5,60,60,0,204`,
    // Адрес - единственный фиолетовый акцент на экране.
    `Style: OutroUrl,Arial Black,50,${Palette.PURPLE},${Palette.PURPLE},` +
      `${Palette.BLACK},${Palette.BLACK},1,${base},0,0,5,60,60,0,204`,
    // Тема стрима.
    `Style: OutroSub,Arial,38,${Palette.ICE},${Palette.ICE},` +
      `${Palette.BLACK},${Palette.BLACK},0,${base},0,0,5,60,60,0,204`,
  ];
}

export interface OutroLayout {
  logoX: number;
  logoY: number;
  logoH: number;
  labelY: number;
  nameY: number;
  urlY: number;
  subY: number;
}

/**
 * Раскладка карточки: где логотип и где строки.
 *
 * Считается по фактическим высотам и центрируется - при добавлении
 * строки композиция не уезжает.
 */
export function outroLayout(
  assets: BrandAssets,
  card: OutroCard,
  width: number,
  height: number,
): OutroLayout {
  const image = pngSize(outroLogoPath(assets, card));
  const logoH = Math.trunc((card.logoWidth * image.height) / image.width);

  const labelH = 48;
  const nameH = 96;
  const urlH = 62;
  const subH = 50;
  const gapLogo = 110;
  const gapLine = 30;

  let block = labelH + gapLine + logoH + gapLogo + nameH + gapLine + urlH;
  if (card.subtitle) block += gapLine + subH;

  const top = Math.trunc((height - block) / 2);
  const labelY = top;
  const logoY = labelY + labelH + gapLine;
  const nameY = logoY + logoH + gapLogo;
  const urlY = nameY + nameH + gapLine;
  const subY = urlY + urlH + gapLine;

  return {
    logoX: Math.trunc((width - card.logoWidth) / 2),
    logoY,
    logoH,
    labelY,
    nameY,
    urlY,
    subY,
  };
}

/**
 * Насколько дольше расчётного конца живут строки карточки.
 *
 * События заканчивались ровно на расчётной длительности, но последние
 * кадры видео из-за округления к сетке кадров живут чуть дольше - и на
 * них карточка оставалась пустой, только логотип (он накладывается
 * ffmpeg-ом и не привязан к событиям ASS). Запас ничего не стоит: видео
 * всё равно кончается раньше.
 */
const OUTRO_HOLD_SECONDS = 5;

/** События концовки. contentEnd - момент, где кончается видео. */
export function outroEvents(
  card: OutroCard,
  contentEnd: number,
  width: number,
  height: number,
  formatTime: (seconds: number) => string,
  assets: BrandAssets = { root: "assets/twitch" },
): string[] {
  if (isOutroEmpty(card)) return [];

  const box = outroLayout(assets, card, width, height);
  const centreX = Math.trunc(width / 2);
  const stop = formatTime(contentEnd + card.seconds + OUTRO_HOLD_SECONDS);
  const at = (offset: number) => formatTime(contentEnd + offset);

  // Строки всплывают снизу вверх по очереди. Порядок - это порядок
  // принятия решения: где смотреть, кого, по какому адресу.
  const rows: [number, string, number, number, string][] = [
    [0.1, "OutroLabel", box.labelY, 24, card.label],
    [0.3, "OutroName", box.nameY, 34, card.channel],
    [0.42, "OutroUrl", box.urlY, 28, card.url],
  ];
  if (card.subtitle) {
    rows.push([0.54, "OutroSub", box.subY, 24, trimmedSubtitle(card)]);
  }

  return rows.map(
    ([delay, style, y, rise, text], i) =>
      `Dialogue: ${i + 2},${at(delay)},${stop},${style},,0,0,0,,` +
      `{\\move(${centreX},${y + rise},${centreX},${y},0,260)\\fad(200,0)}${text}`,
  );
}

// --- шапка клипа: фирменный локап --------------------------------------

export interface HeaderLockup {
  channel: string;
  url: string;
  font: string;
  size: number;
  logoHeight: number;
  /** Отступ между знаком и текстом. */
  gap: number;
  y: number;
  variant: LogoVariant;
}

export const headerLockup = (values: Partial<HeaderLockup> = {}): HeaderLockup => ({
  channel: "",
  url: "",
  font: "Arial Black",
  size: 38,
  logoHeight: 46,
  gap: 18,
  y: 26,
  variant: "purple",
  ...values,
});

export const headerLogoPath = (assets: BrandAssets, lockup: HeaderLockup): string =>
  logoPath(assets, "glitch", lockup.variant);

export interface HeaderGeometry {
  logoX: number;
  logoY: number;
  logoW: number;
  textX: number;
  textY: number;
}

/** Позиции знака и текста для отцентрованного локапа. */
export function headerGeometry(
  assets: BrandAssets,
  lockup: HeaderLockup,
  canvasWidth: number,
): HeaderGeometry {
  const image = pngSize(headerLogoPath(assets, lockup));
  const logoW = Math.trunc((lockup.logoHeight * image.width) / image.height);
  const textW = measureText(lockup.channel, lockup.font, lockup.size);
  const total = logoW + lockup.gap + textW;
  const left = Math.trunc((canvasWidth - total) / 2);

  return {
    logoX: left,
    logoY: lockup.y,
    logoW,
    // Текст ставится по левому краю сразу за знаком и выравнивается по
    // его вертикальному центру.
    textX: left + logoW + lockup.gap,
    textY: lockup.y + Math.trunc(lockup.logoHeight / 2),
  };
}

/** Стиль имени канала в шапке. Цвет - White из основной палитры. */
export const headerStyle = (): string =>
  `Style: Header,Arial Black,38,${Palette.WHITE},${Palette.WHITE},` +
  `${Palette.BLACK},${Palette.BLACK},1,0,0,0,100,100,0,0,1,3,0,4,0,0,0,204`;

/** Имя канала в шапке. Знак накладывается отдельно, как картинка. */
export function headerEvent(
  lockup: HeaderLockup,
  duration: number,
  canvasWidth: number,
  formatTime: (seconds: number) => string,
  assets: BrandAssets = { root: "assets/twitch" },
): string {
  const box = headerGeometry(assets, lockup, canvasWidth);
  // \an4 - привязка по левому краю и вертикальному центру строки.
  return (
    `Dialogue: 0,${formatTime(0)},${formatTime(duration)},Header,,0,0,0,,` +
    `{\\an4\\pos(${box.textX},${box.textY})}${lockup.channel}`
  );
}
