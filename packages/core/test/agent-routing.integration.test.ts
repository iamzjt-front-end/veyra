import { join } from "node:path";
import { parseConfig } from "@veyraoss/config";
import type {
  AgentAdapter,
  AgentDescriptor,
  AgentReadiness,
  AgentResult,
  AgentRoutingPolicy,
  VeyraEvent,
} from "@veyraoss/protocol";
import { isAgentRoutingDecision } from "@veyraoss/protocol";
import type { WorkflowDefinition, WorkflowStep } from "@veyraoss/workflow";
import { describe, expect, it, vi } from "vitest";
import { FakeAgent } from "../../../test/helpers/fake-agent.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, selectAgentRoute, VeyraEngine } from "../src/index.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "routing" } });
const policy = (): AgentRoutingPolicy => ({
  fallbacks: ["backup"],
  fallbackOn: ["requirements", "unavailable", "budget"],
});
const requirements = { role: "planner", capabilities: ["reasoning"] };
function agent(
  id: string,
  status: AgentReadiness["status"] = "ready",
  result: AgentResult = { status: "success", summary: "Fixture evidence", outcome: "pass" },
) {
  const fake = new FakeAgent(result, id);
  const descriptor: AgentDescriptor = {
    schemaVersion: 1,
    id,
    provider: `provider-${id}`,
    adapterVersion: "1.0.0",
    model: `pinned-${id}`,
    roles: ["planner", "reviewer", "judge"],
    capabilities: ["reasoning"],
  };
  const readiness = vi.fn<NonNullable<AgentAdapter["checkReadiness"]>>(async () => ({
    status,
    scope: "configuration",
    message: "Private provider diagnosis fixture-secret must not enter audit decisions",
  }));
  const adapter: AgentAdapter = {
    id,
    provider: descriptor.provider,
    describe: () => descriptor,
    checkReadiness: readiness,
    run: (input) => fake.run(input),
  };
  return { fake, descriptor, readiness, adapter };
}
const step = (routing = policy()): WorkflowStep => ({
  type: "agent",
  agent: "primary",
  requires: requirements,
  routing,
});
const workflow = (): WorkflowDefinition => ({
  name: "routed",
  version: 1,
  start: "work",
  steps: { work: step() },
});
const storeAt = (path: string) => new LocalRunStore({ stateDir: join(path, ".veyra") });

