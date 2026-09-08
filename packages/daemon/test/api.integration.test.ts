import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { describe, expect, it, vi } from "vitest";
import { LocalRunStore } from "@veyraoss/core";
import {
  initializeProject,
  ProjectStateStore,
  ProjectHandoffStore,
  projectPaths,
} from "@veyraoss/project";
import type { ProjectDescriptor, ProjectId } from "@veyraoss/protocol";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { DaemonClient, startDaemon, stopDaemon, type ExecutionSetup } from "../src/index.js";

const exec = promisify(execFile);
const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
const configUrl = new URL("../../config/dist/index.js", import.meta.url).href;
const { parseConfig } = (await import(configUrl)) as typeof import("../../config/src/index.js");
function handoff(project: ProjectDescriptor) {
  const fixture = fixtureProjectState(project.id);
  if (!fixture.handoff) throw new Error("Missing fixture handoff");
  return { ...fixture.handoff, id: randomUUID(), runId: randomUUID() };
}
function setup(run: ExecutionSetup["agents"][string]["run"]): ExecutionSetup {
  return {
    config: parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } }),
    workflow: {
      version: 1,
      name: "fixture",
      start: "execute",
      steps: { execute: { type: "agent", agent: "executor" } },
    },
    agents: { executor: { id: "fixture", provider: "fake", run } },
  };
}

