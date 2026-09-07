export type StepType =
  "agent" | "command" | "human" | "parallel" | "router" | "subworkflow" | "consensus" | "end";

export type ConsensusMode = "all-pass" | "quorum" | "judge";

export interface WorkflowDefinition {
  name: string;
  version: 1;
  start: string;
  steps: Record<string, WorkflowStep>;
  policy?: WorkflowPolicy;
}

export interface RetryBackoff {
  initialMs: number;
  multiplier?: number;
  maxMs?: number;
}
export interface WorkflowPolicy {
  stepTimeoutMs?: number;
  retry?: { max: number; backoff?: RetryBackoff };
  concurrency?: number;
  approval?: { before: string[] };
  failureStrategy?: "branch" | "stop";
  budget?: BudgetLimits;
  maxSteps?: number;
}

export interface WorkflowStep {
  type: StepType;
  agent?: string;
  /** Literal task guidance, appended to the provider-neutral input instructions. */
  instructions?: string;
  run?: string[];
  next?: string;
  on?: Record<string, string>;
  retry?: {
    max: number;
    backoff?: RetryBackoff;
  };
  /** Agent/command wall-clock deadline; inherited workflow caps cannot be weakened. */
  timeoutMs?: number;
  message?: string;
  /** Named, explicit references delivered as AgentInput.context.inputs or gate context.inputs. */
  inputs?: Record<string, StepInputReference>;
  children?: string[];
  concurrency?: number;
  failurePolicy?: "wait-all" | "fail-fast";
  /** A static route label or a reference selecting a label from a previous output. */
  route?: string | StepInputReference;
  /** Subworkflow reference, resolved by loadWorkflow before execution. */
  use?: string;
  /** Resolved snapshot or an explicitly supplied inline definition. */
  workflow?: WorkflowDefinition;
  outputs?: Record<string, StepInputReference>;
  /** Independently invoked agent leaf step IDs; these are owned by this consensus node. */
  reviewers?: string[];
  mode?: ConsensusMode;
  quorum?: number;
  judge?: string;
  /** Every listed command step must have completed successfully before reviews begin. */
  verification?: string[];
  metadata?: Record<string, unknown>;
}

export interface StepInputReference {
  from: string;
  /** RFC 6901 JSON Pointer into the source StepOutput; empty selects the whole output. */
  path: string;
}

export interface StepOutcome {
  status: string;
  data?: Record<string, unknown>;
}

export function resolveNextStep(step: WorkflowStep, outcome: StepOutcome): string | undefined {
  return step.on && Object.hasOwn(step.on, outcome.status)
    ? (step.on[outcome.status] ?? step.next)
    : step.next;
}

export function assertWorkflow(definition: WorkflowDefinition): void {
  parseWorkflow(definition);
}
import { parseWorkflow } from "./parser.js";

export { loadWorkflow, listBuiltinWorkflows } from "./loader.js";
export { parseWorkflow, WorkflowError } from "./parser.js";
export {
  withRetryDefaults,
  withExecutionDefaults,
  retryDelay,
  nextRetry,
  type RetryDecision,
} from "./retry.js";
export { resolveStepInputs, InputResolutionError, MAX_RESOLVED_INPUT_BYTES } from "./inputs.js";
export { analyzeWorkflow, type WorkflowAnalysis } from "./analysis.js";
export { resolveRoute, RouterError, type RouteDecision } from "./router.js";
export { buildWorkflowGraph, type ExecutionGraph, type WorkflowScope } from "./graph.js";
export { aggregateReviews } from "./consensus.js";
import type { BudgetLimits } from "@veyra/protocol";
