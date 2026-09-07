import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import {
  assertWorkflow,
  loadWorkflow,
  parseWorkflow,
  resolveNextStep,
  WorkflowError,
} from "../src/index.js";

const minimal = () => ({
  name: "fixture",
  version: 1,
  start: "plan",
  steps: { plan: { type: "agent", agent: "planner", next: "done" }, done: { type: "end" } },
});

describe("parseWorkflow", () => {
  it("validates the graph through both public validation entry points", () => {
    const workflow = parseWorkflow(minimal());
    expect(workflow).toEqual(minimal());
    expect(() => assertWorkflow(workflow)).not.toThrow();
    expect(() => assertWorkflow({ ...workflow, start: "missing" })).toThrow("start");
  });

  it.each([
    [null, "root"],
    [[], "root"],
    [{ ...minimal(), name: "" }, "name"],
    [{ ...minimal(), version: 2 }, "version"],
    [{ ...minimal(), version: "1" }, "version"],
    [{ ...minimal(), start: "missing" }, "start"],
    [{ ...minimal(), start: "toString" }, "start"],
    [{ ...minimal(), steps: {} }, "start"],
    [{ ...minimal(), steps: [] }, "steps"],
    [{ ...minimal(), unexpected: true }, "root.unexpected"],
  ])("rejects invalid graph %#", (value, field) => {
    expect(() => parseWorkflow(value)).toThrow(String(field));
  });

  it.each([
    [{ type: "agent" }, "agent"],
    [{ type: "agent", agent: "planner", next: "missing" }, "next"],
    [{ type: "agent", agent: "planner", next: "constructor" }, "next"],
    [{ type: "agent", agent: "planner", on: { fail: "missing" } }, "on.fail"],
    [{ type: "agent", agent: "planner", on: { fail: 12 } }, "on.fail"],
    [{ type: "agent", agent: "planner", next: "" }, "next"],
    [{ type: "agent", agent: "planner", run: ["echo hello"] }, "run"],
    [{ type: "command", run: [] }, "run"],
    [{ type: "command", run: "echo hello" }, "run"],
    [{ type: "command", run: [""] }, "run[0]"],
    [{ type: "human", message: 12 }, "message"],
    [{ type: "human", on: [] }, "on"],
    [{ type: "end", next: "done" }, "next"],
    [{ type: "unknown" }, "type"],
  ])("rejects invalid step %#", (step, field) => {
    expect(() =>
      parseWorkflow({ ...minimal(), steps: { ...minimal().steps, plan: step } }),
    ).toThrow(`steps.plan.${String(field)}`);
  });

  it.each(["parallel", "router", "subworkflow"])("keeps %s reserved and unsupported", (type) => {
    expect(() => parseWorkflow({ ...minimal(), steps: { plan: { type } } })).toThrow(
      `${type} is reserved and unsupported in v0.1`,
    );
  });

  it.each([
    null,
    {},
    { max: -1 },
    { max: 1.5 },
    { max: "3" },
    { max: Infinity },
    { max: 2, delay: 1 },
  ])("rejects invalid retry %#", (retry) => {
    expect(() =>
      parseWorkflow({
        ...minimal(),
        steps: { ...minimal().steps, plan: { ...minimal().steps.plan, retry } },
      }),
    ).toThrow("steps.plan.retry");
  });

  it("accepts zero retries and copies mutable node values", () => {
    const value = {
      ...minimal(),
      steps: {
        ...minimal().steps,
        plan: {
          type: "command",
          run: ["node --version"],
          on: { success: "done" },
          retry: { max: 0 },
          metadata: { labels: ["fixture"] },
        },
      },
    };
    const before = structuredClone(value);
    const workflow = parseWorkflow(value);
    const step = workflow.steps.plan;
    assert(step?.run && step.on && step.retry && step.metadata);
    step.run.push("changed");
    step.on.failure = "done";
    step.retry.max = 2;
    step.metadata.labels = [];
    expect(value).toEqual(before);
  });

  it("rejects cyclic metadata", () => {
    const metadata: Record<string, unknown> = {};
    metadata.self = metadata;
    expect(() =>
      parseWorkflow({
        ...minimal(),
        steps: { ...minimal().steps, plan: { ...minimal().steps.plan, metadata } },
      }),
    ).toThrow("cycles");
  });
});

