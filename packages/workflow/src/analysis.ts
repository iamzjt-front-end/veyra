import type { WorkflowDefinition, WorkflowStep } from "./index.js";
import { buildWorkflowGraph } from "./graph.js";

export interface WorkflowAnalysis {
  /** Possible control-flow reachability, in definition order, without predicting agent outcomes. */
  reachableSteps: string[];
  unreachableSteps: string[];
}

/** Validate all destinations, then report unreachable nodes without rejecting intentional spares. */
export function analyzeWorkflow(definition: WorkflowDefinition): WorkflowAnalysis {
  const graph = buildWorkflowGraph(definition);
  const reachable = new Set<string>();
  const pending = [graph.scopes.get("")?.start as string];
  while (pending.length) {
    const id = pending.pop() as string;
    if (reachable.has(id)) continue;
    reachable.add(id);
    // parseWorkflow has checked the start and every destination against this immutable copy.
    const step = graph.steps[id] as WorkflowStep;
    pending.push(...Object.values(step.on ?? {}));
    if (step.type === "parallel") pending.push(...(step.children ?? []));
    if (step.type === "consensus")
      pending.push(...(step.reviewers ?? []), ...(step.judge ? [step.judge] : []));
    if (step.type === "subworkflow") pending.push(graph.scopes.get(id)?.start as string);
    if (step.next) pending.push(step.next);
  }
  const ids = Object.keys(graph.steps);
  return {
    reachableSteps: ids.filter((id) => reachable.has(id)),
    unreachableSteps: ids.filter((id) => !reachable.has(id)),
  };
}
