import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import type { AgentAdapter, AgentInput, AgentResult, VeyraEvent } from "@veyra/protocol";
import { runProcess, type ProcessResult } from "@veyra/runtime";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, StateStoreError, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "parallel" } });
const ok: AgentResult = { status: "success", summary: "Done" };
const failure: AgentResult = { status: "failure", summary: "Fixture failure" };
const workflow = (policy: "wait-all" | "fail-fast" = "wait-all"): WorkflowDefinition => ({
  name: "parallel",
  version: 1,
  start: "group",
  steps: {
    group: {
      type: "parallel",
      children: ["one", "two", "three"],
      concurrency: 2,
      failurePolicy: policy,
      next: "done",
    },
    one: { type: "agent", agent: "worker" },
    two: { type: "agent", agent: "worker" },
    three: { type: "agent", agent: "worker" },
    done: { type: "end" },
  },
});
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { timeout: 5000, interval: 10 });

describe("parallel scheduling and persistence", () => {
  it("overlaps independent children within the limit and joins outputs in declaration order", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.start = "plan";
      definition.steps.plan = { type: "agent", agent: "planner", next: "group" };
      definition.steps.group = { ...definition.steps.group, type: "parallel", next: "join" };
      definition.steps.join = {
        type: "agent",
        agent: "join",
        inputs: {
          results: { from: "group", path: "/results" },
          first: { from: "one", path: "/data/label" },
        },
      };
      const gates = new Map(["one", "two", "three"].map((id) => [id, deferred()]));
      const calls: AgentInput[] = [];
      const finished: string[] = [];
      let active = 0;
      let maximum = 0;
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (input) => {
          calls.push(structuredClone(input));
          maximum = Math.max(maximum, ++active);
          await gates.get(input.stepId)?.promise;
          finished.push(input.stepId);
          active--;
          return { ...ok, data: { label: input.stepId } };
        },
      };
      const joined = new FakeAgent({ status: "needs_input", summary: "Inspect joined evidence" });
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const running = new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { worker, planner: new FakeAgent(ok), join: joined },
        cwd: path,
        goal: "Run independent checks",
      });
      try {
        await waitFor(() => expect(calls.map((call) => call.stepId)).toEqual(["one", "two"]));
        expect((await store.loadRun(calls[0]?.runId as string)).state.currentStep).toBe("group");
        gates.get("two")?.release();
        await waitFor(() => expect(calls).toHaveLength(3));
        gates.get("three")?.release();
        await waitFor(() => expect(finished).toEqual(["two", "three"]));
        gates.get("one")?.release();
        const result = await running;
        expect(result.status).toBe("paused");
        expect(maximum).toBe(2);
        expect(active).toBe(0);
        for (const call of calls) {
          expect(Object.keys(call.context?.steps ?? {})).toEqual(["plan"]);
          expect(call).toMatchObject({ parentStepId: "group", attempt: 1 });
        }
        const records = await store.readEvents(result.runId);
        const completed = records.find((event) => event.type === "parallel.completed");
        expect(
          completed?.type === "parallel.completed" && completed.results.map((row) => row.stepId),
        ).toEqual(["one", "two", "three"]);
        expect(
          records
            .filter((event) => event.type === "parallel.child.completed")
            .map((event) => event.stepId),
        ).toEqual(["two", "three", "one"]);
        expect(joined.calls[0]?.context?.inputs).toEqual({
          results: completed?.type === "parallel.completed" ? completed.results : [],
          first: "one",
        });
        expect(Object.keys(joined.calls[0]?.context?.steps ?? {})).toEqual([
          "plan",
          "one",
          "two",
          "three",
          "group",
        ]);
        expect((await store.loadRun(result.runId)).state.retryCounts).toMatchObject({
          group: 0,
          one: 0,
          two: 0,
          three: 0,
        });
        expect(records.map((event) => event.sequence)).toEqual(
          records.map((_, index) => index + 1),
        );
        const resumedJoin = new FakeAgent(ok);
        expect(
          (
            await new VeyraEngine({ store }).resume({
              config,
              runId: result.runId,
              cwd: path,
              agents: { join: resumedJoin },
            })
          ).status,
        ).toBe("completed");
        expect(Object.keys(resumedJoin.calls[0]?.context?.steps ?? {})).toEqual([
          "plan",
          "one",
          "two",
          "three",
          "group",
          "join",
        ]);
        expect(resumedJoin.calls[0]?.context?.inputs).toEqual(joined.calls[0]?.context?.inputs);
      } finally {
        for (const gate of gates.values()) gate.release();
        await running;
      }
    });
  });

  it("runs real command children and keeps deterministic verifier evidence separate", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      for (const id of ["one", "two", "three"])
        definition.steps[id] = {
          type: "command",
          run: [`node -e "require('node:fs').writeFileSync('${id}.txt','${id}')"`],
        };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: {},
        cwd: path,
        goal: "Commands",
      });
      expect(result.status).toBe("completed");
      for (const id of ["one", "two", "three"])
        expect(await readFile(join(path, `${id}.txt`), "utf8")).toBe(id);
      const events = await store.readEvents(result.runId);
      expect(events.filter((event) => event.type === "verification.completed")).toHaveLength(3);
      expect(events.filter((event) => event.type === "agent.started")).toHaveLength(0);
      const combined = events.find((event) => event.type === "parallel.completed");
      expect(combined).toMatchObject({
        success: true,
        results: [
          { stepId: "one", status: "success" },
          { stepId: "two", status: "success" },
          { stepId: "three", status: "success" },
        ],
      });
      if (combined?.type !== "parallel.completed") throw new Error("Missing join");
      for (const row of combined.results)
        expect(events.find((event) => event.eventId === row.outputEventId)).toMatchObject({
          type: "verification.completed",
          stepId: row.stepId,
          parentStepId: "group",
        });
    });
  });

  it("waits for every child after failure and follows only the parent's explicit failure branch", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = {
        ...definition.steps.group,
        type: "parallel",
        on: { failure: "recover" },
      };
      definition.steps.recover = { type: "agent", agent: "recovery" };
      const calls: string[] = [];
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (input, options) => {
          expect(options?.signal?.aborted).toBe(false);
          calls.push(input.stepId);
          return input.stepId === "one" ? failure : ok;
        },
      };
      const recovery = new FakeAgent(ok);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { worker, recovery },
        cwd: path,
        goal: "Wait all",
      });
      expect(result.status).toBe("completed");
      expect(calls).toEqual(["one", "two", "three"]);
      expect(recovery.calls).toHaveLength(1);
      expect(
        (await store.readEvents(result.runId)).find((event) => event.type === "parallel.completed"),
      ).toMatchObject({
        success: false,
        results: [{ status: "failure" }, { status: "success" }, { status: "success" }],
      });
    });
  });

  it("fail-fast aborts an active peer, drains cleanup, and skips queued children", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const peerStarted = deferred();
      const releaseCleanup = deferred();
      const calls: string[] = [];
      let cancelled = false;
      let cleaned = false;
      let settled = false;
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (input, options) => {
          calls.push(input.stepId);
          if (input.stepId === "one") {
            await peerStarted.promise;
            return failure;
          }
          const aborted = new Promise<void>((resolve) =>
            options?.signal?.addEventListener(
              "abort",
              () => {
                cancelled = true;
                resolve();
              },
              { once: true },
            ),
          );
          peerStarted.release();
          await aborted;
          await releaseCleanup.promise;
          cleaned = true;
          return ok;
        },
      };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const running = new VeyraEngine({ store })
        .run({
          config,
          workflow: workflow("fail-fast"),
          agents: { worker },
          cwd: path,
          goal: "Cancel peers",
        })
        .finally(() => {
          settled = true;
        });
      try {
        await waitFor(() => expect(cancelled).toBe(true));
        expect(settled).toBe(false);
        releaseCleanup.release();
        const result = await running;
        expect(result).toMatchObject({
          status: "failed",
          error: { code: "unhandled_step_failure" },
        });
        expect(cleaned).toBe(true);
        expect(calls).toEqual(["one", "two"]);
        const events = await store.readEvents(result.runId);
        expect(events.find((event) => event.type === "parallel.completed")).toMatchObject({
          success: false,
          results: [{ status: "failure" }, { status: "cancelled" }, { status: "skipped" }],
        });
        expect(
          events.some((event) => event.type === "step.started" && event.stepId === "done"),
        ).toBe(false);
      } finally {
        releaseCleanup.release();
        await running;
      }
    });
  });

  it("propagates external cancellation into real subprocesses and waits for their exit", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const controller = new AbortController();
      const pids: number[] = [];
      const processes: ProcessResult[] = [];
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (_input, options) => {
          processes.push(
            await runProcess({
              executable: process.execPath,
              args: ["-e", "console.log(process.pid); setInterval(() => {}, 1000)"],
              cwd: options?.cwd,
              signal: options?.signal,
              timeoutMs: 5000,
              onStdout: (chunk) => {
                const pid = Number(chunk.trim());
                if (Number.isInteger(pid) && pid > 0) pids.push(pid);
              },
            }),
          );
          return ok;
        },
      };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const running = new VeyraEngine({ store }).run({
        config,
        workflow: workflow(),
        agents: { worker },
        cwd: path,
        goal: "Cancel run",
        signal: controller.signal,
      });
      try {
        await waitFor(() => expect(pids).toHaveLength(2));
        controller.abort();
        const result = await running;
        expect(result).toMatchObject({ status: "failed", error: { code: "run_cancelled" } });
        expect(processes).toHaveLength(2);
        expect(processes.every((item) => item.terminationReason === "cancelled")).toBe(true);
        for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
        expect(
          (await store.readEvents(result.runId)).find(
            (event) => event.type === "parallel.completed",
          ),
        ).toMatchObject({
          results: [{ status: "cancelled" }, { status: "cancelled" }, { status: "skipped" }],
        });
      } finally {
        controller.abort();
        await running;
      }
    });
  });

  it("resumes an unfinished group after process exit without rerunning successful children", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = { ...definition.steps.group, type: "parallel", concurrency: 1 };
      definition.steps.one = {
        type: "command",
        run: ["node -e \"require('node:fs').appendFileSync('once.txt','x')\""],
      };
      const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
      const source = `import { VeyraEngine } from ${JSON.stringify(moduleUrl)};
const worker = { id: 'worker', provider: 'fixture', run: async () => ({ status: 'needs_input', summary: 'Resolve input' }) };
const result = await new VeyraEngine().run({config:${JSON.stringify(config)},workflow:${JSON.stringify(definition)},agents:{worker},goal:'resume parallel',cwd:process.argv[1]});
console.log(JSON.stringify(result));`;
      const child = await runProcess({
        executable: process.execPath,
        args: ["--import", "tsx", "--input-type=module", "-e", source, path],
        timeoutMs: 30_000,
      });
      expect(child.exitCode, child.stderr).toBe(0);
      const paused = JSON.parse(child.stdout);
      expect(paused.status).toBe("paused");
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const initial = await store.readEvents(paused.runId);
      expect(initial.find((event) => event.type === "parallel.paused")).toMatchObject({
        results: [{ status: "success" }, { status: "needs_input" }, { status: "pending" }],
      });
      const worker = new FakeAgent(ok);
      const result = await new VeyraEngine({ store }).resume({
        config,
        runId: paused.runId,
        agents: { worker },
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(await readFile(join(path, "once.txt"), "utf8")).toBe("x");
      expect(worker.calls.map((call) => [call.stepId, call.attempt])).toEqual([
        ["two", 2],
        ["three", 1],
      ]);
      for (const call of worker.calls) expect(call.context?.steps).toEqual({});
      const events = await store.readEvents(paused.runId);
      expect(
        events.filter((event) => event.type === "step.started" && event.stepId === "group"),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "parallel.started")).toHaveLength(1);
      expect((await store.loadRun(paused.runId)).state.retryCounts).toMatchObject({
        group: 0,
        one: 0,
        two: 1,
        three: 0,
      });
    });
  });

  it("enforces saved child retry limits across resume", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = { type: "parallel", children: ["one"], retry: { max: 10 } };
      definition.steps.one = { type: "agent", agent: "worker", retry: { max: 0 } };
      const worker = new FakeAgent({ status: "needs_input", summary: "Waiting" });
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const paused = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { worker },
        cwd: path,
        goal: "Retry",
      });
      expect(paused.status).toBe("paused");
      const result = await new VeyraEngine({ store }).resume({
        config,
        runId: paused.runId,
        agents: { worker },
        cwd: path,
      });
      expect(result.status).toBe("failed");
      expect(worker.calls).toHaveLength(1);
      expect(
        (await store.readEvents(paused.runId)).find((event) => event.type === "parallel.completed"),
      ).toMatchObject({
        success: false,
        results: [{ stepId: "one", status: "failure", error: { code: "retry_exhausted" } }],
      });
    });
  });

  it.each(["event-subscriber", "state-store"])(
    "aborts and drains peers when the %s fails",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        const ready = deferred();
        let cleaned = false;
        const worker: AgentAdapter = {
          id: "worker",
          provider: "fixture",
          run: async (input, options) => {
            if (input.stepId === "one") {
              await ready.promise;
              return ok;
            }
            const aborted = new Promise<void>((resolve) =>
              options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
            );
            ready.release();
            await aborted;
            cleaned = true;
            return ok;
          },
        };
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const storageFailure = new StateStoreError("io_error", ".veyra", "Fixture write failure");
        if (scenario === "state-store") {
          const append = store.appendEvent.bind(store);
          vi.spyOn(store, "appendEvent").mockImplementation(async (runId, event) => {
            if (event.type === "agent.completed" && event.stepId === "one") throw storageFailure;
            return append(runId, event);
          });
        }
        const emit = (event: VeyraEvent) => {
          if (
            scenario === "event-subscriber" &&
            event.type === "agent.completed" &&
            event.stepId === "one"
          )
            throw new Error("Fixture observer failure");
        };
        const running = new VeyraEngine({ store, emit }).run({
          config,
          workflow: workflow(),
          agents: { worker },
          cwd: path,
          goal: "Persistence failure",
        });
        if (scenario === "state-store") await expect(running).rejects.toBe(storageFailure);
        else
          expect(await running).toMatchObject({
            status: "failed",
            error: { code: "event_sink_failed" },
          });
        expect(cleaned).toBe(true);
      });
    },
  );
});
