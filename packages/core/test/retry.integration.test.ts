import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { AgentAdapter, AgentInput, AgentResult } from "@veyraoss/protocol";
import { runProcess } from "@veyraoss/runtime";
import { loadWorkflow, type WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = (max: number) =>
  parseConfig({
    version: 1,
    agents: {},
    workflow: { use: "fixture" },
    runtime: { maxFixIterations: max },
  });
const loop: WorkflowDefinition = {
  name: "loop",
  version: 1,
  start: "work",
  steps: {
    work: { type: "agent", agent: "worker", on: { failure: "work", success: "done" } },
    done: { type: "end" },
  },
};
const failed = { status: "failure", summary: "Fixture needs repair" } satisfies AgentResult;
const passed = { status: "success", summary: "Done" } satisfies AgentResult;

describe("persisted repair limits", () => {
  it.each([0, 1, 3])("bounds an always-failing workflow with default max %i", async (max) => {
    await withFixtureWorkspace(async ({ path }) => {
      const worker = new FakeAgent(failed);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const result = await new VeyraEngine({ store }).run({
        config: config(max),
        workflow: loop,
        agents: { worker },
        goal: "repair",
        cwd: path,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "retry_exhausted" } });
      expect(worker.calls).toHaveLength(max + 1);
      expect((await store.loadRun(result.runId)).state.retryCounts.work).toBe(max);
      const events = await store.readEvents(result.runId);
      expect(events.filter((event) => event.type === "step.retrying")).toHaveLength(max);
      expect(events.at(-1)).toMatchObject({
        type: "run.failed",
        error: { code: "retry_exhausted" },
      });
    });
  });

  it("uses explicit step limits ahead of defaults and can succeed on its final allowed attempt", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = structuredClone(loop);
      const step = workflow.steps.work;
      if (!step) throw new Error("fixture missing");
      step.retry = { max: 2 };
      let calls = 0;
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async () => (++calls === 3 ? passed : failed),
      };
      const result = await new VeyraEngine().run({
        config: config(0),
        workflow,
        agents: { worker },
        goal: "repair",
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(calls).toBe(3);
    });
  });

  it("permits exactly three repair executions in the default dev loop", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const executor = new FakeAgent(passed);
      const workflow = await loadWorkflow("dev");
      const engine = new VeyraEngine({
        verifier: {
          verify: async ({ commands }) => ({
            success: false,
            durationMs: 1,
            results: [
              {
                command: commands[0] ?? "",
                success: false,
                exitCode: 1,
                stdout: "failure",
                stderr: "",
                durationMs: 1,
              },
            ],
          }),
        },
      });
      const result = await engine.run({
        config: config(3),
        workflow,
        agents: {
          planner: new FakeAgent(passed),
          executor,
          reviewer: new FakeAgent({ ...passed, outcome: "pass" }),
        },
        goal: "repair",
        cwd: path,
      });
      expect(result).toMatchObject({
        status: "failed",
        lastStep: "fix",
        error: { code: "retry_exhausted" },
      });
      expect(executor.calls.map((call) => call.stepId)).toEqual(["execute", "fix", "fix", "fix"]);
      const state = (
        await new LocalRunStore({ stateDir: join(path, ".veyra") }).loadRun(result.runId)
      ).state;
      expect(state.retryCounts).toMatchObject({ plan: 0, execute: 0, verify: 3, fix: 3 });
    });
  });

  it("bounds cycles even when agents keep reporting success", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = structuredClone(loop);
      workflow.steps.work = { type: "agent", agent: "worker", next: "work" };
      const worker = new FakeAgent(passed);
      const result = await new VeyraEngine().run({
        config: config(1),
        workflow,
        agents: { worker },
        goal: "cycle",
        cwd: path,
      });
      expect(result.error?.code).toBe("retry_exhausted");
      expect(worker.calls).toHaveLength(2);
    });
  });

  it("routes exhausted retries only to an explicitly configured human gate", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = structuredClone(loop);
      workflow.steps.work = {
        type: "agent",
        agent: "worker",
        on: { failure: "work", retry_exhausted: "gate" },
      };
      workflow.steps.gate = { type: "human", message: "Review the exhausted repair budget" };
      const result = await new VeyraEngine().run({
        config: config(0),
        workflow,
        agents: { worker: new FakeAgent(failed) },
        goal: "repair",
        cwd: path,
      });
      expect(result).toMatchObject({ status: "paused", lastStep: "gate" });
      await expect(
        new VeyraEngine().resume({ config: config(0), runId: result.runId, agents: {}, cwd: path }),
      ).rejects.toMatchObject({ code: "approval_required" });
    });
  });

  it("preserves retry counters and effective policy across process exit and repeated resume", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
      const source = `import { VeyraEngine } from ${JSON.stringify(moduleUrl)};
const worker = { id: 'worker', provider: 'fixture', run: async () => ({ status: 'needs_input', summary: 'Resolve fixture input', data: { note: 'saved evidence' } }) };
const result = await new VeyraEngine().run({ config: ${JSON.stringify(config(1))}, workflow: ${JSON.stringify(loop)}, agents: { worker }, goal: 'resume fixture', cwd: process.argv[1] });
console.log(result.runId);`;
      const writer = await runProcess({
        executable: process.execPath,
        args: ["--import", "tsx", "--input-type=module", "-e", source, path],
        timeoutMs: 30_000,
      });
      expect(writer.exitCode, writer.stderr).toBe(0);
      const runId = writer.stdout.trim();
      const calls: AgentInput[] = [];
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (input) => {
          calls.push(input);
          return { status: "needs_input", summary: "Still needs input" };
        },
      };
      const resumed = await new VeyraEngine().resume({
        config: config(999),
        agents: { worker },
        runId,
        cwd: path,
      });
      expect(resumed.status).toBe("paused");
      expect(calls[0]).toMatchObject({
        attempt: 2,
        context: { steps: { work: { data: { note: "saved evidence" } } } },
      });
      const stopped = await new VeyraEngine().resume({
        config: config(999),
        agents: { worker },
        runId,
        cwd: path,
      });
      expect(stopped.error?.code).toBe("retry_exhausted");
      expect(calls).toHaveLength(1);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      expect((await store.loadRun(runId)).state.retryCounts.work).toBe(1);
      expect((await store.loadRun(runId)).input.workflow.steps.work?.retry?.max).toBe(1);
      expect(
        (await store.readEvents(runId)).filter((event) => event.type === "run.resumed"),
      ).toHaveLength(2);
    });
  });

  it("completes a resumed agent without replaying previous successful steps", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = structuredClone(loop);
      workflow.start = "plan";
      workflow.steps.plan = { type: "agent", agent: "planner", next: "work" };
      const planner = new FakeAgent(passed);
      const paused = await new VeyraEngine().run({
        config: config(2),
        workflow,
        goal: "resume",
        agents: { planner, worker: new FakeAgent({ status: "needs_input", summary: "Waiting" }) },
        cwd: path,
      });
      const resumed = await new VeyraEngine().resume({
        config: config(2),
        runId: paused.runId,
        agents: { planner, worker: new FakeAgent(passed) },
        cwd: path,
      });
      expect(resumed.status).toBe("completed");
      expect(planner.calls).toHaveLength(1);
      await expect(
        new VeyraEngine().resume({ config: config(2), runId: paused.runId, agents: {}, cwd: path }),
      ).rejects.toMatchObject({ code: "run_not_paused" });
    });
  });
});
