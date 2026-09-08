import { ADAPTER_VERSION as CODEX_VERSION } from "@veyraoss/codex";
import { readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentConfig } from "@veyraoss/config";
import { parseConfig } from "@veyraoss/config";
import { LocalRunStore } from "@veyraoss/core";
import type { AgentAdapter } from "@veyraoss/protocol";
import { runProcess, type ProcessRunner } from "@veyraoss/runtime";
import type { WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { runCli, type CliServices } from "../src/application.js";

function commands(cwd: string, dependencies: CliServices = {}) {
  return async (args: string[]) => {
    let stdout = "";
    let stderr = "";
    const code = await runCli(args, {
      cwd,
      env: {},
      ...dependencies,
      stdout: (text) => {
        stdout += text;
      },
      stderr: (text) => {
        stderr += text;
      },
    });
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
  };
}

describe("CLI application commands", () => {
  it.skipIf(process.platform === "win32")(
    "explicitly recovers a paused owner's leases while approving and resuming through the CLI",
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const config = parseConfig({ version: 1, agents: {}, workflow: { use: "workflow.yaml" } });
        const workflow: WorkflowDefinition = {
          version: 1,
          name: "gate",
          start: "gate",
          steps: {
            gate: { type: "human", on: { approved: "done" } },
            done: { type: "end" },
          },
        };
        await writeFile(join(path, "veyra.yaml"), JSON.stringify(config));
        await writeFile(join(path, "workflow.yaml"), JSON.stringify(workflow));
        const moduleUrl = new URL("../../../packages/core/src/index.ts", import.meta.url).href;
        const source = `import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
import {VeyraEngine} from ${JSON.stringify(moduleUrl)};
await new VeyraEngine({emit:event=>{if(event.type==='run.paused'){writeFileSync(join(process.argv[1],'run-id'),event.runId);process.kill(process.pid,'SIGKILL');}}}).run({config:${JSON.stringify(config)},workflow:${JSON.stringify(workflow)},cwd:process.argv[1],goal:'CLI recovery',agents:{}});`;
        const child = await runProcess({
          executable: process.execPath,
          args: ["--import", "tsx", "--input-type=module", "-e", source, path],
          timeoutMs: 30_000,
        });
        expect(child.signal, child.stderr).toBe("SIGKILL");
        const id = await readFile(join(path, "run-id"), "utf8");
        const ve = commands(path);
        const blocked = await ve(["resume", id, "--approve", "--json"]);
        expect(blocked.records().at(-1)).toMatchObject({ code: "lock_busy" });
        const recovered = await ve(["resume", id, "--approve", "--recover-interrupted", "--json"]);
        expect(recovered.code, recovered.stdout + recovered.stderr).toBe(0);
        expect(recovered.records().at(-1)).toMatchObject({ status: "completed" });
      });
    },
    30_000,
  );
  it("reports unknown legacy ownership in plain and JSON status without creating providers or mutating state", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const config = parseConfig({ version: 1, workflow: { use: "fixture" }, agents: {} });
      await writeFile(join(path, "veyra.yaml"), JSON.stringify(config));
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await store.createRun({
        goal: "Legacy fixture",
        cwd: path,
        workflow: {
          version: 1,
          name: "legacy",
          start: "work",
          steps: { work: { type: "end" } },
        },
      });
      const ve = commands(path, {
        createAgent: () => {
          throw new Error("Status must not construct providers");
        },
      });
      const result = await ve(["status", run.state.runId, "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.records()[0]).toMatchObject({
        status: "unknown",
        storedStatus: "running",
        ownerStatus: "unknown",
        recovery: { allowed: false },
      });
      const plain = await ve(["status", run.state.runId]);
      expect(plain.stdout).toContain("Status: unknown (saved: running)");
      expect(plain.stdout).toContain("Recovery: refused");
      expect(await store.loadRun(run.state.runId)).toEqual(run);
    });
  });
  it("redacts recognizable credentials in plain and JSON CLI errors without an environment value", async () => {
    const secret = `sk-proj-${"FixtureOnly".repeat(5)}`;
    for (const flags of [[], ["--json"]]) {
      const result = await commands(process.cwd())([secret, ...flags]);
      expect(result.code).toBe(1);
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(result.stdout + result.stderr).toContain("[REDACTED]");
    }
  });

  it("keeps standard and custom provider secrets out of events, saved files, errors and later CLI inspection", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const token = 'fixture/github+"token';
      const custom = "fixture-custom-credential";
      const encoded = JSON.stringify(token).slice(1, -1);
      const exposed = [
        token,
        encoded,
        JSON.stringify(encoded).slice(1, -1),
        encodeURIComponent(token),
        encodeURIComponent(encodeURIComponent(token)),
        custom,
      ].join(" ");
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          version: 1,
          workflow: { use: "workflow.yaml" },
          agents: { worker: { provider: "fixture", options: { apiKeyEnv: "ODD_CREDENTIAL" } } },
        }),
      );
      await writeFile(
        join(path, "workflow.yaml"),
        JSON.stringify({
          version: 1,
          name: "Auth boundary",
          start: "token",
          steps: { token: { type: "agent", agent: "worker" } },
        }),
      );
      const ve = commands(path, {
        env: { GITHUB_TOKEN: token, ODD_CREDENTIAL: custom },
        createAgent: () => ({
          id: "worker",
          provider: "fixture",
          run: async (input) => {
            expect(JSON.stringify(input)).not.toContain("fixture/github");
            throw new Error(`Provider failed: ${exposed}`);
          },
        }),
      });
      const result = await ve(["run", `Do this task with ${exposed}`, "--json"]);
      expect(result.code, result.stderr).toBe(1);
      const runId = result.records().at(-1).runId as string;
      const status = await ve(["status", runId, "--json"]);
      const reviewed = await ve(["review", runId]);
      expect(status.records()[0]).toMatchObject({ currentStep: "token" });
      const files = await Promise.all(
        ["input.json", "state.json", "events.jsonl"].map((file) =>
          readFile(join(path, ".veyra", "runs", runId, file), "utf8"),
        ),
      );
      for (const text of [result.stdout, result.stderr, status.stdout, reviewed.stdout, ...files]) {
        expect(text).not.toContain("fixture/github");
        expect(text).not.toContain("fixture%2Fgithub");
        expect(text).not.toContain("fixture%252Fgithub");
        expect(text).not.toContain(custom);
      }
      expect(files.join("\n")).toContain("[REDACTED]");
    });
  });
  it("uses the normal approval and resume commands for workflow policy gates", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const worker = new FakeAgent({ status: "success", summary: "Approved work completed" });
      const ve = commands(path, { createAgent: () => worker });
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          version: 1,
          agents: { worker: { provider: "fixture" } },
          workflow: { use: "guarded.yaml" },
        }),
      );
      await writeFile(
        join(path, "guarded.yaml"),
        JSON.stringify({
          name: "guarded",
          version: 1,
          start: "work",
          policy: { approval: { before: ["work"] }, stepTimeoutMs: 5000, maxSteps: 2 },
          steps: { work: { type: "agent", agent: "worker" } },
        }),
      );
      const paused = await ve(["run", "Policy gate", "--json", "--non-interactive"]);
      expect(paused.code, paused.stderr).toBe(3);
      expect(worker.calls).toHaveLength(0);
      const runId = paused.records().at(-1).runId as string;
      const status = await ve(["status", runId, "--json"]);
      expect(status.records()[0]).toMatchObject({
        currentStep: "@approval/work",
        approval: { stepId: "@approval/work" },
      });
      const result = await ve(["resume", "--run-id", runId, "--approve", "--json"]);
      expect(result.code, result.stderr).toBe(0);
      expect(worker.calls).toHaveLength(1);
    });
  });
  it("discovers consensus reviewers and judge and renders the persisted decision", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const constructed: string[] = [];
      const agents = new Map<string, FakeAgent>();
      const ve = commands(path, {
        createAgent: (name) => {
          constructed.push(name);
          const agent = new FakeAgent({ status: "success", outcome: "pass", summary: name });
          agents.set(name, agent);
          return agent;
        },
      });
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          version: 1,
          agents: {
            one: { provider: "fixture", model: "a" },
            two: { provider: "fixture", model: "b" },
            arbiter: { provider: "fixture", model: "c" },
          },
          workflow: { use: "reviews.yaml" },
        }),
      );
      const definition: WorkflowDefinition = {
        name: "reviews",
        version: 1,
        start: "decision",
        steps: {
          decision: {
            type: "consensus",
            reviewers: ["review-one", "review-two"],
            mode: "judge",
            judge: "judge",
          },
          "review-one": { type: "agent", agent: "one" },
          "review-two": { type: "agent", agent: "two" },
          judge: { type: "agent", agent: "arbiter" },
        },
      };
      await writeFile(join(path, "reviews.yaml"), JSON.stringify(definition));
      const result = await ve(["run", "Independent decisions"]);
      expect(result.code, result.stderr).toBe(0);
      expect(constructed).toEqual(["one", "two", "arbiter"]);
      expect(result.stdout).toContain("consensus.completed");
      expect(result.stdout).toContain("pass (judge)");
      expect(agents.get("arbiter")?.calls[0]?.role).toBe("judge");
    });
  });
  it("discovers child providers and resumes a nested human gate through the shared CLI state model", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const worker = new FakeAgent({ status: "success", summary: "Nested provider completed" });
      const constructed: string[] = [];
      const ve = commands(path, {
        createAgent: (name) => {
          constructed.push(name);
          return worker;
        },
      });
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          version: 1,
          agents: { worker: { provider: "fixture" } },
          workflow: { use: "parent.yaml" },
        }),
      );
      const child: WorkflowDefinition = {
        name: "child",
        version: 1,
        start: "gate",
        steps: { gate: { type: "human", next: "work" }, work: { type: "agent", agent: "worker" } },
      };
      const definition: WorkflowDefinition = {
        name: "parent",
        version: 1,
        start: "call",
        steps: { call: { type: "subworkflow", use: "child.yaml" }, done: { type: "end" } },
      };
      await writeFile(join(path, "parent.yaml"), JSON.stringify(definition));
      await writeFile(join(path, "child.yaml"), JSON.stringify(child));
      const started = await ve(["run", "nested goal", "--json"]);
      expect(started.code, started.stderr).toBe(3);
      expect(constructed).toEqual(["worker"]);
      expect(worker.calls).toHaveLength(0);
      const runId = started.records().at(-1).runId as string;
      const status = await ve(["status", runId, "--json"]);
      expect(status.records()[0]).toMatchObject({
        currentStep: "call/gate",
        approval: { stepId: "call/gate" },
      });
      const resumed = await ve(["resume", "--run-id", runId, "--approve", "--json"]);
      expect(resumed.code, resumed.stderr).toBe(0);
      expect(worker.calls[0]?.stepId).toBe("call/work");
      expect(resumed.records().some((event) => event.type === "subworkflow.completed")).toBe(true);
    });
  });

  it("drives the full mocked dev path and human gate using only CLI command handlers", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registry: Record<string, FakeAgent> = {
        planner: new FakeAgent({
          status: "success",
          summary: "Plan greeting",
          data: { instructions: "Preserve the passing fixture" },
        }),
        executor: new FakeAgent({ status: "success", summary: "Fixture inspected" }),
        reviewer: new FakeAgent({
          status: "success",
          summary: "Evidence passes",
          outcome: "pass",
          artifacts: [{ id: "evidence", kind: "test", path: "test/message.test.js" }],
        }),
      };
      const factory = (name: string): AgentAdapter => {
        const agent = registry[name];
        if (!agent) throw new Error("unexpected fixture agent");
        return agent;
      };
      const ve = commands(path, { createAgent: factory });
      expect((await ve(["init", "--model", "fixture-model", "--json"])).code).toBe(0);
      const workflow: WorkflowDefinition = {
        name: "CLI fixture",
        version: 1,
        start: "plan",
        steps: {
          plan: { type: "agent", agent: "planner", next: "gate" },
          gate: { type: "human", message: "Approve the fixture", next: "execute" },
          execute: { type: "agent", agent: "executor", next: "verify" },
          verify: {
            type: "command",
            run: ["node --test"],
            on: { success: "review", failure: "fix" },
          },
          review: { type: "agent", agent: "reviewer", on: { pass: "done", fail: "fix" } },
          fix: { type: "agent", agent: "executor", next: "verify", retry: { max: 2 } },
          done: { type: "end" },
        },
      };
      await writeFile(join(path, "workflow.yaml"), JSON.stringify(workflow));
      const started = await ve([
        "run",
        "inspect fixture",
        "--workflow",
        "workflow.yaml",
        "--non-interactive",
        "--json",
      ]);
      expect(started.code, started.stderr).toBe(3);
      const runId = started.records().at(-1).runId as string;
      const paused = await ve(["status", runId, "--json"]);
      expect(paused.records()[0]).toMatchObject({ runId, status: "paused", currentStep: "gate" });
      expect(registry.executor?.calls).toHaveLength(0);
      const pendingId = paused.records()[0].approval.approvalId as string;
      const resumed = await ve([
        "resume",
        "--run-id",
        runId,
        "--approve",
        "--approval-id",
        pendingId,
        "--comment",
        "fixture approved",
        "--json",
      ]);
      expect(resumed.code, resumed.stdout).toBe(0);
      expect(resumed.records().at(-1)).toMatchObject({
        type: "result",
        runId,
        status: "completed",
      });
      expect((await ve(["status", "--json"])).records()[0]).toMatchObject({
        status: "completed",
        retryCounts: { plan: 0, execute: 0, verify: 0, review: 0 },
      });
      const reviewed = await ve(["review", runId, "--json"]);
      expect(reviewed.records()[0]).toMatchObject({
        review: { result: { outcome: "pass", artifacts: [{ id: "evidence" }] } },
        verification: { success: true },
      });
      expect(registry.planner?.calls).toHaveLength(1);
      expect(registry.executor?.calls).toHaveLength(1);
      expect(registry.reviewer?.calls).toHaveLength(1);
    });
  });

  it("preserves an existing config and unrelated ignore rules unless force is explicit", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const ve = commands(path);
      const ignore = "node_modules/\n!important.txt\n";
      await writeFile(join(path, ".gitignore"), ignore);
      expect((await ve(["init"])).code).toBe(0);
      const first = await readFile(join(path, "veyra.yaml"), "utf8");
      expect((await ve(["init", "--model", "replacement"])).code).toBe(2);
      expect(await readFile(join(path, "veyra.yaml"), "utf8")).toBe(first);
      expect((await ve(["init", "--force", "--model", "replacement"])).code).toBe(0);
      expect(await readFile(join(path, "veyra.yaml"), "utf8")).toContain("replacement");
      expect(await readFile(join(path, ".gitignore"), "utf8")).toBe(
        `${ignore}# Veyra local run state\n.veyra/state/\n.veyra/runs/\n.veyra/worktrees/\n`,
      );
    });
  });

  it("refuses to overwrite a symlink even with force", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const target = join(path, "kept.yaml");
      await writeFile(target, "user data");
      await symlink(target, join(path, "veyra.yaml"));
      const result = await commands(path)(["init", "--force", "--json"]);
      expect(result.code).toBe(2);
      expect(result.records()[0].code).toBe("unsafe_init_path");
      expect(await readFile(target, "utf8")).toBe("user data");
    });
  });

  it("rejects invalid config and missing runs without invoking a provider", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      let calls = 0;
      const factory = (_name: string, _config: AgentConfig): AgentAdapter => {
        calls++;
        throw new Error("must not execute");
      };
      const ve = commands(path, { createAgent: factory });
      await writeFile(join(path, "veyra.yaml"), "version: invalid");
      expect((await ve(["run", "fixture", "--json"])).code).toBe(2);
      expect(calls).toBe(0);
      expect((await ve(["init", "--force"])).code).toBe(0);
      const empty = await ve(["resume", "--json"]);
      expect(empty.records()[0].code).toBe("no_run");
      expect(calls).toBe(0);
    });
  });

  it.each([
    { args: ["run"] },
    { args: ["resume", "--approve", "--reject"] },
    { args: ["status", "one", "--run-id", "two"] },
    { args: ["init", "--approve"] },
    { args: ["run", "goal", "--unknown"] },
  ])("validates command syntax $args", async ({ args }) => {
    const result = await commands(process.cwd())([...args, "--json"]);
    expect(result.code).toBe(2);
    expect(result.records()[0].type).toBe("error");
  });

  it("guides a fresh installation without creating config or state", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const ve = commands(path, {
        runProcess: async () => {
          throw new Error("executable unavailable");
        },
      });
      const result = await ve(["doctor", "--json"]);
      expect(result.code).toBe(1);
      expect(result.records()[0]).toMatchObject({
        ready: false,
        config: { status: "missing", message: expect.stringContaining("ve init") },
        pnpm: { ready: false, message: expect.stringContaining("Install pnpm") },
      });
      expect(
        result
          .records()[0]
          .providers.every((provider: { required: boolean }) => !provider.required),
      ).toBe(true);
      const plain = await ve(["doctor"]);
      expect(plain.code).toBe(1);
      expect(plain.stdout).toContain("corepack enable");
      expect(plain.stdout).toContain("ve init");
      await expect(readFile(join(path, "veyra.yaml"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(path, ".veyra", "state", "active.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });

  it("distinguishes required and optional readiness without network or credential output", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const runner: ProcessRunner = async (request) => ({
        exitCode: request.args?.[0] === "login" ? 1 : 0,
        signal: null,
        stdout:
          request.executable === "pnpm" || request.args?.includes("pnpm --version")
            ? "10.15.1\n"
            : request.args?.[0] === "--version"
              ? "codex-cli 0.153.4\n"
              : "",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        durationMs: 1,
      });
      const ve = commands(path, {
        env: { OPENAI_API_KEY: "fixture-doctor-secret" },
        runProcess: runner,
      });
      const optional = await ve(["doctor", "--json"]);
      expect(optional.code).toBe(1);
      expect(optional.records()[0].executor).toMatchObject({
        available: true,
        ready: false,
        authentication: "not_authenticated",
      });
      const selectedMissing = await ve(["doctor", "--config", "missing.yaml", "--json"]);
      expect(selectedMissing.code).toBe(1);
      expect(selectedMissing.records()[0].config.status).toBe("invalid");
      expect(
        optional
          .records()[0]
          .providers.every((provider: { required: boolean }) => !provider.required),
      ).toBe(true);
      expect((await ve(["init"])).code).toBe(0);
      const required = await ve(["doctor", "--config", "veyra.yaml", "--json"]);
      expect(required.code).toBe(1);
      expect(required.records()[0].providers).toContainEqual(
        expect.objectContaining({
          provider: "codex",
          required: true,
          ready: false,
          descriptor: expect.objectContaining({
            schemaVersion: 1,
            adapterVersion: CODEX_VERSION,
            roles: ["executor"],
            capabilities: expect.arrayContaining(["code-execution", "local-cli"]),
          }),
        }),
      );
      expect(required.stdout).not.toContain("fixture-doctor-secret");
    });
  });
});
