import { runClosedLoopSmoke } from "./closed-loop.js";

const controller = new AbortController();
const interrupt = () => controller.abort();
const deadline = setTimeout(interrupt, 10 * 60_000);
deadline.unref();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const report = await runClosedLoopSmoke(process.env, {
    signal: controller.signal,
    emit: (event) => {
      // Compact progress only; full redacted evidence stays in the disposable state directory.
      console.error(`${event.type}${"stepId" in event && event.stepId ? ` ${event.stepId}` : ""}`);
    },
  });
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
} finally {
  clearTimeout(deadline);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
