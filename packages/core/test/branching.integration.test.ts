import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type { AgentResult } from "@veyraoss/protocol";
import type { WorkflowDefinition } from "@veyraoss/workflow";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "branches" } });
const cases: { label: string; result: AgentResult; expected: string | null }[] = [
  {
    label: "pass takes its exact branch before next",
    result: { status: "success", summary: "approved", outcome: "pass" },
    expected: "accepted",
  },
  {
    label: "review fail takes the explicit repair/rejection branch",
    result: { status: "success", summary: "requires change", outcome: "fail" },
    expected: "rejected",
  },
  {
    label: "unknown successful outcome takes next",
    result: { status: "success", summary: "custom", outcome: "custom" },
    expected: "fallback",
  },
  {
    label: "normalized failure cannot masquerade as a pass",
    result: { status: "failure", summary: "provider failed", outcome: "pass" },
    expected: "failed",
  },
  {
    label: "needs_input pauses before any outcome branch",
    result: { status: "needs_input", summary: "needs approval", outcome: "pass" },
    expected: null,
  },
];

describe("persisted conditional branch execution", () => {
  it.each(cases)("$label", async ({ result: selected, expected }) => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow: WorkflowDefinition = {
        name: "branches",
        version: 1,
        start: "select",
        steps: {
          select: {
            type: "agent",
            agent: "selector",
            on: { pass: "accepted", fail: "rejected", failure: "failed" },
            next: "fallback",
          },
          ...Object.fromEntries(
            ["accepted", "rejected", "failed", "fallback"].map((branch) => [
              branch,
              {
                type: "command" as const,
                run: [`node -e "require('node:fs').writeFileSync('${branch}.txt','selected')"`],
                next: "done",
              },
            ]),
          ),
          done: { type: "end" },
        },
      };
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const outcome = await new VeyraEngine({ store }).run({
        config,
        workflow,
        agents: { selector: new FakeAgent(selected) },
        cwd: path,
        goal: "Select one branch",
      });
      expect(outcome.status).toBe(expected ? "completed" : "paused");
      const markers = (await readdir(path)).filter((name) => name.endsWith(".txt"));
      expect(markers).toEqual(expected ? [`${expected}.txt`] : []);
      const events = await store.readEvents(outcome.runId);
      expect(
        events.filter((event) => event.type === "step.started").map((event) => event.stepId),
      ).toEqual(expected ? ["select", expected, "done"] : ["select"]);
      expect((await store.loadRun(outcome.runId)).state.status).toBe(outcome.status);
    });
  });
});
