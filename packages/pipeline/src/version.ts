/**
 * Версия оформления клипа.
 *
 * Один и тот же отрезок стрима, отрендеренный дважды с одними и теми же
 * настройками, - это один клип, а не два. Отдельная версия нужна только
 * тогда, когда изменилось то, что видно на экране: сетка, субтитры,
 * шапка, концовка, параметры кодирования.
 *
 * Без этого каждый прогон плодил дубли: семь прогонов по одному стриму
 * давали семь копий одного момента.
 *
 * Версия считается отпечатком настроек, а не датой прогона. Поэтому:
 * прогнали второй раз, ничего не поменяв - версия та же, клип не
 * дублируется; поменяли дизайн - появляется новая версия.
 *
 * В отпечаток НЕ входит то, что влияет на выбор моментов (веса сигналов,
 * число клипов, отступы): другие настройки детекции дают другие границы,
 * а границы уже записаны в segmentKey. Смешивать эти две оси не нужно -
 * получилась бы новая версия там, где на самом деле другой отрезок.
 */
import { createHash } from "node:crypto";

/**
 * Поднимать руками, когда меняется САМ рендер, а не его настройки:
 * другой фильтрграф, другая разметка ASS, другая раскладка. Настройки
 * отпечаток ловит сам, изменение кода - нет.
 */
// Поколение 2: строки карточки концовки живут до последнего кадра, а
// фразы субтитров ограничены шириной клипа, а не числом символов.
// Поколение 3: подсветка слова не загорается раньше, чем слово может
// звучать, - тишина, приписанная Whisper'ом началу слова, не подсвечена.
export const RENDER_VERSION = 3;

/** Клипы, отрендеренные до появления версий. */
export const LEGACY = "legacy";

type Plain = null | boolean | number | string | Plain[] | { [key: string]: Plain };

/**
 * Привести значение к тому, что сериализуется одинаково при каждом
 * запуске: ключи по порядку, дроби округлены.
 */
function plain(value: unknown): Plain {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    // Мелкие расхождения в дробях не должны менять версию.
    return Number.isFinite(value) ? Number(value.toFixed(4)) : 0;
  }
  if (typeof value === "boolean" || typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, Plain> = {};
    for (const key of Object.keys(source).sort()) out[key] = plain(source[key]);
    return out;
  }
  return String(value);
}

/** Каноническая запись: ключи отсортированы, лишних пробелов нет. */
function canonical(value: Plain): string {
  if (value === null) return "null";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const entries = Object.keys(value).map(
    (key) => `${JSON.stringify(key)}:${canonical(value[key]!)}`,
  );
  return `{${entries.join(",")}}`;
}

export interface Fingerprint {
  /** "1-a3f9c2": поколение рендера и хэш настроек. */
  version: string;
  /** Из чего он собран - чтобы потом было видно, что именно изменилось. */
  parts: Record<string, Plain>;
}

export function fingerprint(parts: Record<string, unknown>): Fingerprint {
  const payload = plain(parts) as Record<string, Plain>;
  const digest = createHash("sha1")
    .update(canonical(payload), "utf8")
    .digest("hex")
    .slice(0, 6);
  return { version: `${RENDER_VERSION}-${digest}`, parts: payload };
}

/**
 * Ключ отрезка стрима с точностью до десятой доли секунды.
 *
 * Один и тот же момент, отрендеренный в разных прогонах, получает
 * одинаковый ключ - по нему потом сравниваются настройки.
 */
export const segmentKey = (vodId: string, start: number, end: number): string =>
  `${vodId}:${Math.round(start * 10)}-${Math.round(end * 10)}`;

/**
 * Идентификатор клипа: отрезок плюс версия оформления.
 *
 * Прогон в него не входит намеренно. Повторный рендер тех же настроек
 * должен обновлять существующую строку, а не заводить соседнюю.
 */
export const clipId = (vodId: string, segment: string, version: string): string =>
  `${vodId}_${segment.split(":").at(-1)}_${version}`;
