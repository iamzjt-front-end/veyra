import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/index.js";

const config = (plugins: unknown) => ({
  version: 1,
  agents: {},
  workflow: { use: "dev" },
  plugins,
});

describe("plugin configuration namespace", () => {
  it("copies provider defaults and exact local module references without loading them", () => {
    const plugins = {
      openai: { options: { apiKeyEnv: "CUSTOM_KEY", timeoutMs: 1000 } },
      example: {
        module: "./plugins/example.mjs",
        version: "1.2.3",
        options: { endpoint: "local" },
      },
    };
    const value = parseConfig(config(plugins));
    expect(value.plugins).toEqual(plugins);
    if (value.plugins?.openai) value.plugins.openai.options.timeoutMs = 5;
    expect(plugins.openai.options.timeoutMs).toBe(1000);
    expect(
      parseConfig(config({ example: { module: "./absent.mjs", version: "1.0.0" } })).plugins
        ?.example?.options,
    ).toEqual({});
  });
  it.each([
    [[], "plugins"],
    [{ Bad: {} }, "plugins.Bad"],
    [{ example: { unknown: true } }, "unknown"],
    [{ example: { module: "./local.mjs" } }, "version"],
    [{ example: { module: "./local.mjs", version: "^1.0.0" } }, "version"],
    [{ example: { module: "https://example.com/a.mjs", version: "1.0.0" } }, "module"],
    [{ example: { module: "some-package", version: "1.0.0" } }, "module"],
    [{ example: { options: { fn: () => true } } }, "options"],
    [{ example: { options: { large: "x".repeat(256 * 1024) } } }, "options"],
    [Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`p${i}`, {}])), "plugins"],
  ])("rejects invalid plugin configuration %#", (plugins, field) => {
    expect(() => parseConfig(config(plugins))).toThrow(String(field));
  });
});
