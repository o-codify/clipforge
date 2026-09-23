import { test } from "node:test";
import assert from "node:assert/strict";
import { feedbackMultiplier } from "../src/feedback.ts";
test("no observations or unreliable feedback preserves exploration", () => {
  assert.equal(feedbackMultiplier(0,100000,1),1);
  assert.equal(feedbackMultiplier(4,100000,1),1);
  assert.equal(feedbackMultiplier(100,NaN,1),1);
  assert.equal(feedbackMultiplier(100,10,0),1);
});
test("evidence helps successful triggers without suppressing others", () => {
  assert(feedbackMultiplier(100,200,100)>feedbackMultiplier(5,200,100));
  assert(feedbackMultiplier(100000,0,100)>=0.5);
  assert(feedbackMultiplier(100000,100000,1)<=2);
});
