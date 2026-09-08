import { describe, expect, it } from "vitest";
import {
  isAgentRoutingDecision,
  isAgentRoutingPolicy,
  type AgentRoutingDecision,
} from "../src/index.js";

const policy = () => ({ fallbacks: ["backup"], fallbackOn: ["unavailable"] });
const decision = (): AgentRoutingDecision => ({
  version: 1,
  primary: "primary",
  policy: { fallbacks: ["backup"], fallbackOn: ["unavailable"] },
  requirements: { role: "planner", capabilities: ["reasoning"] },
  attempts: [
    {
      binding: "primary",
      decision: "skipped",
      reason: "unavailable",
      readiness: { status: "unavailable", scope: "configuration" },
    },
    {
      binding: "backup",
      decision: "selected",
      reason: "fallback_eligible",
      descriptor: {
        schemaVersion: 1,
        id: "backup",
        provider: "fixture",
        adapterVersion: "1.0.0",
        roles: ["planner"],
        capabilities: ["reasoning"],
      },
      readiness: { status: "ready", scope: "configuration" },
    },
  ],
  selected: "backup",
});

describe("provider routing contracts", () => {
  it("accepts an explicit policy and optional per-invocation estimates", () => {
    expect(isAgentRoutingPolicy(policy())).toBe(true);
    expect(isAgentRoutingPolicy({ fallbacks: [], fallbackOn: [] })).toBe(true);
    expect(
      isAgentRoutingPolicy({
        ...policy(),
        allowUnknownReadiness: true,
        readinessTimeoutMs: 60000,
        budget: {
          currency: "USD",
          maxEstimatedCost: 0.05,
          estimates: [
            { agent: "primary", amount: 0.05 },
            { agent: "backup", amount: 0 },
          ],
        },
      }),
    ).toBe(true);
    expect(isAgentRoutingDecision(decision())).toBe(true);
  });
  it.each([
    {},
    { fallbacks: undefined },
    { fallbackOn: undefined },
    { fallbacks: ["backup", "backup"] },
    { fallbacks: [" "] },
    { fallbacks: ["x".repeat(129)] },
    { fallbacks: Array.from({ length: 16 }, (_, i) => `a${i}`) },
    { fallbackOn: ["unavailable", "unavailable"] },
    { fallbackOn: ["execution_failure"] },
    { allowUnknownReadiness: "yes" },
    { readinessTimeoutMs: 0 },
    { readinessTimeoutMs: 60001 },
    { readinessTimeoutMs: 1.5 },
    { ranking: "best-model" },
    { budget: {} },
    ...[-1, Infinity, NaN].map((amount) => ({
      budget: { currency: "USD", maxEstimatedCost: amount, estimates: [] },
    })),
    { budget: { currency: "usd", maxEstimatedCost: 1, estimates: [] } },
    { budget: { currency: "USD\n", maxEstimatedCost: 1, estimates: [] } },
    {
      budget: {
        currency: "USD",
        maxEstimatedCost: 1,
        estimates: [{ agent: "backup", amount: -1 }],
      },
    },
    {
      budget: {
        currency: "USD",
        maxEstimatedCost: 1,
        estimates: [
          { agent: "backup", amount: 1 },
          { agent: "backup", amount: 2 },
        ],
      },
    },
    { budget: { currency: "USD", maxEstimatedCost: 1, estimates: [], apiKey: "fixture" } },
  ])("rejects malformed policy patch %j", (patch) => {
    expect(
      isAgentRoutingPolicy(Object.keys(patch).length ? { ...policy(), ...patch } : patch),
    ).toBe(false);
  });
  it("rejects native values, getters and cycles without executing accessors", () => {
    expect(isAgentRoutingPolicy(new Date())).toBe(false);
    const cycle = { ...policy(), cycle: {} };
    cycle.cycle = cycle;
    expect(isAgentRoutingPolicy(cycle)).toBe(false);
    expect(
      isAgentRoutingPolicy({
        get fallbacks() {
          throw new Error("must not run");
        },
        fallbackOn: [],
      }),
    ).toBe(false);
  });
  it("rejects out-of-order, unapproved, contradictory or incomplete audit decisions", () => {
    for (const patch of [
      { version: 2 },
      { primary: "backup" },
      { selected: "primary" },
      { requirements: {} },
      { attempts: [] },
      { policy: { fallbacks: ["backup"], fallbackOn: [] } },
      { attempts: [...decision().attempts].reverse() },
      { attempts: [decision().attempts[0]] },
      { attempts: [{ binding: "primary", decision: "blocked", reason: "unavailable" }] },
      {
        attempts: [
          { binding: "primary", decision: "skipped", reason: "anything" },
          decision().attempts[1],
        ],
      },
      {
        policy: {
          ...policy(),
          budget: {
            currency: "USD",
            maxEstimatedCost: 1,
            estimates: [{ agent: "absent", amount: 0 }],
          },
        },
      },
    ])
      expect(isAgentRoutingDecision({ ...decision(), ...patch })).toBe(false);
    const exhausted = decision();
    delete exhausted.selected;
    exhausted.attempts[1] = { binding: "backup", decision: "blocked", reason: "readiness_unknown" };
    expect(isAgentRoutingDecision(exhausted)).toBe(true);
    for (const patch of [
      { descriptor: null },
      { descriptor: { ...decision().attempts[1]?.descriptor, roles: ["executor"] } },
      { descriptor: { ...decision().attempts[1]?.descriptor, capabilities: [] } },
      { readiness: { status: "unavailable", scope: "configuration" } },
      { readiness: { status: "unknown", scope: "configuration" } },
      { readiness: { status: "ready", scope: "configuration", message: "No raw diagnostics" } },
      { estimatedCost: -1 },
    ])
      expect(
        isAgentRoutingDecision({
          ...decision(),
          attempts: [decision().attempts[0], { ...decision().attempts[1], ...patch }],
        }),
      ).toBe(false);
  });
});
