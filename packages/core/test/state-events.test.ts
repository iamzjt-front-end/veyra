import type { VeyraEvent } from "@veyra/protocol";
import { describe, expect, it } from "vitest";
import { isStoredEvent } from "../src/state-events.js";

const metadata = { runId: "run", stepId: "step", at: "2026-09-08T00:00:00.000Z" };

it.each([
  { eventId: "boundary", sequence: 1 },
  { eventId: "", sequence: 1 },
  { eventId: "boundary", sequence: 0 },
  { eventId: "boundary", sequence: 1.5 },
  { eventId: "boundary", sequence: "1" },
  { eventId: "boundary", sequence: 1, extra: true },
  null,
])("validates a persisted recovery reference %#", (recovery) => {
  const valid =
    recovery?.eventId === "boundary" &&
    recovery.sequence === 1 &&
    Object.keys(recovery).length === 2;
  for (const type of ["run.paused", "run.completed"])
    expect(isStoredEvent({ ...metadata, type, recovery })).toBe(valid);
});

it.each(["workflow", "caller", "provider", "", null])(
  "validates persisted command provenance %j",
  (commandSource) => {
    const valid = commandSource === "workflow" || commandSource === "caller";
    expect(
      isStoredEvent({
        ...metadata,
        type: "verification.started",
        commands: ["node --test"],
        commandSource,
      }),
    ).toBe(valid);
    expect(
      isStoredEvent({
        ...metadata,
        type: "verification.completed",
        success: true,
        results: [],
        commandSource,
      }),
    ).toBe(valid);
  },
);
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
const votes = [
  { stepId: "first", verdict: "pass" as const, outputEventId: "first-result" },
  { stepId: "second", verdict: "fail" as const, outputEventId: "second-result" },
];
const consensus = {
  ...metadata,
  type: "consensus.completed" as const,
  mode: "quorum" as const,
  quorum: 1,
  outcome: "pass" as const,
  reviews: votes,
  verification: [{ stepId: "verify", success: true, outputEventId: "check-result" }],
};
const events: VeyraEvent[] = [
  {
    ...metadata,
    type: "agent.selected",
    agentId: "fake",
    provider: "fixture",
    role: "planner",
    binding: "plan",
    requirements: { role: "planner", capabilities: ["reasoning"] },
    descriptor: {
      schemaVersion: 1,
      id: "fake",
      provider: "fixture",
      adapterVersion: "0.1.0",
      roles: ["planner"],
      capabilities: ["reasoning"],
    },
  },
  { ...metadata, type: "step.retrying", retryCount: 2, maxRetries: 3, delayMs: 1000 },
  { ...metadata, type: "budget.checked", phase: "before", allowed: true },
  {
    ...metadata,
    type: "budget.checked",
    phase: "after",
    allowed: false,
    reason: "Budget exhausted",
  },
  consensus,
  {
    ...metadata,
    type: "consensus.started",
    reviewers: ["first", "second"],
    mode: "judge",
    judge: "judge",
    verification: [],
  },
  {
    ...metadata,
    type: "consensus.completed",
    mode: "all-pass",
    outcome: "fail",
    reason: "review_error",
    reviews: [{ stepId: "first", verdict: "error", error }],
    verification: [],
  },
  { ...metadata, type: "consensus.paused", phase: "judge" },
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
  {
    ...metadata,
    type: "subworkflow.started",
    workflowName: "child",
    childStepId: "call/work",
    inputs: { value: [1, true] },
  },
  { ...metadata, type: "subworkflow.completed", success: true, outputs: { result: 2 } },
  { ...metadata, type: "subworkflow.completed", success: false, error },
  { ...metadata, type: "subworkflow.paused", childStepId: "call/gate", reason: "human_approval" },
  { ...metadata, type: "router.selected", route: "inspect", target: "done", selection: "static" },
  {
    ...metadata,
    type: "router.selected",
    route: "inspect",
    target: "done",
    selection: "input",
    source: { stepId: "classify", path: "/data/route" },
  },
  {
    ...metadata,
    type: "parallel.started",
    children: ["child"],
    concurrency: 1,
    failurePolicy: "wait-all",
  },
  {
    ...metadata,
    type: "parallel.child.completed",
    parentStepId: "group",
    result: { stepId: "step", status: "success", outputEventId: "output" },
  },
  {
    ...metadata,
    type: "parallel.completed",
    success: true,
    results: [{ stepId: "child", status: "success" }],
  },
  { ...metadata, type: "parallel.paused", results: [{ stepId: "child", status: "needs_input" }] },
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
    { ...metadata, type: "step.retrying", retryCount: 1, maxRetries: 3, delayMs: -1 },
    { ...metadata, type: "step.retrying", retryCount: 1, maxRetries: 3, delayMs: 3_600_001 },
    { ...metadata, type: "budget.checked", phase: "before", allowed: "yes" },
    { ...metadata, type: "budget.checked", phase: "later", allowed: true },
    { ...consensus, mode: "all-pass", quorum: undefined },
    { ...consensus, quorum: 2 },
    { ...consensus, mode: "judge", quorum: undefined },
    { ...consensus, reviews: [{ ...votes[0], verdict: "maybe" }] },
    { ...consensus, reviews: [votes[0], votes[0]] },
    { ...consensus, reviews: [{ stepId: "first", verdict: "pass" }, votes[1]] },
    { ...consensus, reviews: [{ stepId: "first", verdict: "error", error }, votes[0]] },
    { ...consensus, verification: [{ stepId: "verify", success: false }] },
    { ...consensus, verification: [{ stepId: "verify", success: true }] },
    { ...consensus, outcome: "fail" },
    {
      ...metadata,
      type: "consensus.started",
      reviewers: ["first", "second"],
      mode: "judge",
      judge: "first",
      verification: [],
    },
    {
      ...metadata,
      type: "consensus.started",
      reviewers: ["first"],
      mode: "all-pass",
      verification: [],
    },
    { ...metadata, type: "consensus.paused", phase: "command" },
    { ...metadata, type: "future.unsupported" },
    {
      ...metadata,
      type: "agent.selected",
      agentId: "fake",
      binding: "plan",
      requirements: { capabilities: ["*"] },
    },
    {
      ...metadata,
      type: "agent.selected",
      agentId: "fake",
      provider: "fixture",
      binding: "plan",
      requirements: {},
      descriptor: {
        schemaVersion: 1,
        id: "foreign",
        provider: "fixture",
        adapterVersion: "0.1.0",
        roles: [],
        capabilities: [],
      },
    },
    {
      ...metadata,
      type: "subworkflow.started",
      workflowName: "child",
      childStepId: "call/work",
      inputs: [],
    },
    { ...metadata, type: "subworkflow.started", workflowName: "child", inputs: {} },
    { ...metadata, type: "subworkflow.completed", success: true, error },
    { ...metadata, type: "subworkflow.completed", success: false, outputs: {} },
    { ...metadata, type: "subworkflow.completed", success: true, outputs: {}, error },
    { ...metadata, type: "subworkflow.paused", childStepId: "call/gate" },
    { ...metadata, type: "router.selected", route: "", target: "done", selection: "static" },
    { ...metadata, type: "router.selected", route: "inspect", target: 1, selection: "static" },
    { ...metadata, type: "router.selected", route: "inspect", target: "done", selection: "input" },
    {
      ...metadata,
      type: "router.selected",
      route: "inspect",
      target: "done",
      selection: "static",
      source: { stepId: "classify", path: "/data/route" },
    },
    { ...metadata, type: "router.selected", route: "inspect", target: "done", selection: "agent" },
    {
      ...metadata,
      type: "parallel.started",
      children: ["one", "one"],
      concurrency: 2,
      failurePolicy: "wait-all",
    },
    {
      ...metadata,
      type: "parallel.started",
      children: ["one"],
      concurrency: 0,
      failurePolicy: "wait-all",
    },
    {
      ...metadata,
      type: "parallel.started",
      children: ["one"],
      concurrency: 1,
      failurePolicy: "ignore",
    },
    {
      ...metadata,
      type: "parallel.child.completed",
      result: { stepId: "step", status: "success" },
    },
    {
      ...metadata,
      type: "parallel.child.completed",
      parentStepId: "group",
      result: { stepId: "other", status: "success" },
    },
    {
      ...metadata,
      type: "parallel.child.completed",
      parentStepId: "group",
      attempt: 1,
      result: { stepId: "step", status: "success", attempt: 2 },
    },
    {
      ...metadata,
      type: "parallel.child.completed",
      parentStepId: "group",
      result: { stepId: "step", status: "pending" },
    },
    { ...metadata, type: "parallel.completed", success: true, results: [] },
    {
      ...metadata,
      type: "parallel.completed",
      success: true,
      results: [{ stepId: "child", status: "failure" }],
    },
    {
      ...metadata,
      type: "parallel.completed",
      success: false,
      results: [{ stepId: "child", status: "pending" }],
    },
    {
      ...metadata,
      type: "parallel.completed",
      success: true,
      results: [
        { stepId: "child", status: "success" },
        { stepId: "child", status: "success" },
      ],
    },
    { ...metadata, type: "parallel.paused", results: [{ stepId: "child", status: "failure" }] },
    { ...metadata, type: "parallel.paused", results: [{ stepId: "child", status: "success" }] },
    {
      ...metadata,
      type: "agent.input",
      agentId: "fake",
      parentStepId: "group",
      input: {
        runId: "run",
        stepId: "step",
        parentStepId: "other",
        goal: "fixture",
        role: "worker",
      },
    },
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
