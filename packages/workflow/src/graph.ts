import type { StepInputReference, WorkflowDefinition, WorkflowStep } from "./index.js";
import { parseWorkflow, WorkflowError } from "./parser.js";

export interface WorkflowScope {
  id: string;
  name: string;
  start: string;
  stepIds: string[];
  parent?: string;
  outputs?: Record<string, StepInputReference>;
}
export interface ExecutionGraph {
  steps: Record<string, WorkflowStep>;
  scopes: Map<string, WorkflowScope>;
  scopeOf: Map<string, string>;
}

/** Namespace child graphs without changing the author-facing or persisted definitions. */
export function buildWorkflowGraph(definition: WorkflowDefinition): ExecutionGraph {
  const graph: ExecutionGraph = { steps: {}, scopes: new Map(), scopeOf: new Map() };
  const qualify = (scope: string, id: string) =>
    scope ? `${scope}/${id.replace(/~/g, "~0").replace(/\//g, "~1")}` : id;
  const references = (refs: Record<string, StepInputReference>, scope: string) =>
    Object.fromEntries(
      Object.entries(refs).map(([name, ref]) => [name, { ...ref, from: qualify(scope, ref.from) }]),
    );
  function visit(
    workflow: WorkflowDefinition,
    scope: string,
    parent?: string,
    outputs?: Record<string, StepInputReference>,
  ) {
    graph.scopes.set(scope, {
      id: scope,
      name: workflow.name,
      start: qualify(scope, workflow.start),
      stepIds: [],
      ...(parent !== undefined ? { parent } : {}),
      ...(outputs ? { outputs } : {}),
    });
    for (const [localId, step] of Object.entries(workflow.steps)) {
      const id = qualify(scope, localId);
      if (Object.hasOwn(graph.steps, id))
        throw new WorkflowError(
          `steps.${id}`,
          "step ID collides with a namespaced subworkflow step",
        );
      const compiled: WorkflowStep = {
        ...step,
        ...(step.next ? { next: qualify(scope, step.next) } : {}),
        ...(step.on
          ? {
              on: Object.fromEntries(
                Object.entries(step.on).map(([label, target]) => [label, qualify(scope, target)]),
              ),
            }
          : {}),
        ...(step.children ? { children: step.children.map((child) => qualify(scope, child)) } : {}),
        ...(step.reviewers
          ? { reviewers: step.reviewers.map((child) => qualify(scope, child)) }
          : {}),
        ...(step.judge ? { judge: qualify(scope, step.judge) } : {}),
        ...(step.verification
          ? { verification: step.verification.map((child) => qualify(scope, child)) }
          : {}),
        ...(step.inputs ? { inputs: references(step.inputs, scope) } : {}),
        ...(step.outputs ? { outputs: references(step.outputs, id) } : {}),
        ...(step.route && typeof step.route !== "string"
          ? { route: { ...step.route, from: qualify(scope, step.route.from) } }
          : {}),
      };
      Object.defineProperty(graph.steps, id, {
        value: compiled,
        enumerable: true,
        configurable: true,
        writable: true,
      });
      graph.scopeOf.set(id, scope);
      graph.scopes.get(scope)?.stepIds.push(id);
      if (step.type === "subworkflow") {
        if (!step.workflow)
          throw new WorkflowError(
            `steps.${id}.workflow`,
            "unresolved subworkflow; use loadWorkflow to resolve references before execution",
          );
        visit(step.workflow, id, scope, compiled.outputs);
      }
    }
  }
  visit(parseWorkflow(definition), "");
  return graph;
}
