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
  metadata?: Record<string, unknown>;
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
