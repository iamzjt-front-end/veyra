import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import {
  analyzeWorkflow,
  buildWorkflowGraph,
  loadWorkflow,
  parseWorkflow,
  withRetryDefaults,
  type WorkflowDefinition,
} from "../src/index.js";

const child = (): WorkflowDefinition => ({
  name: "child",
  version: 1,
  start: "work/1",
  steps: {
    "work/1": { type: "agent", agent: "worker", next: "gate" },
    gate: { type: "human" },
  },
});
const parent = (): WorkflowDefinition => ({
  name: "parent",
  version: 1,
  start: "call",
  steps: {
    call: {
      type: "subworkflow",
      workflow: child(),
      outputs: { answer: { from: "work/1", path: "/data/answer" } },
      next: "done",
    },
    done: { type: "end" },
  },
});

describe("subworkflow loading and namespaced graphs", () => {
  it("keeps source definitions immutable and scopes transitions, bindings, outputs and retry policies", () => {
    const definition = parent();
    const original = structuredClone(definition);
    const graph = buildWorkflowGraph(withRetryDefaults(definition, 2));
    expect(Object.keys(graph.steps)).toEqual(["call", "call/work~11", "call/gate", "done"]);
    expect(graph.steps["call/work~11"]).toMatchObject({ next: "call/gate", retry: { max: 2 } });
    expect(graph.steps.call?.outputs?.answer?.from).toBe("call/work~11");
    expect(graph.scopeOf.get("call/gate")).toBe("call");
    expect(graph.scopes.get("call")).toMatchObject({ parent: "", start: "call/work~11" });
    expect(analyzeWorkflow(definition).reachableSteps).toEqual(Object.keys(graph.steps));
    expect(definition).toEqual(original);
  });

  it("distinguishes two calls to the same child and rejects ambiguous author IDs", () => {
    const definition = parent();
    definition.steps.other = { type: "subworkflow", workflow: child() };
    expect(buildWorkflowGraph(definition).steps).toHaveProperty("other/work~11");
    definition.steps["call/gate"] = { type: "end" };
    expect(() => buildWorkflowGraph(definition)).toThrow("collides");
  });

  it("namespaces child routers and parallel groups within their owning workflow", () => {
    const definition: WorkflowDefinition = {
      name: "nested",
      version: 1,
      start: "call",
      steps: {
        call: {
          type: "subworkflow",
          workflow: {
            name: "child",
            version: 1,
            start: "group",
            steps: {
              group: { type: "parallel", children: ["a"], next: "choose" },
              a: { type: "agent", agent: "worker" },
              choose: {
                type: "router",
                route: { from: "a", path: "/outcome" },
                on: { success: "done" },
              },
              done: { type: "end" },
            },
          },
        },
      },
    };
    const graph = buildWorkflowGraph(definition);
    expect(graph.steps["call/group"]).toMatchObject({ children: ["call/a"], next: "call/choose" });
    expect(graph.steps["call/choose"]).toMatchObject({
      route: { from: "call/a", path: "/outcome" },
      on: { success: "call/done" },
    });
  });

  it("resolves user references relative to the declaring file and snapshots built-in presets", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await mkdir(join(path, "flows"));
      await writeFile(join(path, "flows/child.yaml"), JSON.stringify(child()));
      const definition = parent();
      definition.steps.call = { type: "subworkflow", use: "./child.yaml", next: "builtin" };
      definition.steps.builtin = { type: "subworkflow", use: "research" };
      await writeFile(join(path, "flows/parent.yaml"), JSON.stringify(definition));
      const loaded = await loadWorkflow("flows/parent.yaml", path);
      expect(loaded.steps.call?.workflow).toEqual(child());
      expect(loaded.steps.builtin?.workflow?.name).toBe("research");
      expect(() => buildWorkflowGraph(loaded)).not.toThrow();
    });
  });

  it.each(["cycle", "symlink-cycle"])("rejects a %s before execution", async (scenario) => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = parent();
      definition.steps.call = {
        type: "subworkflow",
        use: scenario === "cycle" ? "./parent.yaml" : "./alias.yaml",
      };
      await writeFile(join(path, "parent.yaml"), JSON.stringify(definition));
      if (scenario === "symlink-cycle")
        await symlink(join(path, "parent.yaml"), join(path, "alias.yaml"));
      await expect(loadWorkflow("parent.yaml", path)).rejects.toThrow(
        "recursive subworkflow reference",
      );
    });
  });

  it("rejects unresolved execution graphs and excessive inline nesting", () => {
    expect(() =>
      buildWorkflowGraph({
        name: "unresolved",
        version: 1,
        start: "call",
        steps: { call: { type: "subworkflow", use: "research" } },
      }),
    ).toThrow("use loadWorkflow");
    let definition = child();
    for (let depth = 0; depth < 8; depth++)
      definition = {
        name: "layer",
        version: 1,
        start: "call",
        steps: { call: { type: "subworkflow", workflow: definition } },
      };
    expect(() => buildWorkflowGraph(definition)).not.toThrow();
    expect(() =>
      parseWorkflow({
        name: "too deep",
        version: 1,
        start: "call",
        steps: { call: { type: "subworkflow", workflow: definition } },
      }),
    ).toThrow("maximum depth of 8");
  });

  it.each([
    { use: "" },
    { outputs: { answer: { from: "absent", path: "" } } },
    { outputs: { answer: { from: "work/1", path: "bad" } } },
    { inputs: { answer: { from: "absent", path: "" } } },
    { agent: "worker" },
    { failurePolicy: "ignore" },
  ])("rejects invalid call configuration %#", (fields) => {
    const definition = parent();
    expect(() =>
      parseWorkflow({
        ...definition,
        steps: { ...definition.steps, call: { ...definition.steps.call, ...fields } },
      }),
    ).toThrow("steps.call");
  });
});
