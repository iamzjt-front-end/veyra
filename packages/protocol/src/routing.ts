import type { AgentDescriptor, AgentReadiness, AgentRequirements } from "./index.js";
import { isAgentDescriptor, isAgentRequirements } from "./capabilities.js";
import { isJsonValue } from "./json.js";

export type AgentFallbackReason = "requirements" | "unavailable" | "budget";

/** Ordered, opt-in pre-invocation selection. Never authorizes replay after execution starts. */
export interface AgentRoutingPolicy {
  fallbacks: string[];
  fallbackOn: AgentFallbackReason[];
  allowUnknownReadiness?: boolean;
  readinessTimeoutMs?: number;
  /** User-supplied per-invocation estimates, not observed charges or a run spending limit. */
  budget?: {
    currency: string;
    maxEstimatedCost: number;
    estimates: { agent: string; amount: number }[];
  };
}

export type AgentRoutingReason =
  | "preferred_eligible"
  | "fallback_eligible"
  | "missing_metadata"
  | "unsupported_role"
  | "missing_capability"
  | "estimate_missing"
  | "estimate_exceeded"
  | "unavailable"
  | "readiness_unknown"
  | "readiness_failed"
  | "readiness_timeout";

export interface AgentRoutingAttempt {
  binding: string;
  decision: "selected" | "skipped" | "blocked";
  reason: AgentRoutingReason;
  descriptor?: AgentDescriptor;
  readiness?: Pick<AgentReadiness, "status" | "scope">;
  estimatedCost?: number;
}

export interface AgentRoutingDecision {
  version: 1;
  primary: string;
  policy: AgentRoutingPolicy;
  requirements: AgentRequirements;
  attempts: AgentRoutingAttempt[];
  selected?: string;
}

const object = (value: unknown): value is Record<string, unknown> =>
  isJsonValue(value) && value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, allowed: string[]) =>
  Object.keys(value).every((key) => allowed.includes(key));
const binding = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0 && [...value].length <= 128;
const amount = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const uniqueList = (value: unknown, limit: number, valid: (item: unknown) => boolean) =>
  Array.isArray(value) &&
  value.length <= limit &&
  value.every(valid) &&
  new Set(value).size === value.length;

export function isAgentRoutingPolicy(value: unknown): value is AgentRoutingPolicy {
  if (
    !object(value) ||
    !keys(value, [
      "fallbacks",
      "fallbackOn",
      "allowUnknownReadiness",
      "readinessTimeoutMs",
      "budget",
    ]) ||
    !uniqueList(value.fallbacks, 15, binding) ||
    !uniqueList(value.fallbackOn, 3, (item) =>
      ["requirements", "unavailable", "budget"].includes(item as string),
    ) ||
    (value.allowUnknownReadiness !== undefined &&
      typeof value.allowUnknownReadiness !== "boolean") ||
    (value.readinessTimeoutMs !== undefined &&
      (!Number.isSafeInteger(value.readinessTimeoutMs) ||
        (value.readinessTimeoutMs as number) < 1 ||
        (value.readinessTimeoutMs as number) > 60000))
  )
    return false;
  if (value.budget === undefined) return true;
  const budget = value.budget;
  return (
    object(budget) &&
    keys(budget, ["currency", "maxEstimatedCost", "estimates"]) &&
    typeof budget.currency === "string" &&
    budget.currency.length === 3 &&
    /^[A-Z]{3}$/.test(budget.currency) &&
    amount(budget.maxEstimatedCost) &&
    Array.isArray(budget.estimates) &&
    budget.estimates.length <= 16 &&
    budget.estimates.every(
      (estimate) =>
        object(estimate) &&
        keys(estimate, ["agent", "amount"]) &&
        binding(estimate.agent) &&
        amount(estimate.amount),
    ) &&
    new Set(budget.estimates.map((estimate) => estimate.agent)).size === budget.estimates.length
  );
}

