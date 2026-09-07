import { access, mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { runCli, type CliServices } from "../src/application.js";

async function command(path: string, args: string[], services: CliServices = {}) {
  let output = "";
  let error = "";
  const code = await runCli(args, {
    cwd: path,
    env: {},
    ...services,
    stdout: (text) => {
      output += text;
    },
    stderr: (text) => {
      error += text;
    },
  });
  return {
    code,
    output,
    error,
    records: () =>
      output
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}
const save = (path: string, name: string, value: unknown) =>
  writeFile(join(path, name), JSON.stringify(value));
const simple = {
  name: "local-check",
  version: 1,
  start: "check",
  steps: { check: { type: "command", run: ["node --version"] } },
};

describe("user-defined workflow CLI", () => {
  it("lists the actual built-in workflows without a config or provider construction", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const result = await command(path, ["workflow", "list", "--json"], {
        createAgent: () => {
          throw new Error("Must not construct adapters");
        },
      });
      expect(result.code, result.error).toBe(0);
      expect(
        result.records()[0].workflows.map((item: { reference: string }) => item.reference),
      ).toEqual(["dev", "bugfix", "review", "research"]);
      expect(
        result
          .records()[0]
          .workflows.find((item: { reference: string }) => item.reference === "research")
          .requiredAgents,
      ).toEqual(["planner", "researcher", "judge"]);
      await expect(access(join(path, ".veyra"))).rejects.toThrow();
    });
  });

  it("validates without executing commands or implicitly loading ambient configuration", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await writeFile(join(path, "veyra.yaml"), "invalid: [yaml");
      await save(path, "custom.yaml", {
        ...simple,
        steps: {
          check: {
            type: "command",
            run: ["node -e \"require('node:fs').writeFileSync('unexpected','execution')\""],
          },
        },
      });
      const result = await command(path, ["workflow", "validate", "custom.yaml", "--json"], {
        createAgent: () => {
          throw new Error("Must not construct adapters");
        },
        runProcess: async () => {
          throw new Error("Must not spawn commands");
        },
      });
      expect(result.code, result.error).toBe(0);
      expect(result.records()[0]).toMatchObject({
        valid: true,
        configurationChecked: false,
        workflow: { name: "local-check", requiredAgents: [] },
      });
      await expect(access(join(path, "unexpected"))).rejects.toThrow();
      await expect(access(join(path, ".veyra"))).rejects.toThrow();
    });
  });

  it("reports every missing nested binding and unsupported provider before a run starts", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await save(path, "veyra.yaml", {
        version: 1,
        agents: {
          first: { provider: "openai", model: "fixture-model" },
          judge: { provider: "uninstalled-provider" },
        },
        workflow: { use: "custom.yaml" },
      });
      await save(path, "custom.yaml", {
        name: "nested-reviews",
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
                group: {
                  type: "consensus",
                  mode: "judge",
                  reviewers: ["one", "two"],
                  judge: "judge",
                },
                one: { type: "agent", agent: "first" },
                two: { type: "agent", agent: "second" },
                judge: { type: "agent", agent: "judge" },
              },
            },
          },
          spare: { type: "agent", agent: "unused" },
        },
      });
      const checked = await command(path, [
        "workflow",
        "validate",
        "custom.yaml",
        "--config",
        "veyra.yaml",
        "--json",
      ]);
      expect(checked.code).toBe(2);
      expect(checked.records()[0]).toMatchObject({
        valid: false,
        configurationChecked: true,
        diagnostics: [
          { code: "missing_agent_config", agent: "second", steps: ["call/two"] },
          { code: "unsupported_provider", agent: "judge", steps: ["call/judge"] },
        ],
        warnings: [{ code: "unreachable_step", stepId: "spare" }],
      });
      const run = await command(path, ["run", "Check configuration first", "--json"]);
      expect(run.code).toBe(2);
      expect(run.records()).toHaveLength(1);
      expect(run.records()[0].message).toContain("second");
      expect(run.records()[0].message).toContain("uninstalled-provider");
      await expect(access(join(path, ".veyra"))).rejects.toThrow();
    });
  });

  it("checks all bindings before constructing even an available first adapter", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await save(path, "veyra.yaml", {
        version: 1,
        agents: { first: { provider: "fixture" } },
        workflow: { use: "custom.yaml" },
      });
      await save(path, "custom.yaml", {
        ...simple,
        start: "one",
        steps: {
          one: { type: "agent", agent: "first", next: "two" },
          two: { type: "agent", agent: "missing" },
        },
      });
      let constructions = 0;
      const result = await command(path, ["run", "Preflight", "--json"], {
        createAgent: () => {
          constructions++;
          return new FakeAgent({ status: "success", summary: "Done" });
        },
      });
      expect(result.code).toBe(2);
      expect(result.records()[0].code).toBe("missing_agent_config");
      expect(constructions).toBe(0);
      await expect(access(join(path, ".veyra"))).rejects.toThrow();
    });
  });

  it("allows an unreachable spare agent and runs a file override relative to the explicit config", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = join(path, "project");
      await mkdir(project);
      await save(project, "veyra.yaml", {
        version: 1,
        agents: {},
        workflow: { use: "missing.yaml" },
      });
      await save(project, "selected.yaml", {
        ...simple,
        steps: { ...simple.steps, spare: { type: "agent", agent: "unused" } },
      });
      const validation = await command(path, [
        "workflow",
        "validate",
        "selected.yaml",
        "--config",
        "project/veyra.yaml",
        "--json",
      ]);
      expect(validation.code, validation.error).toBe(0);
      expect(validation.records()[0]).toMatchObject({
        valid: true,
        workflow: { requiredAgents: [] },
        warnings: [{ stepId: "spare" }],
      });
      const run = await command(path, [
        "run",
        "Use selected file",
        "--config",
        "project/veyra.yaml",
        "--workflow",
        "selected.yaml",
        "--json",
        "--non-interactive",
      ]);
      expect(run.code, run.output).toBe(0);
      expect(run.records().at(-1)).toMatchObject({ status: "completed" });
      const state = await command(path, ["status", "--config", "project/veyra.yaml", "--json"]);
      expect(await realpath(state.records()[0].cwd)).toBe(await realpath(project));
    });
  });

  it.each([
    { ...simple, version: 999 },
    { ...simple, start: "missing" },
    { ...simple, steps: { check: { type: "command", run: [] } } },
  ])("rejects malformed workflow %# before state or provider work", async (workflow) => {
    await withFixtureWorkspace(async ({ path }) => {
      await save(path, "bad.yaml", workflow);
      const result = await command(path, ["workflow", "validate", "bad.yaml", "--json"]);
      expect(result.code).toBe(2);
      expect(result.records()[0]).toMatchObject({ type: "error" });
      expect(result.records()[0].message).toContain(join(path, "bad.yaml"));
      await expect(access(join(path, ".veyra"))).rejects.toThrow();
    });
  });

  it("validates an intentional cycle but enforces its saved execution limit when run", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await save(path, "veyra.yaml", {
        version: 1,
        agents: { worker: { provider: "fixture" } },
        workflow: { use: "loop.yaml" },
        runtime: { maxFixIterations: 999 },
      });
      await save(path, "loop.yaml", {
        name: "bounded-loop",
        version: 1,
        start: "work",
        policy: { maxSteps: 2, retry: { max: 100 } },
        steps: { work: { type: "agent", agent: "worker", next: "work" } },
      });
      const worker = new FakeAgent({ status: "success", summary: "Again" });
      const services = { createAgent: () => worker };
      expect(
        (
          await command(
            path,
            ["workflow", "validate", "loop.yaml", "--config", "veyra.yaml", "--json"],
            services,
          )
        ).code,
      ).toBe(0);
      expect(worker.calls).toHaveLength(0);
      const run = await command(path, ["run", "Bound this loop", "--json"], services);
      expect(run.code).toBe(1);
      expect(run.records().at(-1)).toMatchObject({ error: { code: "transition_limit" } });
      expect(worker.calls).toHaveLength(2);
    });
  });

  it.each([
    ["workflow"],
    ["workflow", "unknown"],
    ["workflow", "validate"],
    ["workflow", "validate", "dev", "extra"],
    ["workflow", "list", "extra"],
    ["workflow", "list", "--config", "veyra.yaml"],
  ])("gives actionable usage errors for %j", async (...args) => {
    const result = await command(process.cwd(), [...args, "--json"]);
    expect(result.code).toBe(2);
    expect(result.records()[0].message).toContain("ve workflow");
  });

  it("shows workflow help at either subcommand depth", async () => {
    const result = await command(process.cwd(), ["workflow", "validate", "--help"]);
    expect(result.code).toBe(0);
    expect(result.output).toContain("workflow validate <name/path>");
  });
});
