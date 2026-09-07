import { describe, expect, it } from "vitest";
import {
  analyzeWorkflow,
  buildWorkflowGraph,
  parseWorkflow,
  retryDelay,
  withExecutionDefaults,
  type WorkflowDefinition,
} from "../src/index.js";

const workflow = (): WorkflowDefinition => ({
  name: "policy",
  version: 1,
  start: "work",
  steps: { work: { type: "agent", agent: "worker", next: "done" }, done: { type: "end" } },
});

describe("workflow execution policies", () => {
  it("freezes inherited retry defaults and restrictive timeout/concurrency caps", () => {
    const child = workflow();
    child.policy = { stepTimeoutMs: 5000, concurrency: 8, retry: { max: 2 } };
    child.start = "group";
    child.steps.group = { type: "parallel", children: ["leaf"], concurrency: 16 };
    child.steps.leaf = { type: "agent", agent: "worker", timeoutMs: 10000, retry: { max: 1 } };
    const input: WorkflowDefinition = {
      name: "parent",
      version: 1,
      start: "call",
      policy: {
        stepTimeoutMs: 1000,
        concurrency: 2,
        retry: { max: 4, backoff: { initialMs: 10, maxMs: 50 } },
      },
      steps: { call: { type: "subworkflow", workflow: child } },
    };
    const parsed = withExecutionDefaults(input, 3);
    expect(parsed.steps.call?.retry).toEqual({
      max: 4,
      backoff: { initialMs: 10, multiplier: 2, maxMs: 50 },
    });
    expect(parsed.steps.call?.workflow?.steps.group).toMatchObject({
      concurrency: 2,
      retry: { max: 2 },
    });
    expect(parsed.steps.call?.workflow?.steps.leaf).toMatchObject({
      timeoutMs: 1000,
      retry: { max: 1 },
    });
    expect(input.steps.call?.retry).toBeUndefined();
    expect(child.steps.leaf?.timeoutMs).toBe(10000);
  });
  it("routes every control-flow entry through ordinary human approval gates", () => {
    const input = workflow();
    input.policy = { approval: { before: ["work"] } };
    input.steps.work = { type: "agent", agent: "worker", on: { again: "work", success: "done" } };
    const graph = buildWorkflowGraph(input);
    expect(graph.scopes.get("")?.start).toBe("@approval/work");
    expect(graph.steps["@approval/work"]).toMatchObject({ type: "human", next: "work" });
    expect(graph.steps.work?.on).toEqual({ again: "@approval/work", success: "done" });
    expect(analyzeWorkflow(input).unreachableSteps).toEqual([]);
    expect(input.steps.work?.on?.again).toBe("work");
  });
  it("namespaces child policy gates and rejects explicit ID collisions", () => {
    const child = workflow();
    child.policy = { approval: { before: ["work"] } };
    const nested: WorkflowDefinition = {
      name: "parent",
      version: 1,
      start: "call",
      steps: { call: { type: "subworkflow", workflow: child } },
    };
    expect(buildWorkflowGraph(nested).scopes.get("call")?.start).toBe("call/@approval~1work");
    child.steps["@approval/work"] = { type: "end" };
    expect(() => buildWorkflowGraph(nested)).toThrow("collides");
  });
  it("bounds exponential retry delays without overflow and honors zero delay", () => {
    const input = workflow();
    input.policy = { retry: { max: 10, backoff: { initialMs: 10, maxMs: 30 } } };
    const step = withExecutionDefaults(input, 3).steps.work;
    if (!step) throw new Error("Missing work");
    expect([0, 1, 2, 3, Number.MAX_SAFE_INTEGER].map((count) => retryDelay(step, count))).toEqual([
      0, 10, 20, 30, 30,
    ]);
    expect(retryDelay({ type: "agent", retry: { max: 9, backoff: { initialMs: 0 } } }, 1000)).toBe(
      0,
    );
  });
  it.each([
    { stepTimeoutMs: 0 },
    { stepTimeoutMs: 86_400_001 },
    { stepTimeoutMs: 1.2 },
    { retry: { max: -1 } },
    { retry: { max: 1, backoff: { initialMs: -1 } } },
    { retry: { max: 1, backoff: { initialMs: 10, maxMs: 9 } } },
    { retry: { max: 1, backoff: { initialMs: 10, multiplier: 0 } } },
    { retry: { max: 1, backoff: { initialMs: 10, jitter: true } } },
    { concurrency: 0 },
    { concurrency: 33 },
    { maxSteps: 0 },
    { maxSteps: 1001 },
    { failureStrategy: "ignore" },
    { approval: { before: "work" } },
    { approval: { before: ["work", "work"] } },
    { approval: { before: ["absent"] } },
    { approval: { before: ["done"] } },
    { budget: {} },
    { budget: { maxTokens: -1 } },
    { budget: { maxCost: { amount: Number.NaN, currency: "USD" } } },
    { budget: { maxCost: { amount: 1, currency: "" } } },
    { budget: { tokens: 10 } },
    { unknown: true },
  ])("rejects invalid or ambiguous policy %#", (policy) => {
    expect(() => parseWorkflow({ ...workflow(), policy })).toThrow("policy");
  });
  it.each(["agent", "command"] as const)("validates leaf deadline overrides on %s", (type) => {
    const leaf = {
      type,
      ...(type === "agent" ? { agent: "worker" } : { run: ["node --version"] }),
    };
    expect(() =>
      parseWorkflow({ ...workflow(), steps: { work: { ...leaf, timeoutMs: 100 } } }),
    ).not.toThrow();
    expect(() =>
      parseWorkflow({ ...workflow(), steps: { work: { ...leaf, timeoutMs: -1 } } }),
    ).toThrow("steps.work.timeoutMs");
  });
  it("requires approving a parallel group instead of injecting a gate into an owned child", () => {
    const input = workflow();
    input.steps.work = { type: "parallel", children: ["child"] };
    input.steps.child = { type: "agent", agent: "worker" };
    input.policy = { approval: { before: ["child"] } };
    expect(() => parseWorkflow(input)).toThrow("owning group");
  });
});
