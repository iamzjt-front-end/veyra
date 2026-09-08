import type {
  BudgetLimits,
  ExecutionMetadata,
  UsageMetadata,
  VeyraEvent,
} from "@veyraoss/protocol";
import type { ExecutionGraph } from "@veyraoss/workflow";
import { ExecutionError } from "./execution-error.js";
import type { RecordEvent } from "./leaf.js";

export interface BudgetCheck {
  phase: "before" | "after";
  execution: ExecutionMetadata;
  /** Declared ceilings for each enclosing scope; the hook owns reservation and accounting. */
  policies: { scopeId: string; limits: BudgetLimits }[];
  /** Full observations, not sums; missing usage is unknown and must never mean zero. */
  observations: { execution: ExecutionMetadata; usage?: UsageMetadata }[];
}
export type BudgetHook = (
  check: BudgetCheck,
) => { allowed: boolean; reason?: string } | Promise<{ allowed: boolean; reason?: string }>;

export async function checkBudget(
  hook: BudgetHook | undefined,
  event: Extract<VeyraEvent, { type: "agent.input" | "agent.completed" }>,
  graph: ExecutionGraph,
  events: readonly VeyraEvent[],
  record: RecordEvent,
): Promise<void> {
  const policies: BudgetCheck["policies"] = [];
  let scopeId = graph.scopeOf.get(event.stepId);
  while (scopeId !== undefined) {
    const scope = graph.scopes.get(scopeId);
    if (scope?.policy?.budget) policies.push({ scopeId, limits: scope.policy.budget });
    scopeId = scope?.parent;
  }
  if (!hook && policies.length === 0) return;
  if (!hook)
    throw new ExecutionError(
      "missing_budget_hook",
      "Workflow declares a budget; supply a budget hook before invoking agents.",
    );
  const execution = {
    runId: event.runId,
    stepId: event.stepId,
    ...(event.attemptId ? { attemptId: event.attemptId } : {}),
    ...(event.attempt !== undefined ? { attempt: event.attempt } : {}),
    ...(event.parentStepId ? { parentStepId: event.parentStepId } : {}),
  };
  const phase = event.type === "agent.input" ? "before" : "after";
  let decision: Awaited<ReturnType<BudgetHook>>;
  try {
    decision = await hook(
      structuredClone({
        phase,
        execution,
        policies,
        observations: events
          .filter((item) => item.type === "agent.completed")
          .map((item) => ({
            execution: {
              runId: item.runId,
              stepId: item.stepId,
              ...(item.attemptId ? { attemptId: item.attemptId } : {}),
              ...(item.attempt !== undefined ? { attempt: item.attempt } : {}),
            },
            ...(item.result.usage ? { usage: item.result.usage } : {}),
          })),
      }),
    );
    if (
      !decision ||
      typeof decision.allowed !== "boolean" ||
      (decision.reason !== undefined &&
        (typeof decision.reason !== "string" || Buffer.byteLength(decision.reason) > 4096))
    )
      throw new Error("Invalid budget decision");
  } catch {
    throw new ExecutionError(
      "budget_hook_failed",
      "Budget hook failed or returned an invalid decision; execution stopped.",
    );
  }
  await record({
    type: "budget.checked",
    ...execution,
    phase,
    allowed: decision.allowed,
    ...(decision.reason !== undefined ? { reason: decision.reason } : {}),
    at: new Date().toISOString(),
  });
  if (!decision.allowed)
    throw new ExecutionError(
      "budget_exceeded",
      "Execution budget was denied; inspect the persisted budget decision.",
    );
}
