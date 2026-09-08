import type { VeyraConfig } from "@veyra/config";
import type {
  ApprovalDecision,
  EventSink,
  ExecutionMetadata,
  JsonObject,
  VeyraEvent,
} from "@veyra/protocol";
import { resolveNextStep, buildWorkflowGraph } from "@veyra/workflow";
import { RunControlError } from "./control-error.js";
import type { RunResult } from "./engine.js";
import type { LocalRunStore } from "./state.js";

export interface ReadRunRequest {
  runId: string;
  config: VeyraConfig;
  cwd?: string;
}

export interface ResolveApprovalRequest extends ReadRunRequest {
  recoverInterrupted?: boolean;
  approvalId: string;
  decision: ApprovalDecision;
  comment?: string;
}

export interface PendingApproval {
  runId: string;
  stepId: string;
  approvalId: string;
  message: string;
  requestedAt: string;
  context?: JsonObject;
}

export async function resolveApprovalDecision(
  request: ResolveApprovalRequest,
  store: LocalRunStore,
  emit?: EventSink,
): Promise<RunResult> {
  if (
    (request.decision !== "approved" && request.decision !== "rejected") ||
    typeof request.approvalId !== "string" ||
    !request.approvalId ||
    (request.comment !== undefined &&
      (typeof request.comment !== "string" || Buffer.byteLength(request.comment) > 8192))
  )
    throw new RunControlError(
      "invalid_approval",
      "Supply an approval ID, approved/rejected decision, and an optional comment of at most 8 KiB.",
    );
  const run = await store.loadRun(request.runId);
  if (run.state.status !== "paused")
    throw new RunControlError("run_not_paused", "Approval resolution requires a paused run.");
  const events = await store.readEvents(request.runId);
  const pending = pendingApproval(events);
  if (
    !pending ||
    pending.stepId !== run.state.currentStep ||
    pending.approvalId !== request.approvalId
  )
    throw new RunControlError(
      "approval_not_pending",
      "That approval ID is not the pending gate for this run; refresh its current approval.",
    );
  if (events.at(-1)?.type !== "run.paused")
    throw new RunControlError(
      "incomplete_pause",
      "Approval requires a completed pause boundary; inspect the run events before continuing.",
    );
  const graph = buildWorkflowGraph(run.input.workflow);
  const step = graph.steps[pending.stepId];
  if (step?.type !== "human")
    throw new RunControlError(
      "invalid_approval_step",
      "The pending approval does not match a human workflow step.",
    );
  const hasRejection = Object.hasOwn(step.on ?? {}, "rejected");
  const next =
    request.decision === "rejected" && !hasRejection
      ? undefined
      : resolveNextStep(step, { status: request.decision });
  const failure =
    !next && (request.decision === "rejected" || Object.keys(step.on ?? {}).length > 0)
      ? {
          code: request.decision === "rejected" ? "approval_rejected" : "unhandled_approval",
          message:
            request.decision === "rejected"
              ? "Human approval was rejected; no rejection branch is configured."
              : "The human gate has no approved transition.",
        }
      : undefined;
  const nestedTerminal = Boolean(graph.scopeOf.get(pending.stepId)) && !next;
  const status = nestedTerminal ? "paused" : failure ? "failed" : next ? "paused" : "completed";
  const execution: ExecutionMetadata = {
    runId: request.runId,
    stepId: pending.stepId,
    ...(pending.attemptId ? { attemptId: pending.attemptId } : {}),
    ...(pending.attempt !== undefined ? { attempt: pending.attempt } : {}),
  };
  const saved: VeyraEvent[] = [];
  saved.push(
    await store.appendEvent(request.runId, {
      type: "approval.resolved",
      ...execution,
      approvalId: request.approvalId,
      decision: request.decision,
      ...(request.comment !== undefined ? { comment: request.comment } : {}),
      at: now(),
    }),
  );
  saved.push(
    await store.appendEvent(request.runId, {
      type: "step.completed",
      ...execution,
      outcome: request.decision,
      at: now(),
    }),
  );
  await store.updateRun(request.runId, {
    status,
    ...(failure && status === "failed" ? { error: failure } : {}),
    // Generated gates must not turn an incoming repair into a free initial execution.
    ...(![...graph.policyGates.values()].includes(pending.stepId) || request.decision === "rejected"
      ? { lastOutcome: request.decision }
      : {}),
    ...(next ? { currentStep: next } : status === "completed" ? { currentStep: null } : {}),
  });
  saved.push(
    await store.appendEvent(
      request.runId,
      failure && !nestedTerminal
        ? {
            type: "run.failed",
            runId: request.runId,
            message: failure.message,
            error: failure,
            at: now(),
          }
        : next || nestedTerminal
          ? {
              type: "run.paused",
              runId: request.runId,
              stepId: next ?? pending.stepId,
              reason: "approval_resolved",
              at: now(),
            }
          : { type: "run.completed", runId: request.runId, at: now() },
    ),
  );
  // No provider executes here. Publish only after the decision and new boundary are durable.
  try {
    for (const event of saved) await emit?.(structuredClone(event));
  } catch {
    throw new RunControlError(
      "approval_recorded_notification_failed",
      "The approval decision and run state were saved, but event delivery failed; refresh state before resuming.",
    );
  }
  return {
    runId: request.runId,
    status,
    lastStep: pending.stepId,
    ...(failure ? { error: failure } : {}),
  };
}

export function pendingApproval(
  events: readonly VeyraEvent[],
): Extract<VeyraEvent, { type: "approval.required" }> | undefined {
  let pending: Extract<VeyraEvent, { type: "approval.required" }> | undefined;
  for (const event of events) {
    if (event.type === "approval.required") {
      if (pending || !event.approvalId)
        throw new RunControlError(
          "invalid_approval_history",
          "Approval history is incomplete or predates approval IDs; inspect it before continuing.",
        );
      pending = event;
    } else if (event.type === "approval.resolved") {
      if (!pending || pending.approvalId !== event.approvalId || pending.stepId !== event.stepId)
        throw new RunControlError(
          "invalid_approval_history",
          "Approval resolution does not match its pending gate; inspect the event history.",
        );
      pending = undefined;
    }
  }
  return pending;
}

function now() {
  return new Date().toISOString();
}
