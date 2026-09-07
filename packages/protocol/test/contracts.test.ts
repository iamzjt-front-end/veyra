import { describe, expect, it } from "vitest";
import {
  type AgentAdapter,
  type AgentInput,
  type AgentResult,
  type ArtifactRef,
  type EventSink,
  isJsonValue,
  type SerializedError,
  type VerificationResult,
  type VeyraEvent,
} from "../src/index.js";

const execution = { runId: "run-1", stepId: "execute", attemptId: "attempt-1", attempt: 1 };
const at = "2026-09-08T00:00:00.000Z";
const input: AgentInput = {
  ...execution,
  role: "executor",
  goal: "Update fixture",
  context: { plan: ["change", "verify"] },
};
const artifact: ArtifactRef = {
  id: "artifact-1",
  kind: "log",
  path: "artifacts/stdout.txt",
  mediaType: "text/plain",
  sizeBytes: 12,
  createdAt: at,
  producer: execution,
};
const failure: SerializedError = {
  code: "process_timeout",
  message: "Execution timed out",
  retryable: true,
  details: { timeoutMs: 1000 },
};

describe("provider-neutral contracts", () => {
  it("lets different adapter types share results, verification evidence, and surface events", async () => {
    const adapters: AgentAdapter[] = ["reasoning-provider", "coding-provider"].map((provider) => ({
      id: provider,
      provider,
      async run(request) {
        return {
          status: "success",
          summary: "Fixture result",
          execution: {
            runId: request.runId,
            stepId: request.stepId,
            attemptId: request.attemptId,
            attempt: request.attempt,
          },
          timing: { startedAt: at, completedAt: at, durationMs: 0 },
          artifacts: [artifact],
          usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 },
          data: { instructions: "Verify the fixture" },
        };
      },
    }));
    const verification: VerificationResult = {
      success: true,
      command: "node --test",
      exitCode: 0,
      stdout: "passed",
      stderr: "",
      durationMs: 12,
      execution,
    };
    const events: VeyraEvent[] = [];
    const surface: EventSink = (event) => {
      events.push(event);
    };
    for (const adapter of adapters) {
      const result = await adapter.run(input);
      await surface({
        type: "agent.completed",
        ...execution,
        at,
        agentId: adapter.id,
        provider: adapter.provider,
        result,
      });
    }
    await surface({
      type: "verification.completed",
      ...execution,
      at,
      success: true,
      results: [verification],
    });

    expect(isJsonValue(events)).toBe(true);
    expect(JSON.parse(JSON.stringify(events))).toEqual(events);
    expect(events.map((event) => event.type)).toEqual([
      "agent.completed",
      "agent.completed",
      "verification.completed",
    ]);
  });

  it("represents failures without pretending a process produced an exit code", () => {
    const result: AgentResult = {
      status: "failure",
      summary: failure.message,
      execution,
      error: failure,
    };
    const verification: VerificationResult = {
      success: false,
      command: "fixture-command",
      exitCode: null,
      stdout: "",
      stderr: "",
      durationMs: 1000,
      execution,
      error: failure,
    };
    expect(isJsonValue({ result, verification })).toBe(true);
    expect(JSON.parse(JSON.stringify(verification)).error.code).toBe("process_timeout");
    expect(result.usage).toBeUndefined();
  });

  it("serializes lifecycle, approval, verification, and process-output events", () => {
    const events: VeyraEvent[] = [
      { type: "run.started", runId: execution.runId, at, goal: input.goal },
      { type: "run.completed", runId: execution.runId, at },
      { type: "run.failed", runId: execution.runId, at, message: failure.message, error: failure },
      { type: "run.paused", ...execution, at, reason: "Awaiting approval" },
      { type: "run.resumed", ...execution, at },
      { type: "step.started", ...execution, at },
      { type: "step.completed", ...execution, at, outcome: "pass" },
      { type: "step.failed", ...execution, at, message: failure.message, error: failure },
      { type: "agent.started", ...execution, at, agentId: "fixture-agent" },
      { type: "agent.failed", ...execution, at, agentId: "fixture-agent", error: failure },
      { type: "verification.started", ...execution, at, commands: ["node --test"] },
      {
        type: "approval.required",
        ...execution,
        at,
        approvalId: "gate-1",
        message: "Continue?",
        context: { diff: "artifact-1" },
      },
      { type: "approval.resolved", ...execution, at, approvalId: "gate-1", decision: "approved" },
      { type: "process.output", ...execution, at, stream: "stdout", artifact, preview: "passed" },
    ];
    const recorded = events.map((event, index) => ({
      ...event,
      eventId: `event-${index}`,
      sequence: index + 1,
    }));
    expect(isJsonValue(recorded)).toBe(true);
    expect(JSON.parse(JSON.stringify(recorded))).toEqual(recorded);
  });
});

describe("JSON value boundary", () => {
  it.each([null, true, false, 0, 1.5, "value", [], {}, { nested: [null, 1, { ready: true }] }])(
    "accepts serializable value %#",
    (value) => {
      expect(isJsonValue(value)).toBe(true);
    },
  );

  it.each([
    undefined,
    () => true,
    1n,
    Symbol("value"),
    NaN,
    Infinity,
    new Date(),
    new Error("failure"),
    new Map(),
    { nested: undefined },
    [undefined],
    Array(2),
  ])("rejects non-JSON value %#", (value) => {
    expect(isJsonValue(value)).toBe(false);
  });

  it("rejects cycles but permits repeated independent references", () => {
    const value: Record<string, unknown> = { ready: true };
    expect(isJsonValue({ first: value, second: value })).toBe(true);
    value.self = value;
    expect(isJsonValue(value)).toBe(false);
  });

  it("does not invoke getters or custom serialization hooks", () => {
    let invoked = false;
    const value = Object.defineProperty({}, "secret", {
      enumerable: true,
      get() {
        invoked = true;
        return "hidden";
      },
    });
    expect(isJsonValue(value)).toBe(false);
    expect(
      isJsonValue({
        toJSON() {
          invoked = true;
          return {};
        },
      }),
    ).toBe(false);
    expect(invoked).toBe(false);
  });
});
