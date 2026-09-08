import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { AgentAdapter } from "@veyraoss/protocol";
import type { WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } });
const effect = "node -e \"require('node:fs').writeFileSync('operation.txt','once')\"";

describe("command authorization boundary", () => {
  it("keeps provider command claims and goal shell syntax out of configured verifier execution", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        name: "sources",
        version: 1,
        start: "agent",
        steps: {
          agent: { type: "agent", agent: "worker", next: "verify" },
          verify: { type: "command", run: ["node --test"] },
        },
      };
      const worker: AgentAdapter = {
        id: "worker",
        provider: "fixture",
        async run() {
          return {
            status: "success",
            summary: "Provider claim only",
            data: {
              commandsRun: [effect],
              commands: [effect],
              run: [effect],
              instructions: effect,
            },
          };
        },
      };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const result = await new VeyraEngine({ store }).run({
        config,
        cwd: path,
        workflow,
        agents: { worker },
        goal: `Literal data: $(touch injected.txt); ${effect}`,
      });
      expect(result.status).toBe("completed");
      for (const file of ["operation.txt", "injected.txt"])
        await expect(readFile(join(path, file))).rejects.toMatchObject({ code: "ENOENT" });
      const events = await store.readEvents(result.runId);
      expect(
        events
          .filter((event) => event.type.startsWith("verification."))
          .map((event) => ("commandSource" in event ? event.commandSource : undefined)),
      ).toEqual(["workflow", "workflow"]);
      expect(events.find((event) => event.type === "verification.started")).toMatchObject({
        commands: ["node --test"],
      });
    });
  });

  it.each(["approved", "rejected"] as const)(
    "requires a recorded %s decision before a gated operation",
    async (decision) => {
      await withFixtureWorkspace(async ({ path }) => {
        const workflow: WorkflowDefinition = {
          name: "guarded operation",
          version: 1,
          start: "operation",
          policy: { approval: { before: ["operation"] } },
          steps: {
            operation: { type: "command", run: [effect] },
          },
        };
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const engine = new VeyraEngine({ store });
        const initial = await engine.run({
          config,
          cwd: path,
          workflow,
          agents: {},
          goal: "Fixture effect gated as high risk",
        });
        const request = { config, cwd: path, runId: initial.runId };
        expect(initial.status).toBe("paused");
        await expect(readFile(join(path, "operation.txt"))).rejects.toMatchObject({
          code: "ENOENT",
        });
        await expect(engine.resume({ ...request, agents: {} })).rejects.toMatchObject({
          code: "approval_required",
        });
        const pending = await engine.getPendingApproval(request);
        expect(pending?.context?.operation).toMatchObject({
          stepId: "operation",
          type: "command",
          commandSource: "workflow",
          preview: JSON.stringify({ run: [effect] }),
          truncated: false,
        });
        const resolved = await engine.resolveApproval({
          ...request,
          decision,
          approvalId: pending?.approvalId as string,
        });
        if (decision === "approved") {
          expect(resolved.status).toBe("paused");
          expect((await new VeyraEngine({ store }).resume({ ...request, agents: {} })).status).toBe(
            "completed",
          );
          expect(await readFile(join(path, "operation.txt"), "utf8")).toBe("once");
        } else {
          expect(resolved.status).toBe("failed");
          await expect(readFile(join(path, "operation.txt"))).rejects.toMatchObject({
            code: "ENOENT",
          });
        }
      });
    },
  );

  it("bounds approval previews and explicitly reports omitted operation text", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        version: 1,
        name: "large operation",
        start: "command",
        policy: { approval: { before: ["command"] } },
        steps: { command: { type: "command", run: [`echo ${"x".repeat(20000)}`] } },
      };
      const engine = new VeyraEngine();
      const run = await engine.run({
        config,
        cwd: path,
        workflow,
        agents: {},
        goal: "Bounded inspection",
      });
      const approval = await engine.getPendingApproval({ config, cwd: path, runId: run.runId });
      expect(approval?.context?.operation).toMatchObject({ truncated: true });
      expect(JSON.stringify(approval?.context?.operation).length).toBeLessThan(8400);
    });
  });
});
