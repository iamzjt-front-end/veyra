import { createRequire } from "node:module";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentInput, JsonObject, VeyraEvent } from "@veyra/protocol";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../packages/runtime/src/index.js";
import { loadWorkflow } from "../../packages/workflow/src/index.js";
import { withFixtureWorkspace } from "../helpers/workspace.js";

const harness = fileURLToPath(new URL("./cli-harness.ts", import.meta.url));
const tsx = createRequire(import.meta.url).resolve("tsx");
const greeting = "Hello from a verified Veyra run";
type Call = { pid: number; input: AgentInput; cwd: string };

async function fixture(path: string, scenario: string) {
  await writeFile(join(path, "scenario.txt"), scenario);
  const ve = async (...args: string[]) => {
    const result = await runProcess({
      executable: process.execPath,
      args: ["--import", tsx, harness, ...args, "--json"],
      cwd: path,
      env: {
        OPENAI_API_KEY: undefined,
        CODEX_API_KEY: undefined,
        CODEX_ACCESS_TOKEN: undefined,
        ANTHROPIC_API_KEY: undefined,
        GEMINI_API_KEY: undefined,
      },
      timeoutMs: 45_000,
      maxOutputBytes: 512 * 1024,
    });
    expect(result.terminationReason, result.stderr).toBeUndefined();
    expect(result.stdoutTruncated).toBe(false);
    expect(result.stderr, result.stdout).toBe("");
    const records = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as JsonObject);
    return { ...result, records, last: records.at(-1) as JsonObject };
  };
  expect((await ve("init")).exitCode).toBe(0);
  const config = {
    version: 1,
    agents: {
      planner: { provider: "openai", model: "fixture-model" },
      executor: { provider: "codex", options: { executable: join(path, "absent-codex") } },
      reviewer: { provider: "openai", model: "fixture-model" },
    },
    workflow: { use: "dev" },
    runtime: { maxFixIterations: 3, stateDir: ".veyra" },
  };
  if (scenario === "human-gate") {
    const workflow = await loadWorkflow("dev");
    workflow.steps.plan = { ...workflow.steps.plan, type: "agent", next: "approval" };
    workflow.steps.approval = {
      type: "human",
      message: "Approve fixture changes",
      next: "execute",
    };
    config.workflow.use = "workflow.yaml";
    await writeFile(join(path, "workflow.yaml"), JSON.stringify(workflow));
  }
  await writeFile(join(path, "veyra.yaml"), JSON.stringify(config));
  const packagePath = join(path, "package.json");
  const manifest = JSON.parse(await readFile(packagePath, "utf8"));
  manifest.scripts.build = "node build.js";
  await writeFile(packagePath, JSON.stringify(manifest));
  await writeFile(
    join(path, "build.js"),
    "import {mkdir,copyFile} from 'node:fs/promises'; await mkdir('dist',{recursive:true}); await copyFile('src/message.js','dist/message.js');\n",
  );
  const testPath = join(path, "test/message.test.js");
  await writeFile(
    testPath,
    (await readFile(testPath, "utf8")).replace("Hello from the Veyra fixture", greeting),
  );
  const calls = async (): Promise<Call[]> =>
    (await readFile(join(path, "calls.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Call);
  const events = async (runId: string): Promise<VeyraEvent[]> =>
    (await readFile(join(path, ".veyra/runs", runId, "events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as VeyraEvent);
  const start = () => ve("run", "Change the fixture greeting", "--non-interactive");
  return { ve, start, calls, events };
}

describe("deterministic CLI vertical slice", () => {
  it("completes the built-in dev preset once and exposes saved evidence", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { ve, start, calls, events } = await fixture(path, "happy");
      const run = await start();
      expect(run.exitCode, run.stdout).toBe(0);
      const runId = run.last.runId as string;
      const status = await ve("status", runId);
      expect(status.last).toMatchObject({
        status: "completed",
        retryCounts: { plan: 0, execute: 0, verify: 0, review: 0 },
      });
      const history = await events(runId);
      expect(history.map((event) => event.sequence)).toEqual(history.map((_, index) => index + 1));
      expect(
        history.filter((event) => event.type === "step.started").map((event) => event.stepId),
      ).toEqual(["plan", "execute", "verify", "review", "done"]);
      const review = await ve("review", runId);
      expect(review.last).toMatchObject({
        review: { result: { outcome: "pass", artifacts: [{ path: "dist/message.js" }] } },
        verification: {
          success: true,
          results: [
            { command: "pnpm check", exitCode: 0 },
            { command: "pnpm test", exitCode: 0 },
            { command: "pnpm build", exitCode: 0 },
          ],
        },
      });
      expect((await calls()).map((call) => call.input.role)).toEqual([
        "planner",
        "executor",
        "reviewer",
      ]);
      expect(await readFile(join(path, "dist/message.js"), "utf8")).toContain(greeting);
    });
  }, 60_000);

  it.each(["verifier-fix", "reviewer-fix"])(
    "repairs one %s failure using persisted evidence",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        const { ve, start, calls, events } = await fixture(path, scenario);
        const run = await start();
        expect(run.exitCode, run.stdout).toBe(0);
        const history = await events(run.last.runId as string);
        const invocations = await calls();
        expect(invocations.filter((call) => call.input.role === "executor")).toHaveLength(2);
        const fix = invocations.find((call) => call.input.stepId === "fix");
        expect(fix?.input.context?.steps).toMatchObject(
          scenario === "verifier-fix"
            ? { verify: { outcome: "failure" } }
            : { review: { outcome: "fail" } },
        );
        expect(
          history
            .filter((event) => event.type === "verification.completed")
            .map((event) => event.success),
        ).toEqual(scenario === "verifier-fix" ? [false, true] : [true, true]);
        expect((await ve("status")).last).toMatchObject({
          status: "completed",
          retryCounts: { fix: 1, verify: 1 },
        });
        expect((await ve("review")).last).toMatchObject({
          review: { result: { outcome: "pass" } },
          verification: { success: true },
        });
        expect(await readFile(join(path, "dist/message.js"), "utf8")).toContain(
          "Repaired using the persisted evidence",
        );
      });
    },
    60_000,
  );

  it("stops after exactly three failed repairs and retains the final failure", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { ve, start, calls, events } = await fixture(path, "max-retries");
      const run = await start();
      expect(run.exitCode, run.stdout).toBe(1);
      const history = await events(run.last.runId as string);
      expect(history.at(-1)).toMatchObject({
        type: "run.failed",
        error: { code: "retry_exhausted" },
      });
      expect(history.filter((event) => event.type === "verification.completed")).toHaveLength(4);
      expect((await calls()).filter((call) => call.input.stepId === "fix")).toHaveLength(3);
      expect((await ve("status")).last).toMatchObject({
        status: "failed",
        retryCounts: { fix: 3, verify: 3 },
      });
      expect((await ve("resume")).last).toMatchObject({ type: "error", code: "run_not_paused" });
      expect((await calls()).filter((call) => call.input.stepId === "fix")).toHaveLength(3);
    });
  }, 60_000);

  it("exits at a human gate and continues in a new process only after explicit approval", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { ve, start, calls, events } = await fixture(path, "human-gate");
      const run = await start();
      expect(run.exitCode).toBe(3);
      const runId = run.last.runId as string;
      const status = await ve("status", runId);
      expect(status.last).toMatchObject({ status: "paused", currentStep: "approval" });
      expect((await calls()).map((call) => call.input.role)).toEqual(["planner"]);
      expect((await ve("resume", runId)).exitCode).toBe(2);
      const approvalId = (status.last.approval as JsonObject).approvalId as string;
      const resumed = await ve(
        "resume",
        runId,
        "--approve",
        "--approval-id",
        approvalId,
        "--comment",
        "Fixture scope approved",
      );
      expect(resumed.exitCode, resumed.stdout).toBe(0);
      const invocations = await calls();
      expect(invocations).toHaveLength(3);
      expect(invocations[0]?.pid).not.toBe(invocations[1]?.pid);
      expect(invocations[1]?.input.context?.steps).toMatchObject({
        approval: { outcome: "approved", comment: "Fixture scope approved" },
      });
      expect(
        (await events(runId)).filter((event) => event.type === "approval.resolved"),
      ).toMatchObject([{ approvalId, decision: "approved", comment: "Fixture scope approved" }]);
      expect((await ve("resume", runId, "--approve", "--approval-id", approvalId)).exitCode).toBe(
        2,
      );
    });
  }, 60_000);

  it("recovers a completed checkpoint after the owner exits without repeating the planner", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { ve, start, calls } = await fixture(path, "restart");
      const interrupted = await start();
      expect(interrupted.exitCode).toBe(71);
      const status = await ve("status");
      expect(status.last).toMatchObject({
        status: "interrupted",
        storedStatus: "running",
        currentStep: "plan",
        ownerStatus: "dead",
        recovery: { allowed: true },
      });
      expect((await ve("resume")).exitCode).toBe(2);
      const resumed = await ve("resume", "--recover-interrupted");
      expect(resumed.exitCode, resumed.stdout).toBe(0);
      const invocations = await calls();
      expect(invocations.map((call) => call.input.role)).toEqual([
        "planner",
        "executor",
        "reviewer",
      ]);
      expect(invocations[0]?.pid).not.toBe(invocations[1]?.pid);
      expect(invocations[1]?.input.context?.steps).toMatchObject({ plan: { data: { greeting } } });
      expect((await ve("status")).last).toMatchObject({
        status: "completed",
        retryCounts: { plan: 0, execute: 0 },
      });
    });
  }, 60_000);

  it("rejects invalid config before invoking any provider or creating a run", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { start } = await fixture(path, "invalid-config");
      await writeFile(join(path, "veyra.yaml"), "version: 999\nagents: {}\nworkflow: {use: dev}\n");
      const run = await start();
      expect(run.exitCode).toBe(2);
      expect(run.last.message).toContain("version");
      await expect(access(join(path, "calls.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(access(join(path, ".veyra/runs"))).rejects.toMatchObject({ code: "ENOENT" });
    });
  }, 60_000);

  it("reports a missing real Codex executable with actionable persisted evidence", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { ve, start, calls, events } = await fixture(path, "missing-codex");
      const run = await start();
      expect(run.exitCode, run.stdout).toBe(1);
      const history = await events(run.last.runId as string);
      expect(
        history.find((event) => event.type === "agent.completed" && event.stepId === "execute"),
      ).toMatchObject({
        result: {
          status: "failure",
          error: {
            code: "codex_not_found",
            message: expect.stringContaining("install it or configure its executable path"),
          },
        },
      });
      expect((await ve("status")).last.status).toBe("failed");
      expect((await calls()).map((call) => call.input.role)).toEqual(["planner"]);
    });
  }, 60_000);

  it("persists a thrown provider failure for inspection by a later process", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const { ve, start, events } = await fixture(path, "provider-failure");
      const run = await start();
      expect(run.exitCode, run.stdout).toBe(1);
      const history = await events(run.last.runId as string);
      expect(history.find((event) => event.type === "agent.failed")).toMatchObject({
        error: {
          code: "agent_execution_failed",
          message: expect.stringContaining("Fixture provider is unavailable"),
        },
      });
      expect(history.at(-1)).toMatchObject({
        type: "run.failed",
        error: { code: "agent_execution_failed" },
      });
      expect((await ve("status")).last).toMatchObject({ status: "failed", currentStep: "plan" });
      expect((await ve("review")).last).toMatchObject({ review: null, verification: null });
    });
  }, 60_000);
});
