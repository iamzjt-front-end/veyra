import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type {
  AgentAdapter,
  AgentRunOptions,
  EventSink,
  ExecutionMetadata,
  JsonObject,
  SerializedError,
  VeyraEvent,
} from "@veyra/protocol";
import type { AgentRuntime } from "@veyra/runtime";
import type { Verifier } from "@veyra/verifier";
import {
  buildWorkflowGraph,
  InputResolutionError,
  nextRetry,
  retryDelay,
  resolveNextStep,
  RouterError,
  type WorkflowStep,
} from "@veyra/workflow";
import { RunContext } from "./context.js";
import type { RunResult } from "./engine.js";
import { ExecutionError, fatalExecutionCodes } from "./execution-error.js";
import { checkBudget, type BudgetHook } from "./budget.js";
import { executeLeaf, type LeafResult } from "./leaf.js";
import { executeParallel, pendingParallel } from "./parallel.js";
import { executeConsensus, pendingConsensus } from "./consensus.js";
import { executeRouter } from "./router.js";
import { StateStoreError, type LocalRunStore, type StoredRun } from "./state.js";

type SubworkflowStart = Extract<VeyraEvent, { type: "subworkflow.started" }>;
type ScopeResult =
  | { status: "success"; lastStep?: string; outputs: JsonObject }
  | { status: "failure"; lastStep?: string; error: SerializedError; fatal?: boolean }
  | { status: "paused"; lastStep: string; reason: string };

interface ExecuteRunOptions {
  run: StoredRun;
  store: LocalRunStore;
  history: VeyraEvent[];
  agents: Record<string, AgentAdapter>;
  controls: AgentRunOptions;
  runtime: AgentRuntime;
  verifier: Verifier;
  emit?: EventSink;
  budget?: BudgetHook;
}

