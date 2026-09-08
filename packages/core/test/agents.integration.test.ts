import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentReadiness,
  AgentResult,
  AgentRole,
} from "@veyra/protocol";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { discoverAgents, LocalRunStore, VeyraEngine } from "../src/index.js";
import { selectAgent } from "../src/agents.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "capabilities" } });
const ok: AgentResult = { status: "success", summary: "Evidence-backed result" };
function described(provider = "third-party", result = ok) {
  const fake = new FakeAgent(result, "configured-agent");
  const descriptor: AgentDescriptor = {
    schemaVersion: 1,
    id: fake.id,
    provider,
    adapterVersion: "0.1.0",
    model: "configured-model",
    roles: ["planner", "reviewer", "judge"],
    capabilities: ["reasoning", "structured-output"],
  };
  const readiness = vi.fn(async (): Promise<AgentReadiness> => ({
    status: "ready",
    scope: "configuration",
    message: "Configuration checked; service not contacted",
  }));
  const adapter: AgentAdapter = {
    id: fake.id,
    provider,
    describe: () => descriptor,
    checkReadiness: readiness,
    run: (input) => fake.run(input),
  };
  return { fake, descriptor, adapter, readiness };
}
const definition = (): WorkflowDefinition => ({
  name: "explicit-selection",
  version: 1,
  start: "work",
  steps: {
    work: {
      type: "agent",
      agent: "analysis-binding",
      requires: { role: "planner", capabilities: ["reasoning", "structured-output"] },
    },
  },
});
const storeAt = (path: string) => new LocalRunStore({ stateDir: join(path, ".veyra") });