describe("local daemon tool API", { timeout: 30000 }, () => {
  it("does not start new execution when shutdown races with intent persistence", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const registryRoot = join(path, "registry");
      const execute = vi.fn(async () => ({ status: "success" as const, summary: "Unexpected" }));
      let entered = () => {};
      let release = () => {};
      const saving = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = ProjectStateStore.prototype.save;
      const spy = vi.spyOn(ProjectStateStore.prototype, "save").mockImplementation(async function (
        this: ProjectStateStore,
        update,
        revision,
      ) {
        entered();
        await gate;
        return original.call(this, update, revision);
      });
      const daemon = await startDaemon({ registryRoot, resolveExecution: () => setup(execute) });
      try {
        const api = new DaemonClient({ registryRoot });
        await api.call("projects.register", { path });
        const dispatch = api.call("runs.dispatch", {
          projectId: project.id,
          handoff: handoff(project),
        });
        const rejected = expect(dispatch).rejects.toMatchObject({ code: "daemon_unavailable" });
        await saving;
        const stopping = daemon.stop();
        release();
        await stopping;
        await rejected;
        expect(execute).not.toHaveBeenCalled();
        expect((await new ProjectStateStore({ project }).read())?.handoff).toBeDefined();
      } finally {
        release();
        spy.mockRestore();
        await daemon.stop();
      }
    });
  });

  it("lets another process register/open, dispatch, wait and fetch real verifier evidence without a provider", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const registryRoot = join(path, "registry");
      const requested = handoff(project);
      const env = { ...process.env };
      delete env.OPENAI_API_KEY;
      const script = `
        import {readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path';
        const {startDaemon}=await import(${JSON.stringify(moduleUrl)});
        const {parseConfig}=await import(${JSON.stringify(configUrl)});
        const daemon=await startDaemon({registryRoot:process.argv[1],env:process.env,resolveExecution:project=>({
          config:parseConfig({version:1,agents:{},workflow:{use:'fixture'}}),
          workflow:{version:1,name:'fixture',start:'execute',steps:{
            execute:{type:'agent',agent:'executor',next:'verify'},
            verify:{type:'command',run:[process.execPath+' -e '+JSON.stringify("if(require('node:fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)")],next:'done'},
            done:{type:'end'}
          }},
          agents:{executor:{id:'fixture',provider:'fake',async run(input,options){
            if(options.cwd!==project.root || !input.goal.includes(project.id))throw new Error('Missing Project context');
            await writeFile(join(options.cwd,'answer.txt'),'42');
            return {status:'success',summary:'Wrote answer.txt',data:{changedFiles:['answer.txt']},session:{version:1,kind:'session',provider:'fake',id:'81f7c8ab-8725-46bb-8f48-a420c3870a79',projectId:project.id,runId:input.runId,createdAt:new Date().toISOString()}};
          }}}
        })});
        process.on('SIGTERM',()=>void daemon.stop());
        process.stdout.write('ready\\n'); await daemon.closed;`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, registryRoot], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      const exited = once(child, "exit");
      let diagnostics = "";
      child.stderr.on("data", (chunk) => {
        diagnostics = `${diagnostics}${chunk}`.slice(-8192);
      });
      try {
        await Promise.race([
          once(child.stdout, "data", { signal: AbortSignal.timeout(10000) }),
          exited.then(() => {
            throw new Error(`Daemon exited before readiness: ${diagnostics}`);
          }),
        ]);
        const client = await exec(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `
          const {DaemonClient}=await import(${JSON.stringify(moduleUrl)});
          const client=new DaemonClient({registryRoot:process.argv[1]});
          const handoff=JSON.parse(process.argv[3]); const locator={projectId:handoff.projectId,runId:handoff.runId};
          const registered=await client.call('projects.register',{path:process.argv[2]});
          const opened=await client.call('projects.get',{projectId:handoff.projectId});
          const listed=await client.call('projects.list',undefined);
          const accepted=await client.call('runs.dispatch',{projectId:handoff.projectId,handoff});
          const final=await client.call('runs.wait',{...locator,waitMs:20000});
          const result=await client.call('results.get',locator);
          const saved=await client.call('handoffs.get',locator);
          console.log(JSON.stringify({registered,opened,listed,accepted,final,result,saved}));
        `,
            registryRoot,
            path,
            JSON.stringify(requested),
          ],
          { timeout: 25000, env },
        );
        const response = JSON.parse(client.stdout);
        expect(response.registered).toEqual({ project, status: "available" });
        expect(response.opened).toEqual(response.registered);
        expect(response.listed).toEqual([response.registered]);
        expect(response.accepted.runId).toBe(requested.runId);
        expect(response.final).toMatchObject({
          status: "completed",
          projectId: project.id,
          runId: requested.runId,
        });
        expect(response.result).toMatchObject({
          status: "completed",
          changedFiles: ["answer.txt"],
          handoffId: requested.id,
          summary: "Wrote answer.txt",
        });
        expect(response.saved).toEqual(requested);
        expect(await readFile(join(path, "answer.txt"), "utf8")).toBe("42");
        const events = await new LocalRunStore({
          stateDir: projectPaths(project).directory,
        }).readEvents(requested.runId);
        for (const ref of response.result.evidence) {
          const event = events.find((event) => event.eventId === ref.eventId);
          expect(event?.sequence).toBe(ref.sequence);
          expect(event?.runId).toBe(requested.runId);
        }
        expect(response.result.evidence.map((ref: { source: string }) => ref.source)).toEqual([
          "agent",
          "verifier",
        ]);
        expect(events.find((event) => event.type === "verification.completed")).toMatchObject({
          success: true,
          results: [{ exitCode: 0 }],
        });
        expect((await new ProjectStateStore({ project }).read())?.result).toEqual(response.result);
        expect(await new ProjectHandoffStore({ project }).getSession(requested.runId)).toEqual(
          response.result.session,
        );
        const api = new DaemonClient({ registryRoot });
        await expect(
          api.call("runs.dispatch", { projectId: project.id, handoff: requested }),
        ).rejects.toMatchObject({ code: "run_exists" });
        expect(
          await new LocalRunStore({ stateDir: projectPaths(project).directory }).readEvents(
            requested.runId,
          ),
        ).toEqual(events);
        await stopDaemon({ registryRoot });
        await exited;
        const restarted = await startDaemon({ registryRoot });
        try {
          expect(
            await api.call("runs.get", { projectId: project.id, runId: requested.runId }),
          ).toMatchObject({ status: "completed" });
          expect(
            await api.call("results.get", { projectId: project.id, runId: requested.runId }),
          ).toEqual(response.result);
          await unlink(join(projectPaths(project).handoffs, `${requested.runId}.result.json`));
          expect(
            await api.call("runs.get", { projectId: project.id, runId: requested.runId }),
          ).toMatchObject({ status: "interrupted", error: { code: "result_incomplete" } });
        } finally {
          await restarted.stop();
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          await stopDaemon({ registryRoot }).catch(() => {});
          if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        }
        await exited;
      }
    });
  });

  it("bounds waits and cancels through Runtime while enforcing Project scope and one run per Project", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const registryRoot = join(path, "registry");
      let started = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const daemon = await startDaemon({
        registryRoot,
        resolveExecution: () =>
          setup(async (_input, options) => {
            started();
            await delay(30000, undefined, { signal: options?.signal });
            return { status: "success", summary: "Too late" };
          }),
      });
      const api = new DaemonClient({ registryRoot });
      try {
        await api.call("projects.register", { path });
        const requested = handoff(project);
        const locator = { projectId: project.id, runId: requested.runId };
        await api.call("runs.dispatch", { projectId: project.id, handoff: requested });
        await ready;
        expect(await api.call("runs.wait", { ...locator, waitMs: 0 })).toMatchObject({
          status: "running",
        });
        expect(await api.call("results.get", locator)).toBeNull();
        await expect(
          api.call("runs.dispatch", { projectId: project.id, handoff: handoff(project) }),
        ).rejects.toMatchObject({ code: "run_busy" });
        await expect(
          api.call("projects.get", { projectId: randomUUID() as ProjectId }),
        ).rejects.toMatchObject({ code: "project_not_found" });
        await expect(
          api.call("runs.get", { ...locator, runId: randomUUID() }),
        ).rejects.toMatchObject({ code: "run_not_found" });
        const otherPath = join(path, "other");
        await mkdir(otherPath);
        const other = await initializeProject(otherPath);
        await api.call("projects.register", { path: otherPath });
        await expect(
          api.call("results.get", { ...locator, projectId: other.id }),
        ).rejects.toMatchObject({ code: "run_not_found" });
        await api.call("runs.cancel", locator);
        expect(await api.call("runs.wait", { ...locator, waitMs: 20000 })).toMatchObject({
          status: "cancelled",
        });
        expect(await api.call("results.get", locator)).toMatchObject({ status: "cancelled" });
      } finally {
        await daemon.stop();
      }
      await expect(api.call("health", undefined)).rejects.toMatchObject({
        code: "daemon_unavailable",
      });
    });
  });

  it("requires a trusted local execution composition and stops active work before cleanup", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const registryRoot = join(path, "registry");
      const api = new DaemonClient({ registryRoot });
      const readOnly = await startDaemon({ registryRoot });
      try {
        await api.call("projects.register", { path });
        await expect(
          api.call("runs.dispatch", { projectId: project.id, handoff: handoff(project) }),
        ).rejects.toMatchObject({ code: "execution_unavailable" });
      } finally {
        await readOnly.stop();
      }
      let started = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      const daemon = await startDaemon({
        registryRoot,
        resolveExecution: () =>
          setup(async (_input, options) => {
            started();
            await delay(30000, undefined, { signal: options?.signal });
            return { status: "success", summary: "Too late" };
          }),
      });
      try {
        await api.call("runs.dispatch", { projectId: project.id, handoff: handoff(project) });
        await ready;
        await daemon.stop();
        expect((await new ProjectStateStore({ project }).read())?.result?.status).toBe("cancelled");
      } finally {
        await daemon.stop();
      }
    });
  });
});
