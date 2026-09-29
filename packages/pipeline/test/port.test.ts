/**
 * Сверка переноса с python-реализацией.
 *
 * Конвейер переезжает с Python на TypeScript, и в нём накоплено много
 * поведения, найденного опытным путём: как считается сетка, какие слова
 * не должны считаться матом, где ставятся интервалы писка. Эталоны сняты
 * со старой реализации и лежат в fixtures.
 *
 * Тесты нужны именно на время переноса и после него: они ловят не
 * «неправильно вообще», а «стало иначе, чем было». Первый же прогон
 * поймал настоящий регресс - в JavaScript граница слова \b не работает
 * с кириллицей, и «манда» начала ловиться в «мандарине».
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  beepSpans,
  buildFilter,
  computeGrid,
  describeGrid,
  findProfanity,
  isProfane,
  mask,
  mergeSpans,
  type Rect,
} from "../dist/index.js";

const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8"),
  );

describe("сетка и граф фильтров", () => {
  const reference = fixture("layout.python.json") as Record<
    string,
    { describe: string; subTop: number; accentY: number; game: unknown; cam: unknown; filter: string }
  >;

  // No-camera and wide-camera game geometry intentionally changed; covered by layout.test.ts.
  const cases: Record<string, [number, number, Rect | null]> = {
    "с камерой": [1280, 720, { x: 53, y: 414, w: 259, h: 306 }],
    "камера справа": [1920, 1080, { x: 1500, y: 700, w: 380, h: 300 }],
  };

  for (const [name, [w, h, cam]] of Object.entries(cases)) {
    it(name, () => {
      const grid = computeGrid(w, h, cam);
      const expected = reference[name];
      assert.ok(expected, `нет эталона для случая ${name}`);

      assert.equal(describeGrid(grid), expected.describe);
      assert.equal(grid.subTop, expected.subTop);
      assert.equal(grid.accentY, expected.accentY);
      assert.deepEqual(grid.game,expected.game);
      assert.deepEqual(grid.cam ? JSON.parse(JSON.stringify(grid.cam)) : null, expected.cam);

      // Граф фильтров сравнивается строкой: любая перестановка звеньев
      // меняет картинку, и «почти совпало» здесь не годится.
      const filter = buildFilter(grid, {
        subtitlesPath: "subs.ass",
        overlays: [{ input: 1, x: 220, y: 900, w: 640, from: 30.5, to: 33.9, fade: 0.4 }],
        scrim: { from: 30.5, fade: 0.5, opacity: 0.88 },
        duration: 34,
        fps: 30,
      });
      assert.equal(filter, expected.filter);
    });
  }
});

describe("поиск мата", () => {
  const reference = fixture("profanity.python.json") as {
    words: string[];
    profane: string[];
    masked: Record<string, string>;
    windowWords: { start: number; end: number; text: string }[];
    spans: [number, number][];
  };

  it("сохраняет словарь python и намеренно добавленные формы", () => {
    const mine = reference.words.filter(isProfane);
    const missing = reference.profane.filter((w) => !mine.includes(w));
    const extra = mine.filter((w) => !reference.profane.includes(w));
    assert.deepEqual(missing, [], "пропущено по сравнению с python");
    assert.deepEqual(extra, ['долбоеб', 'долбоёб?', 'пизец.'], "изменения словаря должны быть явными");
  });

  it("приличные слова не срабатывают", () => {
    // Отдельной проверкой, потому что это главный риск: русский мат
    // сильно склоняется, и наивный шаблон ловит «мудрый» и «мандарин».
    const clean = [
      "мудрый", "мандарин", "мандат", "сукно", "сукин", "художник",
      "употреблять", "заблуждение", "веб", "вебка", "требуется", "команда",
    ];
    for (const word of clean) {
      assert.equal(isProfane(word), false, `${word} не должно считаться матом`);
    }
  });

  it("звёздочки ставятся так же", () => {
    for (const [word, expected] of Object.entries(reference.masked)) {
      assert.equal(mask(word), expected, `маска для ${word}`);
    }
  });

  it("интервалы писка сохраняются, включая добавленное ругательство", () => {
    const spans = mergeSpans(beepSpans(findProfanity(reference.windowWords, 0, 600)));
    // Added word at 281.90–282.58: existing 0.22-second center censor window.
    const expectedSpans = [...reference.spans, [282.13, 282.35]].sort((a,b)=>a[0]-b[0]);
    assert.equal(spans.length, expectedSpans.length);
    spans.forEach((span, i) => {
      const expected = expectedSpans[i]!;
      assert.ok(Math.abs(span[0] - expected[0]) < 1e-9, `начало интервала ${i}`);
      assert.ok(Math.abs(span[1] - expected[1]) < 1e-9, `конец интервала ${i}`);
    });
  });
});
