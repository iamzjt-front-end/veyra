import assert from "node:assert/strict";
import { test } from "node:test";
import { solution } from "../src/solution.js";
test("task acceptance", () => {
  assert.equal(solution(), "Hello Veyra");
});
