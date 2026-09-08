import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { AgentAdapter, AgentResult, VeyraEvent } from "@veyraoss/protocol";
import type { AgentRuntime } from "@veyraoss/runtime";
import type { Verifier } from "@veyraoss/verifier";
import { loadWorkflow, type WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, StateStoreError, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "dev" } });
const dev = await loadWorkflow("dev");
const ok = { status: "success", summary: "Done" } satisfies AgentResult;
function agents() {
  return {
    planner: new FakeAgent(
      {
        ...ok,
        data: { instructions: "Repair the greeting" },
        artifacts: [{ id: "plan", kind: "plan", path: "plan.json" }],
      },
      "plan-agent",
    ),
    executor: new FakeAgent(ok, "code-agent"),
    reviewer: new FakeAgent({ ...ok, outcome: "pass" }, "quality-agent"),
  };
}
function verifier(outcomes = [true]) {
  let index = 0;
  return {
    verify: vi.fn<Verifier["verify"]>(async ({ commands }) => {
      const success = outcomes[Math.min(index++, outcomes.length - 1)] ?? true;
      return {
        success,
        durationMs: 1,
        results: (success ? commands : commands.slice(0, 1)).map((command) => ({
          command,
          success,
          exitCode: success ? 0 : 1,
          stdout: success ? "passed" : "fixture assertion failed",
          stderr: "",
          durationMs: 1,
        })),
      };
    }),
  };
}
const oneStep = (agent = "custom"): WorkflowDefinition => ({
  name: "custom",
  version: 1,
  start: "work",
  steps: { work: { type: "agent", agent, next: "done" }, done: { type: "end" } },
});

