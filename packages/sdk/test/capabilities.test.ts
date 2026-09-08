import { expect, it } from "vitest";
import { isAgentDescriptor, isAgentReadiness, type AgentAdapter } from "../src/index.js";

it("lets an extension expose metadata and readiness through SDK contracts", async () => {
  const adapter: AgentAdapter = {
    id: "extension",
    provider: "example",
    describe: () => ({
      schemaVersion: 1,
      id: "extension",
      provider: "example",
      adapterVersion: "1.2.3",
      roles: ["researcher"],
      capabilities: ["reasoning", "example:retrieval"],
    }),
    checkReadiness: async () => ({
      status: "unknown",
      scope: "remote",
      message: "Service was not contacted",
    }),
    run: async () => ({ status: "success", summary: "Fixture" }),
  };
  expect(isAgentDescriptor(adapter.describe?.())).toBe(true);
  expect(isAgentReadiness(await adapter.checkReadiness?.())).toBe(true);
});
