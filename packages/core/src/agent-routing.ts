import type {
  AgentReadiness,
  AgentRequirements,
  AgentRole,
  AgentRoutingAttempt,
  AgentRoutingDecision,
  AgentRoutingPolicy,
  AgentRoutingReason,
  AgentRunOptions,
} from "@veyra/protocol";
import {
  isAgentReadiness,
  isAgentRequirements,
  isAgentRoutingBinding,
  isAgentRoutingPolicy,
  routingFailureCategory,
} from "@veyra/protocol";
import { createDeadline } from "@veyra/runtime";
import { selectAgent, type AgentCandidate } from "./agents.js";
import { ExecutionError } from "./execution-error.js";

export interface AgentRouteRequest {
  primary: string;
  policy: AgentRoutingPolicy;
  requirements: AgentRequirements;
  agents: Record<string, AgentCandidate>;
  role?: AgentRole;
  controls?: AgentRunOptions;
}

const cancelled = (signal?: AbortSignal) => {
  if (signal?.aborted)
    throw new ExecutionError("run_cancelled", "Run was cancelled during provider selection.");
};

async function probe(
  candidate: AgentCandidate,
  policy: AgentRoutingPolicy,
  controls: AgentRunOptions,
) {
  cancelled(controls.signal);
  if (!candidate.checkReadiness)
    return {
      readiness: { status: "unknown", scope: "configuration" } as const,
      reason: "readiness_unknown" as const,
    };
  const timeoutMs = Math.min(policy.readinessTimeoutMs ?? 5000, controls.timeoutMs ?? 60000);
  const deadline = createDeadline(timeoutMs, controls.signal);
  try {
    let readiness: AgentReadiness;
    try {
      // Probes must honor cancellation and drain native processes before returning.
      readiness = await candidate.checkReadiness({
        ...controls,
        timeoutMs,
        signal: deadline.signal,
      });
    } catch (error) {
      cancelled(controls.signal);
      // The SDK may already have validated the hook result before it reaches this boundary.
      if (error instanceof Error && "code" in error && error.code === "invalid_plugin_readiness")
        throw new ExecutionError(
          "invalid_agent_readiness",
          "Plugin returned invalid readiness metadata; selection stopped.",
        );
      return {
        reason: deadline.timedOut()
          ? ("readiness_timeout" as const)
          : ("readiness_failed" as const),
      };
    }
    cancelled(controls.signal);
    if (deadline.timedOut()) return { reason: "readiness_timeout" as const };
    if (!isAgentReadiness(readiness))
      throw new ExecutionError(
        "invalid_agent_readiness",
        "Adapter returned invalid readiness metadata; selection stopped.",
      );
    return {
      readiness: { status: readiness.status, scope: readiness.scope },
      ...(readiness.status === "ready"
        ? {}
        : {
            reason:
              readiness.status === "unavailable"
                ? ("unavailable" as const)
                : ("readiness_unknown" as const),
          }),
    };
  } finally {
    deadline.dispose();
  }
}

/** Deterministic, ordered selection only. This function never invokes an agent or changes a model. */
export async function selectAgentRoute(request: AgentRouteRequest): Promise<{
  decision: AgentRoutingDecision;
  selection?: ReturnType<typeof selectAgent>;
}> {
  if (
    !isAgentRoutingPolicy(request.policy) ||
    !isAgentRoutingBinding(request.primary, request.policy) ||
    !isAgentRequirements(request.requirements) ||
    !request.requirements.role
  )
    throw new ExecutionError(
      "invalid_agent_routing",
      "Routing requires a valid policy, primary binding and explicit role.",
    );
  const policy = structuredClone(request.policy);
  const requirements = structuredClone(request.requirements);
  const controls = { ...request.controls };
  const role = request.role;
  const bindings = [request.primary, ...policy.fallbacks];
  const candidates = { ...request.agents };
  for (const binding of bindings)
    if (!Object.hasOwn(candidates, binding) || !candidates[binding])
      throw new ExecutionError(
        "missing_adapter",
        `Routing candidate '${binding}' is not registered; configure every declared candidate.`,
      );
  const decision: AgentRoutingDecision = {
    version: 1,
    primary: request.primary,
    policy,
    requirements,
    attempts: [],
  };
  for (const [index, binding] of bindings.entries()) {
    cancelled(controls.signal);
    const candidate = candidates[binding] as AgentCandidate;
    let selection: ReturnType<typeof selectAgent> | undefined;
    let reason: AgentRoutingReason | undefined;
    try {
      selection = selectAgent(candidate, binding, requirements, role);
    } catch (error) {
      if (!(error instanceof ExecutionError)) throw error;
      if (error.code === "missing_agent_descriptor") reason = "missing_metadata";
      else if (error.code === "unsupported_agent_role") reason = "unsupported_role";
      else if (error.code === "unsupported_agent_capability") reason = "missing_capability";
      else throw error;
    }
    const attempt: AgentRoutingAttempt = {
      binding,
      decision: "blocked",
      reason: reason ?? "unavailable",
      ...(selection?.descriptor ? { descriptor: selection.descriptor } : {}),
    };
    if (!reason && policy.budget) {
      const estimate = policy.budget.estimates.find((item) => item.agent === binding);
      if (!estimate) reason = "estimate_missing";
      else {
        attempt.estimatedCost = estimate.amount;
        if (estimate.amount > policy.budget.maxEstimatedCost) reason = "estimate_exceeded";
      }
    }
    if (!reason) {
      const result = await probe(candidate, policy, controls);
      if (result.readiness) attempt.readiness = result.readiness;
      if (!(result.reason === "readiness_unknown" && policy.allowUnknownReadiness))
        reason = result.reason;
    }
    cancelled(controls.signal);
    if (!reason && selection) {
      attempt.decision = "selected";
      attempt.reason = index === 0 ? "preferred_eligible" : "fallback_eligible";
      decision.attempts.push(attempt);
      decision.selected = binding;
      return { decision, selection };
    }
    attempt.reason = reason ?? "unavailable";
    const category = routingFailureCategory(attempt.reason);
    const canFallback =
      index < bindings.length - 1 && category && policy.fallbackOn.includes(category);
    attempt.decision = canFallback ? "skipped" : "blocked";
    decision.attempts.push(attempt);
    if (!canFallback) return { decision };
  }
  return { decision };
}
