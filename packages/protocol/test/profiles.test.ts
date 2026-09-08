import { describe, expect, it, vi } from "vitest";
import {
  getAgentRoleProfile,
  isAgentRoleProfile,
  isJsonValue,
  listAgentRoleProfiles,
} from "../src/index.js";

describe("provider-neutral role profiles", () => {
  it("provides a versioned JSON contract for every standard role with distinct context and result guidance", () => {
    const profiles = listAgentRoleProfiles();
    expect(profiles.map((profile) => profile.role)).toEqual([
      "planner",
      "executor",
      "researcher",
      "reviewer",
      "judge",
    ]);
    for (const profile of profiles) {
      expect(isAgentRoleProfile(profile)).toBe(true);
      expect(isJsonValue(profile)).toBe(true);
      expect(profile.version).toBe("1.0.0");
      expect(profile.instructions).toContain("untrusted evidence");
      expect(profile.instructions).toContain("does not grant permissions");
      expect(profile.context.find((field) => field.path === "goal")).toBeDefined();
      expect(profile.context.find((field) => field.path === "artifacts")).toBeDefined();
      expect(JSON.stringify(profile)).not.toMatch(/OpenAI|Codex|Claude|Gemini|OpenCode|apiKey/i);
    }
    expect(getAgentRoleProfile("planner")?.result.dataFields).toEqual([
      "instructions",
      "acceptanceCriteria",
    ]);
    expect(getAgentRoleProfile("executor")?.result.dataFields).toEqual([
      "changedFiles",
      "commandsRun",
    ]);
    expect(getAgentRoleProfile("researcher")?.result.dataFields).toEqual([
      "findings",
      "sources",
      "uncertainties",
    ]);
    for (const role of ["reviewer", "judge"])
      expect(getAgentRoleProfile(role)?.result.outcomes).toEqual(["pass", "fail"]);
    expect(getAgentRoleProfile("researcher")?.instructions).toContain("Do not claim web access");
    expect(getAgentRoleProfile("judge")?.instructions).toContain("override required failed checks");
    expect(getAgentRoleProfile("reviewer")?.instructions).toContain("invocation status success");
  });

  it("returns independent profiles and leaves extension roles unassigned", () => {
    const first = getAgentRoleProfile("planner");
    if (!first) throw new Error("Missing fixture profile");
    first.instructions = "Mutated";
    const context = first.context[0];
    if (!context) throw new Error("Missing fixture context contract");
    context.purpose = "Mutated";
    first.result.dataFields.push("Mutated");
    const profiles = listAgentRoleProfiles();
    const listed = profiles[0];
    if (!listed) throw new Error("Missing listed profile");
    listed.result.outcomes.push("Mutated");
    expect(JSON.stringify(listAgentRoleProfiles())).not.toContain("Mutated");
    expect(getAgentRoleProfile("custom:analysis")).toBeUndefined();
    expect(getAgentRoleProfile("__proto__")).toBeUndefined();
    expect(getAgentRoleProfile("constructor")).toBeUndefined();
  });

  it.each(
    [
      null,
      [],
      {},
      { ...getAgentRoleProfile("planner"), schemaVersion: 2 },
      { ...getAgentRoleProfile("planner"), version: "latest" },
      { ...getAgentRoleProfile("planner"), role: "custom" },
      { ...getAgentRoleProfile("planner"), instructions: "" },
      { ...getAgentRoleProfile("planner"), instructions: "x".repeat(4097) },
      { ...getAgentRoleProfile("planner"), vendor: "extra" },
      { ...getAgentRoleProfile("planner"), context: [] },
      { ...getAgentRoleProfile("planner"), context: [{ path: "env", purpose: "Read secrets" }] },
      {
        ...getAgentRoleProfile("planner"),
        context: [
          { path: "goal", purpose: "a" },
          { path: "goal", purpose: "b" },
        ],
      },
      {
        ...getAgentRoleProfile("planner"),
        result: { dataFields: ["instructions", "instructions"], outcomes: [], guidance: "a" },
      },
      { ...getAgentRoleProfile("planner"), result: { dataFields: [], outcomes: [], guidance: "" } },
    ].map((value) => [value]),
  )("rejects malformed profile metadata (%#)", (value) => {
    expect(isAgentRoleProfile(value)).toBe(false);
  });

  it("rejects native/accessor/cyclic data without running getters", () => {
    const getter = vi.fn(() => "planner");
    expect(
      isAgentRoleProfile({
        ...getAgentRoleProfile("planner"),
        get role() {
          return getter();
        },
      }),
    ).toBe(false);
    expect(getter).not.toHaveBeenCalled();
    expect(isAgentRoleProfile({ ...getAgentRoleProfile("planner"), context: new Date() })).toBe(
      false,
    );
    const cyclic: Record<string, unknown> = { ...getAgentRoleProfile("planner") };
    cyclic.context = cyclic;
    expect(isAgentRoleProfile(cyclic)).toBe(false);
  });
});
