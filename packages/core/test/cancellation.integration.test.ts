import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseConfig } from "@veyraoss/config";
import type { AgentAdapter, AgentResult } from "@veyraoss/protocol";
import { ProcessExecutionError } from "@veyraoss/runtime";
import { ShellVerifier, type Verifier } from "@veyraoss/verifier";
import type { WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, workflow: { use: "fixture" }, agents: {} });
const ok: AgentResult = { status: "success", summary: "Finished" };
const definition = (): WorkflowDefinition => ({
  version: 1,
  name: "cancellation",
  start: "work",
  steps: {
    work: { type: "agent", agent: "worker", next: "after" },
    after: { type: "agent", agent: "after" },
  },
});
const deferred = () => {
  let resolve = () => {};
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

describe("cancellation boundaries", { timeout: 30_000 }, () => {
  it.each(["agent", "verifier"])(
    "records user cancellation when the %s rejects on abort",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        const controller = new AbortController();
        const started = deferred();
        let drained = false;
        const aborting = async (signal?: AbortSignal): Promise<never> => {
          const aborted = deferred();
          signal?.addEventListener("abort", aborted.resolve, { once: true });
          started.resolve();
          await aborted.promise;
          await delay(15);
          drained = true;
          throw signal?.reason;
        };
        const worker: AgentAdapter = {
          id: "worker",
          provider: "fixture",
          run: (_input, options) => aborting(options?.signal),
        };
        const verifier: Verifier = { verify: (request) => aborting(request.signal) };
        const workflow = definition();
        if (kind === "verifier")
          workflow.steps.work = { type: "command", run: ["fixture"], next: "after" };
        const after = new FakeAgent(ok);
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const engine = new VeyraEngine({ store, verifier });
        const running = engine.run({
          config,
          workflow,
          cwd: path,
          goal: "Cancel active work",
          agents: { worker, after },
          signal: controller.signal,
        });
        await started.promise;
        controller.abort(new Error("Caller-private abort detail"));
        const result = await running;
        expect(result).toMatchObject({ status: "failed", error: { code: "run_cancelled" } });
        expect(drained).toBe(true);
        expect(after.calls).toHaveLength(0);
        const saved = await store.loadRun(result.runId);
        expect(saved.state.error).toEqual(result.error);
        expect(JSON.stringify(await store.readEvents(result.runId))).not.toContain(
          "Caller-private",
        );
        expect(
          await readFile(join(path, ".veyra", "runs", result.runId, "state.json"), "utf8"),
        ).not.toContain("Caller-private");
        await expect(
          engine.resume({ config, cwd: path, runId: result.runId, agents: { worker, after } }),
        ).rejects.toMatchObject({ code: "run_not_paused" });
        // Settled execution releases its workspace and run leases before the caller returns.
        expect(
          (
            await new VeyraEngine().run({
              config,
              workflow: {
                version: 1,
                name: "next",
                start: "done",
                steps: { done: { type: "end" } },
              },
              agents: {},
              cwd: path,
              goal: "Next run",
            })
          ).status,
        ).toBe("completed");
      });
    },
  );

  it.each(["run.started", "step.started", "approval.required", "step.completed"])(
    "honors cancellation observed at %s before committing a paused/completed run",
    async (boundary) => {
      await withFixtureWorkspace(async ({ path }) => {
        const controller = new AbortController();
        const workflow: WorkflowDefinition = {
          version: 1,
          name: "boundary",
          start: "work",
          steps: { work: boundary === "approval.required" ? { type: "human" } : { type: "end" } },
        };
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const run = await new VeyraEngine({
          store,
          emit: (event) => {
            if (event.type === boundary) controller.abort();
          },
        }).run({
          config,
          workflow,
          cwd: path,
          goal: "Cancel at boundary",
          agents: {},
          signal: controller.signal,
        });
        expect(run).toMatchObject({ status: "failed", error: { code: "run_cancelled" } });
        expect((await store.loadRun(run.runId)).state.error).toEqual(run.error);
        const events = await store.readEvents(run.runId);
        expect(
          events.some((event) => event.type === "run.completed" || event.type === "run.paused"),
        ).toBe(false);
        expect(events.at(-1)?.type).toBe("run.failed");
      });
    },
  );

  it("keeps a timeout that fired before user cancellation while an adapter drains", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const controller = new AbortController();
      const workflow = definition();
      workflow.steps.work = { type: "agent", agent: "worker", timeoutMs: 500, next: "after" };
      let drained = false;
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        async run(_input, options) {
          const aborted = deferred();
          options?.signal?.addEventListener("abort", aborted.resolve, { once: true });
          await aborted.promise;
          controller.abort();
          await delay(15);
          drained = true;
          throw new Error("Aborted invocation");
        },
      };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const after = new FakeAgent(ok);
      const run = await new VeyraEngine({ store }).run({
        config,
        workflow,
        cwd: path,
        goal: "Deadline ordering",
        agents: { worker, after },
        signal: controller.signal,
      });
      expect(run).toMatchObject({ status: "failed", error: { code: "step_timeout" } });
      expect((await store.loadRun(run.runId)).state.error).toEqual(run.error);
      expect(drained).toBe(true);
      expect(after.calls).toHaveLength(0);
    });
  });

  it("propagates a parent abort into parallel children inside a subworkflow and drains both", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const child: WorkflowDefinition = {
        version: 1,
        name: "child",
        start: "group",
        steps: {
          group: {
            type: "parallel",
            children: ["one", "two", "three"],
            concurrency: 2,
            next: "done",
          },
          one: { type: "agent", agent: "worker" },
          two: { type: "agent", agent: "worker" },
          three: { type: "agent", agent: "worker" },
          done: { type: "end" },
        },
      };
      const workflow: WorkflowDefinition = {
        version: 1,
        name: "parent",
        start: "child",
        steps: {
          child: {
            type: "subworkflow",
            workflow: child,
            on: { failure: "after", success: "after" },
          },
          after: { type: "agent", agent: "after" },
        },
      };
      const controller = new AbortController();
      const started = deferred();
      const calls: string[] = [];
      const drained: string[] = [];
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        async run(input, options) {
          calls.push(input.stepId);
          const aborted = deferred();
          options?.signal?.addEventListener("abort", aborted.resolve, { once: true });
          if (calls.length === 2) started.resolve();
          await aborted.promise;
          await delay(10);
          drained.push(input.stepId);
          throw new Error("AbortError");
        },
      };
      const after = new FakeAgent(ok);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const running = new VeyraEngine({ store }).run({
        config,
        workflow,
        cwd: path,
        goal: "Cancel nested group",
        agents: { worker, after },
        signal: controller.signal,
      });
      await started.promise;
      controller.abort();
      const run = await running;
      expect(run).toMatchObject({ status: "failed", error: { code: "run_cancelled" } });
      expect(calls.sort()).toEqual(["child/one", "child/two"]);
      expect(drained.sort()).toEqual(calls);
      expect(after.calls).toHaveLength(0);
      expect((await store.loadRun(run.runId)).state.error).toEqual(run.error);
      expect(
        (await store.readEvents(run.runId)).find((event) => event.type === "parallel.completed"),
      ).toMatchObject({
        results: [{ status: "cancelled" }, { status: "cancelled" }, { status: "skipped" }],
      });
    });
  });

  it.each(["agent", "verifier"])(
    "preserves a %s cleanup failure when cancellation is requested",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        const controller = new AbortController();
        const failedCleanup = () => {
          controller.abort();
          throw new ProcessExecutionError(
            "termination_failed",
            "Fixture process tree could not stop.",
          );
        };
        const worker: AgentAdapter = {
          id: "worker",
          provider: "fixture",
          run: async () => failedCleanup(),
        };
        const verifier: Verifier = { verify: async () => failedCleanup() };
        const workflow = definition();
        if (kind === "verifier")
          workflow.steps.work = { type: "command", run: ["fixture"], next: "after" };
        const after = new FakeAgent(ok);
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const run = await new VeyraEngine({ store, verifier }).run({
          config,
          workflow,
          cwd: path,
          goal: "Preserve cleanup failure",
          agents: { worker, after },
          signal: controller.signal,
        });
        expect(run).toMatchObject({
          status: "failed",
          error: { code: "process_termination_failed" },
        });
        expect((await store.loadRun(run.runId)).state.error).toEqual(run.error);
        expect(after.calls).toHaveLength(0);
      });
    },
  );

  it("preserves cleanup failure reported by the shell verifier after cancellation", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const controller = new AbortController();
      const verifier = new ShellVerifier({
        runProcess: async () => {
          controller.abort();
          throw new ProcessExecutionError(
            "termination_failed",
            "Fixture process tree could not stop.",
          );
        },
      });
      const workflow = definition();
      workflow.steps.work = { type: "command", run: ["fixture"], next: "after" };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const after = new FakeAgent(ok);
      const run = await new VeyraEngine({ store, verifier }).run({
        config,
        workflow,
        cwd: path,
        goal: "Retain cleanup evidence",
        agents: { after },
        signal: controller.signal,
      });
      expect(run).toMatchObject({
        status: "failed",
        error: { code: "process_termination_failed" },
      });
      expect((await store.loadRun(run.runId)).state.error).toEqual(run.error);
      expect(
        (await store.readEvents(run.runId)).find(
          (event) => event.type === "verification.completed",
        ),
      ).toMatchObject({
        success: false,
        results: [{ error: { code: "process_termination_failed" } }],
      });
      expect(after.calls).toHaveLength(0);
    });
  });

  it("rejects malformed terminal error metadata and redacts persisted reasons", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({
        stateDir: join(path, ".veyra"),
        redactValues: ["fixture-private-value"],
      });
      const run = await store.createRun({ goal: "Errors", workflow: definition(), cwd: path });
      for (const error of [
        null,
        { code: 1, message: "bad" },
        { code: "bad" },
        { code: "bad", message: "bad", retryable: "yes" },
      ])
        await expect(
          store.updateRun(run.state.runId, { status: "failed", error } as never),
        ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        store.updateRun(run.state.runId, {
          error: { code: "run_cancelled", message: "Cancelled" },
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      const saved = await store.updateRun(run.state.runId, {
        status: "failed",
        error: { code: "run_cancelled", message: "Cancelled fixture-private-value" },
      });
      expect(saved.error).toEqual({ code: "run_cancelled", message: "Cancelled [REDACTED]" });
    });
  });
});
