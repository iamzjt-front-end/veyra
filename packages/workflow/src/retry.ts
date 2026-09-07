import type { WorkflowDefinition, WorkflowStep } from "./index.js";
import { parseWorkflow } from "./parser.js";

/** Freeze effective per-step limits into the run's workflow snapshot. */
export function withRetryDefaults(
  workflow: WorkflowDefinition,
  defaultMax: number,
): WorkflowDefinition {
  return withExecutionDefaults(workflow, defaultMax);
}

/** Materialize retry defaults and inherited deadline/concurrency caps before persisting a run. */
export function withExecutionDefaults(
  workflow: WorkflowDefinition,
  defaultMax: number,
): WorkflowDefinition {
  if (!Number.isSafeInteger(defaultMax) || defaultMax < 0)
    throw new Error("Default repair limit must be a non-negative safe integer.");
  const copy = parseWorkflow(workflow);
  const visit = (
    definition: WorkflowDefinition,
    inheritedRetry: NonNullable<WorkflowStep["retry"]>,
    inheritedTimeout?: number,
    inheritedConcurrency?: number,
  ) => {
    const retry = definition.policy?.retry ?? inheritedRetry;
    const timeout = minimum(inheritedTimeout, definition.policy?.stepTimeoutMs);
    const concurrency = minimum(inheritedConcurrency, definition.policy?.concurrency);
    for (const step of Object.values(definition.steps)) {
      if (
        step.type === "agent" ||
        step.type === "command" ||
        step.type === "parallel" ||
        step.type === "consensus" ||
        step.type === "router" ||
        step.type === "subworkflow"
      )
        step.retry = {
          max: step.retry?.max ?? retry.max,
          ...((step.retry?.backoff ?? retry.backoff)
            ? { backoff: structuredClone(step.retry?.backoff ?? retry.backoff) }
            : {}),
        };
      if (step.type === "agent" || step.type === "command") {
        const deadline = minimum(step.timeoutMs, timeout);
        if (deadline !== undefined) step.timeoutMs = deadline;
      }
      if ((step.type === "parallel" || step.type === "consensus") && concurrency !== undefined)
        step.concurrency = Math.min(step.concurrency as number, concurrency);
      if (step.workflow) visit(step.workflow, retry, timeout, concurrency);
    }
  };
  visit(copy, { max: defaultMax });
  return copy;
}

function minimum(left?: number, right?: number): number | undefined {
  return left === undefined ? right : right === undefined ? left : Math.min(left, right);
}

export function retryDelay(step: WorkflowStep, retryCount: number): number {
  const policy = step.retry?.backoff;
  if (!policy || retryCount < 1) return 0;
  if (!Number.isSafeInteger(retryCount))
    throw new Error("Retry delay requires a positive safe integer count.");
  if (policy.initialMs === 0) return 0;
  return Math.min(
    policy.maxMs ?? Math.max(policy.initialMs, 30_000),
    policy.initialMs * (policy.multiplier ?? 2) ** (retryCount - 1),
  );
}

export interface RetryDecision {
  allowed: boolean;
  retryCount: number;
  maxRetries: number;
}

/** First recovery entry and all revisits spend this step's repair budget. */
export function nextRetry(
  step: WorkflowStep,
  previous: number | undefined,
  incomingOutcome?: string,
): RetryDecision {
  const maxRetries = step.retry?.max;
  if (
    maxRetries === undefined ||
    !Number.isSafeInteger(maxRetries) ||
    maxRetries < 0 ||
    (previous !== undefined && (!Number.isSafeInteger(previous) || previous < 0))
  )
    throw new Error("Retry evaluation requires a snapshotted limit and valid persisted counter.");
  const repair =
    previous !== undefined || incomingOutcome === "failure" || incomingOutcome === "fail";
  const current = previous ?? 0;
  if (repair && current >= maxRetries) return { allowed: false, retryCount: current, maxRetries };
  return { allowed: true, retryCount: repair ? current + 1 : 0, maxRetries };
}
