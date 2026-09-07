import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { VeyraConfig } from "@veyra/config";
import {
  type AgentAdapter,
  type AgentResult,
  type AgentRunOptions,
  type EventSink,
  type ExecutionMetadata,
  isJsonValue,
  type SerializedError,
  type VeyraEvent,
} from "@veyra/protocol";
import { type AgentRuntime, LocalAgentRuntime } from "@veyra/runtime";
import { ShellVerifier, type VerificationReport, type Verifier } from "@veyra/verifier";
import {
  nextRetry,
  resolveNextStep,
  withRetryDefaults,
  type WorkflowDefinition,
} from "@veyra/workflow";
import {
  pendingApproval,
  resolveApprovalDecision,
  type PendingApproval,
  type ReadRunRequest,
  type ResolveApprovalRequest,
} from "./approval.js";
import { RunControlError } from "./control-error.js";
import { RunContext } from "./context.js";
import { isStoredEvent } from "./state-events.js";
import { LocalRunStore, StateStoreError, type StoredRun } from "./state.js";

export interface RunRequest extends AgentRunOptions {
  goal: string;
  config: VeyraConfig;
  workflow: WorkflowDefinition;
  /** Keys match workflow agent references; no vendor is special to Core. */
  agents: Record<string, AgentAdapter>;
}

export interface RunResult {
  runId: string;
  status: "completed" | "failed" | "paused";
  lastStep?: string;
  error?: SerializedError;
}

export interface ResumeRequest extends AgentRunOptions {
  runId: string;
  config: VeyraConfig;
  agents: Record<string, AgentAdapter>;
  /** Caller confirms the old owner stopped; only completed scheduling boundaries are recoverable. */
  recoverInterrupted?: boolean;
}

export interface VeyraEngineOptions {
  emit?: EventSink;
  store?: LocalRunStore;
  runtime?: AgentRuntime;
  verifier?: Verifier;
  /** Known secret values, passed to a default run store; configure injected stores directly. */
  redactValues?: readonly string[];
}

class ExecutionError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export class VeyraEngine {
  readonly #options: VeyraEngineOptions;
  readonly #runtime: AgentRuntime;
  readonly #verifier: Verifier;
  readonly #approvalControls = new Map<string, Promise<unknown>>();

  constructor(options: VeyraEngineOptions = {}) {
    this.#options = { ...options, redactValues: [...(options.redactValues ?? [])] };
    this.#runtime = options.runtime ?? new LocalAgentRuntime();
    this.#verifier = options.verifier ?? new ShellVerifier();
  }

  async run(request: RunRequest): Promise<RunResult> {
    const workflow = withRetryDefaults(request.workflow, request.config.runtime.maxFixIterations);
    const cwd = resolve(request.cwd ?? process.cwd());
    const store = this.#store(request);
    const run = await store.createRun({ goal: request.goal, workflow, cwd });
    return this.#execute(request, store, run, []);
  }

  async resume(request: ResumeRequest): Promise<RunResult> {
    const store = this.#store(request);
    const run = await store.loadRun(request.runId);
    if (run.state.status === "running" && request.recoverInterrupted) {
      const history = await store.readEvents(request.runId);
      const last = history.at(-1);
      let next: string | undefined;
      if (last?.type === "run.started" && run.state.currentStep === run.input.workflow.start)
        next = run.state.currentStep;
      if (
        last?.type === "step.completed" &&
        last.outcome &&
        !["failure", "fail", "needs_input"].includes(last.outcome)
      ) {
        const step = run.input.workflow.steps[last.stepId];
        if (step && step.type !== "human") {
          const target = resolveNextStep(step, { status: last.outcome });
          if (run.state.currentStep === last.stepId || run.state.currentStep === target)
            next = target;
        }
      }
      if (!next || pendingApproval(history))
        throw new RunControlError(
          "interrupted_attempt",
          "The interrupted run has no proven completed checkpoint. Its last attempt may have changed files; inspect the workspace and events before starting new work.",
        );
      run.state = await store.updateRun(request.runId, {
        status: "paused",
        currentStep: next,
        ...(last?.type === "step.completed" && last.outcome ? { lastOutcome: last.outcome } : {}),
      });
      await store.appendEvent(request.runId, {
        type: "run.paused",
        runId: request.runId,
        stepId: next,
        reason: "recovered_completed_checkpoint",
        at: now(),
      });
    }
    if (run.state.status !== "paused")
      throw new RunControlError(
        "run_not_paused",
        "Only a paused run can resume; do not replay an interrupted running attempt blindly.",
      );
    if (
      Object.values(run.input.workflow.steps).some(
        (step) => (step.type === "agent" || step.type === "command") && step.retry === undefined,
      )
    )
      throw new RunControlError(
        "missing_retry_snapshot",
        "This run predates snapshotted retry limits; start a new run rather than silently changing its execution policy.",
      );
    const events = await store.readEvents(request.runId);
    if (pendingApproval(events))
      throw new RunControlError(
        "approval_required",
        "The current human gate requires an explicit approval decision before resume.",
      );
    if (events.at(-1)?.type !== "run.paused")
      throw new RunControlError(
        "incomplete_pause",
        "Paused state has no completed pause boundary; inspect its events before continuing.",
      );
    await store.setActiveRun(request.runId);
    return this.#execute(request, store, run, events);
  }

