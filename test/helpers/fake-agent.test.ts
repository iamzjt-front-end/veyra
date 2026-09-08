import type { AgentInput, AgentResult } from "@veyraoss/protocol";
import { describe, expect, it } from "vitest";
import { FakeAgent } from "./fake-agent.js";

function input(): AgentInput {
  return {
    runId: "test-run",
    stepId: "plan",
    role: "planner",
    goal: "Update the fixture greeting",
    context: { value: "original" },
  };
}

describe("FakeAgent", () => {
  it("returns deterministic results and records isolated input copies", async () => {
    const response: AgentResult = { status: "success", summary: "A deterministic plan" };
    const agent = new FakeAgent(response);
    const request = input();
    const first = await agent.run(request);

    response.summary = "changed by caller";
    request.goal = "changed after the call";
    first.summary = "changed by consumer";

    expect(await agent.run(input())).toEqual({
      status: "success",
      summary: "A deterministic plan",
    });
    expect(agent.calls).toEqual([input(), input()]);
  });

  it("can return a configured failure without any provider connection", async () => {
    const response: AgentResult = { status: "failure", summary: "Fixture rejection" };
    expect(await new FakeAgent(response).run(input())).toEqual(response);
  });
});
