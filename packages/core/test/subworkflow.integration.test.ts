import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import type { AgentAdapter, AgentInput } from "@veyra/protocol";
import { runProcess } from "@veyra/runtime";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "subworkflow" } });
const ok = { status: "success" as const, summary: "Done" };
const single = (): WorkflowDefinition => ({
  name: "child",
  version: 1,
  start: "produce",
  steps: { produce: { type: "agent", agent: "worker" } },
});
const wrap = (child: () => WorkflowDefinition): WorkflowDefinition => ({
  name: "parent",
  version: 1,
  start: "call",
  steps: {
    call: { type: "subworkflow", workflow: child(), next: "after" },
    after: { type: "agent", agent: "after" },
  },
});

describe("subworkflow scope execution", () => {
  it("preserves nested structural names while redacting passed parameters and mapped outputs", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition: WorkflowDefinition = {
        name: "redacted scope",
        version: 1,
        start: "source",
        steps: {
          source: { type: "agent", agent: "source", next: "call" },
          call: {
            type: "subworkflow",
            inputs: { apiKey: { from: "source", path: "/data/public" } },
            workflow: {
              name: "child",
              version: 1,
              start: "apiKey",
              steps: { apiKey: { type: "agent", agent: "worker" } },
            },
            outputs: { apiKey: { from: "apiKey", path: "/data/public" } },
          },
        },
      };
      const worker = new FakeAgent({ ...ok, data: { public: "contains fixture-secret" } });
      const store = new LocalRunStore({
        stateDir: join(path, ".veyra"),
        redactValues: ["fixture-secret"],
      });
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { source: new FakeAgent({ ...ok, data: { public: "fixture-secret" } }), worker },
        cwd: path,
        goal: "Redact child data",
      });
      expect(result.status).toBe("completed");
      expect(worker.calls[0]?.context?.workflowInputs).toEqual({ apiKey: "[REDACTED]" });
      const loaded = await store.loadRun(result.runId);
      expect(loaded.input.workflow.steps.call?.workflow?.steps.apiKey?.agent).toBe("worker");
      expect(loaded.input.workflow.steps.call?.outputs?.apiKey?.from).toBe("apiKey");
      const events = await store.readEvents(result.runId);
      expect(JSON.stringify(events)).not.toContain("fixture-secret");
      expect(events.find((event) => event.type === "subworkflow.completed")).toMatchObject({
        outputs: { apiKey: "[REDACTED]" },
      });
    });
  });

  it.each(["leaf", "end", "unmatched"])(
    "preserves child %s semantics when recovering a completed checkpoint without repeating a command",
    async (terminal) => {
      await withFixtureWorkspace(async ({ path }) => {
        const child: WorkflowDefinition = {
          name: "checkpoint child",
          version: 1,
          start: "once",
          steps: {
            once: {
              type: "command",
              run: ["node -e \"require('node:fs').appendFileSync('once.txt','x')\""],
              ...(terminal === "end" ? { next: "done" } : {}),
              ...(terminal === "unmatched" ? { on: { known: "done" } } : {}),
            },
            done: { type: "end" },
          },
        };
        const definition = wrap(() => child);
        const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
        const checkpoint = terminal === "end" ? "call/done" : "call/once";
        const source = `import { VeyraEngine } from ${JSON.stringify(moduleUrl)};
await new VeyraEngine({emit:event=>{if(event.type==='step.completed' && event.stepId===${JSON.stringify(checkpoint)}){console.log(event.runId);process.exit(0);}}}).run({config:${JSON.stringify(config)},workflow:${JSON.stringify(definition)},agents:{},goal:'nested checkpoint',cwd:process.argv[1]});`;
        const writer = await runProcess({
          executable: process.execPath,
          args: ["--import", "tsx", "--input-type=module", "-e", source, path],
          timeoutMs: 30_000,
        });
        expect(writer.exitCode, writer.stderr).toBe(0);
        const after = new FakeAgent(ok);
        const result = await new VeyraEngine().resume({
          config,
          runId: writer.stdout.trim(),
          cwd: path,
          agents: { after },
          recoverInterrupted: true,
        });
        expect(result.status).toBe(terminal === "unmatched" ? "failed" : "completed");
        expect(after.calls).toHaveLength(terminal === "unmatched" ? 0 : 1);
        expect(await readFile(join(path, "once.txt"), "utf8")).toBe("x");
      });
    },
  );

  it("maps typed inputs/outputs across repeated child definitions without leaking either scope", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition: WorkflowDefinition = {
        name: "parent",
        version: 1,
        start: "produce",
        steps: {
          produce: { type: "agent", agent: "planner", next: "first" },
          first: {
            type: "subworkflow",
            workflow: single(),
            inputs: { value: { from: "produce", path: "/data/value" } },
            outputs: { doubled: { from: "produce", path: "/data/value" } },
            next: "second",
          },
          second: {
            type: "subworkflow",
            workflow: single(),
            inputs: { value: { from: "first", path: "/outputs/doubled" } },
            outputs: { doubled: { from: "produce", path: "/data/value" } },
            next: "after",
          },
          after: {
            type: "agent",
            agent: "after",
            inputs: { value: { from: "second", path: "/outputs/doubled" } },
          },
        },
      };
      const calls: AgentInput[] = [];
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (input) => {
          calls.push(structuredClone(input));
          expect(input.context?.steps).toEqual({});
          const params = input.context?.workflowInputs as { value: number };
          return { ...ok, data: { value: params.value * 2, internal: "child-only detail" } };
        },
      };
      const after = new FakeAgent(ok);
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: {
          planner: new FakeAgent({ ...ok, data: { value: 7, internal: "parent-only detail" } }),
          worker,
          after,
        },
        cwd: path,
        goal: "Scoped calculation",
      });
      expect(result.status).toBe("completed");
      expect(calls.map((call) => call.stepId)).toEqual(["first/produce", "second/produce"]);
      expect(calls.map((call) => call.context?.workflowInputs)).toEqual([
        { value: 7 },
        { value: 14 },
      ]);
      expect(JSON.stringify(calls)).not.toContain("parent-only detail");
      expect(after.calls[0]?.context?.inputs).toEqual({ value: 28 });
      expect(Object.keys(after.calls[0]?.context?.steps ?? {})).toEqual([
        "produce",
        "first",
        "second",
      ]);
      expect(JSON.stringify(after.calls)).not.toContain("child-only detail");
      const events = await store.readEvents(result.runId);
      expect(events.filter((event) => event.type === "subworkflow.completed")).toMatchObject([
        { stepId: "first", success: true, outputs: { doubled: 14 } },
        { stepId: "second", success: true, outputs: { doubled: 28 } },
      ]);
      expect((await store.loadRun(result.runId)).state.retryCounts).toMatchObject({
        first: 0,
        "first/produce": 0,
        second: 0,
        "second/produce": 0,
      });
    });
  });

  it.each([false, true])(
    "propagates child failures with explicit parent recovery=%s",
    async (recover) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition = wrap(single);
        if (recover)
          definition.steps.call = {
            ...definition.steps.call,
            type: "subworkflow",
            on: { failure: "recover" },
          };
        definition.steps.recover = { type: "agent", agent: "recover" };
        const after = new FakeAgent(ok);
        const recovery = new FakeAgent(ok);
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow: definition,
          agents: {
            worker: new FakeAgent({ status: "failure", summary: "Child verification failed" }),
            after,
            recover: recovery,
          },
          cwd: path,
          goal: "Handle child error",
        });
        expect(result.status).toBe(recover ? "completed" : "failed");
        expect(after.calls).toHaveLength(0);
        expect(recovery.calls).toHaveLength(recover ? 1 : 0);
        expect(
          (await store.readEvents(result.runId)).find(
            (event) => event.type === "subworkflow.completed",
          ),
        ).toMatchObject({ success: false, error: { code: "unhandled_step_failure" } });
      });
    },
  );

  it.each(["approved", "rejected", "rejected-recover", "rejected-with-next"])(
    "resumes a terminal nested gate after %s",
    async (decision) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition = wrap(() => ({
          name: "gate child",
          version: 1,
          start: "gate",
          steps: { gate: { type: "human", message: "Review nested work" } },
        }));
        if (decision === "rejected-with-next") {
          const child = definition.steps.call?.workflow;
          if (!child) throw new Error("Missing child fixture");
          child.steps.gate = { type: "human", next: "after" };
          child.steps.after = { type: "end" };
        }
        if (decision === "rejected-recover")
          definition.steps.call = {
            ...definition.steps.call,
            type: "subworkflow",
            on: { failure: "recover" },
          };
        definition.steps.recover = { type: "agent", agent: "recover" };
        const after = new FakeAgent(ok);
        const recovery = new FakeAgent(ok);
        const engine = new VeyraEngine();
        const paused = await engine.run({
          config,
          workflow: definition,
          agents: { after, recover: recovery },
          cwd: path,
          goal: "Nested approval",
        });
        expect(paused).toMatchObject({ status: "paused", lastStep: "call/gate" });
        const request = { config, runId: paused.runId, cwd: path };
        const pending = await engine.getPendingApproval(request);
        expect(pending?.stepId).toBe("call/gate");
        await expect(engine.resume({ ...request, agents: {} })).rejects.toMatchObject({
          code: "approval_required",
        });
        expect(
          (
            await engine.resolveApproval({
              ...request,
              approvalId: pending?.approvalId as string,
              decision: decision === "approved" ? "approved" : "rejected",
            })
          ).status,
        ).toBe("paused");
        const result = await new VeyraEngine().resume({
          ...request,
          agents: { after, recover: recovery },
        });
        expect(result.status).toBe(
          decision === "rejected" || decision === "rejected-with-next" ? "failed" : "completed",
        );
        expect(after.calls).toHaveLength(decision === "approved" ? 1 : 0);
        expect(recovery.calls).toHaveLength(decision === "rejected-recover" ? 1 : 0);
        const events = await new LocalRunStore({ stateDir: join(path, ".veyra") }).readEvents(
          paused.runId,
        );
        expect(events.filter((event) => event.type === "approval.required")).toHaveLength(1);
        expect(events.filter((event) => event.type === "subworkflow.started")).toHaveLength(1);
      });
    },
  );

  it("resumes two nested scopes in a new process using saved definitions after their source files disappear", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const child: WorkflowDefinition = {
        name: "saved child",
        version: 1,
        start: "once",
        steps: {
          once: {
            type: "command",
            run: ["node -e \"require('node:fs').appendFileSync('once.txt','x')\""],
            next: "gate",
          },
          gate: { type: "human", next: "produce" },
          produce: { type: "agent", agent: "worker" },
        },
      };
      const inner: WorkflowDefinition = {
        name: "wrapper",
        version: 1,
        start: "inner",
        steps: {
          inner: {
            type: "subworkflow",
            use: "./child.yaml",
            outputs: { answer: { from: "produce", path: "/data/answer" } },
          },
        },
      };
      const definition: WorkflowDefinition = {
        name: "root",
        version: 1,
        start: "outer",
        steps: {
          outer: {
            type: "subworkflow",
            workflow: inner,
            outputs: { answer: { from: "inner", path: "/outputs/answer" } },
            next: "after",
          },
          after: {
            type: "agent",
            agent: "after",
            inputs: { answer: { from: "outer", path: "/outputs/answer" } },
          },
        },
      };
      await writeFile(join(path, "parent.yaml"), JSON.stringify(definition));
      await writeFile(join(path, "child.yaml"), JSON.stringify(child));
      const engineUrl = new URL("../src/index.ts", import.meta.url).href;
      const workflowUrl = new URL("../../workflow/src/index.ts", import.meta.url).href;
      const source = `import { VeyraEngine } from ${JSON.stringify(engineUrl)};
import { loadWorkflow } from ${JSON.stringify(workflowUrl)};
const result=await new VeyraEngine().run({config:${JSON.stringify(config)},workflow:await loadWorkflow('parent.yaml',process.argv[1]),agents:{},goal:'nested resume',cwd:process.argv[1]});console.log(JSON.stringify(result));`;
      const writer = await runProcess({
        executable: process.execPath,
        args: ["--import", "tsx", "--input-type=module", "-e", source, path],
        timeoutMs: 30_000,
      });
      expect(writer.exitCode, writer.stderr).toBe(0);
      const paused = JSON.parse(writer.stdout);
      expect(paused).toMatchObject({ status: "paused", lastStep: "outer/inner/gate" });
      await rm(join(path, "parent.yaml"));
      await rm(join(path, "child.yaml"));
      const request = { config, runId: paused.runId, cwd: path };
      const engine = new VeyraEngine();
      const pending = await engine.getPendingApproval(request);
      await engine.resolveApproval({
        ...request,
        approvalId: pending?.approvalId as string,
        decision: "approved",
      });
      const worker = new FakeAgent({ ...ok, data: { answer: 42 } });
      const after = new FakeAgent(ok);
      expect(
        (await new VeyraEngine().resume({ ...request, agents: { worker, after } })).status,
      ).toBe("completed");
      expect(await readFile(join(path, "once.txt"), "utf8")).toBe("x");
      expect(worker.calls[0]?.stepId).toBe("outer/inner/produce");
      expect(after.calls[0]?.context?.inputs).toEqual({ answer: 42 });
      const events = await new LocalRunStore({ stateDir: join(path, ".veyra") }).readEvents(
        paused.runId,
      );
      expect(events.filter((event) => event.type === "subworkflow.started")).toHaveLength(2);
      expect(events.filter((event) => event.type === "subworkflow.completed")).toHaveLength(2);
    });
  });

  it("resumes parallel children within their own input scope and retains completed peers", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const child: WorkflowDefinition = {
        name: "parallel child",
        version: 1,
        start: "group",
        steps: {
          group: { type: "parallel", children: ["one", "two", "three"], concurrency: 1 },
          one: { type: "agent", agent: "worker" },
          two: { type: "agent", agent: "worker" },
          three: { type: "agent", agent: "worker" },
        },
      };
      const definition = wrap(() => child);
      const initial: string[] = [];
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (input) => {
          initial.push(input.stepId);
          return input.stepId.endsWith("/two") ? { status: "needs_input", summary: "Waiting" } : ok;
        },
      };
      const after = new FakeAgent(ok);
      const paused = await new VeyraEngine().run({
        config,
        workflow: definition,
        agents: { worker, after },
        cwd: path,
        goal: "Nested parallel",
      });
      expect(paused).toMatchObject({ status: "paused", lastStep: "call/group" });
      expect(initial).toEqual(["call/one", "call/two"]);
      const resumed = new FakeAgent(ok);
      expect(
        (
          await new VeyraEngine().resume({
            config,
            runId: paused.runId,
            agents: { worker: resumed, after },
            cwd: path,
          })
        ).status,
      ).toBe("completed");
      expect(resumed.calls.map((call) => [call.stepId, call.attempt])).toEqual([
        ["call/two", 2],
        ["call/three", 1],
      ]);
      for (const call of resumed.calls)
        expect(call.context).toMatchObject({ steps: {}, workflowInputs: {} });
      expect(Object.keys(after.calls[0]?.context?.steps ?? {})).toEqual(["call"]);
    });
  });

  it.each(["missing", "oversized"])(
    "propagates %s output mapping failure before the caller continues",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition = wrap(single);
        definition.steps.call = {
          ...definition.steps.call,
          type: "subworkflow",
          outputs: {
            value: {
              from: "produce",
              path: scenario === "missing" ? "/data/absent" : "/data/value",
            },
          },
        };
        const after = new FakeAgent(ok);
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow: definition,
          agents: { worker: new FakeAgent({ ...ok, data: { value: "x".repeat(40_000) } }), after },
          cwd: path,
          goal: "Validate output",
        });
        expect(result.status).toBe("failed");
        expect(after.calls).toHaveLength(0);
        expect(
          (await store.readEvents(result.runId)).find(
            (event) => event.type === "subworkflow.completed",
          ),
        ).toMatchObject({
          success: false,
          error: { code: scenario === "missing" ? "input_unavailable" : "input_too_large" },
        });
      });
    },
  );

  it("starts a fresh child context on a bounded call retry while keeping lifetime child attempt counters", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = wrap(single);
      definition.steps.call = {
        ...definition.steps.call,
        type: "subworkflow",
        on: { failure: "call" },
        retry: { max: 1 },
      };
      const calls: AgentInput[] = [];
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (input) => {
          calls.push(structuredClone(input));
          return calls.length === 1
            ? {
                status: "failure",
                summary: "First call failed",
                data: { old: "previous invocation" },
              }
            : ok;
        },
      };
      const result = await new VeyraEngine().run({
        config,
        workflow: definition,
        agents: { worker, after: new FakeAgent(ok) },
        cwd: path,
        goal: "Retry call",
      });
      expect(result.status).toBe("completed");
      expect(calls.map((input) => input.attempt)).toEqual([1, 2]);
      for (const call of calls) expect(call.context?.steps).toEqual({});
    });
  });

  it("treats cancellation as a whole-run stop even when the caller declares error recovery", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = wrap(single);
      definition.steps.call = {
        ...definition.steps.call,
        type: "subworkflow",
        on: { failure: "after" },
      };
      const controller = new AbortController();
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        run: async (_input, options) => {
          expect(options?.signal).toBe(controller.signal);
          controller.abort();
          return ok;
        },
      };
      const after = new FakeAgent(ok);
      const result = await new VeyraEngine().run({
        config,
        workflow: definition,
        agents: { worker, after },
        cwd: path,
        goal: "Cancel nested run",
        signal: controller.signal,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "run_cancelled" } });
      expect(after.calls).toHaveLength(0);
    });
  });
});
