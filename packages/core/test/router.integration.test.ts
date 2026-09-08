import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { JsonValue } from "@veyraoss/protocol";
import { runProcess } from "@veyraoss/runtime";
import type { WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "router" } });
const workflow = (): WorkflowDefinition => ({
  name: "router",
  version: 1,
  start: "classify",
  steps: {
    classify: { type: "agent", agent: "classifier", next: "choose" },
    choose: {
      type: "router",
      route: { from: "classify", path: "/data/route" },
      on: { inspect: "inspect", change: "change" },
      next: "fallback",
    },
    ...Object.fromEntries(
      ["inspect", "change", "fallback"].map((id) => [
        id,
        {
          type: "command" as const,
          run: [`node -e "require('node:fs').appendFileSync('${id}.txt','x')"`],
          next: "done",
        },
      ]),
    ),
    done: { type: "end" },
  },
});

describe("persisted router execution", () => {
  it.each(["inspect", "change", "unknown"])(
    "audits an agent-proposed %s label before executing only its declared target",
    async (label) => {
      await withFixtureWorkspace(async ({ path }) => {
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        let sawDecision = false;
        const engine = new VeyraEngine({
          store,
          emit: async (event) => {
            if (event.type !== "router.selected") return;
            sawDecision = true;
            expect((await store.readEvents(event.runId)).at(-1)).toEqual(event);
            expect((await readdir(path)).filter((name) => name.endsWith(".txt"))).toEqual([]);
          },
        });
        const classifier = new FakeAgent({
          status: "success",
          summary: "Classification",
          data: { route: label },
        });
        const result = await engine.run({
          config,
          workflow: workflow(),
          agents: { classifier },
          cwd: path,
          goal: "Choose route",
        });
        expect(result.status).toBe("completed");
        expect(sawDecision).toBe(true);
        expect(classifier.calls).toHaveLength(1);
        const target = label === "unknown" ? "fallback" : label;
        expect((await readdir(path)).filter((name) => name.endsWith(".txt"))).toEqual([
          `${target}.txt`,
        ]);
        expect(
          (await store.readEvents(result.runId)).find((event) => event.type === "router.selected"),
        ).toMatchObject({
          stepId: "choose",
          route: label,
          target,
          selection: "input",
          source: { stepId: "classify", path: "/data/route" },
        });
      });
    },
  );

  it("selects statically without any provider and exposes the saved decision to later inputs", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.start = "choose";
      definition.steps.choose = { type: "router", route: "inspect", on: { inspect: "gate" } };
      definition.steps.gate = {
        type: "human",
        inputs: { target: { from: "choose", path: "/target" } },
      };
      const engine = new VeyraEngine();
      const result = await engine.run({
        config,
        workflow: definition,
        agents: {},
        cwd: path,
        goal: "Static route",
      });
      expect(result.status).toBe("paused");
      expect(
        (await engine.getPendingApproval({ config, runId: result.runId, cwd: path }))?.context
          ?.inputs,
      ).toEqual({ target: "gate" });
    });
  });

  it.each([
    { selected: "done", expected: "unmatched_route" },
    { selected: "constructor", expected: "unmatched_route" },
    { selected: 1, expected: "invalid_route" },
    { selected: null, expected: "invalid_route" },
    { selected: "x".repeat(129), expected: "invalid_route" },
  ] as { selected: JsonValue; expected: string }[])(
    "refuses invalid or undeclared selection %# before any target executes",
    async ({ selected, expected }) => {
      await withFixtureWorkspace(async ({ path }) => {
        const definition = workflow();
        delete definition.steps.choose?.next;
        const result = await new VeyraEngine().run({
          config,
          workflow: definition,
          agents: {
            classifier: new FakeAgent({
              status: "success",
              summary: "Classifier",
              data: { route: selected },
            }),
          },
          cwd: path,
          goal: "Validate route",
        });
        expect(result).toMatchObject({
          status: "failed",
          lastStep: "choose",
          error: { code: expected },
        });
        expect((await readdir(path)).filter((name) => name.endsWith(".txt"))).toEqual([]);
      });
    },
  );

  it("fails an unavailable reference instead of silently using the fallback", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.start = "choose";
      const result = await new VeyraEngine().run({
        config,
        workflow: definition,
        agents: {},
        cwd: path,
        goal: "Missing evidence",
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "input_unavailable" } });
      expect((await readdir(path)).filter((name) => name.endsWith(".txt"))).toEqual([]);
    });
  });

  it("restores selected data after a human gate and a new engine without reclassifying", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      definition.steps.classify = { type: "agent", agent: "classifier", next: "gate" };
      definition.steps.gate = { type: "human", next: "choose" };
      const classifier = new FakeAgent({
        status: "success",
        summary: "Classified",
        data: { route: "change", unused: "x".repeat(40_000) },
      });
      const engine = new VeyraEngine();
      const paused = await engine.run({
        config,
        workflow: definition,
        agents: { classifier },
        cwd: path,
        goal: "Resume routing",
      });
      expect(paused.status).toBe("paused");
      const request = { config, runId: paused.runId, cwd: path };
      const pending = await engine.getPendingApproval(request);
      await engine.resolveApproval({
        ...request,
        approvalId: pending?.approvalId as string,
        decision: "approved",
      });
      const result = await new VeyraEngine().resume({ ...request, agents: {} });
      expect(result.status).toBe("completed");
      expect(await readFile(join(path, "change.txt"), "utf8")).toBe("x");
      expect(classifier.calls).toHaveLength(1);
    });
  });

  it("recovers a completed router checkpoint in a new process without repeating classification", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition = workflow();
      const moduleUrl = new URL("../src/index.ts", import.meta.url).href;
      const source = `import { VeyraEngine } from ${JSON.stringify(moduleUrl)};
const classifier = { id: 'classifier', provider: 'fixture', run: async () => ({ status: 'success', summary: 'Selected', data: { route: 'inspect' } }) };
await new VeyraEngine({emit:event=>{if(event.type==='step.completed' && event.stepId==='choose'){console.log(event.runId);process.exit(0);}}}).run({config:${JSON.stringify(config)},workflow:${JSON.stringify(definition)},agents:{classifier},goal:'checkpoint',cwd:process.argv[1]});`;
      const child = await runProcess({
        executable: process.execPath,
        args: ["--import", "tsx", "--input-type=module", "-e", source, path],
        timeoutMs: 30_000,
      });
      expect(child.exitCode, child.stderr).toBe(0);
      const runId = child.stdout.trim();
      const result = await new VeyraEngine().resume({
        config,
        runId,
        cwd: path,
        agents: {},
        recoverInterrupted: true,
      });
      expect(result.status).toBe("completed");
      expect(await readFile(join(path, "inspect.txt"), "utf8")).toBe("x");
      const events = await new LocalRunStore({ stateDir: join(path, ".veyra") }).readEvents(runId);
      expect(events.filter((event) => event.type === "router.selected")).toHaveLength(1);
      expect(events.filter((event) => event.type === "agent.started")).toHaveLength(1);
    });
  });

  it("bounds a static routing cycle using the saved per-step retry limit", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const definition: WorkflowDefinition = {
        name: "router cycle",
        version: 1,
        start: "repeat",
        steps: {
          repeat: { type: "router", route: "again", on: { again: "repeat" }, retry: { max: 2 } },
        },
      };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: {},
        cwd: path,
        goal: "Bound routing",
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "retry_exhausted" } });
      expect(
        (await store.readEvents(result.runId)).filter((event) => event.type === "router.selected"),
      ).toHaveLength(3);
    });
  });
});
