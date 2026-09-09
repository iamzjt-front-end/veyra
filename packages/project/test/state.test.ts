import { execFile } from "node:child_process";
import { link, readFile, rename, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { initializeProject, projectPaths, ProjectStateStore } from "../src/index.js";
import type { ProjectStateUpdate } from "@veyraoss/protocol";

const exec = promisify(execFile);
const moduleUrl = new URL("../dist/index.js", import.meta.url).href;

describe("Project Shared State store", () => {
  it("exchanges a task/result/review between separate planner, executor and reviewer processes", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const fixture = fixtureProjectState(project.id);
      const planner = {
        context: fixture.context,
        provenance: fixture.provenance,
        handoff: fixture.handoff,
      };
      const script = `import {readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path';
        const api = await import(${JSON.stringify(moduleUrl)}); const project = await api.openProject(process.argv[1]);
        const store = new api.ProjectStateStore({project}); const mode = process.argv[2];
        if(mode === 'planner') { await store.save(${JSON.stringify(planner)},0); }
        else {
          const state = await store.read(); const update = { context:state.context, provenance:state.provenance, handoff:state.handoff };
          if(mode === 'executor') {
            if(state.context.currentTask !== 'task-1' || state.handoff.context.goal !== 'Write the project answer') throw new Error('Missing handoff');
            await writeFile(join(project.root,'answer.txt'),'42');
            const result = {version:1,kind:'result',id:'result-1',projectId:project.id,runId:state.handoff.runId,handoffId:state.handoff.id,status:'completed',summary:'Wrote 42',changedFiles:['answer.txt'],evidence:[],artifacts:[],provenance:{...state.provenance,role:'executor',surface:'fixture-executor'}};
            await store.save({...update,provenance:result.provenance,result},state.revision);
          } else {
            if(state.result.summary !== 'Wrote 42' || await readFile(join(project.root,'answer.txt'),'utf8') !== '42') throw new Error('Missing result');
            const review = {version:1,kind:'review',id:'review-1',projectId:project.id,runId:state.result.runId,resultId:state.result.id,verdict:'pass',summary:'Fixture acceptance met',nextAction:'complete',evidence:[],provenance:{...state.provenance,role:'reviewer',surface:'fixture-reviewer'}};
            await store.save({...update,result:state.result,provenance:review.provenance,review},state.revision);
          }
        }`;
      const env = { ...process.env };
      delete env.OPENAI_API_KEY;
      for (const role of ["planner", "executor", "reviewer"])
        await exec(process.execPath, ["--input-type=module", "-e", script, path, role], {
          env,
          timeout: 10000,
        });
      const state = await new ProjectStateStore({ project }).read();
      expect(state?.revision).toBe(3);
      expect(state?.handoff?.provenance.surface).toBe("fixture-planner");
      expect(state?.result?.provenance.surface).toBe("fixture-executor");
      expect(state?.review).toMatchObject({
        verdict: "pass",
        nextAction: "complete",
        provenance: { surface: "fixture-reviewer" },
      });
      expect((await stat(projectPaths(project).state)).mode & 0o777).toBe(0o600);
    });
  });

  it("rejects stale writes rather than losing another participant's update", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const store = new ProjectStateStore({ project });
      const { context, provenance } = fixtureProjectState(project.id);
      expect(await store.read()).toBeUndefined();
      const outcomes = await Promise.allSettled([
        store.save({ context, provenance }, 0),
        new ProjectStateStore({ project }).save(
          { context: { ...context, goal: "Another goal" }, provenance },
          0,
        ),
      ]);
      expect(outcomes.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(outcomes.find((result) => result.status === "rejected")?.reason).toMatchObject({
        code: "state_conflict",
      });
      const before = await readFile(projectPaths(project).state);
      await expect(store.save({ context, provenance }, 0)).rejects.toMatchObject({
        code: "state_conflict",
      });
      expect(await readFile(projectPaths(project).state)).toEqual(before);
    });
  });

  it("retains existing secret redaction in shared decisions, inputs, results and stored bytes", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const secret = "fixture-sensitive-value";
      const store = new ProjectStateStore({ project, env: { OPTIONAL_API_KEY: secret } });
      const { context, provenance, handoff, result, review } = fixtureProjectState(project.id);
      context.goal = `Goal ${secret}`;
      if (result)
        result.summary = `Output ${encodeURIComponent(secret)} Bearer fake-sensitive-bearer`;
      if (review) review.summary = "Found sk-proj-fixture123456789012345";
      const saved = await store.save({ context, provenance, handoff, result, review }, 0);
      const raw = await readFile(projectPaths(project).state, "utf8");
      for (const sensitive of [secret, "fake-sensitive-bearer", "sk-proj-fixture123456789012345"]) {
        expect(raw).not.toContain(sensitive);
        expect(JSON.stringify(saved)).not.toContain(sensitive);
      }
      expect(raw).toContain("[REDACTED]");
      await expect(
        store.save({ context, provenance, token: secret } as unknown as ProjectStateUpdate, 1),
      ).rejects.toMatchObject({ code: "invalid_shared_state" });
      expect(await readFile(projectPaths(project).state, "utf8")).toBe(raw);
    });
  });

  it.each(["malformed", "oversized", "symlink", "hardlink", "wrong-project"])(
    "preserves and rejects %s state",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        const project = await initializeProject(path);
        const store = new ProjectStateStore({ project });
        const { context, provenance } = fixtureProjectState(project.id);
        await store.save({ context, provenance }, 0);
        const file = projectPaths(project).state;
        if (kind === "symlink" || kind === "hardlink") {
          const outside = join(path, "outside.json");
          await rename(file, outside);
          if (kind === "symlink") await symlink(outside, file);
          else await link(outside, file);
        } else if (kind === "wrong-project")
          await writeFile(
            file,
            JSON.stringify(
              fixtureProjectState("f1cafe00-1897-4555-a629-123456789012" as typeof project.id),
            ),
          );
        else
          await writeFile(file, kind === "oversized" ? "x".repeat(256 * 1024 + 1) : "{incomplete");
        const original = await readFile(file);
        await expect(store.read()).rejects.toMatchObject({ code: "invalid_shared_state" });
        await expect(store.save({ context, provenance }, 1)).rejects.toMatchObject({
          code: "invalid_shared_state",
        });
        // Keep full byte preservation checks without traversing a large Buffer as an object.
        expect((await readFile(file)).equals(original)).toBe(true);
      });
    },
  );

  it("refuses a Project whose identity changed after the store opened", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const store = new ProjectStateStore({ project });
      await writeFile(
        projectPaths(project).metadata,
        JSON.stringify({ ...project, id: "f1cafe00-1897-4555-a629-123456789012" }),
      );
      await expect(store.read()).rejects.toMatchObject({ code: "project_identity_changed" });
    });
  });
});