describe("explicit provider routing", () => {
  it("keeps configured preference/model and does not probe or execute a later eligible peer", async () => {
    const primary = agent("primary"),
      backup = agent("backup");
    const result = await selectAgentRoute({
      primary: "primary",
      policy: policy(),
      requirements,
      agents: { primary: primary.adapter, backup: backup.adapter },
    });
    expect(result.decision).toMatchObject({
      selected: "primary",
      attempts: [
        {
          reason: "preferred_eligible",
          descriptor: { model: "pinned-primary" },
          readiness: { status: "ready", scope: "configuration" },
        },
      ],
    });
    expect(isAgentRoutingDecision(result.decision)).toBe(true);
    expect(backup.readiness).not.toHaveBeenCalled();
    expect(primary.fake.calls).toHaveLength(0);
    expect(JSON.stringify(result.decision)).not.toContain("fixture-secret");
  });
  it.each(["capability", "role", "metadata"] as const)(
    "skips incompatible %s only under explicit requirements fallback",
    async (kind) => {
      const primary = agent("primary"),
        backup = agent("backup");
      if (kind === "capability") primary.descriptor.capabilities = [];
      if (kind === "role") primary.descriptor.roles = ["executor"];
      if (kind === "metadata") delete primary.adapter.describe;
      const request = {
        primary: "primary",
        policy: policy(),
        requirements,
        agents: { primary: primary.adapter, backup: backup.adapter },
      };
      const result = await selectAgentRoute(request);
      expect(result.decision.selected).toBe("backup");
      expect(result.selection?.role).toBe("planner");
      expect(primary.readiness).not.toHaveBeenCalled();
      expect(isAgentRoutingDecision(result.decision)).toBe(true);
      backup.readiness.mockClear();
      request.policy.fallbackOn = ["unavailable"];
      const blocked = await selectAgentRoute(request);
      expect(blocked.decision.selected).toBeUndefined();
      expect(blocked.decision.attempts[0]?.decision).toBe("blocked");
      expect(isAgentRoutingDecision(blocked.decision)).toBe(true);
      expect(backup.readiness).not.toHaveBeenCalled();
    },
  );
  it("uses explicit estimates, treats missing cost as unknown, and preserves order within the ceiling", async () => {
    const primary = agent("primary"),
      backup = agent("backup"),
      local = agent("local");
    const routing: AgentRoutingPolicy = {
      ...policy(),
      fallbacks: ["backup", "local"],
      budget: {
        currency: "USD",
        maxEstimatedCost: 0.02,
        estimates: [
          { agent: "primary", amount: 0.03 },
          { agent: "local", amount: 0.02 },
        ],
      },
    };
    const result = await selectAgentRoute({
      primary: "primary",
      policy: routing,
      requirements,
      agents: { primary: primary.adapter, backup: backup.adapter, local: local.adapter },
    });
    expect(result.decision).toMatchObject({
      selected: "local",
      attempts: [
        { reason: "estimate_exceeded", estimatedCost: 0.03 },
        { reason: "estimate_missing" },
        { reason: "fallback_eligible", estimatedCost: 0.02 },
      ],
    });
    expect(isAgentRoutingDecision(result.decision)).toBe(true);
    expect(primary.readiness).not.toHaveBeenCalled();
    expect(backup.readiness).not.toHaveBeenCalled();
    expect(local.readiness).toHaveBeenCalledOnce();
  });
  it.each(["unknown", "missing"] as const)(
    "requires explicit permission for %s readiness",
    async (kind) => {
      const primary = agent("primary", "unknown"),
        backup = agent("backup", "unavailable");
      if (kind === "missing") delete primary.adapter.checkReadiness;
      const request = {
        primary: "primary",
        policy: policy(),
        requirements,
        agents: { primary: primary.adapter, backup: backup.adapter },
      };
      expect((await selectAgentRoute(request)).decision).toMatchObject({
        attempts: [
          { reason: "readiness_unknown", decision: "skipped" },
          { reason: "unavailable", decision: "blocked" },
        ],
      });
      request.policy.allowUnknownReadiness = true;
      expect((await selectAgentRoute(request)).decision).toMatchObject({
        selected: "primary",
        attempts: [{ readiness: { status: "unknown" } }],
      });
    },
  );
  it.each(["throw", "timeout"] as const)(
    "audits a %s probe safely and drains it before fallback",
    async (kind) => {
      const primary = agent("primary"),
        backup = agent("backup");
      let drained = false;
      primary.readiness.mockImplementation(async (controls) => {
        if (kind === "timeout")
          await new Promise<void>((resolve) =>
            controls?.signal?.addEventListener("abort", () => resolve(), { once: true }),
          );
        drained = true;
        throw new Error("fixture-secret native error");
      });
      backup.readiness.mockImplementation(async () => {
        expect(drained).toBe(true);
        return { status: "ready", scope: "local", message: "ready" };
      });
      const result = await selectAgentRoute({
        primary: "primary",
        policy: { ...policy(), readinessTimeoutMs: 5 },
        requirements,
        agents: { primary: primary.adapter, backup: backup.adapter },
        controls: { cwd: "/fixture" },
      });
      expect(result.decision).toMatchObject({
        selected: "backup",
        attempts: [
          { reason: kind === "timeout" ? "readiness_timeout" : "readiness_failed" },
          { reason: "fallback_eligible" },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("fixture-secret");
      expect(primary.readiness.mock.calls[0]?.[0]).toMatchObject({ cwd: "/fixture", timeoutMs: 5 });
    },
  );
  it("cancels a pending probe without probing a fallback or invoking an agent", async () => {
    const primary = agent("primary"),
      backup = agent("backup"),
      controller = new AbortController();
    primary.readiness.mockImplementation(async (controls) => {
      controller.abort();
      expect(controls?.signal?.aborted).toBe(true);
      return { status: "unavailable", scope: "local", message: "cancelled" };
    });
    const request = {
      primary: "primary",
      policy: policy(),
      requirements,
      agents: { primary: primary.adapter, backup: backup.adapter },
      controls: { signal: controller.signal },
    };
    await expect(selectAgentRoute(request)).rejects.toMatchObject({ code: "run_cancelled" });
    expect(backup.readiness).not.toHaveBeenCalled();
    primary.readiness.mockClear();
    await expect(selectAgentRoute(request)).rejects.toMatchObject({ code: "run_cancelled" });
    expect(primary.readiness).not.toHaveBeenCalled();
  });
  it.each(["descriptor", "readiness", "plugin-readiness", "missing", "conflict"] as const)(
    "stops configuration/contract error %s without fallback",
    async (kind) => {
      const primary = agent("primary"),
        backup = agent("backup");
      if (kind === "descriptor") primary.descriptor.provider = "spoofed";
      if (kind === "readiness")
        primary.readiness.mockResolvedValue({ status: "ready" } as AgentReadiness);
      if (kind === "plugin-readiness")
        primary.readiness.mockRejectedValue(
          Object.assign(new Error("fixture-secret"), { code: "invalid_plugin_readiness" }),
        );
      const agents: Record<string, AgentAdapter> =
        kind === "missing"
          ? { primary: primary.adapter }
          : { primary: primary.adapter, backup: backup.adapter };
      await expect(
        selectAgentRoute({
          primary: "primary",
          policy: policy(),
          requirements,
          agents,
          ...(kind === "conflict" ? { role: "reviewer" } : {}),
        }),
      ).rejects.toMatchObject({
        code: {
          descriptor: "invalid_agent_descriptor",
          readiness: "invalid_agent_readiness",
          "plugin-readiness": "invalid_agent_readiness",
          missing: "missing_adapter",
          conflict: "agent_role_conflict",
        }[kind],
      });
      expect(backup.readiness).not.toHaveBeenCalled();
    },
  );
  it("persists the decision before invocation and exposes the actual provider/model on the shared event path", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const primary = agent("primary", "unavailable"),
        backup = agent("backup"),
        store = storeAt(path);
      const run = backup.adapter.run;
      backup.adapter.run = async (input) => {
        const events = await store.readEvents(input.runId);
        expect(events.find((event) => event.type === "agent.routed")).toMatchObject({
          decision: { selected: "backup" },
        });
        expect(events.find((event) => event.type === "agent.selected")).toMatchObject({
          binding: "backup",
          provider: "provider-backup",
          descriptor: { model: "pinned-backup" },
        });
        return run(input);
      };
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: workflow(),
        agents: { primary: primary.adapter, backup: backup.adapter },
        goal: "Plan",
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(backup.fake.calls[0]).toMatchObject({ role: "planner", profile: { role: "planner" } });
      expect(primary.fake.calls).toHaveLength(0);
      const events = await store.readEvents(result.runId);
      expect(JSON.stringify(events)).not.toContain("fixture-secret");
      expect(events.findIndex((event) => event.type === "agent.routed")).toBeLessThan(
        events.findIndex((event) => event.type === "agent.input"),
      );
    });
  });
  it.each(["failure", "needs_input", "throw"] as const)(
    "does not fall back after execution returns %s",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        const primary = agent("primary", "ready", {
            status: kind === "throw" ? "success" : kind,
            summary: "Execution began",
          }),
          backup = agent("backup");
        if (kind === "throw")
          primary.adapter.run = async () => {
            throw new Error("Provider execution failed");
          };
        const result = await new VeyraEngine({ store: storeAt(path) }).run({
          config,
          workflow: workflow(),
          agents: { primary: primary.adapter, backup: backup.adapter },
          goal: "Do work",
          cwd: path,
        });
        expect(result.status).toBe(kind === "needs_input" ? "paused" : "failed");
        expect(backup.readiness).not.toHaveBeenCalled();
        expect(backup.fake.calls).toHaveLength(0);
      });
    },
  );
  it("records exhaustion and obeys an explicit workflow failure branch", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const primary = agent("primary", "unavailable"),
        backup = agent("backup", "unavailable"),
        store = storeAt(path);
      const definition = workflow();
      definition.steps.work = { ...step(), on: { failure: "gate" } };
      definition.steps.gate = { type: "human", message: "Resolve provider availability" };
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { primary: primary.adapter, backup: backup.adapter },
        goal: "Route safely",
        cwd: path,
      });
      expect(result.status).toBe("paused");
      const events = await store.readEvents(result.runId);
      expect(events.find((event) => event.type === "agent.routed")).toMatchObject({
        decision: { attempts: [{ decision: "skipped" }, { decision: "blocked" }] },
      });
      expect(events.find((event) => event.type === "step.failed")).toMatchObject({
        message: expect.stringContaining("No provider was eligible"),
      });
      expect(events.some((event) => event.type === "agent.input")).toBe(false);
    });
  });
  it("uses the saved policy on resume, while reevaluating current readiness for a new invocation", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const primary = agent("primary", "unavailable"),
        backup = agent("backup"),
        store = storeAt(path);
      const definition = workflow();
      definition.start = "gate";
      definition.steps.gate = { type: "human", next: "work" };
      const engine = new VeyraEngine({ store });
      const paused = await engine.run({
        config,
        workflow: definition,
        agents: { primary: primary.adapter, backup: backup.adapter },
        goal: "Persist policy",
        cwd: path,
      });
      expect(primary.readiness).not.toHaveBeenCalled();
      definition.steps.work = { ...step(), routing: { fallbacks: [], fallbackOn: [] } };
      const approval = await engine.getPendingApproval({ runId: paused.runId, config });
      if (!approval) throw new Error("Missing approval");
      await engine.resolveApproval({
        runId: paused.runId,
        config,
        approvalId: approval.approvalId,
        decision: "approved",
      });
      const resumed = await new VeyraEngine({ store: storeAt(path) }).resume({
        runId: paused.runId,
        config,
        cwd: path,
        agents: { primary: primary.adapter, backup: backup.adapter },
      });
      expect(resumed.status).toBe("completed");
      expect(backup.fake.calls).toHaveLength(1);
    });
  });
  it("routes independent parallel/consensus leaves through the same policy with imposed review roles", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const primary = agent("primary", "unavailable"),
        backup = agent("backup"),
        store = storeAt(path);
      const definition: WorkflowDefinition = {
        name: "groups",
        version: 1,
        start: "parallel",
        steps: {
          parallel: { type: "parallel", children: ["a", "b"], next: "consensus" },
          a: step(),
          b: step(),
          consensus: { type: "consensus", reviewers: ["c", "d"] },
          c: { ...step(), requires: { ...requirements, role: "reviewer" } },
          d: { ...step(), requires: { ...requirements, role: "reviewer" } },
        },
      };
      const result = await new VeyraEngine({ store }).run({
        config,
        workflow: definition,
        agents: { primary: primary.adapter, backup: backup.adapter },
        goal: "Inspect independently",
        cwd: path,
      });
      expect(result.status).toBe("completed");
      expect(backup.fake.calls.map((input) => input.role)).toEqual([
        "planner",
        "planner",
        "reviewer",
        "reviewer",
      ]);
      const events = await store.readEvents(result.runId);
      expect(events.filter((event) => event.type === "agent.routed")).toHaveLength(4);
      expect(
        events
          .filter((event) => event.type === "agent.routed")
          .every((event) => isAgentRoutingDecision(event.decision)),
      ).toBe(true);
    });
  });
  it("preserves bindings and routing evidence inside a namespaced subworkflow", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const primary = agent("primary", "unavailable"),
        backup = agent("backup"),
        store = storeAt(path);
      const result = await new VeyraEngine({ store }).run({
        config,
        cwd: path,
        goal: "Plan within a child workflow",
        agents: { primary: primary.adapter, backup: backup.adapter },
        workflow: {
          name: "parent",
          version: 1,
          start: "call",
          steps: { call: { type: "subworkflow", workflow: workflow() } },
        },
      });
      expect(result.status).toBe("completed");
      expect(backup.fake.calls[0]).toMatchObject({ stepId: "call/work", role: "planner" });
      expect(
        (await store.readEvents(result.runId)).find((event) => event.type === "agent.routed"),
      ).toMatchObject({
        stepId: "call/work",
        decision: { primary: "primary", selected: "backup" },
      });
    });
  });
  it("does not bypass the separate run budget hook by selecting a fallback", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const primary = agent("primary"),
        backup = agent("backup");
      const events: VeyraEvent[] = [];
      const result = await new VeyraEngine({
        store: storeAt(path),
        budget: () => ({ allowed: false }),
        emit: (event) => {
          events.push(event);
        },
      }).run({
        config,
        workflow: workflow(),
        agents: { primary: primary.adapter, backup: backup.adapter },
        goal: "Respect spending control",
        cwd: path,
      });
      expect(result).toMatchObject({ status: "failed", error: { code: "budget_exceeded" } });
      expect(events.some((event) => event.type === "budget.checked")).toBe(true);
      expect(primary.fake.calls).toHaveLength(0);
      expect(backup.readiness).not.toHaveBeenCalled();
    });
  });
});
