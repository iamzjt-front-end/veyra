import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { AgentAdapter } from "@veyraoss/protocol";
import type { WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { git, initializeGit } from "../../../test/helpers/git.js";
import { VeyraEngine, LocalRunStore } from "../src/index.js";

const config = parseConfig({
  version: 1,
  agents: {},
  workflow: { use: "fixture" },
  runtime: { workspace: { mode: "worktree" } },
});
const workflow: WorkflowDefinition = {
  version: 1,
  name: "isolated",
  start: "work",
  steps: {
    work: { type: "agent", agent: "worker", next: "verify" },
    verify: {
      type: "command",
      run: [
        "node -e \"if(require('node:fs').readFileSync('result.txt','utf8')!=='isolated')process.exit(1)\"",
      ],
    },
  },
};

describe("Core workspace coordination", { timeout: 30_000 }, () => {
  it("refuses persistence when redaction would change the leased execution location", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const secret = "fixture-path-credential";
      const cwd = join(path, secret);
      await mkdir(cwd);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra"), redactValues: [secret] });
      const shared = {
        ...config,
        runtime: { ...config.runtime, workspace: { mode: "shared" as const } },
      };
      await expect(
        new VeyraEngine({ store }).run({
          config: shared,
          workflow,
          agents: {},
          cwd,
          goal: "No redirected execution",
        }),
      ).rejects.toThrow(/redaction changed the execution location/);
      expect(await store.listRuns()).toEqual([]);
    });
  });

  it("persists the selected workspace before agents run and verifies in that same directory", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeGit(path);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        async run(input, controls) {
          const saved = await store.loadRun(input.runId);
          expect(saved.input.cwd).toBe(controls?.cwd);
          expect(saved.input.workspace?.mode).toBe("worktree");
          expect((await store.readEvents(input.runId))[0]).toMatchObject({
            type: "run.started",
            workspace: saved.input.workspace,
          });
          await writeFile(join(controls?.cwd as string, "result.txt"), "isolated");
          return { status: "success", summary: "Wrote isolated result" };
        },
      };
      const engine = new VeyraEngine({ store });
      const run = await engine.run({
        config,
        workflow,
        cwd: path,
        goal: "Isolate fixture",
        agents: { worker },
      });
      expect(run.status).toBe("completed");
      const saved = await store.loadRun(run.runId);
      expect(await readFile(join(saved.input.cwd, "result.txt"), "utf8")).toBe("isolated");
      await expect(readFile(join(path, "result.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await expect(
        engine.removeWorkspace({ config, cwd: path, runId: run.runId }),
      ).rejects.toMatchObject({ code: "dirty_workspace" });
    });
  });

  it("resumes from the saved worktree despite changed configuration and source HEAD", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const commit = await initializeGit(path);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const gated: WorkflowDefinition = {
        ...workflow,
        start: "gate",
        steps: {
          ...workflow.steps,
          gate: { type: "human", message: "Inspect workspace", on: { approved: "work" } },
        },
      };
      const engine = new VeyraEngine({ store });
      const first = await engine.run({
        config,
        workflow: gated,
        cwd: path,
        goal: "Resume fixture",
        agents: {},
      });
      const request = { config, cwd: path, runId: first.runId };
      expect(first.status).toBe("paused");
      await expect(engine.removeWorkspace(request)).rejects.toMatchObject({
        code: "workspace_run_active",
      });
      const initial = (await store.loadRun(first.runId)).input;
      await writeFile(join(path, "later.txt"), "new source state");
      await git(path, "add", "later.txt");
      await git(path, "commit", "-m", "Move source HEAD");
      const pending = await engine.getPendingApproval(request);
      await engine.resolveApproval({
        ...request,
        approvalId: pending?.approvalId as string,
        decision: "approved",
      });
      const result = await new VeyraEngine({ store }).resume({
        ...request,
        config: { ...config, runtime: { ...config.runtime, workspace: { mode: "shared" } } },
        agents: {
          worker: {
            id: "worker",
            provider: "fixture",
            async run(_input, controls) {
              expect(controls?.cwd).toBe(initial.cwd);
              expect(await git(initial.cwd, "rev-parse", "HEAD")).toBe(commit);
              await expect(readFile(join(initial.cwd, "later.txt"))).rejects.toMatchObject({
                code: "ENOENT",
              });
              await writeFile(join(initial.cwd, "result.txt"), "isolated");
              return { status: "success", summary: "Resumed in original workspace" };
            },
          },
        },
      });
      expect(result.status).toBe("completed");
      expect((await store.loadRun(first.runId)).input).toEqual(initial);
    });
  });

  it("blocks concurrent shared runs before invocation and releases ownership after failure", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      let started = () => {};
      const ready = new Promise<void>((resolve) => {
        started = resolve;
      });
      let finish = () => {};
      const waiting = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const shared = {
        ...config,
        runtime: { ...config.runtime, workspace: { mode: "shared" as const } },
      };
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        async run() {
          started();
          await waiting;
          throw new Error("Fixture failure");
        },
      };
      const engine = new VeyraEngine();
      const first = engine.run({
        config: shared,
        workflow,
        cwd: path,
        goal: "First",
        agents: { worker },
      });
      await ready;
      try {
        await expect(
          new VeyraEngine().run({
            config: shared,
            workflow,
            cwd: path,
            goal: "Second",
            agents: { worker },
          }),
        ).rejects.toMatchObject({ code: "workspace_busy" });
      } finally {
        finish();
      }
      expect((await first).status).toBe("failed");
      const end: WorkflowDefinition = {
        version: 1,
        name: "empty",
        start: "done",
        steps: { done: { type: "end" } },
      };
      expect(
        (
          await engine.run({
            config: shared,
            workflow: end,
            cwd: path,
            goal: "After failure",
            agents: {},
          })
        ).status,
      ).toBe("completed");
    });
  });

  it("removes only a clean terminal worktree and records its removal without deleting history", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeGit(path);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const engine = new VeyraEngine({ store });
      const end: WorkflowDefinition = {
        version: 1,
        name: "empty",
        start: "done",
        steps: { done: { type: "end" } },
      };
      const result = await engine.run({
        config,
        workflow: end,
        cwd: path,
        goal: "Clean fixture",
        agents: {},
      });
      const input = (await store.loadRun(result.runId)).input;
      expect(await engine.removeWorkspace({ config, cwd: path, runId: result.runId })).toEqual({
        runId: result.runId,
        cwd: input.cwd,
        removed: true,
      });
      expect((await store.readEvents(result.runId)).at(-1)?.type).toBe("workspace.removed");
      expect((await store.loadRun(result.runId)).state.status).toBe("completed");
      await expect(readFile(join(input.cwd, "package.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    });
  });
});
