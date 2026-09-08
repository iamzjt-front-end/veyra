import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { loadConfig, type VeyraConfig } from "@veyraoss/config";
import { discoverAgents, selectAgentRoute, type AgentCandidate } from "@veyraoss/core";
import type { AgentDescriptor, AgentReadiness, AgentRoutingDecision } from "@veyraoss/protocol";
import type { ProcessRunner } from "@veyraoss/runtime";
import {
  analyzeWorkflow,
  buildWorkflowGraph,
  loadWorkflow,
  type WorkflowDefinition,
} from "@veyraoss/workflow";
import { redact, requiredAgents, secretValues } from "./providers.js";
import { builtinPlugins, pluginAgent, registryForProviders } from "./plugins.js";

interface ProviderReadiness {
  agent: string;
  provider: string;
  required: boolean;
  ready: boolean;
  message: string;
  version?: string;
  descriptor?: AgentDescriptor;
  scope?: "configuration" | "local" | "remote";
  status?: AgentReadiness["status"];
  routingCandidate?: boolean;
  configurationError?: boolean;
  probeFailed?: boolean;
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
  let pinned = new Set<string>();
  const routed = new Set<string>();
  let workflow: WorkflowDefinition | undefined;
  try {
    await access(configPath);
    configuration = { path: configPath, status: "invalid" };
    config = await loadConfig(configPath);
    workflow = await loadWorkflow(workflowOverride ?? config.workflow.use, root);
    required = new Set(requiredAgents(workflow));
    pinned = new Set(required);
    const graph = buildWorkflowGraph(workflow);
    const pinnedBindings = new Set<string>();
    for (const id of analyzeWorkflow(workflow).reachableSteps) {
      const step = graph.steps[id];
      if (step?.type !== "agent" || !step.agent) continue;
      if (step.routing)
        for (const binding of [step.agent, ...step.routing.fallbacks]) routed.add(binding);
      else pinnedBindings.add(step.agent);
    }
    for (const binding of routed) if (!pinnedBindings.has(binding)) pinned.delete(binding);
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
    const base: Pick<ProviderReadiness, "agent" | "provider" | "required" | "routingCandidate"> = {
      agent: name,
      provider,
      required: pinned.has(name),
      ...(routed.has(name) ? { routingCandidate: true } : {}),
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
          model: "unconfigured",
        },
      );
      let result: AgentReadiness;
      let probeFailed = false;
      try {
        result = await registry.checkReadiness(provider, request, {
          cwd: root,
          timeoutMs: 5000,
          signal,
        });
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "plugin_readiness_failed"
        ))
          throw error;
        probeFailed = true;
        result = {
          status: "unknown",
          scope: "configuration",
          message: "Provider readiness probe failed; no raw provider error is exposed.",
        };
      }
      const readiness: ProviderReadiness = {
        ...base,
        ready: result.status === "ready",
        status: result.status,
        scope: result.scope,
        message: result.message,
        ...(probeFailed ? { probeFailed: true } : {}),
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
          readiness.configurationError = true;
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
        configurationError: true,
        message: error instanceof Error ? error.message : "Provider readiness check failed.",
      };
    }
  };
  const configured = config
    ? Object.entries(config.agents).map(([name, agent]) => [name, agent.provider] as const)
    : builtinPlugins().map(({ provider }) => [provider, provider] as const);
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
        required: pinned.has(name),
        ...(routed.has(name) ? { routingCandidate: true } : {}),
        configurationError: true,
        ready: false,
        message: "Workflow agent has no config entry.",
      });
  const routing: {
    stepId: string;
    ready: boolean;
    decision?: AgentRoutingDecision;
    message?: string;
  }[] = [];
  if (workflow && routed.size) {
    const candidates: Record<string, AgentCandidate> = Object.fromEntries(
      providers.map((provider) => [
        provider.agent,
        {
          id: provider.descriptor?.id ?? provider.agent,
          provider: provider.provider,
          ...(provider.descriptor
            ? { describe: () => structuredClone(provider.descriptor as AgentDescriptor) }
            : {}),
          checkReadiness: async () => {
            if (provider.probeFailed)
              throw new Error("Previously collected readiness probe failed.");
            return {
              status: provider.status ?? "unknown",
              scope: provider.scope ?? "configuration",
              message: "Previously collected doctor readiness snapshot.",
            };
          },
        },
      ]),
    );
    const graph = buildWorkflowGraph(workflow);
    for (const stepId of analyzeWorkflow(workflow).reachableSteps) {
      const step = graph.steps[stepId];
      if (!step?.routing || !step.agent) continue;
      const bindings = [step.agent, ...step.routing.fallbacks];
      if (
        providers.some(
          (provider) => bindings.includes(provider.agent) && provider.configurationError,
        )
      ) {
        routing.push({
          stepId,
          ready: false,
          message:
            "Fix candidate configuration errors before routing; configuration failures do not permit fallback.",
        });
        continue;
      }
      const group = Object.values(graph.steps).find(
        (candidate) =>
          candidate.type === "consensus" &&
          (candidate.reviewers?.includes(stepId) || candidate.judge === stepId),
      );
      try {
        const result = await selectAgentRoute({
          primary: step.agent,
          policy: step.routing,
          requirements: step.requires ?? {},
          agents: candidates,
          ...(group ? { role: group.judge === stepId ? "judge" : "reviewer" } : {}),
          controls: { signal },
        });
        routing.push({
          stepId,
          ready: Boolean(result.decision.selected),
          decision: result.decision,
        });
      } catch (error) {
        routing.push({
          stepId,
          ready: false,
          message:
            error instanceof Error ? error.message : "Provider routing could not be checked.",
        });
      }
    }
  }
  const secrets = secretValues(env, config);
  const safeProviders = redact(providers, secrets) as ProviderReadiness[];
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
      providers.every((provider) => !provider.required || provider.ready) &&
      routing.every((route) => route.ready),
    node,
    pnpm: packageManager,
    platform: `${process.platform}/${process.arch}`,
    cwd: root,
    workingDirectory: { readable, writable },
    config: configuration,
    providers: safeProviders,
    routing: redact(routing, secrets) as typeof routing,
  };
}