  async getPendingApproval(request: ReadRunRequest): Promise<PendingApproval | null> {
    const pending = pendingApproval(await this.#store(request).readEvents(request.runId));
    return pending
      ? {
          runId: pending.runId,
          stepId: pending.stepId,
          approvalId: pending.approvalId as string,
          message: pending.message,
          requestedAt: pending.at,
          ...(pending.context ? { context: structuredClone(pending.context) } : {}),
        }
      : null;
  }

  resolveApproval(request: ResolveApprovalRequest): Promise<RunResult> {
    const snapshot = { ...request };
    const store = this.#store(snapshot);
    // Serialize competing decisions in this engine; cross-process locking is a later task.
    const previous = this.#approvalControls.get(snapshot.runId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() => resolveApprovalDecision(snapshot, store, this.#options.emit));
    this.#approvalControls.set(snapshot.runId, operation);
    return operation.finally(() => {
      if (this.#approvalControls.get(snapshot.runId) === operation)
        this.#approvalControls.delete(snapshot.runId);
    });
  }

  #store(request: Pick<RunRequest, "config" | "cwd">): LocalRunStore {
    return (
      this.#options.store ??
      new LocalRunStore({
        stateDir: resolve(request.cwd ?? process.cwd(), request.config.runtime.stateDir),
        redactValues: this.#options.redactValues,
      })
    );
  }

  async #execute(
    request: Pick<RunRequest, "agents" | "signal" | "timeoutMs">,
    store: LocalRunStore,
    run: StoredRun,
    history: VeyraEvent[],
  ): Promise<RunResult> {
    const agents = Object.fromEntries(Object.entries(request.agents));
    const controls: AgentRunOptions = {
      cwd: run.input.cwd,
      signal: request.signal,
      timeoutMs: request.timeoutMs,
    };
    const runId = run.state.runId;
    // Execute the validated, redacted snapshot that a later reader will see.
    const goal = run.input.goal;
    const steps = run.input.workflow.steps;
    const context = new RunContext();
    const attempts = new Map<string, number>();
    for (const event of history) {
      context.addEvent(event);
      if (event.type === "step.started")
        attempts.set(event.stepId, (attempts.get(event.stepId) ?? 0) + 1);
    }
    let retryCounts = { ...run.state.retryCounts };
    let incomingOutcome = run.state.lastOutcome;
    let stepId: string | undefined = run.state.currentStep;
    let active: ExecutionMetadata | undefined;
    let stepSettled = false;
    let listenerFailed = false;

    const record = async (
      event: VeyraEvent,
      propagateListenerError = true,
    ): Promise<VeyraEvent> => {
      const saved = await store.appendEvent(runId, event);
      if (!listenerFailed && this.#options.emit) {
        try {
          await this.#options.emit(structuredClone(saved));
        } catch {
          listenerFailed = true;
          if (propagateListenerError)
            throw new ExecutionError(
              "event_sink_failed",
              "Event subscriber failed; execution stopped after persisting the event.",
            );
        }
      }
      return saved;
    };
    const pause = async (reason: string): Promise<RunResult> => {
      await store.updateRun(runId, { status: "paused" });
      await record({ type: "run.paused", runId, stepId, reason, at: now() });
      return { runId, status: "paused", lastStep: stepId };
    };
    const complete = async (): Promise<RunResult> => {
      await store.updateRun(runId, { status: "completed", currentStep: null });
      await record({ type: "run.completed", runId, at: now() });
      return { runId, status: "completed", lastStep: stepId };
    };

    try {
      if (history.length) {
        await store.updateRun(runId, { status: "running" });
        await record({ type: "run.resumed", runId, stepId, at: now() });
      } else {
        await record({
          type: "run.started",
          runId,
          goal,
          workflowName: run.input.workflow.name,
          at: now(),
        });
      }
      let transitions = history.filter((event) => event.type === "step.started").length;
      while (stepId) {
        if (controls.signal?.aborted)
          throw new ExecutionError("run_cancelled", "Run was cancelled.");
        // The lifetime backstop also bounds very large or misconfigured per-step limits.
        if (++transitions > 1000)
          throw new ExecutionError(
            "transition_limit",
            "Run exceeded the 1000-step execution safety limit.",
          );
        const step = steps[stepId];
        if (!step)
          throw new ExecutionError("missing_step", `Workflow step '${stepId}' is missing.`);
        if (step.type === "agent" || step.type === "command") {
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
            const gate = Object.hasOwn(step.on ?? {}, "retry_exhausted")
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
        const attempt = (attempts.get(stepId) ?? 0) + 1;
        attempts.set(stepId, attempt);
        active = { runId, stepId, attemptId: randomUUID(), attempt };
        stepSettled = false;
        await store.updateRun(runId, { status: "running", currentStep: stepId, retryCounts });
        await record({ type: "step.started", ...active, at: now() });
        const retryCount = retryCounts[stepId] ?? 0;
        if (retryCount > 0 && step.retry)
          await record({
            type: "step.retrying",
            ...active,
            retryCount,
            maxRetries: step.retry.max,
            at: now(),
          });

        if (step.type === "end") {
          await record({ type: "step.completed", ...active, at: now() });
          stepSettled = true;
          return await complete();
        }
        if (step.type === "human") {
          await record({
            type: "approval.required",
            ...active,
            message: step.message ?? "Human approval required.",
            approvalId: randomUUID(),
            context: context.input().context,
            at: now(),
          });
          return await pause("human_approval");
        }

        let outcome: string;
        let failureMessage: string | undefined;
        if (step.type === "agent") {
          const key = step.agent as string;
          const adapter = Object.hasOwn(agents, key) ? agents[key] : undefined;
          if (!adapter)
            throw new ExecutionError(
              "missing_adapter",
              `Agent '${key}' for step '${stepId}' is not registered; inject its adapter before running.`,
            );
          const metadata = {
            ...active,
            agentId: adapter.id,
            provider: adapter.provider,
            role: key,
          };
          await record({ type: "agent.started", ...metadata, at: now() });
          let result: AgentResult;
          try {
            result = await this.#runtime.runAgent(
              adapter,
              {
                ...active,
                role: key,
                goal,
                instructions: `Complete workflow step '${stepId}'. Use the relevant earlier outputs and deterministic evidence in context.steps. Preserve project instructions.`,
                ...context.input(),
              },
              { ...controls },
            );
          } catch (error) {
            const detail =
              error instanceof Error
                ? error.message.slice(0, 2048)
                : "The provider threw a non-Error value.";
            const failure = {
              code: "agent_execution_failed",
              message: `Agent '${key}' at step '${stepId}' threw: ${detail}`,
            };
            await record({ type: "agent.failed", ...metadata, error: failure, at: now() });
            throw new ExecutionError(failure.code, failure.message);
          }
          const event = { type: "agent.completed" as const, ...metadata, result, at: now() };
          if (!isStoredEvent(event) || Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024)
            throw new ExecutionError(
              "invalid_agent_result",
              `Agent '${key}' returned an invalid or oversized result; expected the serializable AgentResult contract within 1 MiB.`,
            );
          result = { ...structuredClone(result), execution: { ...active } };
          const saved = await record({ ...event, result });
          if (saved.type !== "agent.completed")
            throw new ExecutionError("invalid_event", "Stored agent event type changed.");
          result = saved.result;
          outcome = result.status === "success" ? (result.outcome ?? "success") : result.status;
          context.addEvent(saved);
          if (controls.signal?.aborted)
            throw new ExecutionError("run_cancelled", "Run was cancelled.");
          if (result.status === "needs_input") return await pause(result.summary);
          if (result.status === "failure" || outcome === "fail" || outcome === "failure")
            failureMessage = result.summary || `Agent '${key}' reported a failure.`;
        } else if (step.type === "command") {
          const commands = [...(step.run ?? [])];
          await record({
            type: "verification.started",
            ...active,
            commands: [...commands],
            at: now(),
          });
          let report: VerificationReport;
          try {
            report = await this.#verifier.verify({
              commands: [...commands],
              ...controls,
              execution: { ...active },
              maxOutputBytes: 64 * 1024,
            });
          } catch (error) {
            const detail =
              error instanceof Error
                ? error.message.slice(0, 2048)
                : "The verifier threw a non-Error value.";
            throw new ExecutionError(
              "verifier_execution_failed",
              `Verification at step '${stepId}' threw: ${detail}`,
            );
          }
          const event = {
            type: "verification.completed" as const,
            ...active,
            success: report.success,
            results: report.results,
            at: now(),
          };
          if (
            !isJsonValue(report) ||
            !isStoredEvent(event) ||
            Buffer.byteLength(JSON.stringify(event)) > 1024 * 1024 ||
            report.results.length === 0 ||
            report.results.length > commands.length ||
            report.success !== report.results.every((item) => item.success) ||
            (report.success && report.results.length !== commands.length) ||
            report.results.some((item, index) => item.command !== commands[index])
          )
            throw new ExecutionError(
              "invalid_verification_result",
              `Verifier at step '${stepId}' returned an invalid or oversized report.`,
            );
          const saved = await record({
            ...event,
            results: report.results.map((item) => ({
              ...item,
              execution: { ...active } as ExecutionMetadata,
            })),
          });
          if (saved.type !== "verification.completed")
            throw new ExecutionError("invalid_event", "Stored verification event type changed.");
          outcome = saved.success ? "success" : "failure";
          context.addEvent(saved);
          if (!saved.success)
            failureMessage = `Deterministic verification failed at step '${stepId}'.`;
        } else {
          throw new ExecutionError(
            "unsupported_step",
            `Step type '${step.type}' cannot execute in v0.1.`,
          );
        }
        if (controls.signal?.aborted)
          throw new ExecutionError("run_cancelled", "Run was cancelled.");
        await store.updateRun(runId, { lastOutcome: outcome });
        incomingOutcome = outcome;
        if (failureMessage) {
          await record({ type: "step.failed", ...active, message: failureMessage, at: now() });
        } else {
          await record({ type: "step.completed", ...active, outcome, at: now() });
        }
        stepSettled = true;
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
        if (!next) return await complete();
        await store.updateRun(runId, { currentStep: next });
        stepId = next;
        active = undefined;
      }
      return await complete();
    } catch (error) {
      // A broken store cannot truthfully claim a persisted failure; surface it to the caller.
      if (error instanceof StateStoreError) throw error;
      const failure: SerializedError =
        error instanceof ExecutionError
          ? { code: error.code, message: error.message }
          : {
              code: "run_execution_failed",
              message: `Workflow execution failed at step '${stepId ?? "start"}'.`,
            };
      await store.updateRun(runId, { status: "failed" });
      if (active && !stepSettled)
        await record(
          {
            type: "step.failed",
            ...active,
            message: failure.message,
            error: failure,
            at: now(),
          },
          false,
        );
      const saved = await record(
        {
          type: "run.failed",
          runId,
          message: failure.message,
          error: failure,
          at: now(),
        },
        false,
      );
      return {
        runId,
        status: "failed",
        lastStep: stepId,
        ...(saved.type === "run.failed" && saved.error ? { error: saved.error } : {}),
      };
    }
  }
}

function now() {
  return new Date().toISOString();
}
