import type { VeyraConfig } from "@veyra/config";
import {
  analyzeWorkflow,
  buildWorkflowGraph,
  listBuiltinWorkflows,
  loadWorkflow,
} from "@veyra/workflow";
import { agentDiagnostics, requiredAgents } from "./providers.js";

/** Read-only surface descriptions; the Workflow package owns loading and graph semantics. */
export async function listWorkflows() {
  return {
    type: "workflow.list" as const,
    workflows: await Promise.all(
      listBuiltinWorkflows().map(async (reference) => {
        const workflow = await loadWorkflow(reference);
        return {
          reference,
          name: workflow.name,
          version: workflow.version,
          requiredAgents: requiredAgents(workflow),
        };
      }),
    ),
  };
}

export async function validateWorkflow(
  reference: string,
  cwd: string,
  config?: VeyraConfig,
  customFactory = false,
) {
  const definition = await loadWorkflow(reference, cwd);
  const graph = buildWorkflowGraph(definition);
  const analysis = analyzeWorkflow(definition);
  const diagnostics = config ? agentDiagnostics(config, definition, customFactory) : [];
  return {
    type: "workflow.validation" as const,
    valid: diagnostics.length === 0,
    workflow: {
      reference,
      name: definition.name,
      version: definition.version,
      start: graph.scopes.get("")?.start,
      stepCount: Object.keys(graph.steps).length,
      requiredAgents: requiredAgents(definition),
    },
    configurationChecked: config !== undefined,
    diagnostics,
    warnings: analysis.unreachableSteps.map((stepId) => ({
      code: "unreachable_step",
      stepId,
      message: `Step '${stepId}' is unreachable from the workflow start.`,
    })),
  };
}
