import type { AgentConfig, VeyraConfig } from "@veyraoss/config";
import {
  ADAPTER_VERSION as CODEX_VERSION,
  CodexAdapter,
  type CodexAdapterOptions,
} from "@veyraoss/codex";
import {
  ADAPTER_VERSION as CLAUDE_VERSION,
  ClaudeAdapter,
  type ClaudeAdapterOptions,
} from "@veyraoss/claude";
import {
  ADAPTER_VERSION as CLAUDE_CODE_VERSION,
  ClaudeCodeAdapter,
  type ClaudeCodeAdapterOptions,
} from "@veyraoss/claude-code";
import {
  ADAPTER_VERSION as GEMINI_VERSION,
  GeminiAdapter,
  type GeminiAdapterOptions,
  GeminiCliAdapter,
  type GeminiCliAdapterOptions,
} from "@veyraoss/gemini";
import {
  ADAPTER_VERSION as OPENAI_VERSION,
  OpenAIAdapter,
  type OpenAIAdapterOptions,
  OpenAICompatibleAdapter,
  type OpenAICompatibleAdapterOptions,
} from "@veyraoss/openai";
import {
  ADAPTER_VERSION as OPENCODE_VERSION,
  OpenCodeAdapter,
  type OpenCodeAdapterOptions,
} from "@veyraoss/opencode";
import type { JsonObject } from "@veyraoss/protocol";
import type { ProcessRunner } from "@veyraoss/runtime";
import {
  PLUGIN_API_VERSION,
  PluginError,
  PluginRegistry,
  loadLocalPlugin,
  type PluginAgentConfig,
  type PluginContext,
  type VeyraPlugin,
} from "@veyraoss/sdk";

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
    new OpenAIAdapter(adapterOptions(agent, context) as OpenAIAdapterOptions, {
      env: services.env,
    });
  const codex = (agent: PluginAgentConfig, context: PluginContext) =>
    new CodexAdapter(adapterOptions(agent, context) as CodexAdapterOptions, {
      runProcess: services.runProcess,
      env: services.env,
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
      apiVersion: PLUGIN_API_VERSION,
      provider: "openai-compatible",
      version: OPENAI_VERSION,
      createAgent: (agent, context) =>
        new OpenAICompatibleAdapter(
          adapterOptions(agent, context) as unknown as OpenAICompatibleAdapterOptions,
          { env: services.env },
        ),
      checkReadiness: async (agent, context, controls) => {
        const options = adapterOptions(agent, context);
        if (!options.baseURL)
          return {
            status: "unavailable",
            scope: "configuration",
            message:
              "Configure options.baseURL with the compatible server's API prefix and select a model.",
          };
        return new OpenAICompatibleAdapter(options as unknown as OpenAICompatibleAdapterOptions, {
          env: services.env,
        }).checkReadiness(controls);
      },
    },
    {
      apiVersion: PLUGIN_API_VERSION,
      provider: "opencode",
      version: OPENCODE_VERSION,
      createAgent: (agent, context) =>
        new OpenCodeAdapter(adapterOptions(agent, context) as OpenCodeAdapterOptions, services),
      checkReadiness: (agent, context, controls) => {
        // Offline CLI support does not depend on a model. Doctor also checks the
        // configured adapter's descriptor, which validates an actual model binding.
        const options = adapterOptions(agent, context);
        delete options.model;
        return new OpenCodeAdapter(options as OpenCodeAdapterOptions, services).checkReadiness(
          controls,
        );
      },
    },
    {
      apiVersion: PLUGIN_API_VERSION,
      provider: "gemini-cli",
      version: GEMINI_VERSION,
      createAgent: (agent, context) =>
        new GeminiCliAdapter(adapterOptions(agent, context) as GeminiCliAdapterOptions, services),
      checkReadiness: (agent, context, controls) =>
        new GeminiCliAdapter(
          adapterOptions(agent, context) as GeminiCliAdapterOptions,
          services,
        ).checkReadiness(controls),
    },
    {
      apiVersion: PLUGIN_API_VERSION,
      provider: "gemini",
      version: GEMINI_VERSION,
      createAgent: (agent, context) =>
        new GeminiAdapter(adapterOptions(agent, context) as unknown as GeminiAdapterOptions, {
          env: services.env,
        }),
      checkReadiness: (agent, context, controls) =>
        new GeminiAdapter(adapterOptions(agent, context) as unknown as GeminiAdapterOptions, {
          env: services.env,
        }).checkReadiness(controls),
    },
    {
      apiVersion: PLUGIN_API_VERSION,
      provider: "claude-code",
      version: CLAUDE_CODE_VERSION,
      createAgent: claudeCode,
      checkReadiness: (agent, context, controls) =>
        claudeCode(agent, context).checkReadiness(controls),
    },
    {
      apiVersion: PLUGIN_API_VERSION,
      provider: "claude",
      version: CLAUDE_VERSION,
      createAgent: claude,
      checkReadiness: (agent, context, controls) => claude(agent, context).checkReadiness(controls),
    },
    {
      apiVersion: PLUGIN_API_VERSION,
      provider: "openai",
      version: OPENAI_VERSION,
      createAgent: openai,
      checkReadiness: (agent, context, controls) => openai(agent, context).checkReadiness(controls),
    },
    {
      apiVersion: PLUGIN_API_VERSION,
      provider: "codex",
      version: CODEX_VERSION,
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
