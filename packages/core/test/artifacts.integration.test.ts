import { readFile, writeFile, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import type { VeyraEvent } from "@veyra/protocol";
import { runProcess } from "@veyra/runtime";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { eventView, LocalRunStore, MAX_INLINE_EVENT_BYTES, VeyraEngine } from "../src/index.js";
import { digest } from "../src/artifacts.js";

const config = parseConfig({ version: 1, workflow: { use: "fixture" }, agents: {} });
const definition: WorkflowDefinition = {
  version: 1,
  name: "payload",
  start: "work",
  steps: { work: { type: "agent", agent: "worker" } },
};
const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
const completion = (runId: string): VeyraEvent => ({
  type: "agent.completed",
  runId,
  stepId: "work",
  agentId: "worker",
  attemptId: "attempt-one",
  attempt: 1,
  at: new Date().toISOString(),
  result: {
    status: "success",
    summary: "Large result",
    data: { output: "你好fixture-private".repeat(10_000), selected: { answer: 42 } },
  },
});

describe("managed event payloads", { timeout: 30_000 }, () => {
  it("offloads large run-level input without inventing a producer step", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await new VeyraEngine({ store }).run({
        config,
        workflow: { version: 1, name: "goal", start: "done", steps: { done: { type: "end" } } },
        cwd: path,
        goal: "目标".repeat(20_000),
        agents: {},
      });
      expect(run.status).toBe("completed");
      const event = (await store.readEvents(run.runId))[0];
      expect(event).toMatchObject({
        type: "run.started",
        goal: "目标".repeat(20_000),
        payload: { producer: { runId: run.runId } },
      });
      expect(event?.payload?.producer).not.toHaveProperty("stepId");
      expect(eventView(event as VeyraEvent)).toMatchObject({
        type: "event.stored",
        eventType: "run.started",
      });
    });
  });

  it("bounds terminal diagnostics while retaining the failed agent's full redacted result", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({
        stateDir: join(path, ".veyra"),
        redactValues: ["fixture-secret"],
      });
      const agent = new FakeAgent({
        status: "failure",
        summary: "failure fixture-secret ".repeat(5000),
      });
      const run = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        cwd: path,
        goal: "Large failure",
        agents: { worker: agent },
      });
      expect(run.status).toBe("failed");
      expect(run.error?.message.length).toBeLessThanOrEqual(4096);
      expect(run.error?.message).not.toContain("fixture-secret");
      const event = (await store.readEvents(run.runId)).find(
        (entry) => entry.type === "agent.completed",
      );
      expect(event).toMatchObject({
        result: { status: "failure", summary: "failure [REDACTED] ".repeat(5000) },
        payload: { kind: "event-payload" },
      });
      expect((await store.loadRun(run.runId)).state.error).toEqual(run.error);
    });
  });

  it("publishes redacted payloads with provenance and restores complete values from a fresh process", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({
        stateDir: join(path, ".veyra"),
        redactValues: ["fixture-private"],
      });
      const run = await store.createRun({
        goal: "Payload fixture",
        workflow: definition,
        cwd: path,
      });
      const saved = await store.appendEvent(run.state.runId, completion(run.state.runId));
      const directory = join(path, ".veyra", "runs", run.state.runId);
      const line = await readFile(join(directory, "events.jsonl"), "utf8");
      expect(Buffer.byteLength(line)).toBeLessThan(MAX_INLINE_EVENT_BYTES);
      const record = JSON.parse(line);
      expect(record).toMatchObject({
        type: "event.stored",
        eventType: "agent.completed",
        sequence: 1,
        artifact: {
          id: saved.eventId,
          kind: "event-payload",
          producer: {
            runId: run.state.runId,
            stepId: "work",
            attemptId: "attempt-one",
            attempt: 1,
          },
          createdAt: saved.at,
        },
      });
      expect(record).toEqual(eventView(saved));
      const payload = await readFile(join(directory, record.artifact.path), "utf8");
      expect(payload).not.toContain("fixture-private");
      expect(payload).toContain("[REDACTED]");
      expect(record.artifact.metadata.sha256).toBe(digest(payload));
      expect(record.artifact.sizeBytes).toBe(Buffer.byteLength(payload));
      expect(payload.length).toBeGreaterThan(MAX_INLINE_EVENT_BYTES);
      const child = await runProcess({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          `import {LocalRunStore} from ${JSON.stringify(moduleUrl)};const [event]=await new LocalRunStore({stateDir:process.argv[1]}).readEvents(${JSON.stringify(run.state.runId)});console.log(JSON.stringify({selected:event.result.data.selected,length:event.result.data.output.length,payload:event.payload}));`,
          join(path, ".veyra"),
        ],
        timeoutMs: 15_000,
      });
      expect(child.exitCode, child.stderr).toBe(0);
      expect(JSON.parse(child.stdout)).toMatchObject({
        selected: { answer: 42 },
        length: "你好[REDACTED]".repeat(10_000).length,
        payload: record.artifact,
      });
      await expect(store.appendEvent(run.state.runId, saved)).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(store.appendEvent(run.state.runId, record)).rejects.toMatchObject({
        code: "invalid_input",
      });
    });
  });

  it("restores mapped inputs across pause/resume and exposes the large evidence artifact in context", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        version: 1,
        name: "mapped",
        start: "work",
        steps: {
          work: { type: "agent", agent: "worker", next: "gate" },
          gate: { type: "human", next: "consume" },
          consume: {
            type: "agent",
            agent: "consumer",
            inputs: { selected: { from: "work", path: "/data/selected" } },
          },
        },
      };
      const worker = new FakeAgent({
        status: "success",
        summary: "Payload",
        data: { output: "x".repeat(90_000), selected: { answer: 42 } },
      });
      const consumer = new FakeAgent({ status: "success", summary: "Used exact mapped value" });
      const paused = await new VeyraEngine().run({
        config,
        workflow,
        cwd: path,
        goal: "Keep mappings",
        agents: { worker, consumer },
      });
      expect(paused.status).toBe("paused");
      const engine = new VeyraEngine();
      const request = { config, runId: paused.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      await engine.resolveApproval({
        ...request,
        approvalId: pending?.approvalId as string,
        decision: "approved",
      });
      expect((await engine.resume({ ...request, agents: { worker, consumer } })).status).toBe(
        "completed",
      );
      expect(worker.calls).toHaveLength(1);
      expect(consumer.calls[0]?.context?.inputs).toEqual({ selected: { answer: 42 } });
      expect(consumer.calls[0]?.artifacts).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            kind: "event-payload",
            producer: expect.objectContaining({ stepId: "work" }),
          }),
        ]),
      );
    });
  });

  it("stores retained verifier streams in an artifact and keeps exact deterministic evidence", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        version: 1,
        name: "logs",
        start: "verify",
        steps: {
          verify: {
            type: "command",
            run: [
              `node -e "process.stdout.write('a'.repeat(50000));process.stderr.write('b'.repeat(30000))"`,
            ],
          },
        },
      };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const run = await new VeyraEngine({ store }).run({
        config,
        workflow,
        cwd: path,
        goal: "Archive logs",
        agents: {},
      });
      expect(run.status).toBe("completed");
      const event = (await store.readEvents(run.runId)).find(
        (entry) => entry.type === "verification.completed",
      );
      expect(event).toMatchObject({
        success: true,
        results: [{ stdout: "a".repeat(50000), stderr: "b".repeat(30000) }],
        payload: { kind: "event-payload", producer: { stepId: "verify" } },
      });
      const lines = (
        await readFile(join(path, ".veyra", "runs", run.runId, "events.jsonl"), "utf8")
      )
        .trim()
        .split("\n");
      expect(lines.every((line) => Buffer.byteLength(line) <= MAX_INLINE_EVENT_BYTES)).toBe(true);
    });
  });

  it.each(["path", "digest", "missing", "preview"])(
    "refuses a %s corruption without discarding history",
    async (fault) => {
      await withFixtureWorkspace(async ({ path }) => {
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const run = await store.createRun({
          goal: "Corrupt payload",
          workflow: definition,
          cwd: path,
        });
        const event = await store.appendEvent(run.state.runId, completion(run.state.runId));
        const file = join(path, ".veyra", "runs", run.state.runId, "events.jsonl");
        const record = JSON.parse(await readFile(file, "utf8"));
        const payload = join(path, ".veyra", "runs", run.state.runId, record.artifact.path);
        if (fault === "path") record.artifact.path = "../../outside.json";
        if (fault === "digest") record.artifact.metadata.sha256 = "0".repeat(64);
        if (fault === "missing") await rm(payload);
        if (fault === "preview") record.preview = "Invented preview";
        const damaged = `${JSON.stringify(record)}\n`;
        await writeFile(file, damaged);
        await expect(store.readEvents(run.state.runId)).rejects.toBeDefined();
        await expect(
          store.appendEvent(run.state.runId, {
            type: "run.resumed",
            runId: run.state.runId,
            at: new Date().toISOString(),
          }),
        ).rejects.toBeDefined();
        expect(await readFile(file, "utf8")).toBe(damaged);
        expect(event.payload).toBeDefined();
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "refuses linked payload files without reading the target",
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const run = await store.createRun({
          goal: "Linked payload",
          workflow: definition,
          cwd: path,
        });
        const saved = await store.appendEvent(run.state.runId, completion(run.state.runId));
        const artifact = join(
          path,
          ".veyra",
          "runs",
          run.state.runId,
          saved.payload?.path as string,
        );
        const outside = join(path, "outside.json");
        await writeFile(outside, "unrelated data");
        await rm(artifact);
        await symlink(outside, artifact);
        await expect(store.readEvents(run.state.runId)).rejects.toMatchObject({
          code: "unsafe_path",
        });
        expect(await readFile(outside, "utf8")).toBe("unrelated data");
      });
    },
  );

  it.skipIf(process.platform === "win32")(
    "ignores a payload published before a killed writer appended its reference",
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const run = await store.createRun({
          goal: "Publication crash",
          workflow: definition,
          cwd: path,
        });
        const source = `import fs from 'node:fs';import {syncBuiltinESMExports} from 'node:module';const rename=fs.promises.rename;fs.promises.rename=async(...args)=>{await rename(...args);if(String(args[1]).includes('/artifacts/'))process.kill(process.pid,'SIGKILL');};syncBuiltinESMExports();const {LocalRunStore}=await import(${JSON.stringify(moduleUrl)});await new LocalRunStore({stateDir:process.argv[1]}).appendEvent(${JSON.stringify(run.state.runId)},{type:'agent.completed',runId:${JSON.stringify(run.state.runId)},stepId:'work',agentId:'worker',at:new Date().toISOString(),result:{status:'success',summary:'Published payload',data:{output:'x'.repeat(90000)}}});`;
        const child = await runProcess({
          executable: process.execPath,
          args: ["--import", "tsx", "--input-type=module", "-e", source, join(path, ".veyra")],
          timeoutMs: 15_000,
        });
        expect(child.signal, child.stderr).toBe("SIGKILL");
        expect(await store.readEvents(run.state.runId)).toEqual([]);
        expect(
          await readdir(join(path, ".veyra", "runs", run.state.runId, "artifacts")),
        ).toHaveLength(1);
        expect(
          (
            await store.appendEvent(run.state.runId, {
              type: "run.resumed",
              runId: run.state.runId,
              at: new Date().toISOString(),
            })
          ).sequence,
        ).toBe(1);
      });
    },
  );
});
