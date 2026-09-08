import { realpath, stat } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  isAgentReadiness,
  isJsonValue,
  type AgentAdapter,
  type AgentReadiness,
  type AgentRunOptions,
  type JsonObject,
} from "@veyra/protocol";

export const PLUGIN_API_VERSION = 1;

export interface PluginAgentConfig {
  id: string;
  model?: string;
  options: JsonObject;
}

export interface PluginContext {
  /** Provider namespace configuration; credentials belong in native authentication. */
  options: JsonObject;
}

/** A trusted in-process extension. Hooks must not return credentials or raw provider errors. */
export interface VeyraPlugin {
  apiVersion: 1;
  provider: string;
  version: string;
  createAgent(config: PluginAgentConfig, context: PluginContext): AgentAdapter;
  checkReadiness?(
    config: PluginAgentConfig,
    context: PluginContext,
    controls: AgentRunOptions,
  ): Promise<AgentReadiness>;
}

export class PluginError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "PluginError";
  }
}

const providerName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 128 &&
  /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value);
const versionNumber = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= 128 &&
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
const jsonObject = (value: unknown): value is JsonObject =>
  isJsonValue(value) && value !== null && typeof value === "object" && !Array.isArray(value);
const plain = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === "object" &&
  [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
  Reflect.ownKeys(value).every(
    (key) =>
      typeof key === "string" && "value" in (Object.getOwnPropertyDescriptor(value, key) ?? {}),
  );

export function isVeyraPlugin(value: unknown): value is VeyraPlugin {
  return (
    plain(value) &&
    Object.keys(value).every((key) =>
      ["apiVersion", "provider", "version", "createAgent", "checkReadiness"].includes(key),
    ) &&
    value.apiVersion === PLUGIN_API_VERSION &&
    providerName(value.provider) &&
    versionNumber(value.version) &&
    typeof value.createAgent === "function" &&
    (value.checkReadiness === undefined || typeof value.checkReadiness === "function")
  );
}

function requestCopy(value: PluginAgentConfig): PluginAgentConfig {
  if (
    !jsonObject(value) ||
    typeof value.id !== "string" ||
    !value.id.trim() ||
    value.id.length > 128 ||
    !jsonObject(value.options) ||
    (value.model !== undefined &&
      (typeof value.model !== "string" || !value.model.trim() || value.model.length > 512))
  )
    throw new PluginError(
      "invalid_plugin_agent",
      "Plugin agent configuration must contain an id, optional model and JSON options.",
    );
  return structuredClone(value);
}

interface Registration {
  plugin: VeyraPlugin;
  options: JsonObject;
}

/** An explicit per-application registry; registration never invokes factories or probes. */
export class PluginRegistry {
  readonly #plugins = new Map<string, Registration>();

  register(value: unknown, options: JsonObject = {}, expectedVersion?: string): void {
    if (!isVeyraPlugin(value))
      throw new PluginError(
        "incompatible_plugin",
        "Expected a Veyra plugin with API version 1, provider, version and createAgent hook.",
      );
    if (expectedVersion !== undefined && expectedVersion !== value.version)
      throw new PluginError(
        "plugin_version_mismatch",
        `Plugin '${value.provider}' does not match its configured exact version.`,
      );
    if (this.has(value.provider))
      throw new PluginError(
        "duplicate_plugin",
        `Provider '${value.provider}' is already registered; overrides are not allowed.`,
      );
    if (!jsonObject(options) || Buffer.byteLength(JSON.stringify(options)) > 256 * 1024)
      throw new PluginError(
        "invalid_plugin_options",
        "Plugin options must be a JSON object of at most 256 KiB.",
      );
    this.#plugins.set(value.provider, {
      plugin: {
        apiVersion: 1,
        provider: value.provider,
        version: value.version,
        createAgent: value.createAgent.bind(value),
        ...(value.checkReadiness ? { checkReadiness: value.checkReadiness.bind(value) } : {}),
      },
      options: structuredClone(options),
    });
  }

  has(provider: string): boolean {
    return this.#plugins.has(provider);
  }

  list(): Array<Pick<VeyraPlugin, "apiVersion" | "provider" | "version">> {
    return [...this.#plugins.values()].map(({ plugin }) => ({
      apiVersion: plugin.apiVersion,
      provider: plugin.provider,
      version: plugin.version,
    }));
  }

  #registered(provider: string): Registration {
    const registered = this.#plugins.get(provider);
    if (!registered)
      throw new PluginError(
        "missing_plugin",
        `Provider '${provider}' has no registered plugin; register a built-in or configure a trusted local plugin module.`,
      );
    return registered;
  }

  createAgent(provider: string, config: PluginAgentConfig): AgentAdapter {
    const { plugin, options } = this.#registered(provider);
    const request = requestCopy(config);
    const readinessRequest = requestCopy(config);
    let agent: AgentAdapter;
    try {
      agent = plugin.createAgent(request, { options: structuredClone(options) });
      if (
        !agent ||
        agent.id !== config.id ||
        agent.provider !== provider ||
        typeof agent.run !== "function" ||
        (agent.describe !== undefined && typeof agent.describe !== "function") ||
        (agent.checkReadiness !== undefined && typeof agent.checkReadiness !== "function")
      )
        throw new Error("Invalid adapter");
    } catch {
      throw new PluginError(
        "plugin_agent_failed",
        `Plugin '${provider}' could not create agent '${config.id}'; check agent and plugin options and adapter identity.`,
      );
    }
    if (!plugin.checkReadiness) return agent;
    // Preserve class receivers and expose the same configured plugin probe to Core and doctor.
    return {
      id: agent.id,
      provider: agent.provider,
      ...(agent.describe ? { describe: agent.describe.bind(agent) } : {}),
      run: agent.run.bind(agent),
      checkReadiness: (controls) => this.checkReadiness(provider, readinessRequest, controls),
    };
  }

  async checkReadiness(
    provider: string,
    config: PluginAgentConfig,
    controls: AgentRunOptions = {},
  ): Promise<AgentReadiness> {
    const { plugin, options } = this.#registered(provider);
    const request = requestCopy(config);
    if (controls.signal?.aborted)
      return {
        status: "unknown",
        scope: "configuration",
        message: "Plugin readiness check was cancelled before probing.",
      };
    let result: AgentReadiness;
    try {
      if (plugin.checkReadiness)
        result = await plugin.checkReadiness(
          request,
          { options: structuredClone(options) },
          { ...controls },
        );
      else {
        const agent = this.createAgent(provider, request);
        result = agent.checkReadiness
          ? await agent.checkReadiness({ ...controls })
          : {
              status: "unknown",
              scope: "configuration",
              message: "Plugin and adapter have no readiness probe.",
            };
      }
    } catch {
      throw new PluginError(
        "plugin_readiness_failed",
        `Plugin '${provider}' readiness probe failed; no raw provider error is exposed.`,
      );
    }
    if (!isAgentReadiness(result))
      throw new PluginError(
        "invalid_plugin_readiness",
        `Plugin '${provider}' returned invalid readiness metadata.`,
      );
    return structuredClone(result);
  }
}

