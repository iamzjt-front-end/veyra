import type {
  StepInputReference,
  WorkflowDefinition,
  WorkflowStep,
  WorkflowPolicy,
} from "./index.js";
import { parseWorkflow, WorkflowError } from "./parser.js";

export interface WorkflowScope {
  id: string;
  name: string;
  start: string;
  stepIds: string[];
  parent?: string;
  outputs?: Record<string, StepInputReference>;
  policy?: WorkflowPolicy;
}
export interface ExecutionGraph {
  steps: Record<string, WorkflowStep>;
  scopes: Map<string, WorkflowScope>;
  scopeOf: Map<string, string>;
  /** Protected step ID to generated human gate ID. */
  policyGates: Map<string, string>;
}

/** Namespace child graphs without changing the author-facing or persisted definitions. */
export function buildWorkflowGraph(definition: WorkflowDefinition): ExecutionGraph {
  const graph: ExecutionGraph = {
    steps: {},
    scopes: new Map(),
    scopeOf: new Map(),
    policyGates: new Map(),
  };
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
      ...(workflow.policy ? { policy: workflow.policy } : {}),
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
    const gates = new Map<string, string>();
    for (const localId of workflow.policy?.approval?.before ?? []) {
      const target = qualify(scope, localId);
      const gateId = qualify(scope, `@approval/${localId}`);
      if (Object.hasOwn(graph.steps, gateId))
        throw new WorkflowError(
          `steps.${gateId}`,
          "step ID collides with a generated policy approval gate",
        );
      gates.set(target, gateId);
      graph.policyGates.set(target, gateId);
    }
    const current = graph.scopes.get(scope) as WorkflowScope;
    current.start = gates.get(current.start) ?? current.start;
    for (const id of current.stepIds) {
      const step = graph.steps[id] as WorkflowStep;
      if (step.next) step.next = gates.get(step.next) ?? step.next;
      if (step.on)
        step.on = Object.fromEntries(
          Object.entries(step.on).map(([label, target]) => [label, gates.get(target) ?? target]),
        );
    }
    for (const [target, gateId] of gates) {
      Object.defineProperty(graph.steps, gateId, {
        value: {
          type: "human",
          message: `Workflow policy requires approval before step '${target}'.`,
          next: target,
        },
        enumerable: true,
        configurable: true,
        writable: true,
      });
      graph.scopeOf.set(gateId, scope);
      current.stepIds.push(gateId);
    }
  }
  visit(parseWorkflow(definition), "");
  return graph;
}
