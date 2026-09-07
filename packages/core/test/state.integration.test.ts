import { execFile } from "node:child_process";
import { mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { VeyraEvent } from "@veyra/protocol";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, StateStoreError } from "../src/state.js";

const workflow: WorkflowDefinition = {
  name: "fixture",
  version: 1,
  start: "plan",
  steps: {
    plan: { type: "agent", agent: "planner", next: "verify" },
    verify: { type: "command", run: ["node --test"], next: "done" },
    done: { type: "end" },
  },
};
const execute = promisify(execFile);

describe("local run state", () => {
  it("defaults to the local .veyra directory without creating state in its constructor", () => {
    expect(new LocalRunStore().directory).toBe(resolve(".veyra"));
  });

  it("creates the complete layout and loads the original input", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, "nested", ".veyra") });
      const run = await store.createRun({ goal: "Fix the fixture", workflow, cwd: path });
      expect(await readdir(join(store.directory, "runs", run.state.runId))).toEqual([
        "artifacts",
        "events.jsonl",
        "input.json",
        "state.json",
      ]);
      expect(run.input).toMatchObject({ goal: "Fix the fixture", workflow, cwd: path, version: 1 });
      expect(run.state).toMatchObject({ status: "running", currentStep: "plan", retryCounts: {} });
      expect(await store.getActiveRun()).toEqual(run);
      expect(await store.readEvents(run.state.runId)).toEqual([]);
      run.state.retryCounts.plan = 99;
      expect((await store.loadRun(run.state.runId)).state.retryCounts).toEqual({});
    });
  });

  it("serializes local updates, maintains valid JSON snapshots, and leaves no temporary files", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await store.createRun({ goal: "fixture", workflow });
      const statePath = join(store.directory, "runs", run.state.runId, "state.json");
      await Promise.all([
        Promise.all(
          Array.from({ length: 15 }, (_, index) =>
            store.updateRun(run.state.runId, {
              currentStep: "verify",
              retryCounts: { plan: index },
              lastOutcome: "success",
            }),
          ),
        ),
        (async () => {
          for (let index = 0; index < 30; index++)
            expect(JSON.parse(await readFile(statePath, "utf8")).runId).toBe(run.state.runId);
        })(),
      ]);
      expect((await store.loadRun(run.state.runId)).state).toMatchObject({
        currentStep: "verify",
        retryCounts: { plan: 14 },
        lastOutcome: "success",
      });
      expect(
        (await readdir(join(store.directory, "runs", run.state.runId))).some((name) =>
          name.endsWith(".tmp"),
        ),
      ).toBe(false);
    });
  });

  it("generates distinct run IDs, lists runs, and switches or clears the active pointer", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      expect(await store.listRuns()).toEqual([]);
      expect(await store.getActiveRun()).toBeNull();
      const runs = await Promise.all(
        Array.from({ length: 3 }, (_, index) =>
          store.createRun({ goal: `goal-${index}`, workflow }),
        ),
      );
      expect(new Set(runs.map((run) => run.state.runId)).size).toBe(3);
      expect(await store.listRuns()).toHaveLength(3);
      const first = runs[0];
      if (!first) throw new Error("Expected a created run");
      await store.setActiveRun(first.state.runId);
      expect((await store.getActiveRun())?.input.goal).toBe("goal-0");
      await store.setActiveRun(null);
      expect(await store.getActiveRun()).toBeNull();
      expect(await store.listRuns()).toHaveLength(3);
    });
  });

  it("appends ordered, traceable events and resumes their sequence after reopening", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const stateDir = join(path, ".veyra");
      const store = new LocalRunStore({ stateDir });
      const { state } = await store.createRun({ goal: "fixture", workflow });
      const event: VeyraEvent = {
        type: "step.started",
        runId: state.runId,
        stepId: "plan",
        at: new Date().toISOString(),
      };
      await Promise.all([
        store.appendEvent(state.runId, event),
        store.appendEvent(state.runId, { ...event, type: "step.completed" }),
      ]);
      const reopened = new LocalRunStore({ stateDir });
      await reopened.appendEvent(state.runId, { ...event, type: "run.paused" });
      const events = await reopened.readEvents(state.runId);
      expect(events.map((item) => item.sequence)).toEqual([1, 2, 3]);
      expect(new Set(events.map((item) => item.eventId)).size).toBe(3);
      expect(events[0]).toMatchObject(event);
    });
  });

  it("loads the next step in a fresh Node process after the writer exits", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const stateDir = join(path, ".veyra");
      const moduleUrl = new URL("../src/state.ts", import.meta.url).href;
      const writer = `import { LocalRunStore } from ${JSON.stringify(moduleUrl)}; const store = new LocalRunStore({ stateDir: process.argv[1] }); const run = await store.createRun({ goal: 'Complete fixture', workflow: ${JSON.stringify(workflow)} }); await store.appendEvent(run.state.runId, {type:'step.completed',runId:run.state.runId,stepId:'plan',at:new Date().toISOString()}); await store.updateRun(run.state.runId, {status:'paused',currentStep:'verify',lastOutcome:'success',retryCounts:{plan:1}}); console.log(run.state.runId);`;
      const first = await execute(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", writer, stateDir],
        { timeout: 10000 },
      );
      const reader = `import { LocalRunStore } from ${JSON.stringify(moduleUrl)}; const store = new LocalRunStore({ stateDir: process.argv[1] }); const run = await store.getActiveRun(); console.log(JSON.stringify({run,events:await store.readEvents(run.state.runId)}));`;
      const second = await execute(
        process.execPath,
        ["--import", "tsx", "--input-type=module", "-e", reader, stateDir],
        { timeout: 10000 },
      );
      const loaded = JSON.parse(second.stdout);
      expect(loaded.run.state).toMatchObject({
        runId: first.stdout.trim(),
        status: "paused",
        currentStep: "verify",
        lastOutcome: "success",
        retryCounts: { plan: 1 },
      });
      expect(loaded.run.input.goal).toBe("Complete fixture");
      expect(loaded.events).toHaveLength(1);
    });
  });

  it("rejects invalid updates without damaging the last valid snapshot", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await store.createRun({ goal: "fixture", workflow });
      await expect(
        store.updateRun(run.state.runId, { currentStep: "missing" }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        store.updateRun(run.state.runId, { retryCounts: { plan: -1 } }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(store.updateRun(run.state.runId, { currentStep: null })).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect((await store.loadRun(run.state.runId)).state).toEqual(run.state);
      expect(
        await store.updateRun(run.state.runId, { status: "completed", currentStep: null }),
      ).not.toHaveProperty("currentStep");
    });
  });

  it("redacts known secret values and credential fields without persisting the environment", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const secret = "fixture-private-credential";
      const store = new LocalRunStore({ stateDir: join(path, ".veyra"), redactValues: [secret] });
      const run = await store.createRun({
        goal: `Work with ${secret}`,
        workflow: {
          ...workflow,
          steps: {
            ...workflow.steps,
            secret: { type: "end", metadata: { api_key: "other-secret-value" } },
          },
        },
      });
      await store.appendEvent(run.state.runId, {
        type: "agent.completed",
        runId: run.state.runId,
        stepId: "plan",
        agentId: "fake",
        at: new Date().toISOString(),
        result: {
          status: "success",
          summary: secret,
          data: {
            password: "another-value",
            env: { UNRECOGNIZED_CREDENTIAL: "hidden-environment-value" },
          },
        },
      });
      const persisted = await Promise.all(
        ["input.json", "state.json", "events.jsonl"].map((file) =>
          readFile(join(store.directory, "runs", run.state.runId, file), "utf8"),
        ),
      );
      expect(persisted.join("\n")).not.toContain(secret);
      expect(persisted.join("\n")).not.toContain("other-secret-value");
      expect(persisted.join("\n")).not.toContain("another-value");
      expect(persisted.join("\n")).not.toContain("hidden-environment-value");
      expect(run.input.goal).toBe("Work with [REDACTED]");
      expect(run.input.workflow.steps.secret?.type).toBe("end");
      await expect(
        store.createRun({ goal: "fixture", workflow, env: { key: secret } } as never),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect((await store.listRuns()).length).toBe(1);
    });
  });

  it("refuses redaction that would corrupt workflow control identifiers", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra"), redactValues: ["plan"] });
      await expect(store.createRun({ goal: "fixture", workflow })).rejects.toMatchObject({
        code: "invalid_input",
      });
      expect(await store.listRuns()).toEqual([]);
      expect(await store.getActiveRun()).toBeNull();
      expect(await readdir(join(store.directory, "runs"))).toEqual([]);
    });
  });

  it.each(["input.json", "state.json"])(
    "reports corrupt %s without exposing its contents",
    async (file) => {
      await withFixtureWorkspace(async ({ path }) => {
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const run = await store.createRun({ goal: "fixture", workflow });
        const filePath = join(store.directory, "runs", run.state.runId, file);
        await writeFile(filePath, '{"private-value":');
        const loading = store.loadRun(run.state.runId);
        await expect(loading).rejects.toBeInstanceOf(StateStoreError);
        await expect(loading).rejects.toMatchObject({ code: "corrupt_state", filePath });
        await expect(loading).rejects.not.toThrow("private-value");
      });
    },
  );

  it("reports missing files, invalid schemas, and corrupt active pointers", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await store.createRun({ goal: "fixture", workflow });
      const statePath = join(store.directory, "runs", run.state.runId, "state.json");
      await writeFile(statePath, JSON.stringify({ ...run.state, version: 99 }));
      await expect(store.loadRun(run.state.runId)).rejects.toMatchObject({ code: "corrupt_state" });
      await rm(statePath);
      await expect(store.loadRun(run.state.runId)).rejects.toMatchObject({ code: "not_found" });
      await writeFile(
        join(store.directory, "state", "active.json"),
        '{"version":1,"runId":"../outside"}',
      );
      await expect(store.getActiveRun()).rejects.toMatchObject({ code: "corrupt_state" });
    });
  });

  it("refuses incomplete or malformed event records and will not append onto them", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await store.createRun({ goal: "fixture", workflow });
      const eventsPath = join(store.directory, "runs", run.state.runId, "events.jsonl");
      const event: VeyraEvent = {
        type: "run.completed",
        runId: run.state.runId,
        at: new Date().toISOString(),
      };
      await writeFile(eventsPath, '{"type":');
      await expect(store.readEvents(run.state.runId)).rejects.toThrow("Incomplete final event");
      await expect(store.appendEvent(run.state.runId, event)).rejects.toMatchObject({
        code: "corrupt_state",
      });
      expect(await readFile(eventsPath, "utf8")).toBe('{"type":');
      await writeFile(eventsPath, "{}\n");
      await expect(store.readEvents(run.state.runId)).rejects.toThrow("line 1");
    });
  });

  it("rejects cross-run and malformed event payloads", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await store.createRun({ goal: "fixture", workflow });
      await expect(
        store.appendEvent(run.state.runId, {
          type: "run.completed",
          runId: "other",
          at: new Date().toISOString(),
        }),
      ).rejects.toMatchObject({ code: "invalid_input" });
      await expect(
        store.appendEvent(run.state.runId, {
          type: "agent.completed",
          runId: run.state.runId,
          stepId: "plan",
          agentId: "fake",
          at: new Date().toISOString(),
          result: { status: "success" },
        } as never),
      ).rejects.toMatchObject({ code: "invalid_input" });
      expect(await store.readEvents(run.state.runId)).toEqual([]);
    });
  });

  it("ignores unpublished staging directories and rejects path traversal", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      await mkdir(join(store.directory, "runs", ".tmp-interrupted"), { recursive: true });
      expect(await store.listRuns()).toEqual([]);
      await expect(store.loadRun("../outside")).rejects.toMatchObject({ code: "invalid_input" });
    });
  });

  it.skipIf(process.platform === "win32")(
    "rejects symlinked state files without overwriting their target",
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const run = await store.createRun({ goal: "fixture", workflow });
        const target = join(path, "unrelated.json");
        await writeFile(target, "preserve me");
        const statePath = join(store.directory, "runs", run.state.runId, "state.json");
        await rm(statePath);
        await symlink(target, statePath);
        await expect(store.updateRun(run.state.runId, { status: "paused" })).rejects.toMatchObject({
          code: "unsafe_path",
        });
        expect(await readFile(target, "utf8")).toBe("preserve me");
      });
    },
  );
});
