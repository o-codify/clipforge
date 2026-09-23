import {test} from "node:test";
import assert from "node:assert/strict";
import {narrateEvent} from "../dist/jobs/narration.js";
test("pipeline phases describe useful work instead of internal identifiers",()=>{
  for(let stage=1;stage<=5;stage++)assert(narrateEvent(`шаг ${stage}/5: internal`).length>25);
  assert.match(narrateEvent("кандидатов 12 (3 в час)"),/12/);
  assert.match(narrateEvent("отрендерено 24, заменено 0, пропущено 2"),/24/);
});
test("paths, external errors and arbitrary log content do not enter human messages",()=>{
  assert.equal(narrateEvent("C:\\private\\file.mp4: secret"),null);
  assert(!narrateEvent("Сбой: secret-token-and-stack").includes("secret"));
  assert.equal(narrateEvent("видео: 15%"),null);
  assert.match(narrateEvent("видео: 80%"),/80%/);
});
