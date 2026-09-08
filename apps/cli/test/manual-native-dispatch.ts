import assert from "node:assert/strict";
import { CodexAdapter } from "@veyraoss/codex";
import { nativeDispatchFixture } from "./native-dispatch-fixture.js";

// Explicit opt-in only, excluded from ordinary tests. Native Codex owns authentication.
const controller = new AbortController();
const interrupt = () => controller.abort();
const deadline = setTimeout(interrupt, 180000);
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const executable = process.argv[2] ?? "codex";
  const readiness = await new CodexAdapter({ executable }).doctor({ signal: controller.signal });
  assert.equal(readiness.ready, true, readiness.message);
  const report = await nativeDispatchFixture(executable, {
    signal: controller.signal,
    progress: (stage) => console.error(stage),
  });
  console.log(JSON.stringify({ ...report, codexVersion: readiness.version }, null, 2));
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
