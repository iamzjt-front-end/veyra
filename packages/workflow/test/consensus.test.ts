import { describe, expect, it } from "vitest";
import {
  aggregateReviews,
  analyzeWorkflow,
  buildWorkflowGraph,
  parseWorkflow,
  withRetryDefaults,
  type WorkflowDefinition,
} from "../src/index.js";

const workflow = (): WorkflowDefinition => ({
  name: "consensus",
  version: 1,
  start: "verify",
  steps: {
    verify: { type: "command", run: ["node --version"], next: "group" },
    group: {
      type: "consensus",
      reviewers: ["one", "two"],
      verification: ["verify"],
      on: { pass: "done", fail: "done" },
    },
    one: { type: "agent", agent: "first-model" },
    two: { type: "agent", agent: "second-model" },
    arbiter: { type: "agent", agent: "judge-model" },
    done: { type: "end" },
  },
});

describe("consensus graph and deterministic aggregation", () => {
  it("copies defaults and namespaces all owned reviewers, judge, and required evidence", () => {
    const input = workflow();
    input.steps.group = {
      ...input.steps.group,
      type: "consensus",
      mode: "judge",
      judge: "arbiter",
    };
    const nested: WorkflowDefinition = {
      name: "parent",
      version: 1,
      start: "call",
      steps: { call: { type: "subworkflow", workflow: input } },
    };
    const snapshot = withRetryDefaults(nested, 2);
    const graph = buildWorkflowGraph(snapshot);
    expect(graph.steps["call/group"]).toMatchObject({
      reviewers: ["call/one", "call/two"],
      judge: "call/arbiter",
      verification: ["call/verify"],
      concurrency: 2,
      retry: { max: 2 },
    });
    expect(snapshot.steps.call?.workflow?.steps.one?.retry).toEqual({ max: 2 });
    expect(input.steps.group?.concurrency).toBeUndefined();
    expect(analyzeWorkflow(nested).unreachableSteps).toEqual([]);
  });
  it.each([
    { reviewers: [] },
    { reviewers: ["one"] },
    { reviewers: ["one", "one"] },
    { reviewers: Array.from({ length: 33 }, (_, i) => `r${i}`) },
    { reviewers: ["one", "absent"] },
    { reviewers: ["one", "verify"] },
    { reviewers: ["one", "group"] },
    { mode: "any" },
    { mode: "quorum" },
    { mode: "quorum", quorum: 0 },
    { mode: "quorum", quorum: 3 },
    { mode: "quorum", quorum: 1.5 },
    { quorum: 1 },
    { judge: "arbiter" },
    { mode: "judge" },
    { mode: "judge", judge: "one" },
    { mode: "judge", judge: "verify" },
    { mode: "judge", judge: "missing" },
    { verification: ["one"] },
    { verification: ["missing"] },
    { verification: ["verify", "verify"] },
    { verification: "verify" },
    { concurrency: 0 },
    { concurrency: 33 },
    { failurePolicy: "fail-fast" },
    { inputs: {} },
  ])("rejects invalid consensus policy %#", (patch) => {
    const input = workflow();
    expect(() =>
      parseWorkflow({
        ...input,
        steps: { ...input.steps, group: { ...input.steps.group, ...patch } },
      }),
    ).toThrow("steps.group");
  });
  it.each(["start", "branch", "next", "on", "self", "peer", "group", "judge", "shared"])(
    "rejects non-independent owned nodes: %s",
    (scenario) => {
      const input = workflow();
      input.steps.group = {
        ...input.steps.group,
        type: "consensus",
        mode: "judge",
        judge: "arbiter",
      };
      if (scenario === "start") input.start = "arbiter";
      if (scenario === "branch")
        input.steps.verify = { type: "command", run: ["node --version"], next: "two" };
      if (scenario === "next") input.steps.one = { type: "agent", agent: "model", next: "done" };
      if (scenario === "on") input.steps.arbiter = { type: "agent", agent: "model", on: {} };
      if (scenario === "shared") input.steps.other = { type: "parallel", children: ["two"] };
      if (["self", "peer", "group", "judge"].includes(scenario))
        input.steps.one = {
          type: "agent",
          agent: "model",
          inputs: {
            evidence: {
              from:
                scenario === "self"
                  ? "one"
                  : scenario === "peer"
                    ? "two"
                    : scenario === "judge"
                      ? "arbiter"
                      : "group",
              path: "",
            },
          },
        };
      expect(() => parseWorkflow(input)).toThrow();
    },
  );
  it("requires explicit votes, supports quorum disagreement, and fails closed on review errors", () => {
    expect(aggregateReviews("all-pass", ["pass", "pass"])).toBe("pass");
    expect(aggregateReviews("all-pass", ["pass", "fail"])).toBe("fail");
    expect(aggregateReviews("quorum", ["pass", "fail", "pass"], 2)).toBe("pass");
    expect(aggregateReviews("quorum", ["pass", "fail"], 2)).toBe("fail");
    expect(aggregateReviews("quorum", ["pass", "pass"], 0)).toBe("fail");
    expect(aggregateReviews("judge", ["fail", "pass"], undefined, "pass")).toBe("pass");
    expect(aggregateReviews("judge", ["pass", "pass"], undefined, "fail")).toBe("fail");
    for (const mode of ["all-pass", "quorum", "judge"] as const) {
      expect(aggregateReviews(mode, ["pass", "error"], 1, "pass")).toBe("fail");
      expect(aggregateReviews(mode, [], 1, "pass")).toBe("fail");
    }
  });
});
