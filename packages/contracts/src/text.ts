/**
 * Хвост слова. В JavaScript \w - это [A-Za-z0-9_], кириллицы он не
 * знает, поэтому везде \p{L} и \p{N}.
 */
const W = String.raw`[\p{L}\p{N}_]*`;

/**
 * Замыкающая граница слова.
 *
 * Не украшение: без неё «манда» ловится в «мандарине», «суки» в
 * «сукине», а именно от этого шаблоны и защищают. В JavaScript \b
 * работает только по латинице, поэтому граница задаётся явно - «дальше
 * не буква и не цифра».
 */
const B = String.raw`(?![\p{L}\p{N}])`;

/**
 * Шаблоны привязаны к началу слова: проверяется отдельно взятое слово,
 * уже очищенное от пунктуации (см. isProfane).
 */
const PATTERNS: readonly string[] = [
  // хуй и производные
  String.raw`(?:на|по|до|ни|о|от|пере|у)?ху(?:й|я|ё|е|ю|и|л[иёе])` + W,
  String.raw`хуёв` + W,
  String.raw`хуев` + W,
  String.raw`охуе` + W,
  String.raw`дохуя` + B,
  String.raw`нихуя` + B,
  // пизда
  String.raw`пизд` + W,
  String.raw`пизец` + W,
  String.raw`спизд` + W,
  String.raw`подпизд` + W,
  // корень еб. Приставки перечислены явно: голое «в» брать нельзя -
  // поймается «веб», поэтому только формы с твёрдым знаком.
  String.raw`(?:вы|за|на|от|по|при|про|у|об|раз|до|пере|въ|съ|объ|подъ|разъ|отъ)?` +
    String.raw`[еёи]б(?:а|ё|е|у|л|н|и)` +
    W,
  String.raw`ёб` + W,
  String.raw`еблан` + W,
  String.raw`ебот` + W,
  String.raw`долбо[её]б` + W,
  // блядь
  String.raw`бля(?:дь|ть|д` + W + String.raw`|т` + W + String.raw`|)` + B,
  String.raw`блят` + W,
  String.raw`бляд` + W,
  // сука - только как отдельное слово, иначе ловится «сукно»
  String.raw`сук(?:а|и|е|у|ой|ам|ами)` + B,
  String.raw`суч(?:ка|ки|ку|кой)` + B,
  // мудак - «мудрый» не должен попадать
  String.raw`муда(?:к|ч|ки|ков|ку)` + W,
  String.raw`мудил` + W,
  String.raw`мудо(?:звон|м)` + W,
  // прочее
  String.raw`гандон` + W,
  String.raw`гондон` + W,
  String.raw`залуп` + W,
  String.raw`дроч` + W,
  String.raw`шлюх` + W,
  String.raw`шалав` + W,
  String.raw`пидор` + W,
  String.raw`пидар` + W,
  String.raw`педик` + W,
  String.raw`манда` + B,
  String.raw`мандой` + B,
  String.raw`мандавошк` + W,
  String.raw`уёбищ` + W,
  String.raw`уебищ` + W,
  String.raw`мразь` + B,
  String.raw`хер(?:ня|ней|ню|ово)` + W,
];

/**
 * Привязка к началу строки: проверяется отдельно взятое слово, уже
 * очищенное от пунктуации.
 */
const MATCHER = new RegExp(`^(?:${PATTERNS.join("|")})`, "iu");

/** Слова, которые НЕ должны считаться матом. Проверяются тестом. */
export const CLEAN_WORDS: readonly string[] = [
  // ловятся корнем «бля»
  "употреблять", "употребление", "ослабляет", "ослаблять", "заблуждение",
  "оскорблять", "потреблять", "наблюдать", "публика", "республика",
  // ловятся корнем «муд»
  "мудрый", "мудрость", "премудрость", "мудрец",
  // ловятся корнем «сук»
  "сукно", "суконный", "сукин",
  // ловятся корнем «ху»
  "художник", "худой", "хутор", "хуторок", "худеть", "художество",
  // ловятся корнем «манда»
  "мандарин", "мандат", "командир", "команда",
  // ловятся корнем «еб»
  "требовать", "ребёнок", "себя", "небо", "хлеб", "лебедь",
  // ловятся корнем «хер»
  "херувим", "херсон",
  // проверка приставок: «веб» не должен попасть под корень «еб»
  "веб", "вебка", "вебинар", "требуется",
];

/**
 * Подмена латиницы: в расшифровках попадаются «xуй» с латинской x.
 * Буквы, которые визуально совпадают с кириллическими.
 */
const LOOKALIKES: Record<string, string> = {
  x: "х", y: "у", o: "о", a: "а", e: "е", c: "с", p: "р", u: "и",
};

/** Убрать пунктуацию, привести к нижнему регистру, починить латиницу. */
export function normalize(text: string): string {
  const lowered = text.toLowerCase();
  let swapped = "";
  for (const ch of lowered) swapped += LOOKALIKES[ch] ?? ch;
  // \p{L} и \p{N} вместо \w: последний в JS не знает кириллицы.
  return swapped.replace(/[^\p{L}\p{N}\s-]/gu, "");
}

export function isProfane(word: string): boolean {
  const plain = normalize(word).trim();
  if (!plain) return false;
  return MATCHER.test(plain);
}

/**
 * Заменить слово звёздочками, оставив первую букву.
 *
 * Полное скрытие читается хуже: зритель не понимает, что там было
 * ругательство, и субтитр выглядит как ошибка распознавания.
 */
export function mask(word: string, keep = 1): string {
  const stripped = word.trim();
  if (stripped.length <= keep) return "*".repeat(Math.max(stripped.length, 1));
  const head = [...stripped].slice(0, keep).join("");
  const tail = [...stripped]
    .slice(keep)
    .map((ch) => (/[\p{L}\p{N}]/u.test(ch) ? "*" : ch))
    .join("");
  return head + tail;
}

/** Mechanical ASR spacing repairs only; never guess missing words or meaning. */
export function normalizeRussianText(text: string): string {
  return text.normalize("NFC")
    .replace(/\s+/gu, " ")
    .replace(/\s+([,.;:!?…])/gu, "$1")
    .replace(/([«(])\s+/gu, "$1")
    .replace(/\s+([»)])/gu, "$1")
    // Keep a spaced dash ("это - то, что…") distinct from a broken suffix.
    .replace(/([\p{L}\p{N}])(?:\s+-|-\s*)(то|либо|нибудь|ка|таки)(?![\p{L}\p{N}])/giu, "$1-$2")
    .replace(/(?<!\p{L})(кое)(?:\s+-|-\s*)(?=\p{L})/giu, "$1-")
    .trim();
}

/** Same word dictionary and first-letter masking as burned-in subtitles. */
export function maskProfanity(text: string): string {
  return text.replace(/https?:\/\/[^\s]+|[\p{L}\p{N}_]+/gu, word =>
    /^https?:\/\//.test(word) ? word : isProfane(word) ? mask(word) : word);
}

export const displayTranscript = (text: string): string => maskProfanity(normalizeRussianText(text));
