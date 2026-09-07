import type { VeyraEvent } from "@veyra/protocol";
import { describe, expect, it } from "vitest";
import { isStoredEvent } from "../src/state-events.js";

const metadata = { runId: "run", stepId: "step", at: "2026-09-08T00:00:00.000Z" };
const error = {
  code: "fixture_failure",
  message: "Failed",
  retryable: true,
  details: { phase: "execute" },
};
const artifact = {
  id: "log",
  kind: "log",
  path: "artifacts/log.txt",
  sizeBytes: 3,
  createdAt: metadata.at,
  producer: { runId: "run", stepId: "step", attempt: 1 },
};
const events: VeyraEvent[] = [
  { ...metadata, type: "run.started", goal: "fixture" },
  {
    ...metadata,
    type: "run.completed",
    timing: { startedAt: metadata.at, durationMs: 3 },
    usage: { inputTokens: 5, cost: { amount: 0.1, currency: "USD" } },
  },
  { ...metadata, type: "run.failed", message: "Failed", error },
  { ...metadata, type: "run.paused", reason: "approval" },
  { ...metadata, type: "run.resumed" },
  { ...metadata, type: "step.started" },
  { ...metadata, type: "step.retrying", retryCount: 1, maxRetries: 3 },
  { ...metadata, type: "step.completed", artifacts: [artifact] },
  { ...metadata, type: "step.failed", message: "Failed", error },
  { ...metadata, type: "agent.started", agentId: "fake" },
  {
    ...metadata,
    type: "agent.input",
    agentId: "fake",
    input: {
      runId: metadata.runId,
      stepId: metadata.stepId,
      role: "executor",
      goal: "fixture",
      context: { inputs: { selected: [true, 1] } },
    },
  },
  {
    ...metadata,
    type: "agent.completed",
    agentId: "fake",
    result: {
      status: "success",
      summary: "Done",
      artifacts: [artifact],
      execution: { runId: "run", stepId: "step" },
    },
  },
  { ...metadata, type: "agent.failed", agentId: "fake", error },
  { ...metadata, type: "verification.started", commands: ["node --test"] },
  {
    ...metadata,
    type: "verification.completed",
    success: false,
    results: [
      {
        command: "node --test",
        success: false,
        exitCode: null,
        stdout: "",
        stderr: "",
        durationMs: 3,
        error,
      },
    ],
  },
  {
    ...metadata,
    type: "approval.required",
    message: "Approve",
    context: { files: ["src/message.js"] },
  },
  { ...metadata, type: "approval.resolved", decision: "approved" },
  { ...metadata, type: "process.output", stream: "stdout", artifact, preview: "log" },
];

describe("persisted event validation", () => {
  it.each(events)("accepts $type after a JSON round trip", (event) => {
    expect(isStoredEvent(JSON.parse(JSON.stringify(event)))).toBe(true);
  });

  it.each([
    { ...metadata, type: "future.unsupported" },
    {
      ...metadata,
      type: "agent.input",
      agentId: "fake",
      input: { runId: "other", stepId: metadata.stepId, role: "executor", goal: "fixture" },
    },
    {
      ...metadata,
      type: "agent.input",
      agentId: "fake",
      input: {
        runId: metadata.runId,
        stepId: metadata.stepId,
        role: "executor",
        goal: "fixture",
        timeoutMs: 1000,
      },
    },
    { ...metadata, type: "step.retrying", retryCount: -1, maxRetries: 3 },
    { ...metadata, type: "run.completed", usage: { inputTokens: -1 } },
    { ...metadata, type: "run.completed", timing: { startedAt: "bad timestamp" } },
    { ...metadata, type: "step.failed", message: "Failed", error: new Error("native error") },
    { ...metadata, type: "agent.completed", agentId: "fake", result: { status: "success" } },
    { ...metadata, type: "approval.resolved", decision: "maybe" },
    { ...metadata, type: "approval.resolved", decision: { toString: "invalid" } },
    { ...metadata, type: "verification.completed", success: true, results: [{ exitCode: "0" }] },
    {
      ...metadata,
      type: "process.output",
      stream: "stdout",
      artifact: { ...artifact, sizeBytes: -1 },
    },
  ])("rejects malformed persisted payload %#", (event) => {
    expect(isStoredEvent(event)).toBe(false);
  });
});
