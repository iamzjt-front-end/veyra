import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { AgentAdapter, ProjectId } from "@veyraoss/protocol";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

describe("caller-correlated Core run identity", () => {
  it.each(["matching", "wrong-run", "credentials"])(
    "validates %s native session result before persistence",
    async (mode) => {
      await withFixtureWorkspace(async ({ path }) => {
        const runId = randomUUID();
        const session = {
          version: 1 as const,
          kind: "session" as const,
          provider: "fake",
          id: randomUUID(),
          projectId: randomUUID() as ProjectId,
          runId: mode === "wrong-run" ? randomUUID() : runId,
          createdAt: new Date().toISOString(),
          ...(mode === "credentials" ? { token: "fixture-secret" } : {}),
        };
        const agent: AgentAdapter = {
          id: "worker",
          provider: "fake",
          run: async () => ({ status: "success", summary: "Done", session }),
        };
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const result = await new VeyraEngine({ store }).run({
          runId,
          cwd: path,
          goal: "Check safe native result",
          config: parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } }),
          workflow: {
            version: 1,
            name: "fixture",
            start: "work",
            steps: { work: { type: "agent", agent: "worker" } },
          },
          agents: { worker: agent },
        });
        expect(result.status).toBe(mode === "matching" ? "completed" : "failed");
        const events = await store.readEvents(runId);
        if (mode === "matching")
          expect(events.find((event) => event.type === "agent.completed")).toMatchObject({
            result: { session },
          });
        else {
          expect(result.error?.code).toBe("invalid_agent_result");
          expect(events.some((event) => event.type === "agent.completed")).toBe(false);
          expect(JSON.stringify(events)).not.toContain("fixture-secret");
        }
      });
    },
  );
  it("rejects invalid IDs before creating state and existing IDs before replaying work", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const stateDir = join(path, ".veyra");
      const store = new LocalRunStore({ stateDir });
      const engine = new VeyraEngine({ store });
      const agent = new FakeAgent({ status: "success", summary: "Once" });
      const request = {
        config: parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } }),
        workflow: {
          version: 1 as const,
          name: "fixture",
          start: "work",
          steps: { work: { type: "agent" as const, agent: "worker" } },
        },
        goal: "Execute once",
        cwd: path,
        agents: { worker: agent },
      };
      await expect(engine.run({ ...request, runId: "../outside" })).rejects.toMatchObject({
        code: "invalid_input",
      });
      await expect(stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      const runId = randomUUID();
      expect(await engine.run({ ...request, runId })).toMatchObject({ runId, status: "completed" });
      const before = await readFile(join(stateDir, "runs", runId, "input.json"));
      await expect(engine.run({ ...request, runId, goal: "Overwrite" })).rejects.toMatchObject({
        code: "run_exists",
      });
      expect(await readFile(join(stateDir, "runs", runId, "input.json"))).toEqual(before);
      expect(agent.calls).toHaveLength(1);
      expect(agent.calls[0]?.runId).toBe(runId);
    });
  });
});
