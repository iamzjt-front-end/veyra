import type { AgentInput } from "@veyraoss/protocol";
import type { ProcessResult, ProcessRunner } from "@veyraoss/runtime";

export const input: AgentInput = {
  runId: "run",
  stepId: "execute",
  attemptId: "attempt",
  attempt: 2,
  parentStepId: "parent",
  role: "executor",
  goal: "Repair $(literal) `greeting` @/private/file",
  instructions: "Change only src/message.js",
};
export const claim = {
  status: "success",
  summary: "Repaired greeting",
  changedFiles: ["src/message.js"],
  commandsRun: ["node --test"],
};
export const part = (type: string, fields: Record<string, unknown> = {}) => ({
  id: type,
  sessionID: "session",
  messageID: "message",
  type,
  ...fields,
});
export const record = (type: string, fields: Record<string, unknown> = {}) =>
  `${JSON.stringify({ type, sessionID: "session", timestamp: 1, ...fields })}\n`;
export const events = (result: Record<string, unknown> = claim, reason = "stop") =>
  [
    record("step_start", { part: part("step-start") }),
    record("text", {
      part: part("text", { text: JSON.stringify(result), time: { start: 1, end: 2 } }),
    }),
    record("step_finish", { part: part("step-finish", { reason }) }),
  ].join("");
export const completed = (fields: Partial<ProcessResult> = {}): ProcessResult => ({
  exitCode: 0,
  signal: null,
  stdout: events(),
  stderr: "",
  stdoutTruncated: false,
  stderrTruncated: false,
  durationMs: 3,
  ...fields,
});
export const help = "--format --dir --title --auto --thinking";
export const withVersion =
  (runner: ProcessRunner): ProcessRunner =>
  (request) =>
    request.args?.[0] === "--version"
      ? Promise.resolve(completed({ stdout: "1.18.29\n" }))
      : runner(request);
