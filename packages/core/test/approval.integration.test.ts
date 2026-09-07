import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import type { ApprovalDecision, VeyraEvent } from "@veyra/protocol";
import { runProcess } from "@veyra/runtime";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } });
const workflow: WorkflowDefinition = {
  name: "approval",
  version: 1,
  start: "plan",
  steps: {
    plan: { type: "agent", agent: "planner", next: "gate" },
    gate: {
      type: "human",
      message: "Approve the fixture change",
      on: { approved: "execute", rejected: "declined" },
    },
    execute: { type: "agent", agent: "executor", next: "done" },
    declined: { type: "end" },
    done: { type: "end" },
  },
};
const agents = () => ({
  planner: new FakeAgent({
    status: "success",
    summary: "Plan evidence",
    data: { instructions: "Change the fixture" },
  }),
  executor: new FakeAgent({ status: "success", summary: "Executed" }),
});

describe("human approval control", () => {
  it("exposes the persisted gate and context, then resolves explicitly before resuming", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registry = agents();
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const events: VeyraEvent[] = [];
      const engine = new VeyraEngine({
        store,
        emit: (event) => {
          events.push(event);
        },
      });
      const result = await engine.run({
        config,
        workflow,
        agents: registry,
        goal: "Fixture approval",
        cwd: path,
      });
      const request = { config, runId: result.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      expect(pending).toMatchObject({
        stepId: "gate",
        message: "Approve the fixture change",
        context: { steps: { plan: { summary: "Plan evidence" } } },
      });
      expect(pending?.approvalId).toMatch(/^[0-9a-f-]{36}$/);
      await expect(engine.resume({ ...request, agents: registry })).rejects.toMatchObject({
        code: "approval_required",
      });
      expect(registry.executor.calls).toHaveLength(0);
      const resolved = await engine.resolveApproval({
        ...request,
        approvalId: pending?.approvalId ?? "",
        decision: "approved",
        comment: "The fixture scope is approved",
      });
      expect(resolved.status).toBe("paused");
      expect(registry.executor.calls).toHaveLength(0);
      expect(await engine.getPendingApproval(request)).toBeNull();
      expect((await store.loadRun(result.runId)).state).toMatchObject({
        currentStep: "execute",
        lastOutcome: "approved",
      });
      const resumed = await new VeyraEngine({ store }).resume({ ...request, agents: registry });
      expect(resumed.status).toBe("completed");
      expect(registry.planner.calls).toHaveLength(1);
      expect(registry.executor.calls).toHaveLength(1);
      expect(registry.executor.calls[0]?.context?.steps).toMatchObject({
        gate: { type: "human", outcome: "approved", comment: "The fixture scope is approved" },
      });
      expect(events.find((event) => event.type === "approval.resolved")).toMatchObject({
        approvalId: pending?.approvalId,
        decision: "approved",
        comment: "The fixture scope is approved",
      });
    });
  });

  it("takes an explicit rejected branch without executing the approved action", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registry = agents();
      const engine = new VeyraEngine();
      const paused = await engine.run({
        config,
        workflow,
        agents: registry,
        goal: "fixture",
        cwd: path,
      });
      const request = { config, runId: paused.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      await engine.resolveApproval({
        ...request,
        approvalId: pending?.approvalId ?? "",
        decision: "rejected",
      });
      expect(await engine.resume({ ...request, agents: registry })).toMatchObject({
        status: "completed",
        lastStep: "declined",
      });
      expect(registry.executor.calls).toHaveLength(0);
    });
  });

  it("fails rejection without a rejection branch, even when next is configured", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const local = structuredClone(workflow);
      local.steps.gate = { type: "human", next: "execute" };
      const registry = agents();
      const engine = new VeyraEngine();
      const paused = await engine.run({
        config,
        workflow: local,
        agents: registry,
        goal: "fixture",
        cwd: path,
      });
      const request = { config, runId: paused.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      expect(
        await engine.resolveApproval({
          ...request,
          approvalId: pending?.approvalId ?? "",
          decision: "rejected",
        }),
      ).toMatchObject({ status: "failed", error: { code: "approval_rejected" } });
      await expect(engine.resume({ ...request, agents: registry })).rejects.toMatchObject({
        code: "run_not_paused",
      });
      expect(registry.executor.calls).toHaveLength(0);
    });
  });

  it("rejects invalid, stale, and duplicate decisions without adding another resolution", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const engine = new VeyraEngine();
      const paused = await engine.run({
        config,
        workflow,
        agents: agents(),
        goal: "fixture",
        cwd: path,
      });
      const request = { config, runId: paused.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      await expect(
        engine.resolveApproval({ ...request, approvalId: "stale", decision: "approved" }),
      ).rejects.toMatchObject({ code: "approval_not_pending" });
      await expect(
        engine.resolveApproval({
          ...request,
          approvalId: pending?.approvalId ?? "",
          decision: "maybe" as ApprovalDecision,
        }),
      ).rejects.toMatchObject({ code: "invalid_approval" });
      await engine.resolveApproval({
        ...request,
        approvalId: pending?.approvalId ?? "",
        decision: "approved",
      });
      await expect(
        engine.resolveApproval({
          ...request,
          approvalId: pending?.approvalId ?? "",
          decision: "rejected",
        }),
      ).rejects.toMatchObject({ code: "approval_not_pending" });
      const events = await new LocalRunStore({ stateDir: join(path, ".veyra") }).readEvents(
        paused.runId,
      );
      expect(events.filter((event) => event.type === "approval.resolved")).toHaveLength(1);
    });
  });

  it("serializes conflicting approval submissions within one engine", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const engine = new VeyraEngine();
      const paused = await engine.run({
        config,
        workflow,
        agents: agents(),
        goal: "fixture",
        cwd: path,
      });
      const request = { config, runId: paused.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      const submitted = await Promise.allSettled([
        engine.resolveApproval({
          ...request,
          approvalId: pending?.approvalId ?? "",
          decision: "approved",
        }),
        engine.resolveApproval({
          ...request,
          approvalId: pending?.approvalId ?? "",
          decision: "rejected",
        }),
      ]);
      expect(submitted.map((result) => result.status)).toEqual(["fulfilled", "rejected"]);
      expect(
        (await new LocalRunStore({ stateDir: join(path, ".veyra") }).loadRun(paused.runId)).state
          .currentStep,
      ).toBe("execute");
    });
  });

  it("requests a fresh ID for each consecutive human gate", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const local = structuredClone(workflow);
      local.steps.gate = { type: "human", next: "second" };
      local.steps.second = { type: "human", next: "execute" };
      const registry = agents();
      const engine = new VeyraEngine();
      const paused = await engine.run({
        config,
        workflow: local,
        agents: registry,
        goal: "fixture",
        cwd: path,
      });
      const request = { config, runId: paused.runId, cwd: path };
      const first = await engine.getPendingApproval(request);
      await engine.resolveApproval({
        ...request,
        approvalId: first?.approvalId ?? "",
        decision: "approved",
      });
      expect((await engine.resume({ ...request, agents: registry })).status).toBe("paused");
      const second = await engine.getPendingApproval(request);
      expect(second?.stepId).toBe("second");
      expect(second?.approvalId).not.toBe(first?.approvalId);
      await expect(
        engine.resolveApproval({
          ...request,
          approvalId: first?.approvalId ?? "",
          decision: "approved",
        }),
      ).rejects.toMatchObject({ code: "approval_not_pending" });
      expect(registry.executor.calls).toHaveLength(0);
    });
  });

  it("can approve a terminal human step", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const local: WorkflowDefinition = {
        name: "terminal",
        version: 1,
        start: "gate",
        steps: { gate: { type: "human" } },
      };
      const engine = new VeyraEngine();
      const paused = await engine.run({
        config,
        workflow: local,
        agents: {},
        goal: "fixture",
        cwd: path,
      });
      const request = { config, runId: paused.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      expect(
        (
          await engine.resolveApproval({
            ...request,
            approvalId: pending?.approvalId ?? "",
            decision: "approved",
          })
        ).status,
      ).toBe("completed");
    });
  });

  it("keeps the saved decision intact if a subscriber fails during publication", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const engine = new VeyraEngine({
        emit: (event) => {
          if (event.type === "approval.resolved") throw new Error("UI disconnected");
        },
      });
      const paused = await engine.run({
        config,
        workflow,
        agents: agents(),
        goal: "fixture",
        cwd: path,
      });
      const request = { config, runId: paused.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      await expect(
        engine.resolveApproval({
          ...request,
          approvalId: pending?.approvalId ?? "",
          decision: "approved",
        }),
      ).rejects.toMatchObject({ code: "approval_recorded_notification_failed" });
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      expect((await store.loadRun(paused.runId)).state).toMatchObject({
        status: "paused",
        currentStep: "execute",
      });
      expect((await store.readEvents(paused.runId)).at(-1)?.type).toBe("run.paused");
    });
  });

  it("redacts approval comments before persistence, publication, and future context", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const secret = "fixture-approval-secret";
      const registry = agents();
      const emitted: VeyraEvent[] = [];
      const engine = new VeyraEngine({
        redactValues: [secret],
        emit: (event) => {
          emitted.push(event);
        },
      });
      const paused = await engine.run({
        config,
        workflow,
        agents: registry,
        goal: "fixture",
        cwd: path,
      });
      const request = { config, runId: paused.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      await engine.resolveApproval({
        ...request,
        approvalId: pending?.approvalId ?? "",
        decision: "approved",
        comment: `Scoped approval ${secret}`,
      });
      await engine.resume({ ...request, agents: registry });
      expect(JSON.stringify(emitted)).not.toContain(secret);
      expect(JSON.stringify(registry.executor.calls)).not.toContain(secret);
      expect(
        await readFile(join(path, ".veyra", "runs", paused.runId, "events.jsonl"), "utf8"),
      ).not.toContain(secret);
    });
  });

  it("exits at a gate in one process, then independently approves and performs the real fixture action", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const local: WorkflowDefinition = {
        name: "real-gate",
        version: 1,
        start: "gate",
        steps: {
          gate: { type: "human", message: "Create the disposable fixture marker", next: "execute" },
          execute: {
            type: "command",
            run: ["node -e \"require('node:fs').writeFileSync('approved.txt', 'approved')\""],
          },
        },
      };
      const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
      const source = `import { VeyraEngine } from ${JSON.stringify(moduleUrl)};
const run = await new VeyraEngine().run({ config: ${JSON.stringify(config)}, workflow: ${JSON.stringify(local)}, agents: {}, goal: 'fixture approval', cwd: process.argv[1] });
console.log(run.runId);`;
      const child = await runProcess({
        executable: process.execPath,
        args: ["--import", "tsx", "--input-type=module", "-e", source, path],
        timeoutMs: 30_000,
      });
      expect(child.exitCode, child.stderr).toBe(0);
      const request = { config, runId: child.stdout.trim(), cwd: path };
      const reader = new VeyraEngine();
      const pending = await reader.getPendingApproval(request);
      await expect(access(join(path, "approved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      await reader.resolveApproval({
        ...request,
        approvalId: pending?.approvalId ?? "",
        decision: "approved",
        comment: "Approve this disposable test action",
      });
      await expect(access(join(path, "approved.txt"))).rejects.toMatchObject({ code: "ENOENT" });
      expect((await new VeyraEngine().resume({ ...request, agents: {} })).status).toBe("completed");
      expect(await readFile(join(path, "approved.txt"), "utf8")).toBe("approved");
    });
  });
});
