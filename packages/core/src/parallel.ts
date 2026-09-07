import type {
  ExecutionMetadata,
  ParallelChildResult,
  SerializedError,
  VeyraEvent,
} from "@veyra/protocol";
import { InputResolutionError, type WorkflowStep } from "@veyra/workflow";
import { RunContext } from "./context.js";
import { ExecutionError } from "./execution-error.js";
import { executeLeaf, type LeafOptions, type LeafResult } from "./leaf.js";
import { StateStoreError } from "./state.js";

type ParallelBatch = Extract<VeyraEvent, { type: "parallel.started" }>;
export function pendingParallel(
  events: readonly VeyraEvent[],
  stepId: string,
): ParallelBatch | undefined {
  const batch = [...events]
    .reverse()
    .find((event) => event.type === "parallel.started" && event.stepId === stepId);
  if (batch?.type !== "parallel.started") return undefined;
  if (
    events.some(
      (event) =>
        event.type === "parallel.completed" &&
        event.stepId === stepId &&
        event.attemptId === batch.attemptId,
    )
  )
    return undefined;
  return batch;
}

interface ParallelOptions extends LeafOptions {
  steps: Record<string, WorkflowStep>;
  /** Live append-only ledger; record() adds each persisted event before notifying observers. */
  events: VeyraEvent[];
  batch?: ParallelBatch;
  startChild: (stepId: string) => Promise<ExecutionMetadata>;
}

