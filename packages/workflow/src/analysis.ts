import type { WorkflowDefinition, WorkflowStep } from "./index.js";
import { parseWorkflow } from "./parser.js";

export interface WorkflowAnalysis {
  /** Possible control-flow reachability, in definition order, without predicting agent outcomes. */
  reachableSteps: string[];
  unreachableSteps: string[];
}

/** Validate all destinations, then report unreachable nodes without rejecting intentional spares. */
export function analyzeWorkflow(definition: WorkflowDefinition): WorkflowAnalysis {
  const workflow = parseWorkflow(definition);
  const reachable = new Set<string>();
  const pending = [workflow.start];
  while (pending.length) {
    const id = pending.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    // parseWorkflow has checked the start and every destination against this immutable copy.
    const step = workflow.steps[id] as WorkflowStep;
    pending.push(...Object.values(step.on ?? {}));
    if (step.type === "parallel") pending.push(...(step.children ?? []));
    if (step.next) pending.push(step.next);
  }
  const ids = Object.keys(workflow.steps);
  return {
    reachableSteps: ids.filter((id) => reachable.has(id)),
    unreachableSteps: ids.filter((id) => !reachable.has(id)),
  };
}
