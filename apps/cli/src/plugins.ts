import type { AgentConfig, VeyraConfig } from "@veyra/config";
import { CodexAdapter, type CodexAdapterOptions } from "@veyra/codex";
import { ClaudeAdapter, type ClaudeAdapterOptions } from "@veyra/claude";
import { ClaudeCodeAdapter, type ClaudeCodeAdapterOptions } from "@veyra/claude-code";
import { OpenAIAdapter, type OpenAIAdapterOptions } from "@veyra/openai";
import type { JsonObject } from "@veyra/protocol";
import type { ProcessRunner } from "@veyra/runtime";
import {
  PluginError,
  PluginRegistry,
  loadLocalPlugin,
  type PluginAgentConfig,
  type PluginContext,
  type VeyraPlugin,
} from "@veyra/sdk";

export interface PluginServices {
  env?: NodeJS.ProcessEnv;
  runProcess?: ProcessRunner;
}

const adapterOptions = (
  agent: PluginAgentConfig,
  context: PluginContext,
): JsonObject & { id: string; model?: string } => ({
  ...context.options,
  ...agent.options,
  ...(agent.model ? { model: agent.model } : {}),
  id: agent.id,
});

/** Built-ins are composed here, never inside Core or the public SDK registry. */
export function builtinPlugins(services: PluginServices = {}): VeyraPlugin[] {
  const openai = (agent: PluginAgentConfig, context: PluginContext) =>
    new OpenAIAdapter(adapterOptions(agent, context) as OpenAIAdapterOptions);
  const codex = (agent: PluginAgentConfig, context: PluginContext) =>
    new CodexAdapter(adapterOptions(agent, context) as CodexAdapterOptions, {
      runProcess: services.runProcess,
    });
  const claude = (agent: PluginAgentConfig, context: PluginContext) =>
    new ClaudeAdapter(adapterOptions(agent, context) as ClaudeAdapterOptions, {
      env: services.env,
    });
  const claudeCode = (agent: PluginAgentConfig, context: PluginContext) =>
    new ClaudeCodeAdapter(adapterOptions(agent, context) as ClaudeCodeAdapterOptions, {
      env: services.env,
      runProcess: services.runProcess,
    });
  return [
    {
      apiVersion: 1,
      provider: "claude-code",
      version: "0.1.0",
      createAgent: claudeCode,
      checkReadiness: (agent, context, controls) =>
        claudeCode(agent, context).checkReadiness(controls),
    },
    {
      apiVersion: 1,
      provider: "claude",
      version: "0.1.0",
      createAgent: claude,
      checkReadiness: (agent, context, controls) => claude(agent, context).checkReadiness(controls),
    },
    {
      apiVersion: 1,
      provider: "openai",
      version: "0.1.0",
      createAgent: openai,
      checkReadiness: async (agent, context, controls) => {
        const adapter = openai(agent, context);
        if (!services.env) return adapter.checkReadiness(controls);
        if (controls.signal?.aborted)
          return {
            status: "unknown",
            scope: "configuration",
            message: "Readiness check was cancelled.",
          };
        const options = adapterOptions(agent, context);
        const key = typeof options.apiKeyEnv === "string" ? options.apiKeyEnv : "OPENAI_API_KEY";
        const present = Boolean(services.env[key]?.trim());
        return {
          status: present ? "ready" : "unavailable",
          scope: "configuration",
          message: present
            ? `${key} is present; API access was not tested.`
            : `Set ${key}; no key value is printed.`,
        };
      },
    },
    {
      apiVersion: 1,
      provider: "codex",
      version: "0.1.0",
      createAgent: codex,
      checkReadiness: (agent, context, controls) => codex(agent, context).checkReadiness(controls),
    },
  ];
}

export function pluginAgent(name: string, config: AgentConfig): PluginAgentConfig {
  return {
    id: name,
    ...(config.model ? { model: config.model } : {}),
    options: config.options as JsonObject,
  };
}

/** Only providers needed by this operation are configured or imported. */
export async function registryForProviders(
  config: VeyraConfig,
  providers: string[],
  cwd: string,
  allowedPlugins: readonly string[] = [],
  services: PluginServices = {},
): Promise<PluginRegistry> {
  const registry = new PluginRegistry();
  const builtins = new Map(builtinPlugins(services).map((plugin) => [plugin.provider, plugin]));
  const unique = [...new Set(providers)];
  // Preflight every trust boundary before importing any module.
  for (const provider of unique) {
    const namespace = Object.hasOwn(config.plugins ?? {}, provider)
      ? config.plugins?.[provider]
      : undefined;
    if (builtins.has(provider) && namespace?.module)
      throw new PluginError(
        "duplicate_plugin",
        `Built-in provider '${provider}' cannot be replaced by a local module.`,
      );
    if (!builtins.has(provider)) {
      if (!namespace?.module || !namespace.version)
        throw new PluginError(
          "missing_plugin",
          `Provider '${provider}' requires a registered plugin or plugins.${provider}.module and an exact version.`,
        );
      if (!allowedPlugins.includes(provider))
        throw new PluginError(
          "plugin_not_trusted",
          `Loading plugin '${provider}' requires explicit trust; pass --allow-plugin ${provider} after reviewing its code.`,
        );
    }
  }
  for (const provider of unique) {
    const namespace = Object.hasOwn(config.plugins ?? {}, provider)
      ? config.plugins?.[provider]
      : undefined;
    const builtin = builtins.get(provider);
    if (builtin)
      registry.register(builtin, namespace?.options as JsonObject | undefined, namespace?.version);
    else if (namespace?.module && namespace.version)
      await loadLocalPlugin(
        registry,
        {
          provider,
          module: namespace.module,
          version: namespace.version,
          options: namespace.options as JsonObject,
        },
        { cwd, trusted: allowedPlugins.includes(provider) },
      );
  }
  return registry;
}
