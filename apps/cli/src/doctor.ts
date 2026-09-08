import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { loadConfig, type VeyraConfig } from "@veyra/config";
import { discoverAgents } from "@veyra/core";
import type { AgentDescriptor } from "@veyra/protocol";
import type { ProcessRunner } from "@veyra/runtime";
import { loadWorkflow } from "@veyra/workflow";
import { redact, requiredAgents, secretValues } from "./providers.js";
import { pluginAgent, registryForProviders } from "./plugins.js";

interface ProviderReadiness {
  agent: string;
  provider: string;
  required: boolean;
  ready: boolean;
  message: string;
  version?: string;
  descriptor?: AgentDescriptor;
  scope?: "configuration" | "local" | "remote";
}

export async function inspectEnvironment(
  configPath: string,
  root: string,
  env: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  workflowOverride?: string,
  requireConfig = false,
  allowedPlugins: readonly string[] = [],
  signal?: AbortSignal,
) {
  let config: VeyraConfig | undefined;
  let configuration: { path: string; status: "valid" | "missing" | "invalid"; message?: string } = {
    path: configPath,
    status: "missing",
  };
  let required = new Set<string>();
  try {
    await access(configPath);
    configuration = { path: configPath, status: "invalid" };
    config = await loadConfig(configPath);
    required = new Set(
      requiredAgents(await loadWorkflow(workflowOverride ?? config.workflow.use, root)),
    );
    configuration.status = "valid";
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT"))
      configuration = {
        path: configPath,
        status: "invalid",
        message: error instanceof Error ? error.message : "Configuration could not be checked.",
      };
  }
  const permission = async (mode: number) => {
    try {
      await access(root, mode);
      return true;
    } catch {
      return false;
    }
  };
  if (requireConfig && configuration.status === "missing")
    configuration = {
      path: configPath,
      status: "invalid",
      message: "The selected configuration does not exist.",
    };
  const pnpm = async () => {
    try {
      const result = await runner({
        executable: process.platform === "win32" ? (env.ComSpec ?? "cmd.exe") : "pnpm",
        args: process.platform === "win32" ? ["/d", "/s", "/c", "pnpm --version"] : ["--version"],
        cwd: root,
        timeoutMs: 5000,
        maxOutputBytes: 4096,
        signal,
      });
      const version = /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.exec(result.stdout.trim())?.[0];
      return {
        ready:
          result.exitCode === 0 && !result.signal && !result.terminationReason && Boolean(version),
        version: version ?? "unavailable",
      };
    } catch {
      return { ready: false, version: "unavailable" };
    }
  };
  const checkProvider = async (name: string, provider: string): Promise<ProviderReadiness> => {
    const agent = config?.agents[name];
    const base: Pick<ProviderReadiness, "agent" | "provider" | "required" | "descriptor"> = {
      agent: name,
      provider,
      required: required.has(name),
    };
    try {
      const registry = await registryForProviders(
        config ?? {
          version: 1,
          agents: {},
          workflow: { use: "dev" },
          runtime: { maxFixIterations: 3, stateDir: ".veyra" },
          approval: { requiredFor: [] },
        },
        [provider],
        root,
        allowedPlugins,
        { env, runProcess: runner },
      );
      const request = pluginAgent(
        name,
        agent ?? {
          provider,
          options: {},
          ...(provider === "openai" ? { model: "unconfigured" } : {}),
        },
      );
      const result = await registry.checkReadiness(provider, request, {
        cwd: root,
        timeoutMs: 5000,
        signal,
      });
      const readiness: ProviderReadiness = {
        ...base,
        ready: result.status === "ready",
        scope: result.scope,
        message: result.message,
        ...(result.version ? { version: result.version } : {}),
      };
      if (agent) {
        try {
          const [discovered] = await discoverAgents({
            [name]: registry.createAgent(provider, request),
          });
          if (discovered?.error) throw new Error(discovered.error.message);
          if (discovered?.descriptor) readiness.descriptor = discovered.descriptor;
        } catch (error) {
          // Preserve a plugin hook's setup diagnosis when an adapter cannot yet be constructed.
          if (readiness.ready)
            return {
              ...readiness,
              ready: false,
              message:
                error instanceof Error ? error.message : "Adapter metadata could not be checked.",
            };
        }
      }
      return readiness;
    } catch (error) {
      return {
        ...base,
        ready: false,
        message: error instanceof Error ? error.message : "Provider readiness check failed.",
      };
    }
  };
  const configured = config
    ? Object.entries(config.agents).map(([name, agent]) => [name, agent.provider] as const)
    : ([
        ["openai", "openai"],
        ["codex", "codex"],
      ] as const);
  const [packageManager, readable, writable, providers] = await Promise.all([
    pnpm(),
    permission(constants.R_OK),
    permission(constants.W_OK),
    Promise.all(configured.map(([name, provider]) => checkProvider(name, provider))),
  ]);
  for (const name of required)
    if (!Object.hasOwn(config?.agents ?? {}, name))
      providers.push({
        agent: name,
        provider: "unconfigured",
        required: true,
        ready: false,
        message: "Workflow agent has no config entry.",
      });
  const safeProviders = redact(providers, secretValues(env, config)) as ProviderReadiness[];
  const node = {
    version: process.version,
    ready: Number(process.versions.node.split(".")[0]) >= 20,
  };
  return {
    ready:
      node.ready &&
      packageManager.ready &&
      readable &&
      writable &&
      configuration.status !== "invalid" &&
      providers.every((provider) => !provider.required || provider.ready),
    node,
    pnpm: packageManager,
    platform: `${process.platform}/${process.arch}`,
    cwd: root,
    workingDirectory: { readable, writable },
    config: configuration,
    providers: safeProviders,
  };
}
