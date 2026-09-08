import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import type { AgentAdapter, AgentInput, AgentResult, VeyraEvent } from "@veyra/protocol";
import { runProcess } from "@veyra/runtime";
import type { Verifier } from "@veyra/verifier";
import { loadWorkflow } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({
  version: 1,
  agents: {},
  workflow: { use: "dev" },
  runtime: { maxFixIterations: 999 },
});
const ok: AgentResult = {
  status: "success",
  summary: "Supported fixture finding [source: supplied text]",
};
const pass = { ...ok, outcome: "pass" };
function scripted(results: AgentResult[]): AgentAdapter & { calls: AgentInput[] } {
  const calls: AgentInput[] = [];
  return {
    id: "scripted",
    provider: "fixture",
    calls,
    run: async (input) => {
      calls.push(structuredClone(input));
      return structuredClone(
        results[Math.min(calls.length - 1, results.length - 1)] as AgentResult,
      );
    },
  };
}
function checks(decide: (stepId: string, invocation: number) => boolean = () => true) {
  const calls: string[] = [];
  const counts = new Map<string, number>();
  const verifier: Verifier = {
    verify: async ({ commands, execution }) => {
      const id = execution?.stepId as string;
      const count = (counts.get(id) ?? 0) + 1;
      counts.set(id, count);
      calls.push(id);
      const success = decide(id, count);
      return {
        success,
        durationMs: 1,
        results: (success ? commands : commands.slice(0, 1)).map((command) => ({
          command,
          success,
          exitCode: success ? 0 : 1,
          stdout: success ? "Passed" : "Targeted regression failed",
          stderr: "",
          durationMs: 1,
        })),
      };
    },
  };
  return { verifier, calls };
}
const starts = (events: VeyraEvent[]) =>
  events.filter((event) => event.type === "step.started").map((event) => event.stepId);
const storeAt = (path: string) => new LocalRunStore({ stateDir: join(path, ".veyra") });

