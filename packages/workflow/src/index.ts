export type StepType =
  | "agent"
  | "command"
  | "human"
  | "parallel"
  | "router"
  | "subworkflow"
  | "end";

export interface WorkflowDefinition {
  name: string;
  version: number;
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

export function resolveNextStep(
  step: WorkflowStep,
  outcome: StepOutcome,
): string | undefined {
  return step.on?.[outcome.status] ?? step.next;
}

export function assertWorkflow(definition: WorkflowDefinition): void {
  if (!definition.steps[definition.start]) {
    throw new Error(`Workflow start step '${definition.start}' does not exist.`);
  }

  for (const [stepId, step] of Object.entries(definition.steps)) {
    const destinations = [step.next, ...Object.values(step.on ?? {})].filter(Boolean) as string[];
    for (const destination of destinations) {
      if (!definition.steps[destination]) {
        throw new Error(`Step '${stepId}' points to missing step '${destination}'.`);
      }
    }
  }
}
