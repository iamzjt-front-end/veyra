import { describe, expect, it } from "vitest";
import {
  analyzeWorkflow,
  parseWorkflow,
  resolveRoute,
  withRetryDefaults,
  type WorkflowDefinition,
} from "../src/index.js";

const workflow = (): WorkflowDefinition => ({
  name: "router",
  version: 1,
  start: "choose",
  steps: {
    source: { type: "agent", agent: "classifier" },
    choose: { type: "router", route: "inspect", on: { inspect: "done" } },
    done: { type: "end" },
  },
});

describe("declarative router selection", () => {
  it("selects a static label without running an agent and freezes its retry budget", () => {
    const parsed = withRetryDefaults(workflow(), 2);
    const step = parsed.steps.choose;
    if (!step) throw new Error("Router fixture is missing");
    expect(resolveRoute(step)).toEqual({
      route: "inspect",
      target: "done",
      selection: "static",
    });
    expect(parsed.steps.choose?.retry).toEqual({ max: 2 });
    expect(analyzeWorkflow(parsed)).toEqual({
      reachableSteps: ["choose", "done"],
      unreachableSteps: ["source"],
    });
  });

  it("uses exact referenced labels before next and protects prototype-shaped labels", () => {
    const definition = workflow();
    definition.steps.choose = {
      type: "router",
      route: { from: "source", path: "/data/label" },
      on: { inspect: "source" },
      next: "done",
    };
    const step = parseWorkflow(definition).steps.choose;
    if (!step) throw new Error("Router fixture is missing");
    expect(resolveRoute(step, "inspect")).toEqual({
      route: "inspect",
      target: "source",
      selection: "input",
    });
    expect(resolveRoute(step, "constructor").target).toBe("done");
    expect(resolveRoute({ ...step, on: { constructor: "source" } }, "constructor").target).toBe(
      "source",
    );
  });

  it.each([null, true, 1, [], {}, "", " ", "x".repeat(129)])(
    "rejects an invalid selected value %#",
    (value) => {
      expect(() =>
        resolveRoute(
          {
            type: "router",
            route: { from: "source", path: "/data/label" },
            on: { inspect: "done" },
          },
          value,
        ),
      ).toThrow("Router selection must be");
    },
  );

  it("never treats an undeclared label as a target even if it names a real step", () => {
    expect(() =>
      resolveRoute(
        { type: "router", route: { from: "source", path: "/data/label" }, on: { inspect: "done" } },
        "done",
      ),
    ).toThrow("no declared matching route");
  });

  it.each([
    { route: "" },
    { route: "x".repeat(129) },
    { route: "undeclared" },
    { on: {} },
    { on: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`route${i}`, "done"])) },
    { on: { inspect: "absent" } },
    { on: { ["x".repeat(129)]: "done" } },
    { route: { from: "absent", path: "/data/label" } },
    { route: { from: "choose", path: "/outcome" } },
    { route: { from: "done", path: "" } },
    { route: { from: "source", path: "data" } },
    { route: { from: "source", path: "", expression: "eval" } },
    { agent: "classifier" },
    { children: ["done"] },
  ])("rejects invalid router definition %#", (fields) => {
    const definition = workflow();
    expect(() =>
      parseWorkflow({
        ...definition,
        steps: { ...definition.steps, choose: { ...definition.steps.choose, ...fields } },
      }),
    ).toThrow("steps.choose");
  });
});
