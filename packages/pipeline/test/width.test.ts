/**
 * Ширина строк субтитров.
 *
 * Лимит по числу символов не знает ширины букв: на широких он давал
 * строки шире клипа, и текст уходил за границы кадра. Тест проверяет
 * обе стороны: с включённым пределом каждая строка помещается, а сам
 * баг воспроизводится - без предела строки шире клипа существуют.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import {
  groupPhrases,
  measureText,
  type Transcript,
} from "../dist/index.js";

const fixture = JSON.parse(
  readFileSync(
    fileURLToPath(new URL("./fixtures/subtitles.python.json", import.meta.url)),
    "utf8",
  ),
) as { cases: Record<string, { transcript: Transcript }> };

const FONT = "Arial Black";
const SIZE = 66;
// Холст 1080 минус поля по 40 и обводка: рабочая ширина строки.
const LIMIT = 1080 - 2 * 40 - 8;

const words = Object.values(fixture.cases).flatMap((c) =>
  c.transcript.segments.flatMap((s) => s.words),
);

describe("ширина строк субтитров", () => {
  it("лимит символов давал строки шире клипа (сам баг)", () => {
    const phrases = groupPhrases(words, 3.2, 42);
    const widths = phrases.map((p) =>
      measureText(p.map((w) => w.text).join(" "), FONT, SIZE),
    );
    assert.ok(
      widths.some((w) => w > LIMIT),
      "на этом материале переполнение должно воспроизводиться",
    );
  });

  it("с пределом ширины каждая строка помещается в клип", () => {
    const fits = (text: string) => measureText(text, FONT, SIZE) <= LIMIT;
    const phrases = groupPhrases(words, 3.2, 42, fits);
    for (const phrase of phrases) {
      const text = phrase.map((w) => w.text).join(" ");
      const width = measureText(text, FONT, SIZE);
      assert.ok(width <= LIMIT, `строка шире клипа (${width}px): ${text}`);
    }
  });
});
