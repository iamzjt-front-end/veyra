import type { AgentConfig, VeyraConfig } from "@veyra/config";
import { CodexAdapter, type CodexAdapterOptions } from "@veyra/codex";
import { OpenAIAdapter, type OpenAIAdapterOptions } from "@veyra/openai";
import type { AgentAdapter } from "@veyra/protocol";
import type { WorkflowDefinition } from "@veyra/workflow";
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
  return [
    ...new Set(
      Object.values(workflow.steps).flatMap((step) =>
        step.type === "agent" && step.agent ? [step.agent] : [],
      ),
    ),
  ];
}

export function adaptersFor(
  config: VeyraConfig,
  workflow: WorkflowDefinition,
  factory: AgentFactory,
): Record<string, AgentAdapter> {
  return Object.fromEntries(
    requiredAgents(workflow).map((name) => {
      const agent = Object.hasOwn(config.agents, name) ? config.agents[name] : undefined;
      if (!agent)
        throw new CliError(
          "missing_agent_config",
          `Workflow agent '${name}' has no entry in config.agents.`,
        );
      return [name, factory(name, agent)];
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
