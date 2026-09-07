export type StepType =
  "agent" | "command" | "human" | "parallel" | "router" | "subworkflow" | "end";

export interface WorkflowDefinition {
  name: string;
  version: 1;
  start: string;
  steps: Record<string, WorkflowStep>;
}

export interface WorkflowStep {
  type: StepType;
  agent?: string;
  run?: string[];
  next?: string;
  on?: Record<string, string>;
  retry?: {
    max: number;
  };
  message?: string;
  /** Named, explicit references delivered as AgentInput.context.inputs or gate context.inputs. */
  inputs?: Record<string, StepInputReference>;
  children?: string[];
  concurrency?: number;
  failurePolicy?: "wait-all" | "fail-fast";
  /** A static route label or a reference selecting a label from a previous output. */
  route?: string | StepInputReference;
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

export { loadWorkflow } from "./loader.js";
export { parseWorkflow, WorkflowError } from "./parser.js";
export { withRetryDefaults, nextRetry, type RetryDecision } from "./retry.js";
export { resolveStepInputs, InputResolutionError, MAX_RESOLVED_INPUT_BYTES } from "./inputs.js";
export { analyzeWorkflow, type WorkflowAnalysis } from "./analysis.js";
export { resolveRoute, RouterError, type RouteDecision } from "./router.js";