export interface LocalPluginConfig {
  provider: string;
  module: string;
  version: string;
  options?: JsonObject;
}

/** Import only explicitly trusted local modules. Imported code has full host-process privileges. */
export async function loadLocalPlugin(
  registry: PluginRegistry,
  config: LocalPluginConfig,
  options: { cwd: string; trusted: boolean },
): Promise<void> {
  if (options.trusted !== true)
    throw new PluginError(
      "plugin_not_trusted",
      `Loading plugin '${config.provider}' requires explicit trust; pass --allow-plugin ${config.provider} after reviewing its code.`,
    );
  if (!providerName(config.provider) || !versionNumber(config.version))
    throw new PluginError(
      "invalid_plugin_config",
      "A plugin requires a provider name and exact version.",
    );
  if (registry.has(config.provider))
    throw new PluginError(
      "duplicate_plugin",
      `Provider '${config.provider}' is already registered; overrides are not allowed.`,
    );
  if (
    typeof config.module !== "string" ||
    (!isAbsolute(config.module) &&
      !config.module.startsWith("./") &&
      !config.module.startsWith("../")) ||
    ![".js", ".mjs", ".cjs"].includes(extname(config.module))
  )
    throw new PluginError(
      "invalid_plugin_module",
      "Plugin module must be an explicit local .js, .mjs or .cjs file path; URLs and package downloads are not supported.",
    );
  let url: string;
  try {
    const path = await realpath(resolve(options.cwd, config.module));
    if (!(await stat(path)).isFile()) throw new Error("Not a file");
    url = pathToFileURL(path).href;
  } catch {
    throw new PluginError(
      "missing_plugin_module",
      `Plugin '${config.provider}' module is missing or unreadable; build or install it locally first.`,
    );
  }
  let plugin: unknown;
  try {
    plugin = (await import(url)).default;
  } catch {
    throw new PluginError(
      "plugin_load_failed",
      `Plugin '${config.provider}' could not be imported; check its local dependencies and module format.`,
    );
  }
  if (!isVeyraPlugin(plugin) || plugin.provider !== config.provider)
    throw new PluginError(
      "incompatible_plugin",
      `Plugin '${config.provider}' must default-export a matching API version 1 plugin.`,
    );
  registry.register(plugin, config.options, config.version);
}
