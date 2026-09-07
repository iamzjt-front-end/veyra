import type { WorkflowDefinition, WorkflowStep } from "./index.js";
import { parseWorkflow } from "./parser.js";

/** Freeze effective per-step limits into the run's workflow snapshot. */
export function withRetryDefaults(
  workflow: WorkflowDefinition,
  defaultMax: number,
): WorkflowDefinition {
  if (!Number.isSafeInteger(defaultMax) || defaultMax < 0)
    throw new Error("Default repair limit must be a non-negative safe integer.");
  const copy = parseWorkflow(workflow);
  const visit = (definition: WorkflowDefinition) => {
    for (const step of Object.values(definition.steps)) {
      if (
        step.type === "agent" ||
        step.type === "command" ||
        step.type === "parallel" ||
        step.type === "router" ||
        step.type === "subworkflow"
      )
        step.retry ??= { max: defaultMax };
      if (step.workflow) visit(step.workflow);
    }
  };
  visit(copy);
  return copy;
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
