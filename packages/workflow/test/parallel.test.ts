import { describe, expect, it } from "vitest";
import {
  analyzeWorkflow,
  parseWorkflow,
  withRetryDefaults,
  type WorkflowDefinition,
} from "../src/index.js";

const workflow = (): WorkflowDefinition => ({
  name: "parallel",
  version: 1,
  start: "group",
  steps: {
    group: { type: "parallel", children: ["first", "second"], next: "done" },
    first: { type: "agent", agent: "reviewer" },
    second: { type: "command", run: ["node --version"] },
    done: { type: "end" },
  },
});

describe("parallel workflow validation", () => {
  it("materializes bounded defaults and includes children in graph reachability", () => {
    const input = workflow();
    const parsed = withRetryDefaults(input, 2);
    expect(parsed.steps.group).toMatchObject({
      concurrency: 2,
      failurePolicy: "wait-all",
      retry: { max: 2 },
    });
    expect(parsed.steps.first?.retry).toEqual({ max: 2 });
    expect(input.steps.group?.concurrency).toBeUndefined();
    expect(analyzeWorkflow(input)).toEqual({
      reachableSteps: ["group", "first", "second", "done"],
      unreachableSteps: [],
    });
  });

  it("accepts explicit fail-fast policy and inputs from preceding steps", () => {
    const input = workflow();
    input.start = "plan";
    input.steps.plan = { type: "agent", agent: "planner", next: "group" };
    input.steps.group = {
      ...input.steps.group,
      type: "parallel",
      concurrency: 1,
      failurePolicy: "fail-fast",
    };
    input.steps.first = {
      type: "agent",
      agent: "reviewer",
      inputs: { plan: { from: "plan", path: "/data" } },
    };
    expect(parseWorkflow(input)).toEqual(input);
  });

  it.each([
    ["empty children", { children: [] }],
    ["too many children", { children: Array.from({ length: 33 }, (_, i) => `child${i}`) }],
    ["duplicate child", { children: ["first", "first"] }],
    ["missing child", { children: ["absent"] }],
    ["terminal child", { children: ["done"] }],
    ["nested group", { children: ["group"] }],
    ["zero concurrency", { concurrency: 0 }],
    ["fractional concurrency", { concurrency: 1.5 }],
    ["unbounded concurrency", { concurrency: 33 }],
    ["unknown policy", { failurePolicy: "ignore" }],
    ["group inputs", { inputs: {} }],
  ])("rejects %s", (_label, fields) => {
    const input = workflow();
    expect(() =>
      parseWorkflow({
        ...input,
        steps: { ...input.steps, group: { ...input.steps.group, ...fields } },
      }),
    ).toThrow("steps.group");
  });

  it.each([
    "human",
    "next",
    "on",
    "self-input",
    "sibling-input",
    "parent-input",
    "two-owners",
    "start",
    "direct-branch",
  ])("rejects non-independent child configuration: %s", (scenario) => {
    const input = workflow();
    if (scenario === "human") input.steps.first = { type: "human" };
    if (scenario === "next") input.steps.first = { type: "agent", agent: "reviewer", next: "done" };
    if (scenario === "on") input.steps.first = { type: "agent", agent: "reviewer", on: {} };
    if (scenario.endsWith("-input"))
      input.steps.first = {
        type: "agent",
        agent: "reviewer",
        inputs: {
          value: {
            from:
              scenario === "self-input"
                ? "first"
                : scenario === "sibling-input"
                  ? "second"
                  : "group",
            path: "",
          },
        },
      };
    if (scenario === "two-owners") input.steps.other = { type: "parallel", children: ["first"] };
    if (scenario === "start") input.start = "first";
    if (scenario === "direct-branch")
      input.steps.gate = { type: "human", on: { approved: "second" } };
    expect(() => parseWorkflow(input)).toThrow(/parallel|child|children/);
  });
});