/** Execute independent leaves; persist each child before producing a declaration-ordered join. */
export async function executeParallel(options: ParallelOptions): Promise<LeafResult> {
  const { step, execution, steps, events, record, context, startChild } = options;
  const created =
    options.batch ??
    (await record({
      type: "parallel.started",
      ...execution,
      children: [...(step.children ?? [])],
      concurrency: step.concurrency as number,
      failurePolicy: step.failurePolicy as "wait-all" | "fail-fast",
      at: now(),
    }));
  if (created.type !== "parallel.started" || !created.sequence || !created.attemptId)
    throw new ExecutionError(
      "invalid_parallel_state",
      "Parallel group has no valid persisted start boundary.",
    );
  const batch = created;
  if (
    JSON.stringify(batch.children) !== JSON.stringify(step.children) ||
    batch.concurrency !== step.concurrency ||
    batch.failurePolicy !== step.failurePolicy
  )
    throw new ExecutionError(
      "invalid_parallel_state",
      "Parallel boundary disagrees with the saved workflow policy.",
    );
  const states = new Map<string, ParallelChildResult>(
    batch.children.map((stepId) => [stepId, { stepId, status: "pending" }]),
  );
  for (const event of events) {
    if (
      (event.sequence ?? 0) > (batch.sequence ?? 0) &&
      event.type === "parallel.child.completed" &&
      event.parentStepId === execution.stepId &&
      states.has(event.stepId)
    )
      states.set(event.stepId, structuredClone(event.result));
  }
  const seed = new RunContext(
    Object.values(steps).flatMap((node) =>
      Object.values(node.inputs ?? {}).map((input) => input.from),
    ),
  );
  seed.restore(events.filter((event) => (event.sequence ?? 0) < (batch.sequence ?? 0)));
  const queued = batch.children.filter((id) =>
    ["pending", "needs_input"].includes(states.get(id)?.status ?? "pending"),
  );
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.controls.signal?.addEventListener("abort", abort, { once: true });
  if (options.controls.signal?.aborted) abort();
  let cursor = 0;
  let paused = false;
  let failed = false;
  let fatal: unknown;
  const finishChild = async (child: ExecutionMetadata, result: ParallelChildResult) => {
    const saved = await record({
      type: "parallel.child.completed",
      ...child,
      parentStepId: execution.stepId,
      result,
      at: now(),
    });
    if (saved.type !== "parallel.child.completed")
      throw new ExecutionError("invalid_event", "Stored parallel child event type changed.");
    states.set(child.stepId, saved.result);
    if (saved.result.status === "needs_input") paused = true;
    if (["failure", "cancelled"].includes(saved.result.status)) {
      failed = true;
      if (batch.failurePolicy === "fail-fast") abort();
    }
  };
  const worker = async () => {
    while (cursor < queued.length && !controller.signal.aborted && !paused && !fatal) {
      const childId = queued[cursor++] as string;
      let child: ExecutionMetadata = {
        runId: execution.runId,
        stepId: childId,
        parentStepId: execution.stepId,
      };
      try {
        child = await startChild(childId);
        if (controller.signal.aborted)
          throw new ExecutionError(
            "parallel_cancelled",
            "Parallel child was cancelled before invocation.",
          );
        const result = await executeLeaf({
          ...options,
          step: steps[childId] as WorkflowStep,
          execution: child,
          context: seed.fork(),
          controls: { ...options.controls, signal: controller.signal },
        });
        if (controller.signal.aborted)
          throw new ExecutionError("parallel_cancelled", "Parallel child was cancelled.");
        if (result.failureMessage)
          await record({
            type: "step.failed",
            ...child,
            message: result.failureMessage,
            at: now(),
          });
        else if (result.pauseReason === undefined)
          await record({ type: "step.completed", ...child, outcome: result.outcome, at: now() });
        const failure = result.failureMessage
          ? { code: "parallel_child_failed", message: result.failureMessage }
          : undefined;
        await finishChild(child, {
          stepId: childId,
          status:
            result.pauseReason !== undefined ? "needs_input" : failure ? "failure" : "success",
          attemptId: child.attemptId,
          attempt: child.attempt,
          outcome: result.outcome,
          ...(result.outputEvent?.eventId ? { outputEventId: result.outputEvent.eventId } : {}),
          ...(failure ? { error: failure } : {}),
        });
      } catch (error) {
        if (
          error instanceof StateStoreError ||
          (error instanceof ExecutionError && error.code === "event_sink_failed")
        ) {
          fatal ??= error;
          abort();
          return;
        }
        const detail: SerializedError = controller.signal.aborted
          ? { code: "parallel_cancelled", message: "Parallel child was cancelled." }
          : error instanceof ExecutionError || error instanceof InputResolutionError
            ? { code: error.code, message: error.message }
            : { code: "parallel_child_failed", message: "Parallel child could not complete." };
        try {
          const saved = await record({
            type: "step.failed",
            ...child,
            message: detail.message,
            error: detail,
            at: now(),
          });
          await finishChild(child, {
            stepId: childId,
            status: controller.signal.aborted ? "cancelled" : "failure",
            ...(child.attemptId ? { attemptId: child.attemptId, attempt: child.attempt } : {}),
            ...(saved.eventId ? { outputEventId: saved.eventId } : {}),
            error: detail,
          });
        } catch (recordError) {
          fatal ??= recordError;
          abort();
          return;
        }
      }
    }
  };
  try {
    const workers = await Promise.allSettled(
      Array.from({ length: Math.min(batch.concurrency, queued.length) }, worker),
    );
    for (const result of workers) if (result.status === "rejected") fatal ??= result.reason;
    if (fatal) throw fatal;
    if (controller.signal.aborted || (failed && batch.failurePolicy === "fail-fast")) {
      for (const id of queued.slice(cursor))
        await finishChild(
          { runId: execution.runId, stepId: id, parentStepId: execution.stepId },
          {
            stepId: id,
            status: "skipped",
            error: {
              code: "parallel_not_started",
              message: "Parallel child was not started after cancellation or fail-fast failure.",
            },
          },
        );
    }
  } finally {
    options.controls.signal?.removeEventListener("abort", abort);
  }
  const results = batch.children.map((id) => states.get(id) as ParallelChildResult);
  const failure =
    results.some((result) => ["failure", "cancelled", "skipped"].includes(result.status)) ||
    controller.signal.aborted;
  const needsInput =
    !failure &&
    results.some((result) => result.status === "needs_input" || result.status === "pending");
  const output = await record(
    needsInput
      ? { type: "parallel.paused", ...execution, results, at: now() }
      : { type: "parallel.completed", ...execution, success: !failure, results, at: now() },
  );
  const byId = new Map(events.map((event) => [event.eventId, event]));
  for (const result of results) {
    const childOutput = result.outputEventId ? byId.get(result.outputEventId) : undefined;
    if (childOutput) context.addEvent(childOutput);
  }
  context.addEvent(output);
  return {
    outcome: needsInput ? "needs_input" : failure ? "failure" : "success",
    outputEvent: output,
    ...(needsInput
      ? { pauseReason: "Parallel children need input; completed children are retained for resume." }
      : {}),
    ...(failure
      ? {
          failureMessage:
            "One or more parallel children failed or were cancelled; inspect the ordered child results.",
        }
      : {}),
  };
}

const now = () => new Date().toISOString();
