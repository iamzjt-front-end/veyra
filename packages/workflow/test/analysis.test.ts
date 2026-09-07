import { describe, expect, it } from "vitest";
import { analyzeWorkflow, type WorkflowDefinition } from "../src/index.js";

describe("conditional graph validation", () => {
  it("finds every possible branch and fallback while data references do not create execution edges", () => {
    const workflow: WorkflowDefinition = {
      name: "branches",
      version: 1,
      start: "review",
      steps: {
        review: {
          type: "agent",
          agent: "reviewer",
          on: { pass: "accepted", fail: "rejected" },
          next: "fallback",
          inputs: { unrelated: { from: "unused", path: "/data" } },
        },
        accepted: { type: "end" },
        rejected: { type: "end" },
        fallback: { type: "end" },
        unused: { type: "agent", agent: "planner" },
      },
    };
    const original = structuredClone(workflow);
    expect(analyzeWorkflow(workflow)).toEqual({
      reachableSteps: ["review", "accepted", "rejected", "fallback"],
      unreachableSteps: ["unused"],
    });
    expect(workflow).toEqual(original);
  });

  it("terminates on repair cycles and handles own prototype-shaped step names", () => {
    const workflow: WorkflowDefinition = {
      name: "cycle",
      version: 1,
      start: "review",
      steps: {
        review: { type: "agent", agent: "reviewer", on: { pass: "constructor", fail: "fix" } },
        fix: { type: "agent", agent: "executor", next: "review" },
        constructor: { type: "end" as const },
        unused: { type: "end" },
      },
    };
    expect(analyzeWorkflow(workflow)).toEqual({
      reachableSteps: ["review", "fix", "constructor"],
      unreachableSteps: ["unused"],
    });
  });

  it("reports an invalid destination even when the containing branch is unreachable", () => {
    const workflow: WorkflowDefinition = {
      name: "bad dead branch",
      version: 1,
      start: "done",
      steps: { done: { type: "end" }, unused: { type: "human", on: { approved: "absent" } } },
    };
    expect(() => analyzeWorkflow(workflow)).toThrow("steps.unused.on.approved");
  });
});
