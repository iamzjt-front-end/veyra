import assert from "node:assert/strict";
import { test } from "node:test";
import { solution } from "../src/solution.js";
test("task acceptance", () => {
  const input = [10, 2, -1];
  assert.deepEqual(solution(input), [-1, 2, 10]);
  assert.deepEqual(input, [10, 2, -1]);
  assert.deepEqual(solution([]), []);
});
