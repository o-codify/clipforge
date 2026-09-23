/**
 * Сверка детекции с python-реализацией.
 *
 * Это самая тонкая часть переноса: границы клипа получаются из пяти
 * шагов подряд, и каждый из них появился после конкретной жалобы -
 * клип начинался на полуслове, обрывался на выдохе, схлопывался в
 * ноль. Проверять «похоже» здесь бессмысленно, поэтому сравниваются
 * точные секунды.
 *
 * Эталон снят на срезе настоящего эфира: 400 секунд сигналов и
 * соответствующий кусок расшифровки лежат рядом в fixtures.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import { SIGNAL_SERIES } from "@clipforge/contracts";

import {
  detect,
  labelTrigger,
  selectDiverse,
  readSignals,
  type Candidate,
  type Transcript,
} from "../dist/index.js";

interface Reference {
  frames: number;
  hopSeconds: number;
  duration: number;
  transcript: Transcript;
  candidates: {
    peak: number;
    start: number;
    end: number;
    score: number;
    trigger: string;
    keywords: string[];
    text: string;
  }[];
  picked: { peak: number; trigger: string }[];
}

const here = (name: string) => fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url));
const reference = JSON.parse(readFileSync(here("detect.python.json"), "utf8")) as Reference;

const options = {
  maxCount: 300,
  minGapSeconds: 22,
  lead: 12,
  tail: 6,
  minLen: 25,
  maxLen: 55,
  minLead: 5,
  minTail: 4,
  padBefore: 1.0,
  padAfter: 1.3,
};

async function run(): Promise<Candidate[]> {
  const audio = await readSignals(here("detect.signals.f32"), {
    frames: reference.frames,
    hopSeconds: reference.hopSeconds,
    duration: reference.duration,
    series: SIGNAL_SERIES,
  });
  return detect(audio, reference.transcript, options);
}

describe("детекция кандидатов", () => {
  it("находит столько же моментов", async () => {
    const candidates = await run();
    assert.equal(candidates.length, reference.candidates.length);
  });

  it("границы клипов совпадают до миллисекунд", async () => {
    const candidates = await run();
    candidates.forEach((got, i) => {
      const want = reference.candidates[i]!;
      // Допуск 1 мс - на разницу округления float32/float64, не на
      // «примерно там же»: сдвиг границы на десятую долю секунды уже
      // слышен как обрыв слова.
      assert.ok(Math.abs(got.peak - want.peak) < 0.001, `пик #${i}: ${got.peak} != ${want.peak}`);
      assert.ok(Math.abs(got.start - want.start) < 0.001, `начало #${i}: ${got.start} != ${want.start}`);
      assert.ok(Math.abs(got.end - want.end) < 0.001, `конец #${i}: ${got.end} != ${want.end}`);
    });
  });

  it("триггеры и ключевые слова те же", async () => {
    const candidates = await run();
    candidates.forEach((got, i) => {
      const want = reference.candidates[i]!;
      assert.equal(labelTrigger(got), want.trigger, `триггер #${i}`);
      assert.deepEqual(got.keywords, want.keywords, `ключевые слова #${i}`);
    });
  });

  it("текст окна собирается так же", async () => {
    const candidates = await run();
    candidates.forEach((got, i) => {
      assert.equal(got.text, reference.candidates[i]!.text, `текст #${i}`);
    });
  });

  it("отбор на разнообразие даёт ту же подборку", async () => {
    const candidates = await run();
    const picked = selectDiverse(candidates, 12, reference.duration, undefined, 6);
    assert.equal(picked.length, reference.picked.length);
    picked.forEach((got, i) => {
      const want = reference.picked[i]!;
      assert.ok(Math.abs(got.peak - want.peak) < 0.001, `отобранный #${i}`);
      assert.equal(labelTrigger(got), want.trigger, `триггер отобранного #${i}`);
    });
  });
});
