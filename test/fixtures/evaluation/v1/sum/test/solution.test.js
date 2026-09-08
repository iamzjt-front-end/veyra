import assert from "node:assert/strict";
import { test } from "node:test";
import { solution } from "../src/solution.js";
test("task acceptance", () => {
  assert.equal(solution(3, 2), 5);
  assert.equal(solution(-3, -5), -8);
  assert.equal(solution(0, 7), 7);
});