describe("hardened built-in presets", () => {
  it("executes the declared dev guidance and repairs verification before a separate review", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = await loadWorkflow("dev");
      const planner = new FakeAgent(ok);
      const executor = new FakeAgent(ok);
      const reviewer = new FakeAgent(pass);
      const check = checks((_step, count) => count > 1);
      const store = storeAt(path);
      const result = await new VeyraEngine({ store, verifier: check.verifier }).run({
        config,
        workflow,
        agents: { planner, executor, reviewer },
        goal: "Fix the fixture",
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(starts(await store.readEvents(result.runId))).toEqual([
        "plan",
        "execute",
        "verify",
        "fix",
        "verify",
        "review",
        "done",
      ]);
      expect(executor.calls[0]?.instructionSources).toContainEqual({
        kind: "workflow",
        reference: "execute",
        text: workflow.steps.execute?.instructions,
      });
      expect(executor.calls[1]?.instructionSources).toContainEqual({
        kind: "workflow",
        reference: "fix",
        text: workflow.steps.fix?.instructions,
      });
      expect(executor.calls[1]?.context?.steps).toMatchObject({ verify: { outcome: "failure" } });
      expect(reviewer.calls[0]?.context?.steps).toMatchObject({ verify: { outcome: "success" } });
      const inputs = (await store.readEvents(result.runId)).filter(
        (event) => event.type === "agent.input",
      );
      expect(inputs.map((event) => event.input)).toEqual([
        planner.calls[0],
        ...executor.calls,
        reviewer.calls[0],
      ]);
    });
  });

  it("keeps dev's three-repair ceiling even when config requests hundreds of repairs", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const executor = new FakeAgent(ok);
      const reviewer = new FakeAgent(pass);
      const result = await new VeyraEngine({
        store: storeAt(path),
        verifier: checks(() => false).verifier,
      }).run({
        config,
        workflow: await loadWorkflow("dev"),
        agents: { planner: new FakeAgent(ok), executor, reviewer },
        goal: "Bound repair",
        cwd: path,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "retry_exhausted" } });
      expect(executor.calls.map((input) => input.stepId)).toEqual(["execute", "fix", "fix", "fix"]);
      expect(reviewer.calls).toHaveLength(0);
    });
  });

  it("reruns targeted bugfix checks before broader checks after each failure", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const planner = new FakeAgent(ok);
      const executor = new FakeAgent(ok);
      const reviewer = new FakeAgent(pass);
      const check = checks((step, count) => step !== "reproduce" && count > 1);
      const store = storeAt(path);
      const result = await new VeyraEngine({ store, verifier: check.verifier }).run({
        config,
        workflow: await loadWorkflow("bugfix"),
        agents: { planner, executor, reviewer },
        goal: "Repair the reproduced regression",
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(starts(await store.readEvents(result.runId))).toEqual([
        "reproduce",
        "analyze",
        "fix",
        "targeted",
        "fix",
        "targeted",
        "verify",
        "fix",
        "targeted",
        "verify",
        "review",
        "done",
      ]);
      expect(planner.calls[0]?.context?.inputs).toEqual({ reproductionOutcome: "failure" });
      expect(reviewer.calls[0]?.context?.inputs).toEqual({
        targetedOutcome: "success",
        broaderOutcome: "success",
      });
      expect(executor.calls).toHaveLength(3);
    });
  });

  it("preserves a non-reproduced passing result for diagnosis and pauses without guessing a fix", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const planner = new FakeAgent({
        status: "needs_input",
        summary: "Supply a failing reproduction",
      });
      const executor = new FakeAgent(ok);
      const result = await new VeyraEngine({
        store: storeAt(path),
        verifier: checks().verifier,
      }).run({
        config,
        workflow: await loadWorkflow("bugfix"),
        agents: { planner, executor },
        goal: "Unclear regression",
        cwd: path,
      });
      expect(result).toMatchObject({ status: "paused", lastStep: "analyze" });
      expect(planner.calls[0]?.context?.inputs).toEqual({ reproductionOutcome: "success" });
      expect(executor.calls).toHaveLength(0);
    });
  });

  it("bounds persistent targeted failures before broader verification or review", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const executor = new FakeAgent(ok);
      const reviewer = new FakeAgent(pass);
      const check = checks(() => false);
      const result = await new VeyraEngine({ store: storeAt(path), verifier: check.verifier }).run({
        config,
        workflow: await loadWorkflow("bugfix"),
        agents: { planner: new FakeAgent(ok), executor, reviewer },
        goal: "Bound bugfix",
        cwd: path,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "retry_exhausted" } });
      expect(executor.calls).toHaveLength(4);
      expect(check.calls).toEqual(["reproduce", "targeted", "targeted", "targeted", "targeted"]);
      expect(reviewer.calls).toHaveLength(0);
    });
  });

  it.each(["pass", "fail"])(
    "presents a %s review separately from failed deterministic checks",
    async (verdict) => {
      await withFixtureWorkspace(async ({ path }) => {
        const reviewer = new FakeAgent({ ...ok, outcome: verdict });
        const engine = new VeyraEngine({
          store: storeAt(path),
          verifier: checks((step) => step === "inspect").verifier,
        });
        const run = await engine.run({
          config,
          workflow: await loadWorkflow("review"),
          agents: { reviewer },
          goal: "Review the diff",
          cwd: path,
        });
        expect(run).toMatchObject({ status: "paused", lastStep: "report" });
        expect(reviewer.calls).toHaveLength(1);
        expect(reviewer.calls[0]?.context?.inputs).toEqual({
          inspectOutcome: "success",
          checksOutcome: "failure",
        });
        const pending = await engine.getPendingApproval({ config, cwd: path, runId: run.runId });
        if (!pending) throw new Error("Missing report");
        expect(pending.context?.inputs).toMatchObject({
          checks: "failure",
          verdict,
          review: ok.summary,
        });
        await expect(
          engine.resume({ config, cwd: path, runId: run.runId, agents: { reviewer } }),
        ).rejects.toMatchObject({ code: "approval_required" });
        await engine.resolveApproval({
          config,
          cwd: path,
          runId: run.runId,
          approvalId: pending.approvalId,
          decision: "approved",
        });
        expect(
          (await engine.resume({ config, cwd: path, runId: run.runId, agents: { reviewer } }))
            .status,
        ).toBe("completed");
        expect(reviewer.calls).toHaveLength(1);
      });
    },
  );

  it("fails a review with no explicit verdict instead of producing a report", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const result = await new VeyraEngine({
        store: storeAt(path),
        verifier: checks().verifier,
      }).run({
        config,
        workflow: await loadWorkflow("review"),
        agents: { reviewer: new FakeAgent(ok) },
        goal: "Review",
        cwd: path,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "unhandled_outcome" } });
    });
  });

  it(
    "runs real review commands in an isolated Git fixture without changing project sources",
    { timeout: 30000 },
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        for (const args of [
          ["init", "--quiet"],
          ["add", "--", "package.json", "src", "test"],
        ]) {
          const result = await runProcess({ executable: "git", args, cwd: path, timeoutMs: 10000 });
          expect(result.exitCode, result.stderr).toBe(0);
        }
        const files = ["package.json", "src/message.js", "test/message.test.js"];
        const before = await Promise.all(files.map((file) => readFile(join(path, file), "utf8")));
        const reviewer = new FakeAgent(pass);
        const store = storeAt(path);
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow: await loadWorkflow("review"),
          agents: { reviewer },
          goal: "Read-only review",
          cwd: path,
        });
        expect(result).toMatchObject({ status: "paused", lastStep: "report" });
        expect(await Promise.all(files.map((file) => readFile(join(path, file), "utf8")))).toEqual(
          before,
        );
        const events = await store.readEvents(result.runId);
        expect(
          events
            .filter((event) => event.type === "verification.completed")
            .map((event) => event.success),
        ).toEqual([true, true]);
        expect(reviewer.calls[0]?.context?.steps).toMatchObject({
          inspect: { outcome: "success" },
          verify: { outcome: "success" },
        });
      });
    },
  );

  it("refines research from judge feedback, then presents a synthesis without executing commands", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const researcher = new FakeAgent(ok);
      const judge = scripted([
        { ...ok, outcome: "fail", summary: "Clarify the evidence gap" },
        pass,
      ]);
      const check = checks();
      const store = storeAt(path);
      const engine = new VeyraEngine({ store, verifier: check.verifier });
      const result = await engine.run({
        config,
        workflow: await loadWorkflow("research"),
        agents: { planner: new FakeAgent(ok), researcher, judge },
        goal: "Compare supplied sources",
        cwd: path,
      });
      expect(result).toMatchObject({ status: "paused", lastStep: "output" });
      expect(check.calls).toHaveLength(0);
      expect(starts(await store.readEvents(result.runId))).toEqual([
        "plan",
        "research",
        "synthesize",
        "research",
        "synthesize",
        "output",
      ]);
      expect(researcher.calls[1]?.context?.steps).toMatchObject({
        synthesize: { outcome: "fail", summary: "Clarify the evidence gap" },
      });
      expect(judge.calls[0]?.role).toBe("judge");
      expect(
        (await engine.getPendingApproval({ config, cwd: path, runId: result.runId }))?.context
          ?.inputs,
      ).toEqual({ synthesis: ok.summary, research: ok.summary });
    });
  });

  it("stops research after two refinements despite a larger runtime default", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const researcher = new FakeAgent(ok);
      const judge = new FakeAgent({ ...ok, outcome: "fail" });
      const check = checks();
      const result = await new VeyraEngine({ store: storeAt(path), verifier: check.verifier }).run({
        config,
        workflow: await loadWorkflow("research"),
        agents: { planner: new FakeAgent(ok), researcher, judge },
        goal: "Bound research",
        cwd: path,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "retry_exhausted" } });
      expect(researcher.calls).toHaveLength(3);
      expect(judge.calls).toHaveLength(3);
      expect(check.calls).toHaveLength(0);
    });
  });
});