/** Coordinate one persisted run with isolated, resumable scopes for nested workflows. */
export async function executeRun(options: ExecuteRunOptions): Promise<RunResult> {
  const { run, store, history, runtime, verifier, emit } = options;
  const agents = Object.fromEntries(Object.entries(options.agents));
  const controls = { ...options.controls, cwd: run.input.cwd };
  const runId = run.state.runId;
  const graph = buildWorkflowGraph(run.input.workflow);
  const steps = graph.steps;
  const eventLog = [...history];
  const attempts = new Map<string, number>();
  for (const event of history)
    if (event.type === "step.started")
      attempts.set(event.stepId, (attempts.get(event.stepId) ?? 0) + 1);
  let retryCounts = { ...run.state.retryCounts };
  const ancestors = (scopeId: string): string[] => {
    const ids: string[] = [];
    let id: string | undefined = scopeId;
    while (id !== undefined) {
      ids.push(id);
      id = graph.scopes.get(id)?.parent;
    }
    return ids;
  };
  const starts = new Map<string, number>();
  for (const event of history)
    if (event.type === "step.started")
      for (const id of ancestors(graph.scopeOf.get(event.stepId) ?? ""))
        starts.set(id, (starts.get(id) ?? 0) + 1);
  let listenerFailed = false;
  const record = async (event: VeyraEvent, propagateListenerError = true): Promise<VeyraEvent> => {
    const saved = await store.appendEvent(runId, event);
    eventLog.push(saved);
    if (!listenerFailed && emit) {
      try {
        await emit(structuredClone(saved));
      } catch {
        listenerFailed = true;
        if (propagateListenerError)
          throw new ExecutionError(
            "event_sink_failed",
            "Event subscriber failed; execution stopped after persisting the event.",
          );
      }
    }
    if (saved.type === "agent.input" || saved.type === "agent.completed")
      await checkBudget(options.budget, saved, graph, eventLog, record);
    return saved;
  };
  const tick = (scopeId: string) => {
    for (const id of ancestors(scopeId)) {
      const limit = graph.scopes.get(id)?.policy?.maxSteps ?? (id === "" ? 1000 : undefined);
      if (limit !== undefined && (starts.get(id) ?? 0) >= limit)
        throw new ExecutionError(
          "transition_limit",
          `Workflow scope '${id || "root"}' exceeded its ${limit}-step execution safety limit.`,
        );
    }
    for (const id of ancestors(scopeId)) starts.set(id, (starts.get(id) ?? 0) + 1);
  };
  const backoff = async (
    step: WorkflowStep,
    retryCount: number,
    active: ExecutionMetadata,
    signal = controls.signal,
  ) => {
    if (retryCount < 1 || !step.retry) return;
    const delayMs = retryDelay(step, retryCount);
    await record({
      type: "step.retrying",
      ...active,
      retryCount,
      maxRetries: step.retry.max,
      ...(delayMs ? { delayMs } : {}),
      at: now(),
    });
    if (delayMs) {
      try {
        await delay(delayMs, undefined, { signal });
      } catch {
        throw new ExecutionError("run_cancelled", "Run was cancelled during retry backoff.");
      }
    }
  };
  const resumeAt = (scope: string): string => {
    const current = run.state.currentStep as string;
    let owner = graph.scopeOf.get(current);
    if (owner === scope) return current;
    while (owner) {
      if (graph.scopes.get(owner)?.parent === scope) return owner;
      owner = graph.scopes.get(owner)?.parent;
    }
    throw new ExecutionError(
      "invalid_subworkflow_state",
      "Saved current step does not belong to the pending workflow scope.",
    );
  };

  const executeScope = async (
    scopeId: string,
    boundary?: SubworkflowStart,
    resuming = false,
  ): Promise<ScopeResult> => {
    const scope = graph.scopes.get(scopeId);
    if (!scope)
      throw new ExecutionError("invalid_subworkflow_state", "Saved workflow scope is missing.");
    let stepId: string | undefined = resuming ? resumeAt(scopeId) : scope.start;
    let incomingOutcome = resuming ? run.state.lastOutcome : undefined;
    let active: ExecutionMetadata | undefined;
    let stepSettled = false;
    const references = [
      ...scope.stepIds.flatMap((id) => {
        const step = steps[id] as WorkflowStep;
        return [
          ...Object.values(step.inputs ?? {}),
          ...(step.route && typeof step.route !== "string" ? [step.route] : []),
        ];
      }),
      ...Object.values(scope.outputs ?? {}),
    ];
    const contextBefore = (sequence = Number.POSITIVE_INFINITY) => {
      const context = new RunContext(
        references.map((input) => input.from),
        boundary?.inputs,
      );
      context.restore(
        eventLog.filter(
          (event) =>
            "stepId" in event &&
            event.stepId &&
            graph.scopeOf.get(event.stepId) === scopeId &&
            (event.sequence ?? 0) > (boundary?.sequence ?? 0) &&
            (event.sequence ?? 0) < sequence,
        ),
      );
      return context;
    };
    const context = contextBefore();
    const success = (): ScopeResult => ({
      status: "success",
      lastStep: stepId,
      outputs: scope.outputs ? (context.input(scope.outputs).context.inputs as JsonObject) : {},
    });
    try {
      // A resolved terminal child gate or proven completed child checkpoint closes its scope.
      if (scopeId && resuming && graph.scopeOf.get(run.state.currentStep as string) === scopeId) {
        const completed = [...history]
          .reverse()
          .find(
            (event) =>
              (event.type === "step.started" ||
                event.type === "step.completed" ||
                event.type === "step.failed") &&
              event.stepId === stepId,
          );
        const step = steps[stepId as string];
        if (
          completed?.type === "step.completed" &&
          step?.type === "human" &&
          completed.outcome === "rejected" &&
          !Object.hasOwn(step.on ?? {}, "rejected")
        )
          throw new ExecutionError(
            "approval_rejected",
            "The child workflow approval was rejected without a rejection branch.",
          );
        if (
          completed?.type === "step.completed" &&
          step &&
          !resolveNextStep(step, { status: completed.outcome ?? "success" })
        ) {
          if (Object.keys(step.on ?? {}).length > 0)
            throw new ExecutionError(
              step.type === "human" ? "unhandled_approval" : "unhandled_outcome",
              "The completed child step has no matching continuation.",
            );
          return success();
        }
      }
      while (stepId) {
        if (controls.signal?.aborted)
          throw new ExecutionError("run_cancelled", "Run was cancelled.");
        const step: WorkflowStep | undefined = steps[stepId];
        if (!step || graph.scopeOf.get(stepId) !== scopeId)
          throw new ExecutionError(
            "missing_step",
            `Workflow step '${stepId}' is missing from its scope.`,
          );
        const batch = step.type === "parallel" ? pendingParallel(eventLog, stepId) : undefined;
        const sub = step.type === "subworkflow" ? pendingSubworkflow(eventLog, stepId) : undefined;
        const consensus =
          step.type === "consensus" ? pendingConsensus(eventLog, stepId) : undefined;
        const pending = batch ?? sub ?? consensus;
        if (
          !pending &&
          ["agent", "command", "parallel", "router", "subworkflow", "consensus"].includes(step.type)
        ) {
          const decision = nextRetry(
            step,
            Object.hasOwn(retryCounts, stepId) ? retryCounts[stepId] : undefined,
            incomingOutcome,
          );
          if (!decision.allowed) {
            const message = `Retry budget exhausted at step '${stepId}': ${decision.retryCount} of ${decision.maxRetries} repairs used.`;
            active = { runId, stepId };
            stepSettled = false;
            await store.updateRun(runId, { currentStep: stepId, lastOutcome: "retry_exhausted" });
            const gate: string | undefined = Object.hasOwn(step.on ?? {}, "retry_exhausted")
              ? resolveNextStep(step, { status: "retry_exhausted" })
              : undefined;
            if (gate && steps[gate]?.type === "human") {
              await record({
                type: "step.failed",
                ...active,
                message,
                error: { code: "retry_exhausted", message },
                at: now(),
              });
              await store.updateRun(runId, { currentStep: gate });
              stepId = gate;
              active = undefined;
              incomingOutcome = "retry_exhausted";
              continue;
            }
            throw new ExecutionError("retry_exhausted", message);
          }
          retryCounts = { ...retryCounts, [stepId]: decision.retryCount };
        }
        if (!pending) tick(scopeId);
        const attempt = pending?.attempt ?? (attempts.get(stepId) ?? 0) + 1;
        if (!pending) attempts.set(stepId, attempt);
        active = { runId, stepId, attemptId: pending?.attemptId ?? randomUUID(), attempt };
        stepSettled = false;
        await store.updateRun(runId, { status: "running", currentStep: stepId, retryCounts });
        if (!pending) await record({ type: "step.started", ...active, at: now() });
        const retryCount = retryCounts[stepId] ?? 0;
        if (!pending) await backoff(step, retryCount, active);
        if (controls.signal?.aborted)
          throw new ExecutionError("run_cancelled", "Run was cancelled before step execution.");
        if (step.type === "end") {
          await record({ type: "step.completed", ...active, at: now() });
          stepSettled = true;
          return success();
        }
        if (step.type === "human") {
          const protectedId = [...graph.policyGates].find(([, gate]) => gate === stepId)?.[0];
          const protectedStep = protectedId ? graph.steps[protectedId] : undefined;
          const operation =
            protectedId && protectedStep
              ? {
                  stepId: protectedId,
                  type: protectedStep.type,
                  ...(protectedStep.type === "command" ? { commandSource: "workflow" } : {}),
                  ...operationPreview(protectedStep),
                }
              : undefined;
          await record({
            type: "approval.required",
            ...active,
            message: step.message ?? "Human approval required.",
            approvalId: randomUUID(),
            context: { ...context.input(step.inputs).context, ...(operation ? { operation } : {}) },
            at: now(),
          });
          return { status: "paused", lastStep: stepId, reason: "human_approval" };
        }
        const leafOptions = {
          step,
          execution: active,
          agents,
          goal: run.input.goal,
          context,
          controls,
          record,
          runtime,
          verifier,
          redactText: (value: string) => store.redactText(value),
        };
        let leaf: LeafResult;
        if (step.type === "subworkflow") {
          const childScope = graph.scopes.get(stepId);
          if (!childScope)
            throw new ExecutionError(
              "invalid_subworkflow_state",
              "Resolved child workflow is missing.",
            );
          const started =
            sub ??
            (await record({
              type: "subworkflow.started",
              ...active,
              workflowName: childScope.name,
              childStepId: childScope.start,
              inputs: step.inputs ? (context.input(step.inputs).context.inputs as JsonObject) : {},
              at: now(),
            }));
          if (
            started.type !== "subworkflow.started" ||
            !started.attemptId ||
            !started.sequence ||
            started.childStepId !== childScope.start ||
            started.workflowName !== childScope.name
          )
            throw new ExecutionError(
              "invalid_subworkflow_state",
              "Persisted subworkflow boundary disagrees with its snapshot.",
            );
          const child = await executeScope(stepId, started, Boolean(sub));
          if (child.status === "paused") {
            await record({
              type: "subworkflow.paused",
              ...active,
              childStepId: child.lastStep,
              reason: child.reason,
              at: now(),
            });
            return child;
          }
          if (child.status === "failure" && child.fatal)
            throw new ExecutionError(child.error.code, child.error.message);
          await store.updateRun(runId, { currentStep: stepId });
          const saved = await record({
            type: "subworkflow.completed",
            ...active,
            success: child.status === "success",
            ...(child.status === "success" ? { outputs: child.outputs } : { error: child.error }),
            at: now(),
          });
          context.addEvent(saved);
          leaf = {
            outcome: child.status === "success" ? "success" : "failure",
            outputEvent: saved,
            ...(child.status === "failure"
              ? { failureMessage: `Subworkflow '${stepId}' failed: ${child.error.message}` }
              : {}),
          };
        } else if (step.type === "parallel" || step.type === "consensus") {
          leaf = await (step.type === "parallel" ? executeParallel : executeConsensus)({
            ...leafOptions,
            steps,
            events: eventLog,
            batch,
            consensus,
            scopeSequence: boundary?.sequence,
            contextBefore,
            startChild: async (childId, signal) => {
              const child = steps[childId];
              if (!child)
                throw new ExecutionError("missing_step", "Parallel child step is missing.");
              const decision = nextRetry(
                child,
                Object.hasOwn(retryCounts, childId) ? retryCounts[childId] : undefined,
                incomingOutcome,
              );
              if (!decision.allowed)
                throw new ExecutionError(
                  "retry_exhausted",
                  `Retry budget exhausted at parallel child '${childId}': ${decision.retryCount} of ${decision.maxRetries} repairs used.`,
                );
              tick(scopeId);
              retryCounts = { ...retryCounts, [childId]: decision.retryCount };
              const childAttempt = (attempts.get(childId) ?? 0) + 1;
              attempts.set(childId, childAttempt);
              const execution = {
                runId,
                stepId: childId,
                parentStepId: stepId as string,
                attemptId: randomUUID(),
                attempt: childAttempt,
              };
              await store.updateRun(runId, { retryCounts });
              await record({ type: "step.started", ...execution, at: now() });
              await backoff(child, decision.retryCount, execution, signal);
              return execution;
            },
          });
        } else
          leaf =
            step.type === "router"
              ? await executeRouter(leafOptions)
              : await executeLeaf(leafOptions);
        if (leaf.pauseReason !== undefined)
          return { status: "paused", lastStep: stepId, reason: leaf.pauseReason };
        if (controls.signal?.aborted)
          throw new ExecutionError("run_cancelled", "Run was cancelled.");
        const { outcome, failureMessage } = leaf;
        await store.updateRun(runId, { lastOutcome: outcome });
        incomingOutcome = outcome;
        if (failureMessage)
          await record({ type: "step.failed", ...active, message: failureMessage, at: now() });
        else await record({ type: "step.completed", ...active, outcome, at: now() });
        stepSettled = true;
        if (
          failureMessage &&
          ancestors(scopeId).some((id) => graph.scopes.get(id)?.policy?.failureStrategy === "stop")
        )
          throw new ExecutionError(
            "failure_policy_stop",
            `Workflow failure policy stopped at step '${stepId}'.`,
          );
        if (failureMessage && !Object.hasOwn(step.on ?? {}, outcome))
          throw new ExecutionError(
            "unhandled_step_failure",
            `${failureMessage} No explicit '${outcome}' transition is configured.`,
          );
        const next = resolveNextStep(step, { status: outcome });
        if (!next && Object.keys(step.on ?? {}).length > 0)
          throw new ExecutionError(
            "unhandled_outcome",
            `Step '${stepId}' has no transition for outcome '${outcome}'.`,
          );
        if (!next) return success();
        await store.updateRun(runId, { currentStep: next });
        stepId = next;
        active = undefined;
      }
      return success();
    } catch (error) {
      if (error instanceof StateStoreError) throw error;
      const failure = normalizeError(error, stepId);
      if (active && !stepSettled)
        await record(
          { type: "step.failed", ...active, message: failure.message, error: failure, at: now() },
          false,
        );
      return {
        status: "failure",
        lastStep: stepId,
        error: failure,
        fatal:
          fatalExecutionCodes.has(failure.code) ||
          ancestors(scopeId).some((id) => graph.scopes.get(id)?.policy?.failureStrategy === "stop"),
      };
    }
  };

  let result: ScopeResult;
  try {
    if (history.length) {
      await store.updateRun(runId, { status: "running" });
      await record({ type: "run.resumed", runId, stepId: run.state.currentStep, at: now() });
    } else
      await record({
        type: "run.started",
        runId,
        goal: run.input.goal,
        workflowName: run.input.workflow.name,
        ...(run.input.workspace ? { workspace: run.input.workspace } : {}),
        at: now(),
      });
    result = await executeScope("", undefined, history.length > 0);
    if (result.status !== "failure" && controls.signal?.aborted)
      result = {
        status: "failure",
        lastStep: result.lastStep,
        error: { code: "run_cancelled", message: "Run was cancelled before its final boundary." },
      };
    if (result.status === "paused") {
      await store.updateRun(runId, { status: "paused" });
      await record({
        type: "run.paused",
        runId,
        stepId: result.lastStep,
        reason: result.reason,
        at: now(),
      });
      return { runId, status: "paused", lastStep: result.lastStep };
    }
    if (result.status === "success") {
      await store.updateRun(runId, { status: "completed", currentStep: null });
      await record({ type: "run.completed", runId, at: now() });
      return { runId, status: "completed", lastStep: result.lastStep };
    }
  } catch (error) {
    if (error instanceof StateStoreError) throw error;
    result = {
      status: "failure",
      lastStep: run.state.currentStep,
      error: normalizeError(error, run.state.currentStep),
    };
  }
  await store.updateRun(runId, { status: "failed", error: result.error });
  const saved = await record(
    { type: "run.failed", runId, message: result.error.message, error: result.error, at: now() },
    false,
  );
  return {
    runId,
    status: "failed",
    lastStep: result.lastStep,
    ...(saved.type === "run.failed" && saved.error ? { error: saved.error } : {}),
  };
}