describe("agent discovery and explicit capability selection", () => {
  it("discovers metadata without running or probing agents and returns independent copies", async () => {
    const fixture = described();
    const found = await discoverAgents({ bound: fixture.adapter, legacy: new FakeAgent(ok) });
    expect(found).toEqual([
      { binding: "bound", descriptor: fixture.descriptor },
      { binding: "legacy" },
    ]);
    found[0]?.descriptor?.capabilities.push("vision");
    expect(fixture.descriptor.capabilities).not.toContain("vision");
    expect(fixture.readiness).not.toHaveBeenCalled();
    expect(fixture.fake.calls).toHaveLength(0);
  });
  it("probes readiness only when requested, forwards controls, and distinguishes unknown support", async () => {
    const fixture = described();
    const signal = new AbortController().signal;
    const result = await discoverAgents(
      { selected: fixture.adapter, legacy: new FakeAgent(ok) },
      { checkReadiness: true, cwd: "/fixture", timeoutMs: 20, signal },
    );
    expect(fixture.readiness).toHaveBeenCalledWith({ cwd: "/fixture", timeoutMs: 20, signal });
    expect(result[0]?.readiness).toMatchObject({ status: "ready", scope: "configuration" });
    expect(result[1]?.readiness?.status).toBe("unknown");
    expect(fixture.fake.calls).toHaveLength(0);
    fixture.readiness.mockClear();
    expect(
      (
        await discoverAgents(
          { selected: fixture.adapter },
          { checkReadiness: true, signal: AbortSignal.abort() },
        )
      )[0]?.readiness?.status,
    ).toBe("unknown");
    expect(fixture.readiness).not.toHaveBeenCalled();
  });
  it("isolates invalid metadata and suppresses raw readiness errors", async () => {
    const bad = described();
    bad.descriptor.provider = "spoofed";
    const throwing = described("throwing");
    throwing.readiness.mockImplementation(async () => {
      throw new Error("sensitive credential detail");
    });
    const malformed = described("malformed");
    malformed.readiness.mockResolvedValue({ status: "ready" } as AgentReadiness);
    const result = await discoverAgents(
      { bad: bad.adapter, throwing: throwing.adapter, malformed: malformed.adapter },
      { checkReadiness: true },
    );
    expect(result.map((item) => item.error?.code)).toEqual([
      "invalid_agent_descriptor",
      "agent_readiness_failed",
      "invalid_agent_readiness",
    ]);
    expect(JSON.stringify(result)).not.toContain("sensitive credential");
    expect(bad.readiness).not.toHaveBeenCalled();
  });
  it.each(["provider-a", "provider-b"])(
    "routes the same role/capability contract through %s and audits selection",
    async (provider) => {
      await withFixtureWorkspace(async ({ path }) => {
        const fixture = described(provider);
        const store = storeAt(path);
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow: definition(),
          agents: { "analysis-binding": fixture.adapter },
          goal: "Plan using the selected provider",
          cwd: path,
        });
        expect(result.status).toBe("completed");
        expect(fixture.fake.calls[0]?.role).toBe("planner");
        const events = await store.readEvents(result.runId);
        const selected = events.find((event) => event.type === "agent.selected");
        expect(selected).toMatchObject({
          binding: "analysis-binding",
          provider,
          role: "planner",
          requirements: { capabilities: ["reasoning", "structured-output"] },
          descriptor: fixture.descriptor,
        });
        expect(events.findIndex((event) => event.type === "agent.selected")).toBeLessThan(
          events.findIndex((event) => event.type === "agent.input"),
        );
        expect(fixture.readiness).not.toHaveBeenCalled();
      });
    },
  );
  it.each(["capability", "role", "descriptor", "missing"] as const)(
    "refuses a selected adapter with incompatible %s without substituting a peer",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        const selected = described();
        if (scenario === "capability") selected.descriptor.capabilities = [];
        if (scenario === "role") selected.descriptor.roles = ["executor"];
        if (scenario === "descriptor") selected.descriptor.id = "wrong-id";
        if (scenario === "missing") delete selected.adapter.describe;
        const fallback = described("alternative");
        const result = await new VeyraEngine({ store: storeAt(path) }).run({
          config,
          workflow: definition(),
          agents: { "analysis-binding": selected.adapter, fallback: fallback.adapter },
          goal: "Keep explicit binding",
          cwd: path,
        });
        expect(result).toMatchObject({
          status: "failed",
          error: {
            code: {
              capability: "unsupported_agent_capability",
              role: "unsupported_agent_role",
              descriptor: "invalid_agent_descriptor",
              missing: "missing_agent_descriptor",
            }[scenario],
          },
        });
        expect(selected.fake.calls).toHaveLength(0);
        expect(fallback.fake.calls).toHaveLength(0);
      });
    },
  );
  it("checks saved requirements against the newly supplied adapter on resume", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const workflow = definition();
      const first = described("original", { status: "needs_input", summary: "Wait for context" });
      const store = storeAt(path);
      const paused = await new VeyraEngine({ store }).run({
        config,
        workflow,
        agents: { "analysis-binding": first.adapter },
        goal: "Resume with requirements",
        cwd: path,
      });
      expect(paused.status).toBe("paused");
      const work = workflow.steps.work;
      if (!work) throw new Error("Missing fixture step");
      work.requires = {};
      const replacement = described("replacement");
      replacement.descriptor.capabilities = [];
      const result = await new VeyraEngine({ store: storeAt(path) }).resume({
        config,
        cwd: path,
        runId: paused.runId,
        agents: { "analysis-binding": replacement.adapter },
      });
      expect(result).toMatchObject({
        status: "failed",
        error: { code: "unsupported_agent_capability" },
      });
      expect(replacement.fake.calls).toHaveLength(0);
    });
  });
  it("keeps legacy bindings compatible while requiring descriptors for explicit constraints", () => {
    const legacy = new FakeAgent(ok);
    expect(selectAgent(legacy, "custom-name").role).toBe("custom-name");
    expect(selectAgent(legacy, "custom-name", {}, "reviewer").role).toBe("reviewer");
    expect(() => selectAgent(legacy, "custom-name", { capabilities: ["reasoning"] })).toThrow(
      "metadata",
    );
    const fixture = described();
    expect(() =>
      selectAgent(fixture.adapter, "bound", { role: "executor" as AgentRole }, "reviewer"),
    ).toThrow("conflicts");
  });
});
