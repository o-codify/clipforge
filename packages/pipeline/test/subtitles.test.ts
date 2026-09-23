/**
 * Сверка субтитров с python-реализацией.
 *
 * Лента прокрутки - место, где ошибка не видна в коде, но сразу видна на
 * экране: строки уезжают вверх, подсветка залипает на слове, текст
 * пропадает в паузе. Каждое из этих поведений уже было и чинилось,
 * поэтому эталон сравнивается построчно.
 *
 * Сверка идёт при capHighlight: false - ограничение подсветки по
 * правдоподобной длительности слова (поколение 3) введено уже после
 * python-версии, эталон о нём не знает. Само поведение проверяется
 * отдельным тестом ниже.
 *
 * Осознанных расхождений два. Первое - время конца строк концовки:
 * поколение рендера 2 держит их до последнего кадра, а python обрывал
 * ровно на расчётной длительности, из-за чего последние кадры оставались
 * с одним логотипом. Конец Outro-событий поэтому не сравнивается.
 *
 * Второе - позиция имени канала в шапке.
 * Она зависит от ширины текста: PIL округлял ширину каждого глифа, а
 * fontkit складывает в единицах шрифта и округляет один раз. Разница до
 * трёх пикселей на строку, при центровке - меньше двух. Допуск на эту
 * строку задан явно, чтобы случайная поломка центровки всё равно
 * поймалась.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  buildAss,
  defaultStyle,
  groupPhrases,
  headerLockup,
  outroCard,
  type Transcript,
} from "../dist/index.js";

interface Case {
  start: number;
  end: number;
  transcript: Transcript;
  phrases: string[][];
  ass: string;
}

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/subtitles.python.json", import.meta.url)),
    "utf8",
  ),
) as { cases: Record<string, Case> };

const assets = {
  root: fileURLToPath(new URL("../../../assets/twitch", import.meta.url)),
};

const style = defaultStyle({
  size: 66,
  topY: 1560,
  maxPhraseSeconds: 3.2,
  maxPhraseChars: 42,
  censor: true,
  capHighlight: false,
});
const header = headerLockup({
  channel: "Sany_Jeweler",
  url: "twitch.tv/sany_jeweler",
});
const outro = outroCard({
  channel: "Sany_Jeweler",
  url: "twitch.tv/sany_jeweler",
  subtitle: "НОЧНАЯ ДОТА,ВЕРНУЛСЯ?!12к ММР",
  seconds: 3.4,
});

/** Позиция X из тега \pos, если строка её содержит. */
const posX = (line: string): number | null => {
  const match = /\\pos\((\d+),/.exec(line);
  return match ? Number(match[1]) : null;
};

/** Убрать время конца у Outro-строк: оно намеренно другое. */
const withoutOutroEnd = (line: string): string =>
  line.replace(/^(Dialogue: \d+,[^,]+,)[\d:.]+(,Outro)/, "$1*$2");

describe("субтитры", () => {
  for (const [name, want] of Object.entries(fixture.cases)) {
    describe(name, () => {
      const words = want.transcript.segments
        .flatMap((s) => s.words)
        .filter((w) => want.start <= w.start && w.start < want.end);

      it("слова собираются в те же фразы", () => {
        const phrases = groupPhrases(
          words,
          style.maxPhraseSeconds,
          style.maxPhraseChars,
        ).map((p) => p.map((w) => w.text));
        assert.deepEqual(phrases, want.phrases);
      });

      it("ASS совпадает построчно", () => {
        const mine = buildAss(
          want.transcript, want.start, want.end, 1080, 1920,
          { style, header, outro, assets },
        ).split("\n");
        const theirs = want.ass.split("\n");

        assert.equal(mine.length, theirs.length, "число строк");

        mine.forEach((line, i) => {
          const expected = theirs[i]!;
          if (line === expected) return;
          if (withoutOutroEnd(line) === withoutOutroEnd(expected)) return;

          // Единственное допустимое расхождение: центровка шапки.
          const isHeader = expected.includes(",Header,");
          const mineX = posX(line);
          const theirsX = posX(expected);
          if (isHeader && mineX !== null && theirsX !== null) {
            assert.ok(
              Math.abs(mineX - theirsX) <= 3,
              `шапка сдвинута на ${Math.abs(mineX - theirsX)} px, допустимо 3`,
            );
            assert.equal(
              line.replace(/\\pos\(\d+,/, ""),
              expected.replace(/\\pos\(\d+,/, ""),
              "шапка отличается не только позицией",
            );
            return;
          }
          assert.equal(line, expected, `строка ${i}`);
        });
      });
    });
  }
});

/**
 * Ограничение подсветки (поколение 3).
 *
 * Whisper часто приписывает паузу после предложения первому слову
 * следующего: интервал слова начинается сразу за прошлой фразой, а
 * звучит оно через несколько секунд. Без ограничения подсветка горела
 * всю «проглоченную» тишину.
 */
describe("ограничение подсветки", () => {
  // «привет.» кончается на 2.0, дальше 4 секунды тишины, приписанные
  // слову «мир»: его интервал 2.0..6.3, хотя звучит оно в самом конце.
  const transcript: Transcript = {
    language: "ru",
    duration: 8,
    segments: [
      {
        start: 0, end: 2, text: "привет.",
        words: [{ start: 1.0, end: 2.0, text: "привет." }],
      },
      {
        start: 2, end: 6.5, text: "мир",
        words: [{ start: 2.0, end: 6.3, text: "мир" }],
      },
    ],
  };

  const capStyle = defaultStyle({ size: 66, topY: 1560 });

  /** Строки, где подсвечено слово (есть смена цвета на активный). */
  const litLines = (ass: string, word: string): string[] =>
    ass.split("\n").filter(
      (line) => line.startsWith("Dialogue:") && line.includes(`&}${word}{`),
    );

  it("подсветка прижата к концу интервала слова", () => {
    const ass = buildAss(transcript, 0, 8, 1080, 1920, { style: capStyle });
    const lit = litLines(ass, "мир");
    assert.ok(lit.length > 0, "слово вообще подсвечивается");
    // highlightCap("мир") = 0.4 + 0.08*3 = 0.64: подсветка не раньше
    // 6.30 - 0.64 = 5.66, а не с 2.00, как в исходных временах.
    for (const line of lit) {
      const startTime = line.split(",")[1]!;
      assert.ok(
        startTime >= "0:00:05.6",
        `подсветка загорелась в ${startTime}, ожидалось не раньше 5.66`,
      );
    }
  });

  it("выключенное ограничение сохраняет старое поведение", () => {
    const ass = buildAss(transcript, 0, 8, 1080, 1920, {
      style: { ...capStyle, capHighlight: false },
    });
    const lit = litLines(ass, "мир");
    assert.ok(lit.some((line) => line.split(",")[1] === "0:00:02.00"));
  });
});