describe("Core orchestration", () => {
  it("runs the complete default dev workflow with persisted events, input context and execution controls", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const registry = agents();
      const check = verifier();
      const events: VeyraEvent[] = [];
      const runtime: AgentRuntime = {
        runAgent: vi.fn(async (adapter, input, options) => {
          expect((await store.loadRun(input.runId)).state).toMatchObject({
            status: "running",
            currentStep: input.stepId,
          });
          expect((await store.readEvents(input.runId)).at(-1)?.type).toBe("agent.started");
          expect(options).toMatchObject({ cwd: path, timeoutMs: 20_000, signal });
          return adapter.run(input, options);
        }),
      };
      const signal = new AbortController().signal;
      const engine = new VeyraEngine({
        store,
        verifier: check,
        runtime,
        emit: (event) => {
          events.push(event);
        },
      });
      const result = await engine.run({
        config,
        workflow: dev,
        goal: "Repair fixture",
        agents: registry,
        cwd: path,
        timeoutMs: 20_000,
        signal,
      });
      expect(result).toMatchObject({ status: "completed", lastStep: "done" });
      expect((await store.loadRun(result.runId)).state).toMatchObject({
        status: "completed",
        lastOutcome: "pass",
      });
      expect((await store.loadRun(result.runId)).state.currentStep).toBeUndefined();
      expect(
        events.filter((event) => event.type === "step.started").map((event) => event.stepId),
      ).toEqual(["plan", "execute", "verify", "review", "done"]);
      expect(await store.readEvents(result.runId)).toEqual(events);
      expect(events.map((event) => event.sequence)).toEqual(events.map((_, index) => index + 1));
      expect(events.at(-1)?.type).toBe("run.completed");
      expect(registry.executor.calls[0]?.context?.steps).toMatchObject({
        plan: { data: { instructions: "Repair the greeting" } },
      });
      expect(registry.executor.calls[0]?.artifacts).toEqual([
        { id: "plan", kind: "plan", path: "plan.json" },
      ]);
      expect(registry.reviewer.calls[0]?.context?.steps).toMatchObject({
        execute: { summary: "Done" },
        verify: {
          outcome: "success",
          results: [{ command: "pnpm check" }, { command: "pnpm test" }, { command: "pnpm build" }],
        },
      });
      expect(check.verify.mock.calls[0]?.[0]).toMatchObject({
        commands: ["pnpm check", "pnpm test", "pnpm build"],
        cwd: path,
        timeoutMs: 20_000,
        signal,
      });
    });
  });

  it("routes verification failure to fix and supplies the failing evidence", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registry = agents();
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const check = verifier([false, true]);
      const result = await new VeyraEngine({ store, verifier: check }).run({
        config,
        workflow: dev,
        goal: "repair",
        agents: registry,
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(registry.executor.calls.map((call) => call.stepId)).toEqual(["execute", "fix"]);
      expect(registry.executor.calls[1]?.context?.steps).toMatchObject({
        verify: {
          outcome: "failure",
          results: [{ stdout: "fixture assertion failed", exitCode: 1 }],
        },
      });
      expect(
        (await store.readEvents(result.runId)).filter((event) => event.type === "step.failed"),
      ).toHaveLength(1);
    });
  });

  it("routes reviewer fail independently of provider completion status", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registry = agents();
      let count = 0;
      const reviewer: AgentAdapter = {
        id: "independent-review",
        provider: "another-vendor",
        run: async () => ({
          ...ok,
          outcome: ++count === 1 ? "fail" : "pass",
          data: { requiredFixes: ["Add the missing greeting"] },
        }),
      };
      const result = await new VeyraEngine({ verifier: verifier() }).run({
        config,
        workflow: dev,
        goal: "repair",
        agents: { ...registry, reviewer },
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(registry.executor.calls[1]?.context?.steps).toMatchObject({
        review: { outcome: "fail", data: { requiredFixes: ["Add the missing greeting"] } },
      });
    });
  });

  it("persists thrown provider failures and redacts secrets before events, context, or returned errors escape", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const secret = "fixture-credential-123";
      const emitted: VeyraEvent[] = [];
      const broken: AgentAdapter = {
        id: "custom",
        provider: "custom-provider",
        run: async () => {
          throw new Error(`connection rejected ${secret}`);
        },
      };
      const result = await new VeyraEngine({
        redactValues: [secret],
        emit: (event) => {
          emitted.push(event);
        },
      }).run({ config, workflow: oneStep(), goal: "work", agents: { custom: broken }, cwd: path });
      expect(result).toMatchObject({
        status: "failed",
        lastStep: "work",
        error: { code: "agent_execution_failed" },
      });
      expect(result.error?.message).toContain("connection rejected [REDACTED]");
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      expect((await store.loadRun(result.runId)).state.status).toBe("failed");
      expect(emitted.slice(-3).map((event) => event.type)).toEqual([
        "agent.failed",
        "step.failed",
        "run.failed",
      ]);
      expect(JSON.stringify(emitted)).not.toContain(secret);
      expect(
        await readFile(join(store.directory, "runs", result.runId, "events.jsonl"), "utf8"),
      ).not.toContain(secret);
    });
  });

  it("reports a missing adapter, including a prototype-shaped key", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const result = await new VeyraEngine().run({
        config,
        workflow: oneStep("toString"),
        goal: "work",
        agents: {},
        cwd: path,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "missing_adapter" } });
      expect(result.error?.message).toContain("toString");
    });
  });

  it.each(["failure", "fail"])(
    "never falls through next to success for unhandled %s",
    async (failure) => {
      await withFixtureWorkspace(async ({ path }) => {
        const agent = new FakeAgent(
          failure === "failure"
            ? { status: "failure", summary: "", outcome: "pass" }
            : { ...ok, outcome: "fail" },
        );
        const result = await new VeyraEngine().run({
          config,
          workflow: oneStep(),
          goal: "work",
          agents: { custom: agent },
          cwd: path,
        });
        expect(result).toMatchObject({
          status: "failed",
          error: { code: "unhandled_step_failure" },
        });
      });
    },
  );

  it("fails on an unrecognized reviewer outcome instead of reporting completion", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const result = await new VeyraEngine({ verifier: verifier() }).run({
        config,
        workflow: dev,
        goal: "work",
        agents: { ...agents(), reviewer: new FakeAgent(ok) },
        cwd: path,
      });
      expect(result.error?.code).toBe("unhandled_outcome");
    });
  });

  it.each(["human", "needs_input"])(
    "persists a pause for %s without executing its successor",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        const workflow = oneStep();
        if (kind === "human")
          workflow.steps.work = { type: "human", message: "Approve fixture change", next: "done" };
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow,
          goal: "work",
          agents: {
            custom: new FakeAgent({ status: "needs_input", summary: "Permission required" }),
          },
          cwd: path,
        });
        expect(result).toMatchObject({ status: "paused", lastStep: "work" });
        expect((await store.loadRun(result.runId)).state).toMatchObject({
          status: "paused",
          currentStep: "work",
        });
        const events = await store.readEvents(result.runId);
        expect(events.at(-1)?.type).toBe("run.paused");
        expect(events.some((event) => event.type === "run.completed")).toBe(false);
        if (kind === "human")
          expect(events.find((event) => event.type === "approval.required")).toMatchObject({
            message: "Approve fixture change",
          });
      });
    },
  );

  it("fails cancelled runs before invoking a provider", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const agent = new FakeAgent(ok);
      const result = await new VeyraEngine().run({
        config,
        workflow: oneStep(),
        goal: "work",
        agents: { custom: agent },
        cwd: path,
        signal: AbortSignal.abort(),
      });
      expect(result.error?.code).toBe("run_cancelled");
      expect(agent.calls).toHaveLength(0);
    });
  });

  it("uses the real verifier for a command-only fixture workflow", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        name: "commands",
        version: 1,
        start: "verify",
        steps: { verify: { type: "command", run: ["node --test"] } },
      };
      const result = await new VeyraEngine().run({
        config,
        workflow,
        goal: "Check fixture",
        agents: {},
        cwd: path,
      });
      expect(result.status).toBe("completed");
      const events = await new LocalRunStore({ stateDir: join(path, ".veyra") }).readEvents(
        result.runId,
      );
      expect(events.find((event) => event.type === "verification.completed")).toMatchObject({
        success: true,
        results: [{ exitCode: 0 }],
      });
    });
  });

  it("turns verifier exceptions into persisted run failures", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const broken: Verifier = {
        verify: async () => {
          throw new Error("fixture verifier unavailable");
        },
      };
      const result = await new VeyraEngine({ verifier: broken }).run({
        config,
        workflow: dev,
        goal: "work",
        agents: agents(),
        cwd: path,
      });
      expect(result).toMatchObject({
        status: "failed",
        lastStep: "verify",
        error: { code: "verifier_execution_failed" },
      });
      expect(result.error?.message).toContain("fixture verifier unavailable");
    });
  });

  it("rejects a verifier report that claims success without executing all commands", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const incomplete: Verifier = {
        verify: async () => ({ success: true, durationMs: 0, results: [] }),
      };
      const result = await new VeyraEngine({ verifier: incomplete }).run({
        config,
        workflow: dev,
        goal: "work",
        agents: agents(),
        cwd: path,
      });
      expect(result.error?.code).toBe("invalid_verification_result");
    });
  });

  it("passes only redacted persisted provider data into the next agent", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const secret = "fixture-context-secret";
      const registry = agents();
      const planner = new FakeAgent({
        ...ok,
        data: { instructions: secret, apiKey: "a-second-secret" },
      });
      const result = await new VeyraEngine({ verifier: verifier(), redactValues: [secret] }).run({
        config,
        workflow: dev,
        goal: "work",
        agents: { ...registry, planner },
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(registry.executor.calls[0]?.context?.steps).toMatchObject({
        plan: { data: { instructions: "[REDACTED]", apiKey: "[REDACTED]" } },
      });
    });
  });

  it.each([
    { status: "invalid", summary: "bad" },
    { ...ok, data: { error: new Error("native") } },
    { ...ok, summary: "x".repeat(1024 * 1024) },
  ])("rejects malformed or oversized provider results", async (bad) => {
    await withFixtureWorkspace(async ({ path }) => {
      const adapter: AgentAdapter = {
        id: "custom",
        provider: "custom",
        run: async () => bad as AgentResult,
      };
      const result = await new VeyraEngine().run({
        config,
        workflow: oneStep(),
        goal: "work",
        agents: { custom: adapter },
        cwd: path,
      });
      expect(result.error?.code).toBe("invalid_agent_result");
    });
  });

  it("isolates subscriber mutation from persisted evidence and later agent inputs", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registry = agents();
      const result = await new VeyraEngine({
        verifier: verifier(),
        emit: (event) => {
          if (event.type === "agent.completed") event.result.summary = "tampered";
        },
      }).run({ config, workflow: dev, goal: "work", agents: registry, cwd: path });
      expect(result.status).toBe("completed");
      expect(JSON.stringify(registry.reviewer.calls)).not.toContain("tampered");
    });
  });

  it("persists a subscriber failure and stops safely", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const result = await new VeyraEngine({
        store,
        emit: () => {
          throw new Error("UI failed");
        },
      }).run({
        config,
        workflow: oneStep(),
        goal: "work",
        agents: { custom: new FakeAgent(ok) },
        cwd: path,
      });
      expect(result.error?.code).toBe("event_sink_failed");
      expect((await store.loadRun(result.runId)).state.status).toBe("failed");
      expect((await store.readEvents(result.runId)).at(-1)?.type).toBe("run.failed");
    });
  });

  it("does not claim failure persistence when storage itself breaks", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      vi.spyOn(store, "appendEvent").mockRejectedValue(
        new StateStoreError("io_error", path, "fixture disk failure"),
      );
      await expect(
        new VeyraEngine({ store }).run({
          config,
          workflow: oneStep(),
          goal: "work",
          agents: {},
          cwd: path,
        }),
      ).rejects.toMatchObject({ code: "io_error" });
    });
  });
});
