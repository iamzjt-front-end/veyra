import type {
  AgentAdapter,
  AgentDescriptor,
  AgentReadiness,
  AgentRequirements,
  AgentRole,
  AgentRunOptions,
  SerializedError,
} from "@veyra/protocol";
import { isAgentDescriptor, isAgentReadiness } from "@veyra/protocol";
import { ExecutionError } from "./execution-error.js";

function descriptorFor(adapter: AgentAdapter): AgentDescriptor | undefined {
  if (!adapter.describe) return undefined;
  try {
    const value = adapter.describe();
    if (
      !isAgentDescriptor(value) ||
      value.id !== adapter.id ||
      value.provider !== adapter.provider ||
      Buffer.byteLength(JSON.stringify(value)) > 16 * 1024
    )
      throw new Error("Invalid descriptor");
    return structuredClone(value);
  } catch {
    throw new ExecutionError(
      "invalid_agent_descriptor",
      "Adapter metadata is invalid or does not match its identity.",
    );
  }
}

/** Resolve the explicitly pinned binding; never replace it with another provider silently. */
export function selectAgent(
  adapter: AgentAdapter,
  binding: string,
  requirements: AgentRequirements = {},
  imposedRole?: AgentRole,
) {
  const descriptor = descriptorFor(adapter);
  const role = imposedRole ?? requirements.role ?? binding;
  if (imposedRole && requirements.role && imposedRole !== requirements.role)
    throw new ExecutionError(
      "agent_role_conflict",
      `Step role '${requirements.role}' conflicts with its required group role '${imposedRole}'.`,
    );
  const capabilities = requirements.capabilities ?? [];
  if (!descriptor && (requirements.role || capabilities.length))
    throw new ExecutionError(
      "missing_agent_descriptor",
      `Agent '${binding}' must expose capability metadata to satisfy explicit workflow requirements.`,
    );
  if (descriptor) {
    if ((requirements.role || imposedRole) && !descriptor.roles.includes(role))
      throw new ExecutionError(
        "unsupported_agent_role",
        `Agent '${binding}' does not support role '${role}'.`,
      );
    const missing = capabilities.filter(
      (capability) => !descriptor.capabilities.includes(capability),
    );
    if (missing.length)
      throw new ExecutionError(
        "unsupported_agent_capability",
        `Agent '${binding}' lacks required capabilities: ${missing.join(", ")}.`,
      );
  }
  return { role, descriptor, requirements: structuredClone(requirements) };
}

export interface DiscoveredAgent {
  binding: string;
  descriptor?: AgentDescriptor;
  readiness?: AgentReadiness;
  error?: SerializedError;
}
export interface DiscoveryOptions extends AgentRunOptions {
  /** False by default; ordinary discovery only reads declared metadata. */
  checkReadiness?: boolean;
}

export async function discoverAgents(
  agents: Record<string, AgentAdapter>,
  options: DiscoveryOptions = {},
): Promise<DiscoveredAgent[]> {
  const { checkReadiness, ...controls } = options;
  return Promise.all(
    Object.entries(agents).map(async ([binding, adapter]) => {
      const result: DiscoveredAgent = { binding };
      try {
        const descriptor = descriptorFor(adapter);
        if (descriptor) result.descriptor = descriptor;
        if (checkReadiness) {
          if (controls.signal?.aborted)
            result.readiness = {
              status: "unknown",
              scope: "configuration",
              message: "Readiness check was cancelled before probing.",
            };
          else if (!adapter.checkReadiness)
            result.readiness = {
              status: "unknown",
              scope: "configuration",
              message: "Adapter has no readiness probe.",
            };
          else {
            let value: AgentReadiness;
            try {
              value = await adapter.checkReadiness({ ...controls });
            } catch {
              throw new ExecutionError(
                "agent_readiness_failed",
                "Adapter readiness probe failed; no raw provider error is exposed.",
              );
            }
            if (!isAgentReadiness(value))
              throw new ExecutionError(
                "invalid_agent_readiness",
                "Adapter returned invalid readiness metadata.",
              );
            result.readiness = structuredClone(value);
          }
        }
      } catch (error) {
        result.error =
          error instanceof ExecutionError
            ? { code: error.code, message: error.message }
            : { code: "agent_discovery_failed", message: "Agent discovery failed." };
      }
      return result;
    }),
  );
}
