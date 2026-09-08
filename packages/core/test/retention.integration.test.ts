import { readFile, readdir, writeFile, symlink, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import { runProcess } from "@veyra/runtime";
import type { WorkflowDefinition } from "@veyra/workflow";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeGit } from "../../../test/helpers/git.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const definition: WorkflowDefinition = {
  version: 1,
  name: "retention",
  start: "done",
  steps: { done: { type: "end" } },
};
async function terminal(store: LocalRunStore, cwd: string) {
  const run = await store.createRun({ goal: "Retention fixture", workflow: definition, cwd });
  await store.updateRun(run.state.runId, { status: "completed", currentStep: null });
  return run.state.runId;
}
afterEach(() => vi.useRealTimers());

describe("local history retention", { timeout: 30_000 }, () => {
  it("reports the exact retained trash directory if deletion fails after atomic removal from the live list", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const id = await terminal(store, path);
      await store.setActiveRun(null);
      const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
      const source = `import fs from 'node:fs';import {basename,dirname} from 'node:path';import {syncBuiltinESMExports} from 'node:module';const rm=fs.promises.rm;fs.promises.rm=async(...args)=>{if(basename(dirname(String(args[0])))==='trash')throw new Error('Fixture deletion denied');return rm(...args);};syncBuiltinESMExports();const {LocalRunStore}=await import(${JSON.stringify(moduleUrl)});try{await new LocalRunStore({stateDir:process.argv[1]}).pruneRuns({olderThanDays:0,keepLast:0,apply:true});process.exitCode=1;}catch(error){console.log(JSON.stringify({code:error.code,path:error.filePath,message:error.message}));}`;
      const result = await runProcess({
        executable: process.execPath,
        args: ["--import", "tsx", "--input-type=module", "-e", source, store.directory],
        timeoutMs: 15_000,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const failure = JSON.parse(result.stdout);
      expect(failure).toMatchObject({
        code: "io_error",
        message: expect.stringContaining("cleanup is incomplete"),
      });
      const [trash] = await readdir(join(path, ".veyra", "state", "trash"));
      expect(trash).toMatch(new RegExp(`^${id}-`));
      expect(failure.path).toBe(join(store.directory, "state", "trash", trash as string));
      expect(JSON.parse(await readFile(join(failure.path, "state.json"), "utf8"))).toMatchObject({
        runId: id,
        status: "completed",
      });
      expect(await store.listRuns()).toEqual([]);
      expect((await store.pruneRuns({ apply: true })).removed).toEqual([]);
      expect(await readdir(join(path, ".veyra", "state", "trash"))).toEqual([trash]);
    });
  });

  it("previews by default, keeps the newest 20 and recent/active runs, and deletes only eligible history", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2020-01-01T00:00:00Z"));
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const old: string[] = [];
      for (let index = 0; index < 22; index++) {
        vi.setSystemTime(new Date(Date.UTC(2020, 0, 1, 0, 0, index)));
        old.push(await terminal(store, path));
      }
      vi.setSystemTime(new Date("2020-03-01T00:00:00Z"));
      const active = await terminal(store, path);
      const preview = await store.pruneRuns();
      expect(preview.dryRun).toBe(true);
      expect(preview.candidates.map((run) => run.runId)).toEqual(old.slice(0, 3).reverse());
      expect(preview.candidates.every((run) => run.sizeBytes > 0)).toBe(true);
      expect(preview.removed).toEqual([]);
      expect(await store.listRuns()).toHaveLength(23);
      const result = await store.pruneRuns({ apply: true });
      expect(result.removed).toEqual(preview.candidates);
      expect(await store.listRuns()).toHaveLength(20);
      expect((await store.getActiveRun())?.state.runId).toBe(active);
      expect(await readdir(join(path, ".veyra", "state", "trash"))).toEqual([]);
      await store.setActiveRun(null);
      const ageOnly = await store.pruneRuns({ keepLast: 0 });
      expect(ageOnly.skipped).toContainEqual({ runId: active, reason: "recent" });
      expect((await store.pruneRuns()).candidates).toEqual([]);
    });
  });

  it("preserves running/paused runs and retained worktrees until explicit workspace removal", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeGit(path);
      const config = parseConfig({
        version: 1,
        workflow: { use: "fixture" },
        agents: {},
        runtime: { workspace: { mode: "worktree" } },
      });
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const engine = new VeyraEngine({ store });
      const complete = await engine.run({
        config,
        workflow: definition,
        agents: {},
        cwd: path,
        goal: "Preserve worktree",
      });
      const running = await store.createRun({ goal: "Running", workflow: definition, cwd: path });
      const paused = await store.createRun({ goal: "Paused", workflow: definition, cwd: path });
      await store.updateRun(paused.state.runId, { status: "paused" });
      await store.setActiveRun(null);
      const options = { olderThanDays: 0, keepLast: 0, apply: true };
      const first = await store.pruneRuns(options);
      expect(first.removed).toEqual([]);
      expect(first.skipped).toEqual(
        expect.arrayContaining([
          { runId: complete.runId, reason: "workspace_present" },
          { runId: running.state.runId, reason: "nonterminal" },
          { runId: paused.state.runId, reason: "nonterminal" },
        ]),
      );
      await engine.removeWorkspace({ config, runId: complete.runId, cwd: path });
      expect((await store.pruneRuns(options)).removed.map((run) => run.runId)).toEqual([
        complete.runId,
      ]);
      expect(await store.listRuns()).toHaveLength(2);
      expect((await stat(join(path, "src", "message.js"))).isFile()).toBe(true);
    });
  });

  it("does not delete history controlled by another live run lease", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const id = await terminal(store, path);
      await store.setActiveRun(null);
      let release = () => {};
      let ready = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const started = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const owner = store.withRunLock(id, async () => {
        ready();
        await gate;
      });
      await started;
      try {
        const result = await new LocalRunStore({ stateDir: store.directory }).pruneRuns({
          olderThanDays: 0,
          keepLast: 0,
          apply: true,
        });
        expect(result.removed).toEqual([]);
        expect(result.skipped).toContainEqual({ runId: id, reason: "lock_timeout" });
        expect((await store.loadRun(id)).state.status).toBe("completed");
      } finally {
        release();
        await owner;
      }
    });
  });

  it("rechecks active selection after planning and serializes competing cleanup requests", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      class SelectingStore extends LocalRunStore {
        override async withRunLock<T>(id: string, action: () => Promise<T>, recover = false) {
          await this.setActiveRun(id);
          return super.withRunLock(id, action, recover);
        }
      }
      const store = new SelectingStore({ stateDir: join(path, ".veyra") });
      const id = await terminal(store, path);
      await store.setActiveRun(null);
      const options = { olderThanDays: 0, keepLast: 0, apply: true };
      expect((await store.pruneRuns(options)).skipped).toContainEqual({
        runId: id,
        reason: "changed_since_preview",
      });
      const normal = new LocalRunStore({ stateDir: store.directory });
      await normal.setActiveRun(null);
      const results = await Promise.all([
        normal.pruneRuns(options),
        new LocalRunStore({ stateDir: store.directory }).pruneRuns(options),
      ]);
      expect(results.flatMap((result) => result.removed).map((run) => run.runId)).toEqual([id]);
      expect(await normal.listRuns()).toEqual([]);
    });
  });

  it("refuses corrupt history before moving it and never follows provider artifact paths", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const id = await terminal(store, path);
      const outside = join(path, "outside.txt");
      await writeFile(outside, "Unrelated file");
      await store.appendEvent(id, {
        type: "step.completed",
        runId: id,
        stepId: "done",
        at: new Date().toISOString(),
        artifacts: [{ id: "external", kind: "file", path: outside }],
      });
      await store.setActiveRun(null);
      const file = join(path, ".veyra", "runs", id, "events.jsonl");
      const original = await readFile(file, "utf8");
      await writeFile(file, `${original}{"partial":`);
      await expect(
        store.pruneRuns({ olderThanDays: 0, keepLast: 0, apply: true }),
      ).rejects.toMatchObject({ code: "corrupt_state" });
      expect(await readFile(file, "utf8")).toBe(`${original}{"partial":`);
      await writeFile(file, original);
      expect(
        (await store.pruneRuns({ olderThanDays: 0, keepLast: 0, apply: true })).removed,
      ).toHaveLength(1);
      expect(await readFile(outside, "utf8")).toBe("Unrelated file");
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses linked run content and preserves its target",
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const id = await terminal(store, path);
        await store.setActiveRun(null);
        const outside = join(path, "outside.txt");
        await writeFile(outside, "Preserve");
        await symlink(outside, join(path, ".veyra", "runs", id, "artifacts", "linked"));
        await expect(
          store.pruneRuns({ olderThanDays: 0, keepLast: 0, apply: true }),
        ).rejects.toMatchObject({ code: "unsafe_path" });
        expect(await readFile(outside, "utf8")).toBe("Preserve");
        expect((await store.loadRun(id)).state.status).toBe("completed");
      });
    },
  );

  it("rejects invalid cleanup policies and leaves an absent store absent", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const directory = join(path, ".veyra");
      const store = new LocalRunStore({ stateDir: directory });
      for (const options of [
        null,
        { olderThanDays: -1 },
        { olderThanDays: 365_001 },
        { keepLast: 0.5 },
        { keepLast: 100_001 },
        { apply: "yes" },
        { force: true },
      ])
        await expect(store.pruneRuns(options as never)).rejects.toMatchObject({
          code: "invalid_input",
        });
      expect(await store.pruneRuns()).toMatchObject({ dryRun: true, candidates: [], removed: [] });
      expect(await store.pruneRuns({ apply: true })).toMatchObject({
        dryRun: false,
        candidates: [],
        removed: [],
      });
      await expect(stat(directory)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