/** Cross-field constraints shared by the workflow parser and audited decision guard. */
export function isAgentRoutingBinding(
  primary: unknown,
  policy: AgentRoutingPolicy,
): primary is string {
  if (!binding(primary) || policy.fallbacks.includes(primary)) return false;
  const candidates = [primary, ...policy.fallbacks];
  return (policy.budget?.estimates ?? []).every((estimate) => candidates.includes(estimate.agent));
}

export function routingFailureCategory(
  reason: AgentRoutingReason,
): AgentFallbackReason | undefined {
  if (["missing_metadata", "unsupported_role", "missing_capability"].includes(reason))
    return "requirements";
  if (["estimate_missing", "estimate_exceeded"].includes(reason)) return "budget";
  if (
    ["unavailable", "readiness_unknown", "readiness_failed", "readiness_timeout"].includes(reason)
  )
    return "unavailable";
  return undefined;
}

export function isAgentRoutingDecision(value: unknown): value is AgentRoutingDecision {
  if (
    !object(value) ||
    !keys(value, ["version", "primary", "policy", "requirements", "attempts", "selected"]) ||
    value.version !== 1 ||
    !isAgentRoutingPolicy(value.policy) ||
    !isAgentRoutingBinding(value.primary, value.policy) ||
    !isAgentRequirements(value.requirements) ||
    !value.requirements.role ||
    !Array.isArray(value.attempts) ||
    value.attempts.length < 1
  )
    return false;
  const candidates = [value.primary, ...value.policy.fallbacks];
  if (value.attempts.length > candidates.length) return false;
  const policy = value.policy;
  for (let index = 0; index < value.attempts.length; index++) {
    const attempt = value.attempts[index];
    if (
      !object(attempt) ||
      !keys(attempt, [
        "binding",
        "decision",
        "reason",
        "descriptor",
        "readiness",
        "estimatedCost",
      ]) ||
      attempt.binding !== candidates[index] ||
      typeof attempt.reason !== "string" ||
      (attempt.descriptor !== undefined && !isAgentDescriptor(attempt.descriptor)) ||
      (attempt.estimatedCost !== undefined && !amount(attempt.estimatedCost)) ||
      (attempt.readiness !== undefined &&
        (!object(attempt.readiness) ||
          !keys(attempt.readiness, ["status", "scope"]) ||
          !["ready", "unavailable", "unknown"].includes(attempt.readiness.status as string) ||
          !["configuration", "local", "remote"].includes(attempt.readiness.scope as string)))
    )
      return false;
    const last = index === value.attempts.length - 1;
    const category = routingFailureCategory(attempt.reason as AgentRoutingReason);
    if (attempt.decision === "selected") {
      if (
        !last ||
        value.selected !== attempt.binding ||
        attempt.reason !== (index === 0 ? "preferred_eligible" : "fallback_eligible") ||
        !isAgentDescriptor(attempt.descriptor) ||
        !attempt.descriptor.roles.includes(value.requirements.role) ||
        !(value.requirements.capabilities ?? []).every((capability) =>
          (attempt.descriptor as AgentDescriptor).capabilities.includes(capability),
        ) ||
        !object(attempt.readiness) ||
        !(
          attempt.readiness.status === "ready" ||
          (attempt.readiness.status === "unknown" && policy.allowUnknownReadiness)
        ) ||
        (policy.budget &&
          (attempt.estimatedCost === undefined ||
            attempt.estimatedCost !==
              policy.budget.estimates.find((estimate) => estimate.agent === attempt.binding)
                ?.amount ||
            (attempt.estimatedCost as number) > policy.budget.maxEstimatedCost))
      )
        return false;
    } else if (attempt.decision === "skipped") {
      if (last || !category || !policy.fallbackOn.includes(category)) return false;
    } else if (attempt.decision === "blocked") {
      if (
        !last ||
        value.selected !== undefined ||
        !category ||
        (index < candidates.length - 1 && policy.fallbackOn.includes(category))
      )
        return false;
    } else return false;
  }
  return true;
}
