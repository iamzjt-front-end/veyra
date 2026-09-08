import { sessionFixture } from "./session-fixture.js";
import assert from "node:assert/strict";
import { CodexAdapter } from "../src/index.js";

// Opt-in real native usage; the parent user must authorize it. Never part of pnpm test.
const readiness = await new CodexAdapter({ executable: process.argv[2] }).doctor();
assert.equal(readiness.ready, true, readiness.message);
console.log(
  JSON.stringify(
    { ...(await sessionFixture(process.argv[2])), codexVersion: readiness.version },
    null,
    2,
  ),
);
