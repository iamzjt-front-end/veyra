import { readFile, writeFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseConfig } from "@veyra/config";
import type { AgentAdapter } from "@veyra/protocol";
import { runProcess } from "@veyra/runtime";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { initializeGit } from "../../../test/helpers/git.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, workflow: { use: "fixture" }, agents: {} });
const workflow: WorkflowDefinition = {
  version: 1,
  name: "locking",
  start: "work",
  steps: { work: { type: "agent", agent: "worker" } },
};
const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
const processRequest = (source: string, cwd: string) => ({
  executable: process.execPath,
  args: ["--import", "tsx", "--input-type=module", "-e", source, cwd],
  timeoutMs: 30_000,
});

describe("coordinated local state and run controls", { timeout: 30_000 }, () => {
  it("serializes independent writer processes without duplicate event sequences or lost revisions", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await store.createRun({ goal: "Concurrent fixture", workflow, cwd: path });
      const source = `import {LocalRunStore} from ${JSON.stringify(moduleUrl)};
import {join} from 'node:path';
const store=new LocalRunStore({stateDir:join(process.argv[1],'.veyra')});
for(let index=0;index<10;index++) {
  await store.appendEvent(${JSON.stringify(run.state.runId)},{type:'run.resumed',runId:${JSON.stringify(run.state.runId)},stepId:'work',at:new Date().toISOString()});
  await store.updateRun(${JSON.stringify(run.state.runId)},{lastOutcome:String(index)});
}`;
      const writers = await Promise.all(
        Array.from({ length: 4 }, () => runProcess(processRequest(source, path))),
      );
      for (const writer of writers) expect(writer.exitCode, writer.stderr).toBe(0);
      const events = await store.readEvents(run.state.runId);
      expect(events.map((event) => event.sequence)).toEqual(
        Array.from({ length: 40 }, (_, index) => index + 1),
      );
      expect(new Set(events.map((event) => event.eventId)).size).toBe(40);
      expect((await store.loadRun(run.state.runId)).state.revision).toBe(41);
    });
  });

  it("waits for an in-progress append instead of interpreting its partial line as corrupt history", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await store.createRun({ goal: "Concurrent reader", workflow, cwd: path });
      const source = `import fs from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const root=process.argv[1], originalOpen=fs.promises.open;
fs.promises.open=async (path,flags,...rest)=>{
  const handle=await originalOpen(path,flags,...rest);
  if(String(path).endsWith('events.jsonl') && flags==='a') {
    const write=handle.writeFile.bind(handle);
    handle.writeFile=async data=>{
      const mid=Math.floor(data.length/2);
      await write(data.slice(0,mid),'utf8');
      console.log('partial');
      while(!fs.existsSync(join(root,'release'))) await delay(5);
      await write(data.slice(mid),'utf8');
    };
  }
  return handle;
};
syncBuiltinESMExports();
const {LocalRunStore}=await import(${JSON.stringify(moduleUrl)});
await new LocalRunStore({stateDir:join(root,'.veyra')}).appendEvent(${JSON.stringify(run.state.runId)},{type:'run.resumed',runId:${JSON.stringify(run.state.runId)},stepId:'work',at:new Date().toISOString()});`;
      let ready = () => {};
      const partial = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let output = "";
      const writer = runProcess({
        ...processRequest(source, path),
        onStdout: (chunk) => {
          output += chunk;
          if (output.includes("partial")) ready();
        },
      });
      await partial;
      let settled = false;
      const reading = store.readEvents(run.state.runId).finally(() => {
        settled = true;
      });
      try {
        await delay(25);
        expect(settled).toBe(false);
      } finally {
        await writeFile(join(path, "release"), "go");
      }
      expect(await reading).toHaveLength(1);
      const result = await writer;
      expect(result.exitCode, result.stderr).toBe(0);
    });
  });

  it("rejects a resume captured before another invocation reached a new pause", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      let calls = 0;
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        async run() {
          calls++;
          return { status: "needs_input", summary: "Inspect this attempt" };
        },
      };
      const first = new VeyraEngine();
      const run = await first.run({
        config,
        workflow,
        cwd: path,
        goal: "Resume race",
        agents: { worker },
      });
      let arrived = () => {};
      let release = () => {};
      const waiting = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      class DelayedStore extends LocalRunStore {
        override async withRunLock<T>(
          id: string,
          action: () => Promise<T>,
          recover = false,
        ): Promise<T> {
          arrived();
          await gate;
          return super.withRunLock(id, action, recover);
        }
      }
      const second = new VeyraEngine({
        store: new DelayedStore({ stateDir: join(path, ".veyra") }),
      });
      const request = { config, runId: run.runId, cwd: path, agents: { worker } };
      const stale = second.resume(request);
      await waiting;
      try {
        expect((await first.resume(request)).status).toBe("paused");
      } finally {
        release();
      }
      await expect(stale).rejects.toMatchObject({ code: "stale_resume" });
      expect(calls).toBe(2);
    });
  });

  it("allows two isolated runs to execute concurrently while their shared state store stays readable", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeGit(path);
      const isolated = {
        ...config,
        runtime: { ...config.runtime, workspace: { mode: "worktree" as const } },
      };
      let release = () => {};
      const finish = new Promise<void>((resolve) => {
        release = resolve;
      });
      const directories: string[] = [];
      const start = async (label: string) => {
        let ready = () => {};
        const started = new Promise<void>((resolve) => {
          ready = resolve;
        });
        const result = new VeyraEngine().run({
          config: isolated,
          workflow,
          cwd: path,
          goal: label,
          agents: {
            worker: {
              id: "worker",
              provider: "fixture",
              async run(_input, controls) {
                const cwd = controls?.cwd as string;
                directories.push(cwd);
                await writeFile(join(cwd, "marker.txt"), label);
                ready();
                await finish;
                return { status: "success", summary: label };
              },
            },
          },
        });
        await started;
        return { result };
      };
      const first = await start("first");
      let second: Awaited<ReturnType<typeof start>> | undefined;
      try {
        second = await start("second");
        expect(new Set(directories).size).toBe(2);
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const states = await store.listRuns();
        expect(states.map((state) => state.status)).toEqual(["running", "running"]);
        expect(
          await Promise.all(directories.map((cwd) => readFile(join(cwd, "marker.txt"), "utf8"))),
        ).toEqual(["first", "second"]);
        await expect(readFile(join(path, "marker.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        release();
        await Promise.all([first.result, second?.result]);
      }
    });
  });

  it("records only one approval when independent processes submit the same nonce", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition: WorkflowDefinition = {
        version: 1,
        name: "approval",
        start: "gate",
        steps: { gate: { type: "human", on: { approved: "done" } }, done: { type: "end" } },
      };
      const engine = new VeyraEngine();
      const run = await engine.run({
        config,
        workflow: definition,
        cwd: path,
        goal: "Decide once",
        agents: {},
      });
      const request = { config, runId: run.runId, cwd: path };
      const approval = await engine.getPendingApproval(request);
      const source = `import {VeyraEngine} from ${JSON.stringify(moduleUrl)};
try { await new VeyraEngine().resolveApproval(${JSON.stringify({ ...request, approvalId: approval?.approvalId, decision: "approved" })}); console.log('resolved'); }
catch(error) { console.log(error.code); }`;
      const attempts = await Promise.all(
        Array.from({ length: 2 }, () => runProcess(processRequest(source, path))),
      );
      for (const result of attempts) expect(result.exitCode, result.stderr).toBe(0);
      expect(attempts.filter((result) => result.stdout.trim() === "resolved")).toHaveLength(1);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      expect(
        (await store.readEvents(run.runId)).filter((event) => event.type === "approval.resolved"),
      ).toHaveLength(1);
      expect((await engine.resume({ ...request, agents: {} })).status).toBe("completed");
    });
  });

  it.skipIf(process.platform === "win32")(
    "requires explicit stale-lease recovery for approval and preserves the gate decision",
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition: WorkflowDefinition = {
          version: 1,
          name: "gate",
          start: "gate",
          steps: { gate: { type: "human", on: { approved: "done" } }, done: { type: "end" } },
        };
        const source = `import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
import {VeyraEngine} from ${JSON.stringify(moduleUrl)};
await new VeyraEngine({emit:event=>{if(event.type==='run.paused'){writeFileSync(join(process.argv[1],'id'),event.runId);process.kill(process.pid,'SIGKILL');}}}).run({config:${JSON.stringify(config)},workflow:${JSON.stringify(definition)},cwd:process.argv[1],goal:'Pause crash',agents:{}});`;
        const child = await runProcess(processRequest(source, path));
        expect(child.signal, child.stderr).toBe("SIGKILL");
        const runId = await readFile(join(path, "id"), "utf8");
        const engine = new VeyraEngine();
        const request = { config, runId, cwd: path };
        const approval = await engine.getPendingApproval(request);
        const decision = {
          ...request,
          approvalId: approval?.approvalId as string,
          decision: "approved" as const,
        };
        await expect(engine.resolveApproval(decision)).rejects.toMatchObject({ code: "lock_busy" });
        expect(
          (await engine.resolveApproval({ ...decision, recoverInterrupted: true })).status,
        ).toBe("paused");
        expect(
          (await engine.resume({ ...request, agents: {}, recoverInterrupted: true })).status,
        ).toBe("completed");
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "reclaims a dead terminal run's leases only for explicit clean-worktree removal",
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        await initializeGit(path);
        const isolated = {
          ...config,
          runtime: { ...config.runtime, workspace: { mode: "worktree" as const } },
        };
        const definition: WorkflowDefinition = {
          version: 1,
          name: "terminal",
          start: "done",
          steps: { done: { type: "end" } },
        };
        const source = `import {writeFileSync} from 'node:fs'; import {join} from 'node:path';
import {VeyraEngine} from ${JSON.stringify(moduleUrl)};
await new VeyraEngine({emit:event=>{if(event.type==='run.completed'){writeFileSync(join(process.argv[1],'id'),event.runId);process.kill(process.pid,'SIGKILL');}}}).run({config:${JSON.stringify(isolated)},workflow:${JSON.stringify(definition)},cwd:process.argv[1],goal:'Terminal crash',agents:{}});`;
        const child = await runProcess(processRequest(source, path));
        expect(child.signal, child.stderr).toBe("SIGKILL");
        const runId = await readFile(join(path, "id"), "utf8");
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const saved = await store.loadRun(runId);
        const engine = new VeyraEngine({ store });
        const request = { config: isolated, runId, cwd: path };
        await expect(engine.removeWorkspace(request)).rejects.toMatchObject({ code: "lock_busy" });
        expect(
          await engine.removeWorkspace({ ...request, recoverInterrupted: true }),
        ).toMatchObject({ removed: true });
        await expect(stat(saved.input.cwd)).rejects.toMatchObject({ code: "ENOENT" });
        expect((await store.loadRun(runId)).state.status).toBe("completed");
      });
    },
  );
});
