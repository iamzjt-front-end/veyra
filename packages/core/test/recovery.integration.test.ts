import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { AgentAdapter, VeyraEvent } from "@veyraoss/protocol";
import { currentProcessOwner, runProcess } from "@veyraoss/runtime";
import type { WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } });
const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
const workflow: WorkflowDefinition = {
  version: 1,
  name: "crash",
  start: "work",
  steps: {
    work: { type: "agent", agent: "worker", next: "next" },
    next: { type: "end" },
  },
};

async function killedRun(path: string, definition = workflow, boundary = "step.completed") {
  const source = `import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { VeyraEngine, LocalRunStore } from ${JSON.stringify(moduleUrl)};
const cwd = process.argv[1];
const crash = id => { writeFileSync(join(cwd, 'run-id.txt'), id); process.kill(process.pid, 'SIGKILL'); };
class Store extends LocalRunStore {
  async updateRun(id, update) {
    const state = await super.updateRun(id, update);
    if (${JSON.stringify(boundary)} === 'transition' && update.currentStep === 'next') crash(id);
    return state;
  }
}
const worker = {id:'worker',provider:'fixture',run:async () => {
  appendFileSync(join(cwd,'mutations.txt'),'x');
  return {status:'success',summary:'One persisted mutation'};
}};
await new VeyraEngine({store:new Store({stateDir:join(cwd,'.veyra')}),emit:event=>{
  if (event.type === ${JSON.stringify(boundary)} && (!('stepId' in event) || event.stepId === 'work')) crash(event.runId);
}}).run({config:${JSON.stringify(config)},workflow:${JSON.stringify(definition)},cwd,goal:'Crash fixture',agents:{worker}});`;
  const child = await runProcess({
    executable: process.execPath,
    args: ["--import", "tsx", "--input-type=module", "-e", source, path],
    timeoutMs: 30_000,
  });
  expect(child.signal, child.stderr).toBe("SIGKILL");
  return (await readFile(join(path, "run-id.txt"), "utf8")).trim();
}

