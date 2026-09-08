import type { RecoveryBoundary, VeyraEvent } from "@veyraoss/protocol";
import { inspectProcessOwner, type ProcessLiveness } from "@veyraoss/runtime";
import { buildWorkflowGraph, resolveNextStep } from "@veyraoss/workflow";
import { pendingApproval } from "./approval.js";
import { RunControlError } from "./control-error.js";
import type { RunStatus, StoredRun } from "./state.js";

export interface RunCheckpoint {
  boundary: RecoveryBoundary;
  stepId?: string;
  attemptId?: string;
  attempt?: number;
  outcome?: string;
  nextStep?: string;
  terminal: boolean;
}

export interface RunInspection {
  runId: string;
  storedStatus: RunStatus;
  /** A point-in-time observation; unknown never grants permission to recover. */
  status: RunStatus | "interrupted" | "unknown";
  ownerStatus: ProcessLiveness;
  recovery: { allowed: boolean; reason: string; checkpoint?: RunCheckpoint };
}

export function inspectRun(run: StoredRun, history: readonly VeyraEvent[]): RunInspection {
  const ownerStatus = inspectProcessOwner(run.state.owner);
  const running = run.state.status === "running";
  const checkpoint = running ? completedCheckpoint(run, history) : undefined;
  const status = !running
    ? run.state.status
    : ownerStatus === "dead"
      ? "interrupted"
      : ownerStatus === "alive"
        ? "running"
        : "unknown";
  return {
    runId: run.state.runId,
    storedStatus: run.state.status,
    status,
    ownerStatus,
    recovery: {
      allowed: running && ownerStatus === "dead" && checkpoint !== undefined,
      reason: !running
        ? "Run is paused or terminal; interrupted recovery is not applicable."
        : ownerStatus === "alive"
          ? "The recorded local owner PID is still present; recovery is refused."
          : ownerStatus === "unknown"
            ? "Owner liveness cannot be proven (legacy metadata, another host, or a denied probe); recovery is refused."
            : checkpoint
              ? "A completed boundary can be reconciled after confirming the prior owner and its child processes stopped."
              : "No safe completed boundary exists. The attempt may have changed files or external systems; inspect its effects before starting new work.",
      ...(checkpoint ? { checkpoint } : {}),
    },
  };
}

export function requireRecovery(run: StoredRun, history: readonly VeyraEvent[]): RunCheckpoint {
  const inspection = inspectRun(run, history);
  if (inspection.ownerStatus === "alive")
    throw new RunControlError("run_still_running", inspection.recovery.reason);
  if (inspection.ownerStatus === "unknown")
    throw new RunControlError("owner_unknown", inspection.recovery.reason);
  if (!inspection.recovery.allowed || !inspection.recovery.checkpoint)
    throw new RunControlError("interrupted_attempt", inspection.recovery.reason);
  return inspection.recovery.checkpoint;
}

/** Evidence only: never infer successful effects from an agent result or a stale PID. */
function completedCheckpoint(
  run: StoredRun,
  history: readonly VeyraEvent[],
): RunCheckpoint | undefined {
  if (pendingApproval(history)) return;
  const graph = buildWorkflowGraph(run.input.workflow);
  let events = history;
  const tail = history.at(-1);
  const reconciled =
    (tail?.type === "run.paused" || tail?.type === "run.completed") && tail.recovery
      ? tail
      : undefined;
  if (reconciled) {
    const previous = history.at(-2);
    if (
      previous?.eventId !== reconciled.recovery?.eventId ||
      previous?.sequence !== reconciled.recovery?.sequence
    )
      return;
    events = history.slice(0, -1);
  }
  const last = events.at(-1);
  if (!last?.eventId || !last.sequence) return;
  const boundary = { eventId: last.eventId, sequence: last.sequence };
  let checkpoint: RunCheckpoint | undefined;
  if (
    events.length === 1 &&
    last.type === "run.started" &&
    run.state.currentStep === graph.scopes.get("")?.start &&
    Object.keys(run.state.retryCounts).length === 0
  )
    checkpoint = { boundary, nextStep: run.state.currentStep, terminal: false };
  if (
    last.type === "step.completed" &&
    last.attemptId &&
    last.attempt &&
    !last.parentStepId &&
    (!last.outcome || !["failure", "fail", "needs_input"].includes(last.outcome))
  ) {
    const starts = events.filter(
      (event) => event.type === "step.started" && event.attemptId === last.attemptId,
    );
    const started = starts[0];
    if (
      starts.length !== 1 ||
      started?.type !== "step.started" ||
      started.stepId !== last.stepId ||
      started.attempt !== last.attempt ||
      started.parentStepId !== last.parentStepId
    )
      return;
    const step = graph.steps[last.stepId];
    if (!step || step.type === "human") return;
    // Other unfinished leaves can still have effects. Only enclosing subworkflow
    // scopes may remain open at a completed child scheduling boundary.
    const open = new Map<string, string>();
    for (const event of events) {
      if (event.type === "run.started" || event.type === "run.resumed") open.clear();
      if (event.type === "step.started") {
        if (!event.attemptId) return;
        open.set(event.attemptId, event.stepId);
      } else if (
        (event.type === "step.completed" || event.type === "step.failed") &&
        event.attemptId
      )
        open.delete(event.attemptId);
    }
    const enclosing = new Set<string>();
    let scope = graph.scopeOf.get(last.stepId);
    while (scope) {
      enclosing.add(scope);
      scope = graph.scopes.get(scope)?.parent;
    }
    if ([...open.values()].some((id) => !enclosing.has(id))) return;
    const target = resolveNextStep(step, { status: last.outcome ?? "success" });
    if (!target && Object.keys(step.on ?? {}).length > 0 && !graph.scopeOf.get(last.stepId)) return;
    const next = target ?? (graph.scopeOf.get(last.stepId) ? last.stepId : undefined);
    if (run.state.currentStep !== last.stepId && run.state.currentStep !== next) return;
    checkpoint = {
      boundary,
      stepId: last.stepId,
      attemptId: last.attemptId,
      attempt: last.attempt,
      ...(last.outcome ? { outcome: last.outcome } : {}),
      ...(next ? { nextStep: next } : {}),
      terminal: next === undefined,
    };
  }
  if (reconciled && checkpoint) {
    if (
      checkpoint.terminal
        ? reconciled.type !== "run.completed"
        : reconciled.type !== "run.paused" ||
          reconciled.stepId !== checkpoint.nextStep ||
          reconciled.reason !== "recovered_completed_checkpoint"
    )
      return;
  }
  return checkpoint;
}
