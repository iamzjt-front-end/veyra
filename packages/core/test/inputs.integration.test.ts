import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import type { AgentAdapter, AgentInput } from "@veyra/protocol";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { VeyraEngine, LocalRunStore } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } });
const ok = { status: "success" as const, summary: "Done" };
describe("resolved input audit and persistence", () => {
  it("resolves typed agent/verification/approval outputs after resume and persists the exact adapter input", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        name: "typed inputs",
        version: 1,
        start: "plan",
        steps: {
          plan: { type: "agent", agent: "planner", next: "verify" },
          verify: { type: "command", run: ["node --test"], next: "gate" },
          gate: {
            type: "human",
            message: "Approve evidence",
            inputs: {
              count: { from: "plan", path: "/data/count" },
              verified: { from: "verify", path: "/outcome" },
            },
            next: "execute",
          },
          execute: {
            type: "agent",
            agent: "executor",
            inputs: {
              approved: { from: "gate", path: "/outcome" },
              details: { from: "plan", path: "/data/details" },
              code: { from: "verify", path: "/results/0/exitCode" },
              artifact: { from: "plan", path: "/artifacts/0" },
            },
          },
        },
      };
      const planner = new FakeAgent({
        ...ok,
        data: { count: 2, details: [true, null, { label: "literal $(command)" }] },
        artifacts: [{ id: "plan-ref", kind: "plan", path: "does-not-exist.txt" }],
      });
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const engine = new VeyraEngine({ store });
      const paused = await engine.run({
        config,
        workflow,
        agents: { planner },
        cwd: path,
        goal: "inspect",
      });
      expect(paused.status).toBe("paused");
      const request = { config, cwd: path, runId: paused.runId };
      const pending = await engine.getPendingApproval(request);
      expect(pending?.context?.inputs).toEqual({ count: 2, verified: "success" });
      await engine.resolveApproval({
        ...request,
        approvalId: pending?.approvalId as string,
        decision: "approved",
        comment: "Evidence checked",
      });
      let received: AgentInput | undefined;
      const executor: AgentAdapter = {
        id: "executor",
        provider: "fixture",
        run: async (input) => {
          const inputEvent = (await store.readEvents(input.runId)).find(
            (event) => event.type === "agent.input" && event.stepId === "execute",
          );
          expect(inputEvent?.type === "agent.input" && inputEvent.input).toEqual(input);
          received = structuredClone(input);
          input.context = { tamperedByAdapter: true };
          return ok;
        },
      };
      expect(
        (await new VeyraEngine({ store }).resume({ ...request, agents: { executor } })).status,
      ).toBe("completed");
      expect(received?.context?.inputs).toEqual({
        approved: "approved",
        details: [true, null, { label: "literal $(command)" }],
        code: 0,
        artifact: { id: "plan-ref", kind: "plan", path: "does-not-exist.txt" },
      });
      const records = await store.readEvents(paused.runId);
      const audited = records.find(
        (event) => event.type === "agent.input" && event.stepId === "execute",
      );
      expect(audited?.type === "agent.input" && audited.input).toEqual(received);
      expect(JSON.stringify(audited)).not.toContain("tamperedByAdapter");
      expect(planner.calls).toHaveLength(1);
    });
  });

  it.each(["missing-output", "missing-field", "too-large"])(
    "persists %s before invoking the dependent adapter",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        const planner = new FakeAgent({
          ...ok,
          data: { value: scenario === "too-large" ? "x".repeat(40_000) : "small" },
        });
        const executor = new FakeAgent(ok);
        const workflow: WorkflowDefinition = {
          name: "unresolved",
          version: 1,
          start: "plan",
          steps: {
            plan: { type: "agent", agent: "planner", next: "execute" },
            skipped: { type: "agent", agent: "planner" },
            execute: {
              type: "agent",
              agent: "executor",
              inputs: {
                required: {
                  from: scenario === "missing-output" ? "skipped" : "plan",
                  path: scenario === "missing-field" ? "/data/missing" : "/data/value",
                },
              },
            },
          },
        };
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow,
          agents: { planner, executor },
          cwd: path,
          goal: "work",
        });
        const code = scenario === "too-large" ? "input_too_large" : "input_unavailable";
        expect(result).toMatchObject({ status: "failed", error: { code } });
        expect(executor.calls).toHaveLength(0);
        expect((await store.readEvents(result.runId)).at(-1)).toMatchObject({
          type: "run.failed",
          error: { code },
        });
      });
    },
  );

  it("redacts both selected values and credential-shaped input names while keeping workflow references valid", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const secret = "fixture-input-secret";
      const planner = new FakeAgent({
        ...ok,
        data: { token: secret, public: `contains ${secret}` },
      });
      const executor = new FakeAgent(ok);
      const workflow: WorkflowDefinition = {
        name: "redaction",
        version: 1,
        start: "plan",
        steps: {
          plan: { type: "agent", agent: "planner", next: "execute" },
          execute: {
            type: "agent",
            agent: "executor",
            inputs: {
              apiKey: { from: "plan", path: "/data/token" },
              selected: { from: "plan", path: "/data/public" },
            },
          },
        },
      };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra"), redactValues: [secret] });
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow,
        agents: { planner, executor },
        cwd: path,
        goal: "work",
      });
      expect(result.status).toBe("completed");
      expect(executor.calls[0]?.context?.inputs).toEqual({
        apiKey: "[REDACTED]",
        selected: "contains [REDACTED]",
      });
      expect(
        (await store.loadRun(result.runId)).input.workflow.steps.execute?.inputs?.apiKey,
      ).toEqual({ from: "plan", path: "/data/token" });
      const events = await readFile(
        join(path, ".veyra/runs", result.runId, "events.jsonl"),
        "utf8",
      );
      expect(events).not.toContain(secret);
      expect(events).not.toContain('"signal"');
      expect(events).not.toContain('"timeoutMs"');
    });
  });

  it("bounds the full audited agent envelope before provider invocation", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const agent = new FakeAgent(ok);
      const workflow: WorkflowDefinition = {
        name: "oversized goal",
        version: 1,
        start: "work",
        steps: { work: { type: "agent", agent: "worker" } },
      };
      const result = await new VeyraEngine().run({
        config,
        workflow,
        agents: { worker: agent },
        cwd: path,
        goal: "x".repeat(256 * 1024),
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "input_too_large" } });
      expect(agent.calls).toHaveLength(0);
    });
  });
});
