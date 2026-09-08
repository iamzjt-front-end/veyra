import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ProcessRunner } from "@veyraoss/runtime";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { runCli } from "../src/application.js";

const moduleSource = `import { appendFileSync } from "node:fs";
appendFileSync(new URL("./imported", import.meta.url), "yes");
export default {
  apiVersion: 1, provider: "fixture-routing", version: "1.0.0",
  createAgent(config) {
    if (config.options.invalid) throw new Error("fixture-secret must not leak");
    return {
      id: config.id, provider: "fixture-routing",
      describe: () => ({ schemaVersion: 1, id: config.id, provider: "fixture-routing", adapterVersion: "1.0.0", model: config.model, roles: ["planner"], capabilities: ["reasoning"] }),
      run: async (input) => { appendFileSync(new URL("./invoked", import.meta.url), config.id + "\\n"); return { status: "success", summary: input.role + ":" + config.model }; }
    };
  },
  checkReadiness: async (config) => {
    if (config.options.probeFails) throw new Error("fixture-secret native readiness failure");
    return { status: config.options.available ? "ready" : "unavailable", scope: "configuration", message: config.options.available ? "configured" : "fixture-secret unavailable" };
  }
};`;
const runner: ProcessRunner = async () => ({
  exitCode: 0,
  signal: null,
  stdout: "10.15.1\n",
  stderr: "",
  durationMs: 1,
  stdoutTruncated: false,
  stderrTruncated: false,
});
async function setup(path: string) {
  await writeFile(join(path, "plugin.mjs"), moduleSource);
  const config = {
    version: 1,
    agents: {
      primary: {
        provider: "fixture-routing",
        model: "pinned-primary",
        options: { available: false },
      },
      backup: { provider: "fixture-routing", model: "pinned-backup", options: { available: true } },
    },
    plugins: { "fixture-routing": { module: "./plugin.mjs", version: "1.0.0" } },
    workflow: { use: "workflow.yaml" },
  };
  const workflow = {
    name: "routing",
    version: 1,
    start: "work",
    steps: {
      work: {
        type: "agent",
        agent: "primary",
        requires: { role: "planner", capabilities: ["reasoning"] },
        routing: { fallbacks: ["backup"], fallbackOn: ["unavailable"] },
      },
    },
  };
  await writeFile(join(path, "veyra.yaml"), JSON.stringify(config));
  await writeFile(join(path, "workflow.yaml"), JSON.stringify(workflow));
  return { config, workflow };
}
async function invoke(path: string, args: string[], json = true, trusted = true) {
  let stdout = "",
    stderr = "";
  const code = await runCli(
    [
      ...args,
      ...(json ? ["--json"] : []),
      ...(trusted ? ["--allow-plugin", "fixture-routing"] : []),
    ],
    {
      cwd: path,
      env: { GENERIC_TOKEN: "fixture-secret" },
      runProcess: runner,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    },
  );
  return {
    code,
    stdout,
    stderr,
    records: () =>
      stdout
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
  };
}