function operationPreview(step: WorkflowStep): { preview: string; truncated: boolean } {
  const text = JSON.stringify(
    step.type === "command"
      ? { run: step.run }
      : {
          type: step.type,
          ...(step.agent ? { agent: step.agent } : {}),
          ...(step.requires ? { requires: step.requires } : {}),
          ...(step.routing ? { routing: step.routing } : {}),
          ...(step.instructions ? { instructions: step.instructions } : {}),
          ...(step.children ? { children: step.children } : {}),
          ...(step.reviewers ? { reviewers: step.reviewers } : {}),
          ...(step.judge ? { judge: step.judge } : {}),
        },
  );
  return { preview: text.slice(0, 8192), truncated: text.length > 8192 };
}

function normalizeError(error: unknown, stepId?: string): SerializedError {
  return error instanceof ExecutionError ||
    error instanceof InputResolutionError ||
    error instanceof RouterError
    ? { code: error.code, message: error.message }
    : {
        code: "run_execution_failed",
        message: `Workflow execution failed at step '${stepId ?? "start"}'.`,
      };
}

function pendingSubworkflow(
  events: readonly VeyraEvent[],
  stepId: string,
): SubworkflowStart | undefined {
  const start = [...events]
    .reverse()
    .find((event) => event.type === "subworkflow.started" && event.stepId === stepId);
  if (start?.type !== "subworkflow.started") return undefined;
  return events.some(
    (event) =>
      event.type === "subworkflow.completed" &&
      event.stepId === stepId &&
      event.attemptId === start.attemptId,
  )
    ? undefined
    : start;
}
const now = () => new Date().toISOString();
