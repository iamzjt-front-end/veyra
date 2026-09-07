import { resolve } from "node:path";
import type { VeyraConfig } from "@veyra/config";
import type {
  AgentAdapter,
  AgentRunOptions,
  EventSink,
  SerializedError,
  VeyraEvent,
} from "@veyra/protocol";
import { type AgentRuntime, LocalAgentRuntime } from "@veyra/runtime";
import { ShellVerifier, type Verifier } from "@veyra/verifier";
import {
  buildWorkflowGraph,
  resolveNextStep,
  withExecutionDefaults,
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
import { executeRun } from "./execution.js";
import type { BudgetHook } from "./budget.js";
import { LocalRunStore, type StoredRun } from "./state.js";

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
  budget?: BudgetHook;
  /** Known secret values, passed to a default run store; configure injected stores directly. */
  redactValues?: readonly string[];
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
    const workflow = withExecutionDefaults(
      request.workflow,
      request.config.runtime.maxFixIterations,
    );
    buildWorkflowGraph(workflow);
    const cwd = resolve(request.cwd ?? process.cwd());
    const store = this.#store(request);
    const run = await store.createRun({ goal: request.goal, workflow, cwd });
    return this.#execute(request, store, run, []);
  }

  async resume(request: ResumeRequest): Promise<RunResult> {
    const store = this.#store(request);
    const run = await store.loadRun(request.runId);
    const graph = buildWorkflowGraph(run.input.workflow);
    if (run.state.status === "running" && request.recoverInterrupted) {
      const history = await store.readEvents(request.runId);
      const last = history.at(-1);
      let next: string | undefined;
      if (last?.type === "run.started" && run.state.currentStep === graph.scopes.get("")?.start)
        next = run.state.currentStep;
      if (
        last?.type === "step.completed" &&
        (!last.outcome || !["failure", "fail", "needs_input"].includes(last.outcome))
      ) {
        const step = graph.steps[last.stepId];
        if (step && step.type !== "human") {
          const target =
            resolveNextStep(step, { status: last.outcome ?? "success" }) ??
            (graph.scopeOf.get(last.stepId) ? last.stepId : undefined);
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
      Object.values(graph.steps).some(
        (step) =>
          (step.type === "agent" ||
            step.type === "command" ||
            step.type === "parallel" ||
            step.type === "consensus" ||
            step.type === "router" ||
            step.type === "subworkflow") &&
          step.retry === undefined,
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
    const protectedStep = run.state.currentStep as string;
    const policyGate = graph.policyGates.get(protectedStep);
    if (policyGate && graph.steps[protectedStep]?.type === "agent") {
      const lastResult = [...events]
        .reverse()
        .find((event) => event.type === "agent.completed" && event.stepId === protectedStep);
      const lastApproval = [...events]
        .reverse()
        .find((event) => event.type === "approval.resolved" && event.stepId === policyGate);
      if (
        lastResult?.type === "agent.completed" &&
        lastResult.result.status === "needs_input" &&
        (lastResult.sequence ?? 0) > (lastApproval?.sequence ?? 0)
      )
        run.state = await store.updateRun(request.runId, { currentStep: policyGate });
    }
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
    return executeRun({
      run,
      store,
      history,
      agents: request.agents,
      controls: { signal: request.signal, timeoutMs: request.timeoutMs },
      runtime: this.#runtime,
      verifier: this.#verifier,
      emit: this.#options.emit,
      budget: this.#options.budget,
    });
  }
}

function now() {
  return new Date().toISOString();
}
