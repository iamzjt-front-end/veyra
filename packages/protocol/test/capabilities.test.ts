import { describe, expect, it } from "vitest";
import { isAgentDescriptor, isAgentReadiness, isAgentRequirements } from "../src/index.js";

const descriptor = {
  schemaVersion: 1,
  id: "fixture",
  provider: "third-party",
  adapterVersion: "0.1.0",
  model: "fixture-model",
  roles: ["researcher"],
  capabilities: ["reasoning", "example:retrieval"],
};
describe("provider-neutral capability contracts", () => {
  it("accepts serializable configured metadata and namespaced extension capabilities", () => {
    expect(isAgentDescriptor(descriptor)).toBe(true);
    expect(isAgentRequirements({ role: "researcher", capabilities: ["example:retrieval"] })).toBe(
      true,
    );
    expect(isAgentRequirements({})).toBe(true);
    expect(
      isAgentReadiness({
        status: "unknown",
        scope: "configuration",
        message: "No live probe was made",
      }),
    ).toBe(true);
  });
  it.each([
    { schemaVersion: 2 },
    { id: "" },
    { adapterVersion: " " },
    { model: "x".repeat(513) },
    { roles: ["planner", "planner"] },
    { roles: "planner" },
    { capabilities: ["Vision"] },
    { capabilities: ["a", "a"] },
    { capabilities: Array.from({ length: 65 }, (_, i) => `cap-${i}`) },
    { credentials: "must-not-serialize" },
  ])("rejects invalid descriptor %#", (patch) => {
    expect(isAgentDescriptor({ ...descriptor, ...patch })).toBe(false);
  });
  it.each([
    { role: "" },
    { capabilities: ["web research"] },
    { capabilities: ["*"] },
    { optional: ["vision"] },
    { role: 1 },
  ])("rejects ambiguous requirements %#", (requirements) => {
    expect(isAgentRequirements(requirements)).toBe(false);
  });
  it.each([{ status: "maybe" }, { scope: "assumed" }, { message: "" }, { credentials: "hidden" }])(
    "rejects invalid readiness %#",
    (patch) => {
      expect(
        isAgentReadiness({ status: "ready", scope: "local", message: "CLI available", ...patch }),
      ).toBe(false);
    },
  );
  it("accepts bounded permission declarations without pretending to inspect native policy", () => {
    expect(
      isAgentDescriptor({
        ...descriptor,
        permissions: { mode: "default", source: "adapter-argument", toolAllowRules: 3 },
      }),
    ).toBe(true);
    expect(
      isAgentDescriptor({
        ...descriptor,
        permissions: {
          mode: "unknown",
          source: "native-configuration",
          sandbox: "workspace-write",
        },
      }),
    ).toBe(true);
  });
  it.each([
    {},
    { mode: "default" },
    { mode: "", source: "adapter-argument" },
    { mode: "default", source: "assumed" },
    { mode: "default", source: "adapter-argument", toolAllowRules: -1 },
    { mode: "default", source: "adapter-argument", toolAllowRules: 1.5 },
    { mode: "default", source: "adapter-argument", sandbox: "x".repeat(129) },
    { mode: "default", source: "adapter-argument", token: "private" },
  ])("rejects malformed permission metadata %j", (permissions) => {
    expect(isAgentDescriptor({ ...descriptor, permissions })).toBe(false);
  });

  it("does not invoke accessors while validating metadata", () => {
    let reads = 0;
    const value = Object.defineProperty({ ...descriptor }, "model", {
      enumerable: true,
      get: () => {
        reads++;
        return "secret";
      },
    });
    expect(isAgentDescriptor(value)).toBe(false);
    expect(reads).toBe(0);
  });
});