describe("routed workflow CLI", () => {
  it("treats a thrown readiness probe as availability failure in both doctor and execution", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { config } = await setup(path);
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          ...config,
          agents: {
            ...config.agents,
            primary: { ...config.agents.primary, options: { probeFails: true } },
          },
        }),
      );
      const doctor = await invoke(path, ["doctor"]);
      expect(doctor.code, doctor.stdout).toBe(0);
      expect(doctor.records()[0].routing[0].decision).toMatchObject({
        selected: "backup",
        attempts: [{ reason: "readiness_failed" }, { reason: "fallback_eligible" }],
      });
      const run = await invoke(path, ["run", "Plan"]);
      expect(run.code, run.stdout).toBe(0);
      expect(run.records().find((record) => record.type === "agent.routed").decision).toMatchObject(
        {
          selected: "backup",
          attempts: [{ reason: "readiness_failed" }, { reason: "fallback_eligible" }],
        },
      );
      expect(doctor.stdout + run.stdout + run.stderr).not.toContain("fixture-secret");
    });
  });
  it("validates every candidate binding without importing providers and requires trust before running", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { config } = await setup(path);
      const valid = await invoke(
        path,
        ["workflow", "validate", "workflow.yaml", "--config", "veyra.yaml"],
        true,
        false,
      );
      expect(valid.code, valid.stderr).toBe(0);
      expect(valid.records()[0].workflow.requiredAgents).toEqual(["primary", "backup"]);
      await expect(access(join(path, "imported"))).rejects.toThrow();
      const untrusted = await invoke(path, ["run", "Plan"], true, false);
      expect(untrusted.code).toBe(2);
      expect(untrusted.stdout).toContain("plugin_not_trusted");
      await expect(access(join(path, "imported"))).rejects.toThrow();
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({ ...config, agents: { primary: config.agents.primary } }),
      );
      const missing = await invoke(
        path,
        ["workflow", "validate", "workflow.yaml", "--config", "veyra.yaml"],
        true,
        false,
      );
      expect(missing.code).toBe(2);
      expect(missing.stdout).toContain("backup");
      await expect(access(join(path, "imported"))).rejects.toThrow();
    });
  });
  it("doctor evaluates the ordered policy using provider readiness and run audits the same fallback", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await setup(path);
      const doctor = await invoke(path, ["doctor"]);
      expect(doctor.code, doctor.stderr).toBe(0);
      expect(doctor.records()[0]).toMatchObject({
        ready: true,
        routing: [
          {
            stepId: "work",
            ready: true,
            decision: {
              selected: "backup",
              attempts: [{ reason: "unavailable" }, { reason: "fallback_eligible" }],
            },
          },
        ],
      });
      await expect(access(join(path, "invoked"))).rejects.toThrow();
      await expect(access(join(path, ".veyra"))).rejects.toThrow();
      const result = await invoke(path, ["run", "Plan"]);
      expect(result.code, result.stderr).toBe(0);
      const routed = result.records().find((record) => record.type === "agent.routed");
      expect(routed.decision.selected).toBe("backup");
      expect(result.records().find((record) => record.type === "agent.selected")).toMatchObject({
        binding: "backup",
        descriptor: { model: "pinned-backup" },
      });
      expect(await readFile(join(path, "invoked"), "utf8")).toBe("backup\n");
      const events = await readFile(
        join(path, ".veyra", "runs", routed.runId, "events.jsonl"),
        "utf8",
      );
      expect(events).toContain('"type":"agent.routed"');
      expect([events, doctor.stdout, result.stdout, result.stderr].join("\n")).not.toContain(
        "fixture-secret",
      );
    });
  });
  it("makes fallback and exhaustion visible in plain text without treating a failure as success", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { config } = await setup(path);
      const run = await invoke(path, ["run", "Plan"], false);
      expect(run.code).toBe(0);
      expect(run.stdout).toContain(
        "primary skipped (unavailable); backup selected (fallback_eligible)",
      );
      config.agents.backup.options.available = false;
      await writeFile(join(path, "veyra.yaml"), JSON.stringify(config));
      const doctor = await invoke(path, ["doctor"], false);
      expect(doctor.code).toBe(1);
      expect(doctor.stdout).toContain("Routing work: blocked");
      const failed = await invoke(path, ["run", "Plan"], false);
      expect(failed.code).toBe(1);
      expect(failed.stdout).toContain("backup blocked (unavailable)");
      expect(await readFile(join(path, "invoked"), "utf8")).toBe("backup\n");
    });
  });
  it("does not hide invalid candidate configuration behind an otherwise eligible backup", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { config, workflow } = await setup(path);
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          ...config,
          agents: {
            ...config.agents,
            primary: { ...config.agents.primary, options: { invalid: true, available: false } },
          },
        }),
      );
      workflow.steps.work.routing.fallbackOn.push("requirements");
      await writeFile(join(path, "workflow.yaml"), JSON.stringify(workflow));
      const doctor = await invoke(path, ["doctor"]);
      expect(doctor.code).toBe(1);
      expect(doctor.records()[0].routing[0]).toMatchObject({
        ready: false,
        message: expect.stringContaining("configuration errors"),
      });
      const run = await invoke(path, ["run", "Plan"]);
      expect(run.code).toBe(2);
      expect(run.stdout).toContain("plugin_agent_failed");
      expect(run.stdout + run.stderr).not.toContain("fixture-secret");
      await expect(access(join(path, "invoked"))).rejects.toThrow();
    });
  });
});
