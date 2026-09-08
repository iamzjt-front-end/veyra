import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { CodexAdapter, type CodexAdapterOptions } from "@veyra/codex";
import { loadConfig, type VeyraConfig } from "@veyra/config";
import type { AgentDescriptor } from "@veyra/protocol";
import type { ProcessRunner } from "@veyra/runtime";
import { loadWorkflow } from "@veyra/workflow";
import { createAgent, requiredAgents } from "./providers.js";

interface ProviderReadiness {
  agent: string;
  provider: string;
  required: boolean;
  ready: boolean;
  message: string;
  version?: string;
  descriptor?: AgentDescriptor;
}

export async function inspectEnvironment(
  configPath: string,
  root: string,
  env: NodeJS.ProcessEnv,
  runner: ProcessRunner,
  workflowOverride?: string,
  requireConfig = false,
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
      if (agent) base.descriptor = createAgent(name, agent).describe?.();
      if (provider === "openai") {
        const keyName =
          typeof agent?.options.apiKeyEnv === "string" ? agent.options.apiKeyEnv : "OPENAI_API_KEY";
        const ready = Boolean(env[keyName]);
        return {
          ...base,
          ready,
          message: ready
            ? `${keyName} is present; API access was not tested.`
            : `Set ${keyName}; no key value is printed.`,
        };
      }
      if (provider === "codex") {
        if (agent?.options.mode === "sdk")
          return { ...base, ready: false, message: "Codex SDK mode is planned; select CLI mode." };
        const result = await new CodexAdapter((agent?.options ?? {}) as CodexAdapterOptions, {
          runProcess: runner,
        }).doctor({ cwd: root });
        return {
          ...base,
          ready: result.ready,
          message: result.message,
          ...(result.version ? { version: result.version } : {}),
        };
      }
      return { ...base, ready: false, message: `Provider '${provider}' is not implemented.` };
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
    providers,
  };
}
