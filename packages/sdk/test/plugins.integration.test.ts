import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import {
  isVeyraPlugin,
  loadLocalPlugin,
  PluginRegistry,
  type VeyraPlugin,
  type AgentReadiness,
} from "../src/index.js";

const request = () => ({ id: "research", model: "configured", options: { tag: "agent" } });
function plugin(): VeyraPlugin {
  return {
    apiVersion: 1,
    provider: "example",
    version: "1.2.3",
    createAgent: (agent, context) => ({
      id: agent.id,
      provider: "example",
      run: async () => ({
        status: "success",
        summary: `${agent.model}/${agent.options.tag}/${context.options.tag}`,
      }),
    }),
  };
}

describe("explicit plugin registry", () => {
  it("exposes the plugin readiness hook on constructed adapters without losing class receivers or request snapshots", async () => {
    const fixture = plugin();
    const hook = vi.fn<NonNullable<VeyraPlugin["checkReadiness"]>>(async (config) => ({
      status: "ready",
      scope: "configuration",
      message: config.model ?? "missing",
    }));
    fixture.checkReadiness = hook;
    fixture.createAgent = (config) => {
      class Adapter {
        readonly id = config.id;
        readonly provider = "example";
        #model = config.model;
        describe() {
          return {
            schemaVersion: 1 as const,
            id: this.id,
            provider: this.provider,
            adapterVersion: "1.2.3",
            model: this.#model,
            roles: ["planner"],
            capabilities: ["reasoning"],
          };
        }
        async run() {
          return { status: "success" as const, summary: this.#model ?? "missing" };
        }
        async checkReadiness(): Promise<AgentReadiness> {
          throw new Error("The explicit plugin hook takes precedence");
        }
      }
      const adapter = new Adapter();
      config.model = "factory mutation";
      return adapter;
    };
    const registry = new PluginRegistry();
    registry.register(fixture);
    const config = request();
    const adapter = registry.createAgent("example", config);
    config.model = "caller mutation";
    expect(hook).not.toHaveBeenCalled();
    expect(adapter.describe?.().model).toBe("configured");
    expect(
      await adapter.run({ runId: "run", stepId: "step", role: "planner", goal: "Plan" }),
    ).toMatchObject({ summary: "configured" });
    expect(await adapter.checkReadiness?.({ timeoutMs: 20 })).toMatchObject({
      status: "ready",
      message: "configured",
    });
    expect(hook).toHaveBeenCalledWith(request(), { options: {} }, { timeoutMs: 20 });
  });
  it("registers without invocation, isolates options and metadata, and creates an adapter", async () => {
    const fixture = plugin();
    const create = vi.fn(fixture.createAgent);
    fixture.createAgent = create;
    const options = { tag: "namespace" };
    const registry = new PluginRegistry();
    registry.register(fixture, options, "1.2.3");
    options.tag = "changed";
    fixture.provider = "changed";
    const list = registry.list();
    expect(list).toEqual([{ apiVersion: 1, provider: "example", version: "1.2.3" }]);
    if (list[0]) list[0].provider = "changed";
    expect(registry.list()[0]?.provider).toBe("example");
    expect(create).not.toHaveBeenCalled();
    const input = request();
    const agent = registry.createAgent("example", input);
    input.model = "changed";
    expect(
      await agent.run({ runId: "run", stepId: "work", role: "researcher", goal: "work" }),
    ).toMatchObject({ summary: "configured/agent/namespace" });
    const firstCall = create.mock.calls[0];
    if (firstCall) firstCall[1].options.tag = "changed";
    const next = registry.createAgent("example", request());
    expect(
      (await next.run({ runId: "run", stepId: "work", role: "researcher", goal: "work" })).summary,
    ).toBe("configured/agent/namespace");
  });
  it.each([
    { apiVersion: 2 },
    { provider: "Invalid" },
    { version: "^1.0.0" },
    { createAgent: "not-a-function" },
    { checkReadiness: true },
    { extra: true },
  ])("rejects incompatible plugin %# before hooks run", (patch) => {
    const value = { ...plugin(), ...patch };
    expect(isVeyraPlugin(value)).toBe(false);
    expect(() => new PluginRegistry().register(value)).toThrow("API version 1");
  });
  it("rejects accessors without executing them", () => {
    const getter = vi.fn();
    const value = Object.defineProperty(plugin(), "version", { get: getter, enumerable: true });
    expect(isVeyraPlugin(value)).toBe(false);
    expect(getter).not.toHaveBeenCalled();
  });
  it("rejects missing, duplicate and mismatched versions without overwriting registration", () => {
    const registry = new PluginRegistry();
    expect(() => registry.createAgent("missing", request())).toThrow("no registered plugin");
    expect(() => registry.register(plugin(), {}, "1.2.4")).toThrow("exact version");
    expect(registry.list()).toEqual([]);
    registry.register(plugin());
    expect(() => registry.register(plugin())).toThrow("overrides are not allowed");
    expect(registry.list()).toHaveLength(1);
  });
  it.each(["identity", "throw", "async"])(
    "refuses invalid %s factories without raw diagnostics",
    (scenario) => {
      const fixture = plugin();
      fixture.createAgent = (() => {
        if (scenario === "throw") throw new Error("private-auth-detail");
        if (scenario === "async") return Promise.resolve({});
        return {
          id: "wrong",
          provider: "example",
          run: async () => ({ status: "success", summary: "invalid" }),
        };
      }) as VeyraPlugin["createAgent"];
      const registry = new PluginRegistry();
      registry.register(fixture);
      expect(() => registry.createAgent("example", request())).toThrow("adapter identity");
      expect(() => registry.createAgent("example", request())).not.toThrow("private-auth-detail");
    },
  );
  it("runs the plugin readiness hook with copied inputs and ephemeral controls only on request", async () => {
    const fixture = plugin();
    const hook = vi.fn(async (): Promise<AgentReadiness> => ({
      status: "ready",
      scope: "local",
      message: "Local service checked",
    }));
    fixture.checkReadiness = hook;
    fixture.createAgent = () => {
      throw new Error("Readiness need not construct an agent");
    };
    const registry = new PluginRegistry();
    registry.register(fixture, { tag: "namespace" });
    expect(hook).not.toHaveBeenCalled();
    const signal = new AbortController().signal;
    expect(
      await registry.checkReadiness("example", request(), {
        cwd: "/fixture",
        signal,
        timeoutMs: 100,
      }),
    ).toMatchObject({ status: "ready", scope: "local" });
    expect(hook).toHaveBeenCalledWith(
      request(),
      { options: { tag: "namespace" } },
      { cwd: "/fixture", signal, timeoutMs: 100 },
    );
    hook.mockClear();
    expect(
      (await registry.checkReadiness("example", request(), { signal: AbortSignal.abort() })).status,
    ).toBe("unknown");
    expect(hook).not.toHaveBeenCalled();
  });
  it("uses adapter readiness when the plugin has no hook, and reports unknown when neither exists", async () => {
    const registry = new PluginRegistry();
    registry.register(plugin());
    expect((await registry.checkReadiness("example", request())).status).toBe("unknown");
    const fallback = plugin();
    const create = fallback.createAgent;
    fallback.createAgent = (agent, context) => ({
      ...create(agent, context),
      checkReadiness: async () => ({
        status: "unavailable",
        scope: "local",
        message: "Service missing",
      }),
    });
    const other = new PluginRegistry();
    other.register(fallback);
    expect((await other.checkReadiness("example", request())).status).toBe("unavailable");
  });
  it.each(["throw", "invalid"])("normalizes %s readiness failures", async (scenario) => {
    const fixture = plugin();
    fixture.checkReadiness = async () => {
      if (scenario === "throw") throw new Error("private-auth-detail");
      return { status: "ready" } as AgentReadiness;
    };
    const registry = new PluginRegistry();
    registry.register(fixture);
    await expect(registry.checkReadiness("example", request())).rejects.toMatchObject({
      code: scenario === "throw" ? "plugin_readiness_failed" : "invalid_plugin_readiness",
    });
    await expect(registry.checkReadiness("example", request())).rejects.not.toThrow(
      "private-auth-detail",
    );
  });
});

describe("trusted local plugin loading", () => {
  const source = `import { writeFileSync } from "node:fs";
writeFileSync(new URL("./imported", import.meta.url), "imported");
export default {
  apiVersion: 1, provider: "example", version: "1.2.3",
  createAgent: ({ id }, { options }) => ({ id, provider: "example", run: async () => ({ status: "success", summary: options.summary }) })
};`;
  it("requires explicit trust before importing code and resolves from the configuration directory", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await writeFile(join(path, "plugin.mjs"), source);
      const registry = new PluginRegistry();
      const config = {
        provider: "example",
        module: "./plugin.mjs",
        version: "1.2.3",
        options: { summary: "trusted extension" },
      };
      await expect(
        loadLocalPlugin(registry, config, { cwd: path, trusted: false }),
      ).rejects.toMatchObject({ code: "plugin_not_trusted" });
      await expect(readFile(join(path, "imported"))).rejects.toMatchObject({ code: "ENOENT" });
      await loadLocalPlugin(registry, config, { cwd: path, trusted: true });
      expect(await readFile(join(path, "imported"), "utf8")).toBe("imported");
      expect(registry.list()).toEqual([{ apiVersion: 1, provider: "example", version: "1.2.3" }]);
    });
  });
  it.each([
    "https://example.com/plugin.mjs",
    "npm:plugin",
    "@example/plugin",
    "./plugin.ts",
    "data:text/javascript,x",
  ])("rejects nonlocal or unsupported module %s", async (module) => {
    await expect(
      loadLocalPlugin(
        new PluginRegistry(),
        { provider: "example", module, version: "1.2.3" },
        { cwd: process.cwd(), trusted: true },
      ),
    ).rejects.toMatchObject({ code: "invalid_plugin_module" });
  });
  it.each(["missing", "import", "provider", "version", "api"])(
    "fails clearly for %s modules without registering them",
    async (scenario) => {
      await withFixtureWorkspace(async ({ path }) => {
        let body = source;
        if (scenario === "import") body = `throw new Error("private-auth-detail");`;
        if (scenario === "provider")
          body = body.replace('provider: "example"', 'provider: "other"');
        if (scenario === "version") body = body.replace('version: "1.2.3"', 'version: "1.2.4"');
        if (scenario === "api") body = body.replace("apiVersion: 1", "apiVersion: 2");
        if (scenario !== "missing") await writeFile(join(path, "plugin.mjs"), body);
        const registry = new PluginRegistry();
        const failure = await loadLocalPlugin(
          registry,
          { provider: "example", module: "./plugin.mjs", version: "1.2.3" },
          { cwd: path, trusted: true },
        ).catch((error: Error & { code: string }) => error);
        expect(failure).toMatchObject({
          code: {
            missing: "missing_plugin_module",
            import: "plugin_load_failed",
            provider: "incompatible_plugin",
            version: "plugin_version_mismatch",
            api: "incompatible_plugin",
          }[scenario],
        });
        expect(String(failure)).not.toContain("private-auth-detail");
        expect(registry.list()).toEqual([]);
      });
    },
  );
});
