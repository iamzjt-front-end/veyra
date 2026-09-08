import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { AgentAdapter, AgentInput, AgentResult, VeyraEvent } from "@veyraoss/protocol";
import { runProcess } from "@veyraoss/runtime";
import type { WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, StateStoreError, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "consensus" } });
const pass: AgentResult = {
  status: "success",
  outcome: "pass",
  summary: "Evidence passes",
  data: { detail: "Independent evidence" },
};
const fail: AgentResult = { ...pass, outcome: "fail", summary: "Fix the missed case" };
const workflow = (): WorkflowDefinition => ({
  name: "reviews",
  version: 1,
  start: "verify",
  steps: {
    verify: { type: "command", run: ["node --version"], next: "group" },
    group: { type: "consensus", reviewers: ["one", "two"], verification: ["verify"] },
    one: { type: "agent", agent: "first" },
    two: { type: "agent", agent: "second" },
    arbitrate: { type: "agent", agent: "arbiter" },
  },
});
const decision = (events: VeyraEvent[]) =>
  [...events].reverse().find((event) => event.type === "consensus.completed");
const storeAt = (path: string) => new LocalRunStore({ stateDir: join(path, ".veyra") });

describe("independent consensus reviews and judge", () => {
  it("resumes a consensus inside a child workflow in a fresh process without replaying completed reviews", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const child = workflow();
      const definition: WorkflowDefinition = {
        name: "parent",
        version: 1,
        start: "call",
        steps: { call: { type: "subworkflow", workflow: child } },
      };
      const store = storeAt(path);
      const initial = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        cwd: path,
        goal: "Persist child reviews",
        agents: {
          first: new FakeAgent(pass),
          second: new FakeAgent({ status: "needs_input", summary: "Wait" }),
        },
      });
      expect(initial).toMatchObject({ status: "paused", lastStep: "call/group" });
      const script = `
        import { VeyraEngine, LocalRunStore } from ${JSON.stringify(new URL("../dist/index.js", import.meta.url).href)};
        const calls = [];
        const agent = { id: 'fresh', provider: 'fake', run: async (input) => { calls.push(input.stepId); return ${JSON.stringify(pass)}; } };
        const result = await new VeyraEngine({store: new LocalRunStore({stateDir: '.veyra'})}).resume({config: ${JSON.stringify(config)}, cwd: process.cwd(), runId: ${JSON.stringify(initial.runId)}, agents: { first: { ...agent, run: async () => { throw new Error('Completed reviewer replayed'); } }, second: agent }});
        process.stdout.write(JSON.stringify({ result, calls }));
      `;
      const childProcess = await runProcess({
        executable: process.execPath,
        args: ["--input-type=module", "-e", script],
        cwd: path,
        timeoutMs: 10000,
      });
      expect(childProcess.exitCode, childProcess.stderr).toBe(0);
      expect(JSON.parse(childProcess.stdout)).toMatchObject({
        result: { status: "completed" },
        calls: ["call/two"],
      });
      const events = await store.readEvents(initial.runId);
      expect(
        events.filter((event) => event.type === "agent.completed" && event.stepId === "call/one"),
      ).toHaveLength(1);
      expect(events.filter((event) => event.type === "verification.completed")).toHaveLength(1);
    });
  });

  it(
    "does not reuse verifier evidence from an earlier invocation of the same child scope",
    { timeout: 15_000 },
    async () => {
      await withFixtureWorkspace(async ({ path }) => {
        const child = workflow();
        child.start = "choose";
        child.steps.choose = { type: "agent", agent: "choice", next: "route" };
        child.steps.route = {
          type: "router",
          route: { from: "choose", path: "/data/route" },
          on: { check: "verify", skip: "group" },
        };
        const definition: WorkflowDefinition = {
          name: "repeat-child",
          version: 1,
          start: "call",
          steps: {
            call: {
              type: "subworkflow",
              workflow: child,
              retry: { max: 1 },
              on: { success: "call", failure: "done" },
            },
            done: { type: "end" },
          },
        };
        const choice: AgentAdapter = {
          id: "choice",
          provider: "fake",
          run: async (input) => ({
            status: "success",
            summary: "Choose path",
            data: { route: input.attempt === 1 ? "check" : "skip" },
          }),
        };
        const reviewer = new FakeAgent(pass);
        const store = storeAt(path);
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow: definition,
          cwd: path,
          goal: "Require current-scope evidence",
          agents: { choice, first: reviewer, second: reviewer },
        });
        expect(result.status).toBe("completed");
        expect(reviewer.calls).toHaveLength(2);
        expect(decision(await store.readEvents(result.runId))).toMatchObject({
          outcome: "fail",
          reason: "verification_failed",
          verification: [{ stepId: "call/verify", success: false }],
        });
      });
    },
  );

  it("keeps judge retry limits across resume and cannot use quorum to hide a thrown reviewer", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = {
        ...definition.steps.group,
        type: "consensus",
        mode: "judge",
        judge: "arbitrate",
      };
      definition.steps.arbitrate = { type: "agent", agent: "arbiter", retry: { max: 0 } };
      const arbiter = new FakeAgent({ status: "needs_input", summary: "Waiting" });
      const store = storeAt(path);
      const initial = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        cwd: path,
        goal: "Bound judge retries",
        agents: { first: new FakeAgent(pass), second: new FakeAgent(pass), arbiter },
      });
      expect(initial.status).toBe("paused");
      const resumed = await new VeyraEngine({ store: storeAt(path) }).resume({
        config,
        runId: initial.runId,
        cwd: path,
        agents: { arbiter },
      });
      expect(resumed.status).toBe("failed");
      expect(arbiter.calls).toHaveLength(1);
      expect(decision(await store.readEvents(resumed.runId))).toMatchObject({
        outcome: "fail",
        reason: "judge_error",
      });
      definition.steps.group = {
        type: "consensus",
        reviewers: ["one", "two"],
        mode: "quorum",
        quorum: 1,
      };
      const broken: AgentAdapter = {
        id: "broken",
        provider: "fake",
        run: async () => {
          throw new Error("Fixture reviewer exception");
        },
      };
      const failed = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        cwd: path,
        goal: "No missing votes",
        agents: { first: new FakeAgent(pass), second: broken },
      });
      expect(failed.status).toBe("failed");
      expect(decision(await store.readEvents(failed.runId))).toMatchObject({
        outcome: "fail",
        reason: "review_error",
      });
    });
  });

  it.each([
    { mode: "all-pass" as const, second: pass, expected: "pass" },
    { mode: "all-pass" as const, second: fail, expected: "fail" },
    { mode: "quorum" as const, second: fail, expected: "pass" },
    { mode: "judge" as const, second: fail, expected: "pass" },
  ])(
    "aggregates $mode as $expected and persists distinct full reviews",
    async ({ mode, second, expected }) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition = workflow();
        definition.steps.group = {
          ...definition.steps.group,
          type: "consensus",
          mode,
          ...(mode === "quorum" ? { quorum: 1 } : {}),
          ...(mode === "judge" ? { judge: "arbitrate" } : {}),
        };
        const first = new FakeAgent(pass, "model-a");
        const other = new FakeAgent(second, "model-b");
        const arbiter = new FakeAgent(pass, "model-c");
        const store = storeAt(path);
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow: definition,
          agents: { first, second: other, arbiter },
          cwd: path,
          goal: "Review fixture",
        });
        expect(result.status).toBe(expected === "pass" ? "completed" : "failed");
        const events = await store.readEvents(result.runId);
        const output = decision(events);
        expect(output).toMatchObject({
          outcome: expected,
          mode,
          reviews: [
            { stepId: "one", verdict: "pass" },
            { stepId: "two", verdict: second.outcome },
          ],
        });
        if (output?.type !== "consensus.completed") throw new Error("Missing decision");
        for (const review of output.reviews)
          expect(events.find((event) => event.eventId === review.outputEventId)).toMatchObject({
            type: "agent.completed",
            stepId: review.stepId,
            parentStepId: "group",
            result: { data: { detail: "Independent evidence" } },
          });
        expect(first.calls[0]?.role).toBe("reviewer");
        expect(other.calls[0]?.role).toBe("reviewer");
        expect(arbiter.calls).toHaveLength(mode === "judge" ? 1 : 0);
        if (mode === "judge")
          expect(arbiter.calls[0]).toMatchObject({
            role: "judge",
            parentStepId: "group",
            context: {
              consensus: {
                reviews: [
                  { stepId: "one", verdict: "pass", evidence: { summary: pass.summary } },
                  { stepId: "two", verdict: "fail", evidence: { summary: fail.summary } },
                ],
                verification: [{ stepId: "verify", success: true }],
              },
            },
          });
      });
    },
  );

  it("overlaps different providers, keeps queued reviewer inputs independent, and orders votes by declaration", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = {
        ...definition.steps.group,
        type: "consensus",
        reviewers: ["one", "two", "three"],
        concurrency: 2,
      };
      definition.steps.three = { type: "agent", agent: "second" };
      const calls: AgentInput[] = [];
      let release = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const first: AgentAdapter = {
        id: "remote",
        provider: "provider-a",
        run: async (input) => {
          calls.push(input);
          await gate;
          return pass;
        },
      };
      const second: AgentAdapter = {
        id: "local",
        provider: "provider-b",
        run: async (input) => {
          calls.push(input);
          if (input.stepId === "three") release();
          return pass;
        },
      };
      const store = storeAt(path);
      const running = new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { first, second },
        cwd: path,
        goal: "Independent inputs",
      });
      try {
        await vi.waitFor(() => expect(calls).toHaveLength(3), { timeout: 5000 });
      } finally {
        release();
      }
      const result = await running;
      expect(result.status).toBe("completed");
      for (const input of calls)
        expect(Object.keys(input.context?.steps ?? {})).toEqual(["verify"]);
      const events = await store.readEvents(result.runId);
      expect(
        events.filter((event) => event.type === "agent.completed").map((event) => event.stepId)[0],
      ).toBe("two");
      expect(decision(events)).toMatchObject({
        reviews: [{ stepId: "one" }, { stepId: "two" }, { stepId: "three" }],
      });
    });
  });

  it.each([
    { ...pass, status: "failure" as const },
    { status: "success" as const, summary: "No verdict" },
    { ...pass, outcome: "PASS" },
    { ...pass, outcome: "done" },
    { ...pass, summary: "x".repeat(1024 * 1024) },
  ])("refuses incomplete/invalid votes even if quorum would otherwise pass %#", async (bad) => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = {
        ...definition.steps.group,
        type: "consensus",
        mode: "quorum",
        quorum: 1,
      };
      const store = storeAt(path);
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { first: new FakeAgent(pass), second: new FakeAgent(bad) },
        cwd: path,
        goal: "Fail closed",
      });
      expect(result.status).toBe("failed");
      expect(decision(await store.readEvents(result.runId))).toMatchObject({
        outcome: "fail",
        reason: "review_error",
        reviews: [{ verdict: "pass" }, { verdict: "error" }],
      });
    });
  });

  it.each(["missing", "failed"])(
    "refuses %s required verification before invoking reviewers or a judge",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition = workflow();
        definition.steps.group = {
          ...definition.steps.group,
          type: "consensus",
          mode: "judge",
          judge: "arbitrate",
        };
        if (scenario === "missing") definition.start = "group";
        else
          definition.steps.verify = {
            type: "command",
            run: ['node -e "process.exit(1)"'],
            on: { failure: "group" },
          };
        const reviewer = new FakeAgent(pass);
        const store = storeAt(path);
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow: definition,
          agents: { first: reviewer, second: reviewer, arbiter: reviewer },
          cwd: path,
          goal: "Required evidence",
        });
        expect(result.status).toBe("failed");
        expect(reviewer.calls).toHaveLength(0);
        expect(decision(await store.readEvents(result.runId))).toMatchObject({
          outcome: "fail",
          reason: "verification_failed",
          reviews: [],
          verification: [{ stepId: "verify", success: false }],
        });
      });
    },
  );

  it("resumes only an unfinished reviewer after a completed negative vote", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = {
        ...definition.steps.group,
        type: "consensus",
        concurrency: 1,
        mode: "quorum",
        quorum: 1,
      };
      const store = storeAt(path);
      const first = new FakeAgent(fail);
      const waiting = new FakeAgent({ status: "needs_input", summary: "Supply detail" });
      const paused = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { first, second: waiting },
        cwd: path,
        goal: "Resume votes",
      });
      expect(paused.status).toBe("paused");
      const second = new FakeAgent(pass);
      const resumed = await new VeyraEngine({ store: storeAt(path) }).resume({
        config,
        runId: paused.runId,
        agents: { first, second },
        cwd: path,
      });
      expect(resumed.status).toBe("completed");
      expect(first.calls).toHaveLength(1);
      expect(second.calls[0]).toMatchObject({
        attempt: 2,
        context: { steps: { verify: { type: "command" } } },
      });
      expect(Object.keys(second.calls[0]?.context?.steps ?? {})).toEqual(["verify"]);
      const events = await store.readEvents(resumed.runId);
      expect(events.filter((event) => event.type === "consensus.started")).toHaveLength(1);
      expect(
        events.filter((event) => event.type === "step.started" && event.stepId === "group"),
      ).toHaveLength(1);
      expect(decision(events)).toMatchObject({
        outcome: "pass",
        reviews: [
          { verdict: "fail", attempt: 1 },
          { verdict: "pass", attempt: 2 },
        ],
      });
    });
  });

  it("resumes a judge without replaying reviews, then restores selected judge output after a gate", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = {
        ...definition.steps.group,
        type: "consensus",
        mode: "judge",
        judge: "arbitrate",
        on: { pass: "gate" },
      };
      definition.steps.gate = { type: "human", next: "report" };
      definition.steps.report = {
        type: "agent",
        agent: "report",
        inputs: {
          judge: { from: "arbitrate", path: "/summary" },
          votes: { from: "group", path: "/reviews" },
        },
      };
      const first = new FakeAgent(pass);
      const second = new FakeAgent(fail);
      const report = new FakeAgent(pass);
      const store = storeAt(path);
      const initial = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: {
          first,
          second,
          report,
          arbiter: new FakeAgent({ status: "needs_input", summary: "Clarify judgment" }),
        },
        cwd: path,
        goal: "Resume judge",
      });
      expect(initial.status).toBe("paused");
      const arbiter = new FakeAgent(pass);
      const engine = new VeyraEngine({ store: storeAt(path) });
      const gated = await engine.resume({
        config,
        runId: initial.runId,
        agents: { first, second, arbiter, report },
        cwd: path,
      });
      expect(gated).toMatchObject({ status: "paused", lastStep: "gate" });
      expect(first.calls).toHaveLength(1);
      expect(second.calls).toHaveLength(1);
      expect(arbiter.calls[0]?.attempt).toBe(2);
      const approval = (await store.readEvents(initial.runId)).find(
        (event) => event.type === "approval.required",
      );
      if (approval?.type !== "approval.required" || !approval.approvalId)
        throw new Error("Missing approval");
      await engine.resolveApproval({
        config,
        cwd: path,
        runId: initial.runId,
        approvalId: approval.approvalId,
        decision: "approved",
      });
      const result = await new VeyraEngine({ store: storeAt(path) }).resume({
        config,
        runId: initial.runId,
        agents: { first, second, arbiter, report },
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(report.calls[0]?.context?.inputs).toMatchObject({
        judge: pass.summary,
        votes: [{ verdict: "pass" }, { verdict: "fail" }],
      });
    });
  });

  it.each(["fail", "invalid", "throws"])(
    "persists a judge %s without silently accepting reviewer passes",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition = workflow();
        definition.steps.group = {
          ...definition.steps.group,
          type: "consensus",
          mode: "judge",
          judge: "arbitrate",
        };
        const arbiter: AgentAdapter = {
          id: "judge",
          provider: "other",
          run: async () => {
            if (scenario === "throws") throw new Error("Fixture judge error");
            return scenario === "fail" ? fail : { ...pass, outcome: "maybe" };
          },
        };
        const store = storeAt(path);
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow: definition,
          agents: { first: new FakeAgent(pass), second: new FakeAgent(pass), arbiter },
          cwd: path,
          goal: "Judge fail closed",
        });
        expect(result.status).toBe("failed");
        expect(decision(await store.readEvents(result.runId))).toMatchObject({
          outcome: "fail",
          judge: { verdict: scenario === "fail" ? "fail" : "error" },
        });
      });
    },
  );

  it("retains every review reference while bounding large evidence passed to the judge", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = {
        ...definition.steps.group,
        type: "consensus",
        mode: "judge",
        judge: "arbitrate",
      };
      const arbiter = new FakeAgent(pass);
      const large = new FakeAgent({ ...pass, data: { body: "x".repeat(64 * 1024) } });
      const store = storeAt(path);
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { first: large, second: large, arbiter },
        cwd: path,
        goal: "Bounded judge evidence",
      });
      expect(result.status).toBe("completed");
      expect(arbiter.calls[0]?.context?.consensus).toMatchObject({
        reviews: [{ evidence: { truncated: true } }, { evidence: { truncated: true } }],
      });
      expect(Buffer.byteLength(JSON.stringify(arbiter.calls[0]))).toBeLessThan(32 * 1024);
      expect(
        (await store.readEvents(result.runId))
          .filter((event) => event.type === "agent.completed")
          .filter((event) => event.role === "reviewer")
          .every((event) => event.result.data?.body === "x".repeat(64 * 1024)),
      ).toBe(true);
    });
  });

  it("starts independent inputs again on group retry and persists redacted evidence", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.group = {
        ...definition.steps.group,
        type: "consensus",
        on: { fail: "group" },
        retry: { max: 1 },
      };
      const calls: AgentInput[] = [];
      const first: AgentAdapter = {
        id: "first",
        provider: "fake",
        run: async (input) => {
          calls.push(input);
          return {
            ...(input.attempt === 1 ? fail : pass),
            summary: "Never persist fixture-secret",
            artifacts: [{ id: "peer-note", kind: "review" }],
          };
        },
      };
      const second = new FakeAgent(pass);
      const store = new LocalRunStore({
        stateDir: join(path, ".veyra"),
        redactValues: ["fixture-secret"],
      });
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { first, second },
        cwd: path,
        goal: "Independent retries",
      });
      // The second decision passes; a non-empty unmatched on map remains an explicit failure.
      expect(result.status).toBe("failed");
      expect(result.error?.code).toBe("unhandled_outcome");
      expect(calls.map((call) => call.attempt)).toEqual([1, 2]);
      for (const call of [...calls, ...second.calls]) {
        expect(Object.keys(call.context?.steps ?? {})).toEqual(["verify"]);
        expect(call.artifacts).toEqual([]);
      }
      expect(
        await readFile(join(path, ".veyra", "runs", result.runId, "events.jsonl"), "utf8"),
      ).not.toContain("fixture-secret");
    });
  });

  it.each(["cancel", "subscriber", "store"])(
    "drains active reviewers on %s failure and never invokes a judge",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition = workflow();
        definition.steps.group = {
          ...definition.steps.group,
          type: "consensus",
          mode: "judge",
          judge: "arbitrate",
        };
        const controller = new AbortController();
        let ready = () => {};
        const gate = new Promise<void>((resolve) => {
          ready = resolve;
        });
        let drained = false;
        const first: AgentAdapter = {
          id: "first",
          provider: "fake",
          run: async () => {
            await gate;
            if (scenario === "cancel") controller.abort();
            return pass;
          },
        };
        const second: AgentAdapter = {
          id: "second",
          provider: "fake",
          run: async (_input, options) => {
            const wait = new Promise<void>((resolve) => {
              options?.signal?.addEventListener("abort", () => resolve(), { once: true });
            });
            ready();
            await wait;
            drained = true;
            return pass;
          },
        };
        const arbiter = new FakeAgent(pass);
        const store = storeAt(path);
        const storageError = new StateStoreError("io_error", path, "Fixture storage failure");
        if (scenario === "store") {
          const append = store.appendEvent.bind(store);
          vi.spyOn(store, "appendEvent").mockImplementation(async (runId, event) => {
            if (event.type === "agent.completed" && event.stepId === "one") throw storageError;
            return append(runId, event);
          });
        }
        const running = new VeyraEngine({
          store,
          emit: (event) => {
            if (
              scenario === "subscriber" &&
              event.type === "agent.completed" &&
              event.stepId === "one"
            )
              throw new Error("Fixture subscriber error");
          },
        }).run({
          config,
          workflow: definition,
          agents: { first, second, arbiter },
          cwd: path,
          goal: "Stop safely",
          signal: controller.signal,
        });
        if (scenario === "store") await expect(running).rejects.toBe(storageError);
        else
          expect(await running).toMatchObject({
            status: "failed",
            error: { code: scenario === "cancel" ? "run_cancelled" : "event_sink_failed" },
          });
        expect(drained).toBe(true);
        expect(arbiter.calls).toHaveLength(0);
      });
    },
  );
});
