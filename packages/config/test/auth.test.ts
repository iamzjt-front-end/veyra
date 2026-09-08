import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/index.js";

const config = (options: unknown, namespace = false) => ({
  version: 1,
  workflow: { use: "dev" },
  agents: { planner: { provider: "example", ...(namespace ? {} : { options }) } },
  ...(namespace ? { plugins: { example: { options } } } : {}),
});
describe("credential-free provider configuration", () => {
  it.each([
    "apiKey",
    "api_key",
    "accessToken",
    "auth_token",
    "password",
    "private_key",
    "cookie",
    "authorization",
    "env",
    "environment",
  ])("rejects %s at agent and namespace boundaries without echoing values", (name) => {
    for (const namespace of [false, true]) {
      try {
        parseConfig(config({ nested: [{ [name]: "fixture-credential" }] }, namespace));
        throw new Error("Expected configuration rejection");
      } catch (error) {
        expect(error).toMatchObject({ name: "ConfigError", field: expect.stringContaining(name) });
        expect(String(error)).not.toContain("fixture-credential");
        expect(String(error)).toContain("apiKeyEnv");
      }
    }
  });
  it.each(["contains-a-credential!", "", "x".repeat(129), 123, null])(
    "rejects an invalid apiKeyEnv value (%#)",
    (apiKeyEnv) => {
      expect(() => parseConfig(config({ apiKeyEnv }))).toThrow("must name an environment variable");
    },
  );
  it("accepts explicit variable indirection and native-login configurations without env access", () => {
    expect(
      parseConfig(config({ apiKeyEnv: "CUSTOM_CREDENTIAL", maxOutputTokens: 1024 })).agents.planner
        ?.options,
    ).toEqual({ apiKeyEnv: "CUSTOM_CREDENTIAL", maxOutputTokens: 1024 });
    expect(parseConfig(config({})).agents.planner?.options).toEqual({});
  });
});
