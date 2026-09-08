import type { AgentConfig, VeyraConfig } from "@veyra/config";
import type { AgentAdapter, JsonValue } from "@veyra/protocol";
import { collectSecretValues, createSecretRedactor } from "@veyra/runtime";
import { PluginRegistry } from "@veyra/sdk";
import { analyzeWorkflow, buildWorkflowGraph, type WorkflowDefinition } from "@veyra/workflow";
import { CliError } from "./arguments.js";
import {
  builtinPlugins,
  pluginAgent,
  registryForProviders,
  type PluginServices,
} from "./plugins.js";

export type AgentFactory = (name: string, config: AgentConfig) => AgentAdapter;

/** Surface composition only; workflow roles are never tied to a provider in Core. */
export const createAgent: AgentFactory = (name, config) => {
  const registry = new PluginRegistry();
  for (const plugin of builtinPlugins()) registry.register(plugin);
  return registry.createAgent(config.provider, pluginAgent(name, config));
};

export function requiredAgents(workflow: WorkflowDefinition): string[] {
  return [...agentReferences(workflow).keys()];
}

function agentReferences(workflow: WorkflowDefinition): Map<string, string[]> {
  const graph = buildWorkflowGraph(workflow);
  const references = new Map<string, string[]>();
  for (const id of analyzeWorkflow(workflow).reachableSteps) {
    const step = graph.steps[id];
    if (step?.type !== "agent" || !step.agent) continue;
    references.set(step.agent, [...(references.get(step.agent) ?? []), id]);
  }
  return references;
}

export interface AgentDiagnostic {
  code: "missing_agent_config" | "unsupported_provider";
  agent: string;
  steps: string[];
  provider?: string;
  message: string;
}

/** Inspect bindings only; no adapter construction, credential lookup or provider calls. */
export function agentDiagnostics(
  config: VeyraConfig,
  workflow: WorkflowDefinition,
  customFactory = false,
): AgentDiagnostic[] {
  const diagnostics: AgentDiagnostic[] = [];
  for (const [name, steps] of agentReferences(workflow)) {
    const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
    if (!agent)
      diagnostics.push({
        code: "missing_agent_config",
        agent: name,
        steps,
        message: `Workflow agent '${name}' used by ${steps.join(", ")} has no entry in config.agents.`,
      });
    else if (
      !customFactory &&
      !builtinPlugins().some((plugin) => plugin.provider === agent.provider) &&
      !(
        Object.hasOwn(config.plugins ?? {}, agent.provider) &&
        config.plugins?.[agent.provider]?.module
      )
    )
      diagnostics.push({
        code: "unsupported_provider",
        agent: name,
        steps,
        provider: agent.provider,
        message: `Provider '${agent.provider}' for agent '${name}' has no plugin; register a built-in or configure plugins.${agent.provider}.module with an exact version.`,
      });
  }
  return diagnostics;
}

export async function configuredAdapters(
  config: VeyraConfig,
  workflow: WorkflowDefinition,
  cwd: string,
  allowedPlugins: readonly string[] = [],
  services: PluginServices = {},
): Promise<Record<string, AgentAdapter>> {
  const diagnostics = agentDiagnostics(config, workflow);
  if (diagnostics[0])
    throw new CliError(diagnostics[0].code, diagnostics.map((item) => item.message).join("\n"));
  const names = requiredAgents(workflow);
  const registry = await registryForProviders(
    config,
    names.map((name) => (config.agents[name] as AgentConfig).provider),
    cwd,
    allowedPlugins,
    services,
  );
  return adaptersFor(config, workflow, (name, agent) =>
    registry.createAgent(agent.provider, pluginAgent(name, agent)),
  );
}

export function adaptersFor(
  config: VeyraConfig,
  workflow: WorkflowDefinition,
  factory: AgentFactory,
): Record<string, AgentAdapter> {
  const diagnostics = agentDiagnostics(config, workflow, factory !== createAgent);
  if (diagnostics[0])
    throw new CliError(diagnostics[0].code, diagnostics.map((item) => item.message).join("\n"));
  return Object.fromEntries(
    requiredAgents(workflow).map((name) => {
      const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
      return [name, factory(name, agent as AgentConfig)];
    }),
  );
}

export function secretValues(env: NodeJS.ProcessEnv, config?: VeyraConfig): string[] {
  const names = new Set<string>();
  for (const agent of Object.values(config?.agents ?? {})) {
    if (typeof agent.options.apiKeyEnv === "string") names.add(agent.options.apiKeyEnv);
  }
  for (const plugin of Object.values(config?.plugins ?? {})) {
    if (typeof plugin.options.apiKeyEnv === "string") names.add(plugin.options.apiKeyEnv);
  }
  return collectSecretValues(env, [...names]);
}

export function redact(value: unknown, secrets: readonly string[]): unknown {
  // Surface DTOs may contain workflow step/maps named "token"; persistence owns
  // schema-aware field redaction, while display must preserve those structures.
  return createSecretRedactor({ values: secrets }).json(value as JsonValue, false);
}