describe.skipIf(process.platform === "win32")("process-death recovery", () => {
  it.each(["agent", "command", "end"] as const)(
    "finalizes a completed terminal %s attempt without repeating it",
    async (type) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition: WorkflowDefinition = {
          ...workflow,
          steps: {
            work:
              type === "agent"
                ? { type, agent: "worker" }
                : type === "end"
                  ? { type }
                  : {
                      type,
                      run: ["node -e \"require('node:fs').appendFileSync('mutations.txt','x')\""],
                    },
          },
        };
        const runId = await killedRun(path, definition);
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const before = await store.loadRun(runId);
        const events = await store.readEvents(runId);
        const engine = new VeyraEngine({ store });
        const request = { config, runId, cwd: path };
        const inspection = await engine.inspectRun(request);
        expect(inspection).toMatchObject({
          status: "interrupted",
          storedStatus: "running",
          ownerStatus: "dead",
          recovery: { allowed: true, checkpoint: { terminal: true, stepId: "work", attempt: 1 } },
        });
        expect(inspection.recovery.checkpoint?.attemptId).toBe(
          (events.at(-1) as { attemptId: string }).attemptId,
        );
        expect(
          (await engine.resume({ ...request, recoverInterrupted: true, agents: {} })).status,
        ).toBe("completed");
        const saved = await store.loadRun(runId);
        expect(saved.input).toEqual(before.input);
        expect(saved.state.retryCounts).toEqual(before.state.retryCounts);
        const after = await store.readEvents(runId);
        expect(after.filter((event) => event.type === "step.started")).toHaveLength(1);
        expect(after.at(-1)).toMatchObject({
          type: "run.completed",
          recovery: inspection.recovery.checkpoint?.boundary,
        });
        expect((await engine.inspectRun(request)).status).toBe("completed");
        await expect(
          engine.resume({ ...request, recoverInterrupted: true, agents: {} }),
        ).rejects.toMatchObject({ code: "run_not_paused" });
        if (type !== "end") expect(await readFile(join(path, "mutations.txt"), "utf8")).toBe("x");
      });
    },
    30_000,
  );

  it.each(["run.started", "transition"])(
    "recovers at %s without resetting attempts or repeating work",
    async (boundary) => {
      await withFixtureWorkspace(async ({ path }) => {
        const runId = await killedRun(path, workflow, boundary);
        let calls = 0;
        const worker: AgentAdapter = {
          id: "worker",
          provider: "fixture",
          async run() {
            calls++;
            await appendFile(join(path, "mutations.txt"), "x");
            return { status: "success", summary: "Continue" };
          },
        };
        const engine = new VeyraEngine();
        expect(
          (
            await engine.resume({
              config,
              runId,
              cwd: path,
              agents: { worker },
              recoverInterrupted: true,
            })
          ).status,
        ).toBe("completed");
        expect(calls).toBe(boundary === "run.started" ? 1 : 0);
        expect(await readFile(join(path, "mutations.txt"), "utf8")).toBe("x");
      });
    },
    30_000,
  );

  it.each(["step.started", "agent.completed"])(
    "refuses uncertain effects at %s even when the owner is dead",
    async (boundary) => {
      await withFixtureWorkspace(async ({ path }) => {
        const runId = await killedRun(path, workflow, boundary);
        const engine = new VeyraEngine();
        const request = { config, runId, cwd: path };
        expect(await engine.inspectRun(request)).toMatchObject({
          status: "interrupted",
          recovery: { allowed: false },
        });
        await expect(
          engine.resume({ ...request, agents: {}, recoverInterrupted: true }),
        ).rejects.toMatchObject({ code: "interrupted_attempt" });
        if (boundary === "agent.completed")
          expect(await readFile(join(path, "mutations.txt"), "utf8")).toBe("x");
        else
          await expect(readFile(join(path, "mutations.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
      });
    },
    30_000,
  );

  it.each([false, true])(
    "reconciles a crash during recovery itself (terminal=%s)",
    async (terminal) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition = terminal
          ? { ...workflow, steps: { work: { type: "agent" as const, agent: "worker" } } }
          : workflow;
        const runId = await killedRun(path, definition);
        const source = `import { join } from 'node:path';
import { VeyraEngine, LocalRunStore } from ${JSON.stringify(moduleUrl)};
class Store extends LocalRunStore { async appendEvent(id,event) {
  const saved = await super.appendEvent(id,event);
  if (event.recovery) process.kill(process.pid,'SIGKILL');
  return saved;
} }
await new VeyraEngine({store:new Store({stateDir:join(process.argv[1],'.veyra')})}).resume({config:${JSON.stringify(config)},runId:${JSON.stringify(runId)},cwd:process.argv[1],agents:{},recoverInterrupted:true});`;
        const child = await runProcess({
          executable: process.execPath,
          args: ["--import", "tsx", "--input-type=module", "-e", source, path],
          timeoutMs: 30_000,
        });
        expect(child.signal, child.stderr).toBe("SIGKILL");
        const engine = new VeyraEngine();
        expect(
          (await engine.resume({ config, runId, cwd: path, agents: {}, recoverInterrupted: true }))
            .status,
        ).toBe("completed");
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const events = await store.readEvents(runId);
        expect(
          events.filter(
            (event) =>
              (event.type === "run.completed" || event.type === "run.paused") && event.recovery,
          ),
        ).toHaveLength(1);
        expect(await readFile(join(path, "mutations.txt"), "utf8")).toBe("x");
      });
    },
    30_000,
  );

  it("preserves a torn event tail and refuses automatic repair or replay", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const runId = await killedRun(path);
      const file = join(path, ".veyra", "runs", runId, "events.jsonl");
      await appendFile(file, '{"type":');
      const before = await readFile(file, "utf8");
      await expect(
        new VeyraEngine().resume({
          config,
          runId,
          cwd: path,
          agents: {},
          recoverInterrupted: true,
        }),
      ).rejects.toMatchObject({ code: "corrupt_state" });
      expect(await readFile(file, "utf8")).toBe(before);
      expect(await readFile(join(path, "mutations.txt"), "utf8")).toBe("x");
    });
  }, 30_000);

  it.each([
    "mismatched-id",
    "missing-start",
    "duplicate-start",
    "unsettled-peer",
    "invalid-recovery-ref",
  ])(
    "refuses an unproven boundary: %s",
    async (fault) => {
      await withFixtureWorkspace(async ({ path }) => {
        const runId = await killedRun(path);
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const events = await store.readEvents(runId);
        const tail = events.at(-1);
        if (tail?.type !== "step.completed") throw new Error("Missing completion");
        const index = events.findIndex(
          (event) => event.type === "step.started" && event.attemptId === tail.attemptId,
        );
        if (fault === "mismatched-id") tail.attemptId = "mismatched-attempt";
        if (fault === "missing-start") events.splice(index, 1);
        if (fault === "duplicate-start")
          events.splice(index, 0, { ...events[index], eventId: "duplicate-start" } as VeyraEvent);
        if (fault === "unsettled-peer")
          events.splice(events.length - 1, 0, {
            type: "step.started",
            runId,
            stepId: "next",
            attemptId: "unsettled-peer",
            attempt: 1,
            at: tail.at,
            eventId: "unsettled-peer",
          });
        if (fault === "invalid-recovery-ref")
          events.push({
            type: "run.paused",
            runId,
            stepId: "next",
            at: tail.at,
            eventId: "bad-reference",
            reason: "recovered_completed_checkpoint",
            recovery: { eventId: "wrong-boundary", sequence: 1 },
          });
        for (const [index, event] of events.entries()) event.sequence = index + 1;
        await writeFile(
          join(store.directory, "runs", runId, "events.jsonl"),
          `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
        );
        await expect(
          new VeyraEngine({ store }).resume({
            config,
            runId,
            agents: {},
            recoverInterrupted: true,
          }),
        ).rejects.toMatchObject({ code: "interrupted_attempt" });
      });
    },
    30_000,
  );
});

describe("recovery ownership requirements", () => {
  it("reports live ownership and refuses recovery while execution is still active", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      let signal = (_id: string) => {};
      const started = new Promise<string>((resolve) => {
        signal = resolve;
      });
      let release = () => {};
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const engine = new VeyraEngine({
        emit: async (event) => {
          if (event.type === "step.completed" && event.stepId === "work") {
            signal(event.runId);
            await wait;
          }
        },
      });
      const running = engine.run({
        config,
        workflow,
        cwd: path,
        goal: "Active fixture",
        agents: {
          worker: {
            id: "worker",
            provider: "fixture",
            run: async () => ({ status: "success", summary: "Completed work" }),
          },
        },
      });
      const runId = await started;
      try {
        const request = { config, runId, cwd: path };
        expect(await engine.inspectRun(request)).toMatchObject({
          status: "running",
          ownerStatus: "alive",
          recovery: { allowed: false },
        });
        await expect(
          new VeyraEngine().resume({ ...request, agents: {}, recoverInterrupted: true }),
        ).rejects.toMatchObject({ code: "run_still_running" });
      } finally {
        release();
        await running;
      }
    });
  });

  it.each(["legacy", "foreign"])(
    "keeps a %s owner's liveness unknown without changing state",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const run = await store.createRun({ goal: "Unknown owner", workflow, cwd: path });
        if (kind === "foreign")
          await store.updateRun(run.state.runId, {
            owner: { ...currentProcessOwner(), host: "fixture-other-host" },
          });
        await store.appendEvent(run.state.runId, {
          type: "run.started",
          runId: run.state.runId,
          goal: "Unknown owner",
          at: new Date().toISOString(),
        });
        const before = await store.loadRun(run.state.runId);
        const engine = new VeyraEngine({ store });
        const request = { config, runId: run.state.runId, cwd: path };
        expect(await engine.inspectRun(request)).toMatchObject({
          status: "unknown",
          storedStatus: "running",
          recovery: { allowed: false },
        });
        await expect(
          engine.resume({ ...request, agents: {}, recoverInterrupted: true }),
        ).rejects.toMatchObject({ code: "owner_unknown" });
        expect(await store.loadRun(run.state.runId)).toEqual(before);
      });
    },
  );
});
