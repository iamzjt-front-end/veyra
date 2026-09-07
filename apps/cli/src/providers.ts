import type { AgentConfig, VeyraConfig } from "@veyra/config";
import { CodexAdapter, type CodexAdapterOptions } from "@veyra/codex";
import { OpenAIAdapter, type OpenAIAdapterOptions } from "@veyra/openai";
import type { AgentAdapter } from "@veyra/protocol";
import { analyzeWorkflow, buildWorkflowGraph, type WorkflowDefinition } from "@veyra/workflow";
import { CliError } from "./arguments.js";

export type AgentFactory = (name: string, config: AgentConfig) => AgentAdapter;

/** Surface composition only; workflow roles are never tied to a provider in Core. */
export const createAgent: AgentFactory = (name, config) => {
  const options = { ...config.options, ...(config.model ? { model: config.model } : {}), id: name };
  if (config.provider === "openai") return new OpenAIAdapter(options as OpenAIAdapterOptions);
  if (config.provider === "codex") return new CodexAdapter(options as CodexAdapterOptions);
  throw new CliError(
    "unsupported_provider",
    `Provider '${config.provider}' for agent '${name}' is not implemented; supported providers are openai and codex.`,
  );
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
    else if (!customFactory && !["openai", "codex"].includes(agent.provider))
      diagnostics.push({
        code: "unsupported_provider",
        agent: name,
        steps,
        provider: agent.provider,
        message: `Provider '${agent.provider}' for agent '${name}' is not implemented; supported providers are openai and codex.`,
      });
  }
  return diagnostics;
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
  const names = new Set(
    Object.keys(env).filter((key) =>
      /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|secret|authorization|cookie)$/i.test(
        key,
      ),
    ),
  );
  for (const agent of Object.values(config?.agents ?? {})) {
    if (typeof agent.options.apiKeyEnv === "string") names.add(agent.options.apiKeyEnv);
  }
  return [...names].map((name) => env[name]).filter((value): value is string => Boolean(value));
}

export function redact(value: unknown, secrets: readonly string[]): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
    return result;
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets));
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, redact(item, secrets)]),
    );
  return value;
}
