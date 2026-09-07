import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { parseConfig } from "@veyra/config";
import type { AgentAdapter, AgentInput, AgentResult } from "@veyra/protocol";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine, type BudgetCheck, type BudgetHook } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "policies" } });
const ok: AgentResult = { status: "success", summary: "Done" };
const definition = (): WorkflowDefinition => ({
  name: "policy",
  version: 1,
  start: "work",
  steps: { work: { type: "agent", agent: "worker" } },
});
const storeAt = (path: string) => new LocalRunStore({ stateDir: join(path, ".veyra") });

describe("persisted workflow policy enforcement", () => {
  it("preserves a first repair's budget through a generated approval gate", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { approval: { before: ["fix"] } };
      workflow.steps.work = { type: "agent", agent: "worker", on: { failure: "fix" } };
      workflow.steps.fix = { type: "agent", agent: "fixer", retry: { max: 0 } };
      const fixer = new FakeAgent(ok);
      const engine = new VeyraEngine({ store: storeAt(path) });
      const run = await engine.run({
        config,
        workflow,
        cwd: path,
        goal: "Approval preserves retry policy",
        agents: { worker: new FakeAgent({ status: "failure", summary: "Repair needed" }), fixer },
      });
      expect(run).toMatchObject({ status: "paused", lastStep: "@approval/fix" });
      const pending = await engine.getPendingApproval({ config, cwd: path, runId: run.runId });
      if (!pending) throw new Error("Missing gate");
      await engine.resolveApproval({
        config,
        cwd: path,
        runId: run.runId,
        approvalId: pending.approvalId,
        decision: "approved",
      });
      const result = await new VeyraEngine({ store: storeAt(path) }).resume({
        config,
        cwd: path,
        runId: run.runId,
        agents: { fixer },
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "retry_exhausted" } });
      expect(fixer.calls).toHaveLength(0);
    });
  });
  it("requires another policy approval before resuming a protected paused agent", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { approval: { before: ["work"] } };
      const worker = new FakeAgent({ status: "needs_input", summary: "Wait" });
      const engine = new VeyraEngine({ store: storeAt(path) });
      const run = await engine.run({
        config,
        workflow,
        cwd: path,
        goal: "Reapprove resumed agent",
        agents: { worker },
      });
      const pending = await engine.getPendingApproval({ config, cwd: path, runId: run.runId });
      if (!pending) throw new Error("Missing gate");
      await engine.resolveApproval({
        config,
        cwd: path,
        runId: run.runId,
        approvalId: pending.approvalId,
        decision: "approved",
      });
      expect(
        await engine.resume({ config, cwd: path, runId: run.runId, agents: { worker } }),
      ).toMatchObject({ status: "paused", lastStep: "work" });
      const fresh = new VeyraEngine({ store: storeAt(path) });
      const after = new FakeAgent(ok);
      expect(
        await fresh.resume({ config, cwd: path, runId: run.runId, agents: { worker: after } }),
      ).toMatchObject({ status: "paused", lastStep: "@approval/work" });
      const next = await fresh.getPendingApproval({ config, cwd: path, runId: run.runId });
      if (!next) throw new Error("Missing new gate");
      expect(next.approvalId).not.toBe(pending.approvalId);
      expect(after.calls).toHaveLength(0);
      await fresh.resolveApproval({
        config,
        cwd: path,
        runId: run.runId,
        approvalId: next.approvalId,
        decision: "approved",
      });
      expect(
        (await fresh.resume({ config, cwd: path, runId: run.runId, agents: { worker: after } }))
          .status,
      ).toBe("completed");
      expect(after.calls[0]?.attempt).toBe(2);
    });
  });
  it("counts actual step starts when exhausted retries route to a human gate", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { maxSteps: 2, retry: { max: 0 } };
      workflow.steps.work = {
        type: "agent",
        agent: "worker",
        on: { again: "work", retry_exhausted: "inspect" },
      };
      workflow.steps.inspect = { type: "human" };
      const store = storeAt(path);
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow,
        agents: { worker: new FakeAgent({ ...ok, outcome: "again" }) },
        cwd: path,
        goal: "Count persisted starts",
      });
      expect(result).toMatchObject({ status: "paused", lastStep: "inspect" });
      expect(
        (await store.readEvents(result.runId))
          .filter((event) => event.type === "step.started")
          .map((event) => event.stepId),
      ).toEqual(["work", "inspect"]);
    });
  });
  it("requires a fresh explicit human decision before each protected invocation", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { approval: { before: ["work"] }, retry: { max: 1 } };
      workflow.steps.work = { type: "agent", agent: "worker", on: { again: "work", done: "done" } };
      workflow.steps.done = { type: "end" };
      const calls: AgentInput[] = [];
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (input) => {
          calls.push(input);
          return { ...ok, outcome: input.attempt === 1 ? "again" : "done" };
        },
      };
      const engine = new VeyraEngine({ store: storeAt(path) });
      const run = await engine.run({
        config,
        workflow,
        agents: { worker },
        cwd: path,
        goal: "Approve twice",
      });
      expect(run).toMatchObject({ status: "paused", lastStep: "@approval/work" });
      expect(calls).toHaveLength(0);
      const seen: string[] = [];
      for (let index = 0; index < 2; index++) {
        const fresh = new VeyraEngine({ store: storeAt(path) });
        const pending = await fresh.getPendingApproval({ config, cwd: path, runId: run.runId });
        if (!pending) throw new Error("Missing policy gate");
        expect(seen).not.toContain(pending.approvalId);
        seen.push(pending.approvalId);
        await expect(
          fresh.resume({ config, cwd: path, runId: run.runId, agents: { worker } }),
        ).rejects.toMatchObject({ code: "approval_required" });
        await fresh.resolveApproval({
          config,
          cwd: path,
          runId: run.runId,
          approvalId: pending.approvalId,
          decision: "approved",
        });
        const result = await fresh.resume({
          config,
          cwd: path,
          runId: run.runId,
          agents: { worker },
        });
        expect(result.status).toBe(index === 0 ? "paused" : "completed");
      }
      expect(calls.map((call) => call.attempt)).toEqual([1, 2]);
    });
  });

  it("rejects a generated gate without invoking protected work", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { approval: { before: ["work"] } };
      const worker = new FakeAgent(ok);
      const engine = new VeyraEngine({ store: storeAt(path) });
      const run = await engine.run({
        config,
        workflow,
        agents: { worker },
        cwd: path,
        goal: "Reject work",
      });
      const pending = await engine.getPendingApproval({ config, cwd: path, runId: run.runId });
      if (!pending) throw new Error("Missing gate");
      expect(
        await engine.resolveApproval({
          config,
          cwd: path,
          runId: run.runId,
          approvalId: pending.approvalId,
          decision: "rejected",
        }),
      ).toMatchObject({ status: "failed" });
      expect(worker.calls).toHaveLength(0);
    });
  });

  it("enforces one wall-clock deadline across a command list and drains the subprocess", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { stepTimeoutMs: 250 };
      workflow.steps.work = {
        type: "command",
        run: ["node --version", 'node -e "setInterval(() => {}, 1000)"'],
        next: "after",
      };
      workflow.steps.after = { type: "agent", agent: "worker" };
      const worker = new FakeAgent(ok);
      const store = storeAt(path);
      const start = Date.now();
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow,
        agents: { worker },
        cwd: path,
        goal: "Bound command work",
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "step_timeout" } });
      expect(Date.now() - start).toBeLessThan(4000);
      expect(worker.calls).toHaveLength(0);
      expect(
        (await store.readEvents(result.runId)).some(
          (event) => event.type === "verification.completed",
        ),
      ).toBe(true);
    });
  });

  it("signals an agent deadline and waits for its cleanup before failing", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { stepTimeoutMs: 500 };
      let drained = false;
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (_input, options) => {
          expect(options?.timeoutMs).toBe(500);
          await new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          await delay(15);
          drained = true;
          return ok;
        },
      };
      const result = await new VeyraEngine({ store: storeAt(path) }).run({
        config,
        workflow,
        agents: { worker },
        timeoutMs: 5000,
        cwd: path,
        goal: "Deadline cleanup",
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "step_timeout" } });
      expect(drained).toBe(true);
    });
  });

  it("does not invoke a provider after the deadline expires while persisting its input", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { stepTimeoutMs: 10 };
      const worker = new FakeAgent(ok);
      const result = await new VeyraEngine({
        store: storeAt(path),
        emit: async (event) => {
          if (event.type === "agent.input") await delay(25);
        },
      }).run({ config, workflow, agents: { worker }, cwd: path, goal: "No late invocation" });
      expect(result).toMatchObject({ status: "failed", error: { code: "step_timeout" } });
      expect(worker.calls).toHaveLength(0);
    });
  });

  it("persists retry delays and cancels during backoff before another invocation", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { retry: { max: 2, backoff: { initialMs: 30, maxMs: 60 } } };
      workflow.steps.work = { type: "agent", agent: "worker", on: { failure: "work" } };
      const worker = new FakeAgent({ status: "failure", summary: "Retry" });
      const controller = new AbortController();
      const store = storeAt(path);
      const run = await new VeyraEngine({
        store,
        emit: (event) => {
          if (event.type === "step.retrying" && event.retryCount === 2) controller.abort();
        },
      }).run({
        config,
        workflow,
        agents: { worker },
        cwd: path,
        goal: "Bound retry delay",
        signal: controller.signal,
      });
      expect(run).toMatchObject({ status: "failed", error: { code: "run_cancelled" } });
      expect(worker.calls).toHaveLength(2);
      const events = await store.readEvents(run.runId);
      const retries = events.filter((event) => event.type === "step.retrying");
      expect(retries.map((event) => event.delayMs)).toEqual([30, 60]);
      const nextInput = events.find((event) => event.type === "agent.input" && event.attempt === 2);
      expect(
        Date.parse(nextInput?.at as string) - Date.parse(retries[0]?.at as string),
      ).toBeGreaterThanOrEqual(25);
    });
  });

  it("keeps saved timeout/retry caps when resuming with changed config and request controls", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { stepTimeoutMs: 2000, retry: { max: 1, backoff: { initialMs: 5 } } };
      const store = storeAt(path);
      const run = await new VeyraEngine({ store }).run({
        config,
        workflow,
        agents: { worker: new FakeAgent({ status: "needs_input", summary: "Wait" }) },
        cwd: path,
        goal: "Keep snapshot",
      });
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (_input, options) => {
          expect(options?.timeoutMs).toBe(2000);
          return ok;
        },
      };
      const changed = parseConfig({
        version: 1,
        agents: {},
        workflow: { use: "other" },
        runtime: { maxFixIterations: 99 },
      });
      const result = await new VeyraEngine({ store: storeAt(path) }).resume({
        config: changed,
        runId: run.runId,
        agents: { worker },
        cwd: path,
        timeoutMs: 10000,
      });
      expect(result.status).toBe("completed");
      expect((await store.loadRun(result.runId)).input.workflow.steps.work).toMatchObject({
        timeoutMs: 2000,
        retry: { max: 1, backoff: { initialMs: 5 } },
      });
    });
  });

  it.each(["branch", "stop"] as const)(
    "applies the %s failure strategy inside child workflows",
    async (strategy) => {
      await withFixtureWorkspace(async ({ path }) => {
        const child = definition();
        const workflow: WorkflowDefinition = {
          name: "failure-policy",
          version: 1,
          start: "call",
          policy: { failureStrategy: strategy },
          steps: {
            call: { type: "subworkflow", workflow: child, on: { failure: "recover" } },
            recover: { type: "agent", agent: "recovery" },
          },
        };
        const recovery = new FakeAgent(ok);
        const result = await new VeyraEngine({ store: storeAt(path) }).run({
          config,
          workflow,
          agents: { worker: new FakeAgent({ status: "failure", summary: "Failed" }), recovery },
          cwd: path,
          goal: "Failure policy",
        });
        expect(result.status).toBe(strategy === "branch" ? "completed" : "failed");
        expect(recovery.calls).toHaveLength(strategy === "branch" ? 1 : 0);
      });
    },
  );

  it("caps group concurrency using the saved workflow policy", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { concurrency: 1, retry: { max: 2, backoff: { initialMs: 50 } } };
      workflow.steps.work = {
        type: "parallel",
        children: ["a", "b"],
        concurrency: 10,
        failurePolicy: "fail-fast",
        on: { failure: "again" },
      };
      workflow.steps.a = { type: "agent", agent: "worker" };
      workflow.steps.b = { type: "agent", agent: "worker" };
      workflow.steps.again = { type: "human" };
      let active = 0;
      let maximum = 0;
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async () => {
          maximum = Math.max(maximum, ++active);
          await delay(5);
          active--;
          return ok;
        },
      };
      const store = storeAt(path);
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow,
        agents: { worker },
        cwd: path,
        goal: "Cap parallelism",
      });
      expect(result.status).toBe("failed"); // Success has no declared continuation.
      expect(maximum).toBe(1);
      expect(
        (await store.readEvents(result.runId)).find((event) => event.type === "parallel.started"),
      ).toMatchObject({ concurrency: 1 });
    });
  });

  it(
    "interrupts an active peer's long retry backoff after fail-fast failure",
    { timeout: 15000 },
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const workflow = definition();
        workflow.policy = { retry: { max: 2, backoff: { initialMs: 30000 } } };
        workflow.steps.work = {
          type: "parallel",
          children: ["a", "b"],
          concurrency: 2,
          failurePolicy: "fail-fast",
          on: { failure: "inspect" },
        };
        workflow.steps.a = { type: "agent", agent: "worker", retry: { max: 0 } };
        workflow.steps.b = { type: "agent", agent: "worker" };
        workflow.steps.inspect = { type: "human" };
        const store = storeAt(path);
        const initial = await new VeyraEngine({ store }).run({
          config,
          workflow,
          agents: { worker: new FakeAgent({ status: "needs_input", summary: "Wait" }) },
          cwd: path,
          goal: "Cancel peer backoff",
        });
        expect(initial.status).toBe("paused");
        const worker = new FakeAgent(ok);
        const start = Date.now();
        const result = await new VeyraEngine({ store: storeAt(path) }).resume({
          config,
          runId: initial.runId,
          agents: { worker },
          cwd: path,
        });
        expect(Date.now() - start).toBeLessThan(10000);
        expect(result).toMatchObject({ status: "paused", lastStep: "inspect" });
        expect(worker.calls).toHaveLength(0);
      });
    },
  );

  it("enforces root and child lifetime step limits across pause/resume", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const child = definition();
      child.policy = { maxSteps: 1, retry: { max: 100 } };
      const workflow: WorkflowDefinition = {
        name: "step-budget",
        version: 1,
        start: "call",
        steps: {
          call: { type: "subworkflow", workflow: child, on: { failure: "done" } },
          done: { type: "end" },
        },
      };
      const worker = new FakeAgent({ status: "needs_input", summary: "Wait" });
      const store = storeAt(path);
      const paused = await new VeyraEngine({ store }).run({
        config,
        workflow,
        agents: { worker },
        cwd: path,
        goal: "Lifetime limit",
      });
      expect(paused.status).toBe("paused");
      const result = await new VeyraEngine({ store: storeAt(path) }).resume({
        config,
        runId: paused.runId,
        agents: { worker },
        cwd: path,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "transition_limit" } });
      expect(worker.calls).toHaveLength(1);
      const loop = definition();
      loop.policy = { maxSteps: 2, retry: { max: 100 } };
      loop.steps.work = { type: "agent", agent: "worker", next: "work" };
      const other = new FakeAgent(ok);
      const bounded = await new VeyraEngine({ store }).run({
        config,
        workflow: loop,
        agents: { worker: other },
        cwd: path,
        goal: "Bound loop",
      });
      expect(bounded).toMatchObject({ status: "failed", error: { code: "transition_limit" } });
      expect(other.calls).toHaveLength(2);
    });
  });

  it.each(["missing", "throws", "invalid", "deny"])(
    "fails closed when a declared budget hook is %s",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        const workflow = definition();
        workflow.policy = { budget: { maxTokens: 0, maxCost: { amount: 0, currency: "USD" } } };
        const budget: BudgetHook | undefined =
          scenario === "missing"
            ? undefined
            : async () => {
                if (scenario === "throws") throw new Error("Sensitive hook error");
                return scenario === "invalid"
                  ? ({} as ReturnType<BudgetHook>)
                  : { allowed: false, reason: "No budget remains" };
              };
        const worker = new FakeAgent(ok);
        const store = storeAt(path);
        const result = await new VeyraEngine({ store, budget }).run({
          config,
          workflow,
          agents: { worker },
          cwd: path,
          goal: "Budget denied",
        });
        expect(result.status).toBe("failed");
        expect(result.error?.code).toBe(
          scenario === "missing"
            ? "missing_budget_hook"
            : scenario === "deny"
              ? "budget_exceeded"
              : "budget_hook_failed",
        );
        expect(worker.calls).toHaveLength(0);
        expect(JSON.stringify(await store.readEvents(result.runId))).not.toContain(
          "Sensitive hook error",
        );
      });
    },
  );

  it("passes persisted token/cost observations and unknown usage to budget hooks across resume", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.policy = { budget: { maxTokens: 10 } };
      workflow.steps.work = { type: "agent", agent: "worker", next: "gate" };
      workflow.steps.gate = { type: "human", next: "after" };
      workflow.steps.after = { type: "agent", agent: "after" };
      const checks: BudgetCheck[] = [];
      const budget: BudgetHook = (check) => {
        checks.push(check);
        return { allowed: true };
      };
      const store = storeAt(path);
      const engine = new VeyraEngine({ store, budget });
      const run = await engine.run({
        config,
        workflow,
        agents: {
          worker: new FakeAgent({
            ...ok,
            usage: { totalTokens: 4, cost: { amount: 0.1, currency: "USD" } },
          }),
        },
        cwd: path,
        goal: "Persist budget evidence",
      });
      const pending = await engine.getPendingApproval({ config, cwd: path, runId: run.runId });
      if (!pending) throw new Error("Missing gate");
      await engine.resolveApproval({
        config,
        cwd: path,
        runId: run.runId,
        approvalId: pending.approvalId,
        decision: "approved",
      });
      const after = new FakeAgent(ok);
      expect(
        (
          await new VeyraEngine({ store: storeAt(path), budget }).resume({
            config,
            runId: run.runId,
            cwd: path,
            agents: { after },
          })
        ).status,
      ).toBe("completed");
      expect(checks.map((check) => check.phase)).toEqual(["before", "after", "before", "after"]);
      expect(checks[2]).toMatchObject({
        policies: [{ scopeId: "", limits: { maxTokens: 10 } }],
        observations: [{ usage: { totalTokens: 4, cost: { amount: 0.1, currency: "USD" } } }],
      });
      expect(checks[3]?.observations[1]?.usage).toBeUndefined();
      expect(
        (await store.readEvents(run.runId)).filter((event) => event.type === "budget.checked"),
      ).toHaveLength(4);
    });
  });

  it("denies after-result budget checks before transitions and drains active parallel peers", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      workflow.steps.work = {
        type: "parallel",
        children: ["one", "two"],
        on: { failure: "recover" },
      };
      workflow.steps.one = { type: "agent", agent: "one" };
      workflow.steps.two = { type: "agent", agent: "two" };
      workflow.steps.recover = { type: "agent", agent: "recover" };
      let ready = () => {};
      const peer = new Promise<void>((resolve) => {
        ready = resolve;
      });
      let drained = false;
      const one: AgentAdapter = {
        id: "one",
        provider: "fixture",
        run: async () => {
          await peer;
          return { ...ok, usage: { totalTokens: 11 } };
        },
      };
      const two: AgentAdapter = {
        id: "two",
        provider: "fixture",
        run: async (_input, options) => {
          const done = new Promise<void>((resolve) =>
            options?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
          ready();
          await done;
          drained = true;
          return ok;
        },
      };
      const recover = new FakeAgent(ok);
      const budget: BudgetHook = (check) => ({
        allowed: !(check.phase === "after" && check.execution.stepId === "one"),
        reason: "Fixture ceiling",
      });
      const result = await new VeyraEngine({ store: storeAt(path), budget }).run({
        config,
        workflow,
        agents: { one, two, recover },
        cwd: path,
        goal: "Budget stop",
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "budget_exceeded" } });
      expect(drained).toBe(true);
      expect(recover.calls).toHaveLength(0);
    });
  });
});