describe("resolveNextStep", () => {
  it.each(["success", "failure", "pass", "fail", "approved", "rejected"])(
    "matches the exact %s outcome before next",
    (status) => {
      expect(
        resolveNextStep(
          { type: "human", on: { [status]: "matched" }, next: "fallback" },
          { status },
        ),
      ).toBe("matched");
    },
  );

  it("uses next for unmatched outcomes and ignores inherited object properties", () => {
    const step = { type: "human" as const, on: { approved: "done" }, next: "fallback" };
    for (const status of ["unknown", "toString", "constructor"]) {
      expect(resolveNextStep(step, { status })).toBe("fallback");
    }
    expect(resolveNextStep({ type: "end" }, { status: "success" })).toBeUndefined();
  });
});

describe("loadWorkflow", () => {
  it.each(["dev", "bugfix", "review", "research"])(
    "loads built-in %s independently of the project directory",
    async (preset) => {
      await withFixtureWorkspace(async (workspace) => {
        const workflow = await loadWorkflow(preset, workspace.path);
        expect(workflow.name).toBe(preset === "dev" ? "default-dev" : preset);
        expect(() => assertWorkflow(workflow)).not.toThrow();
      });
    },
  );

  it("loads workflows/dev.yaml including its repair loop", async () => {
    const path = fileURLToPath(new URL("../../../workflows/dev.yaml", import.meta.url));
    const workflow = await loadWorkflow(path);
    expect(workflow.start).toBe("plan");
    expect(workflow.steps.fix?.retry?.max).toBe(3);
    assert(workflow.steps.verify);
    expect(resolveNextStep(workflow.steps.verify, { status: "failure" })).toBe("fix");
  });

  it("resolves a user workflow relative to its explicit working directory", async () => {
    await withFixtureWorkspace(async (workspace) => {
      await writeFile(
        join(workspace.path, "custom.yaml"),
        "name: approval\nversion: 1\nstart: approve\nsteps:\n  approve:\n    type: human\n    message: Continue?\n    on:\n      approved: done\n      rejected: stop\n  done:\n    type: end\n  stop:\n    type: end\n",
      );
      const workflow = await loadWorkflow("./custom.yaml", workspace.path);
      assert(workflow.steps.approve);
      expect(resolveNextStep(workflow.steps.approve, { status: "rejected" })).toBe("stop");
    });
  });

  it("reports file and field for invalid workflow data", async () => {
    await withFixtureWorkspace(async (workspace) => {
      const path = join(workspace.path, "invalid.yaml");
      await writeFile(path, "name: invalid\nversion: 1\nstart: missing\nsteps: {}\n");
      await expect(loadWorkflow(path)).rejects.toMatchObject({ filePath: path, field: "start" });
    });
  });

  it("reports malformed YAML without echoing source values", async () => {
    await withFixtureWorkspace(async (workspace) => {
      const path = join(workspace.path, "invalid.yaml");
      await writeFile(path, "name: [not-a-real-secret");
      const failure = await loadWorkflow(path).then(
        () => null,
        (error: unknown) => error,
      );
      assert(failure instanceof WorkflowError);
      expect(failure.filePath).toBe(path);
      expect(failure.message).toContain("line");
      expect(failure.message).not.toContain("not-a-real-secret");
    });
  });

  it("reports missing files and invalid references", async () => {
    await withFixtureWorkspace(async (workspace) => {
      await expect(loadWorkflow("missing.yaml", workspace.path)).rejects.toThrow("ENOENT");
      await expect(loadWorkflow(" ", workspace.path)).rejects.toThrow("reference");
    });
  });
});
