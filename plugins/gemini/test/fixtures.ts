import type { AgentInput } from "@veyraoss/protocol";

export const input: AgentInput = {
  runId: "run",
  stepId: "plan",
  attemptId: "attempt",
  attempt: 2,
  parentStepId: "parent",
  role: "planner",
  goal: "Repair the greeting",
  context: { verification: { exitCode: 1 } },
  artifacts: [{ id: "test-log", kind: "log", path: "test.log" }],
};
export const plan = {
  summary: "Repair greeting",
  instructions: "Change src/message.js only",
  acceptanceCriteria: ["The existing test passes"],
  artifactIds: ["test-log"],
};
export const review = {
  summary: "The greeting passes",
  outcome: "pass",
  requiredFixes: [],
  evidenceArtifactIds: ["test-log"],
};
export const envelope = (value: unknown = plan) => ({
  candidates: [
    { finishReason: "STOP", content: { role: "model", parts: [{ text: JSON.stringify(value) }] } },
  ],
  usageMetadata: {
    promptTokenCount: 20,
    cachedContentTokenCount: 7,
    candidatesTokenCount: 5,
    thoughtsTokenCount: 3,
    totalTokenCount: 28,
  },
});
export const env = { GEMINI_API_KEY: "fixture-gemini-key" };
export const options = { model: "gemini-2.5-flash" };
export const png =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+ip1sAAAAASUVORK5CYII=";
