import { join } from "node:path";
import { parseConfig } from "@veyra/config";
import {
  type AgentAdapter,
  type AgentInput,
  getAgentRoleProfile,
  listAgentRoleProfiles,
} from "@veyra/protocol";
import type { WorkflowDefinition } from "@veyra/workflow";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { LocalRunStore, VeyraEngine } from "../src/index.js";
import { isStoredEvent } from "../src/state-events.js";

const config = parseConfig({ version: 1, agents: {}, workflow: { use: "profiles" } });

describe("role profile delivery and audit", () => {
  it.each(["provider-a", "provider-b"])(
    "delivers all standard role contracts through %s before invocation",
    async (provider) => {
      await withFixtureWorkspace(async ({ path }) => {
        const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
        const workflow: WorkflowDefinition = {
          version: 1,
          name: "Role profiles",
          start: "planner",
          steps: {},
        };
        const agents: Record<string, AgentAdapter> = {};
        const roles = listAgentRoleProfiles().map((profile) => profile.role);
        const calls: AgentInput[] = [];
        for (const [index, role] of roles.entries()) {
          const binding = `bound-${role}`;
          workflow.steps[role] = {
            type: "agent",
            agent: binding,
            requires: { role },
            instructions: `Scoped ${role} guidance`,
            ...(roles[index + 1] ? { next: roles[index + 1] } : {}),
          };
          agents[binding] = {
            id: binding,
            provider,
            describe: () => ({
              schemaVersion: 1,
              id: binding,
              provider,
              adapterVersion: "1.0.0",
              roles: [role],
              capabilities: [],
            }),
            run: async (input) => {
              const saved = (await store.readEvents(input.runId)).find(
                (event) => event.type === "agent.input" && event.stepId === role,
              );
              expect(saved).toMatchObject({
                type: "agent.input",
                input: { profile: getAgentRoleProfile(role) },
              });
              expect(input.profile?.role).toBe(role);
              expect(input.instructionSources).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    kind: "role-profile",
                    text: input.profile?.instructions,
                  }),
                  expect.objectContaining({ kind: "workflow", text: `Scoped ${role} guidance` }),
                ]),
              );
              expect(input.context?.steps).toBeDefined();
              calls.push(structuredClone(input));
              if (input.profile) input.profile.instructions = "untrusted mutation";
              return {
                status: "success",
                summary: "Completed role fixture",
                ...(["reviewer", "judge"].includes(role)
                  ? { outcome: "pass", data: { requiredFixes: [], evidenceArtifactIds: [] } }
                  : {}),
              };
            },
          };
        }
        const result = await new VeyraEngine({ store }).run({
          config,
          workflow,
          agents,
          goal: "Exercise role profiles",
          cwd: path,
        });
        expect(result.status).toBe("completed");
        expect(calls.map((input) => input.role)).toEqual(roles);
        expect(JSON.stringify(await store.readEvents(result.runId))).not.toContain(
          "untrusted mutation",
        );
        expect(JSON.stringify(listAgentRoleProfiles())).not.toContain("untrusted mutation");
      });
    },
  );

  it("preserves extension-role compatibility without guessing a standard role", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const inputs: AgentInput[] = [];
      const result = await new VeyraEngine().run({
        config,
        cwd: path,
        goal: "Custom role",
        workflow: {
          name: "custom",
          version: 1,
          start: "work",
          steps: { work: { type: "agent", agent: "custom:analysis" } },
        },
        agents: {
          "custom:analysis": {
            id: "custom",
            provider: "extension",
            run: async (input) => {
              inputs.push(input);
              return { status: "success", summary: "Custom result" };
            },
          },
        },
      });
      expect(result.status).toBe("completed");
      expect(inputs[0]?.role).toBe("custom:analysis");
      expect(inputs[0]?.profile).toBeUndefined();
    });
  });

  it("keeps persisted profile evidence across a fresh-engine approval/resume", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const store = new LocalRunStore({ stateDir: join(path, ".veyra") });
      const inputs: AgentInput[] = [];
      const agent: AgentAdapter = {
        id: "planner",
        provider: "any-provider",
        run: async (input) => {
          inputs.push(structuredClone(input));
          return { status: "success", summary: "Plan" };
        },
      };
      const paused = await new VeyraEngine({ store }).run({
        config,
        cwd: path,
        goal: "Pause between profiles",
        agents: { planner: agent },
        workflow: {
          version: 1,
          name: "resumed",
          start: "plan",
          steps: {
            plan: { type: "agent", agent: "planner", next: "gate" },
            gate: { type: "human", message: "Inspect plan", next: "again" },
            again: { type: "agent", agent: "planner" },
          },
        },
      });
      expect(paused.status).toBe("paused");
      const engine = new VeyraEngine({
        store: new LocalRunStore({ stateDir: join(path, ".veyra") }),
      });
      const request = { config, cwd: path, runId: paused.runId };
      const pending = await engine.getPendingApproval(request);
      if (!pending) throw new Error("Expected gate");
      await engine.resolveApproval({
        ...request,
        approvalId: pending.approvalId,
        decision: "approved",
      });
      const result = await engine.resume({ ...request, agents: { planner: agent } });
      expect(result.status).toBe("completed");
      expect(inputs).toHaveLength(2);
      expect(inputs[0]?.profile).toEqual(inputs[1]?.profile);
      expect(inputs[1]?.profile?.version).toBe("1.0.0");
    });
  });

  it("validates profile-role identity while continuing to accept historical inputs without profiles", () => {
    const event = {
      type: "agent.input",
      runId: "run",
      stepId: "plan",
      agentId: "planner",
      at: new Date().toISOString(),
      input: { runId: "run", stepId: "plan", role: "planner", goal: "Plan" },
    };
    expect(isStoredEvent(event)).toBe(true);
    expect(
      isStoredEvent({
        ...event,
        input: { ...event.input, profile: getAgentRoleProfile("planner") },
      }),
    ).toBe(true);
    expect(
      isStoredEvent({ ...event, input: { ...event.input, profile: getAgentRoleProfile("judge") } }),
    ).toBe(false);
    expect(
      isStoredEvent({
        ...event,
        input: { ...event.input, profile: { schemaVersion: 1, role: "planner" } },
      }),
    ).toBe(false);
  });
});
