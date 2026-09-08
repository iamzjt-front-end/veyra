import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { VeyraConfig } from "@veyraoss/config";
import type {
  AgentAdapter,
  AgentRunOptions,
  EventSink,
  SerializedError,
  VeyraEvent,
} from "@veyraoss/protocol";
import {
  type AgentRuntime,
  currentProcessOwner,
  LocalAgentRuntime,
  LocalWorkspaceManager,
  readProjectInstructions,
} from "@veyraoss/runtime";
import { ShellVerifier, type Verifier } from "@veyraoss/verifier";
import {
  buildWorkflowGraph,
  withExecutionDefaults,
  type WorkflowDefinition,
} from "@veyraoss/workflow";
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
import { inspectRun, requireRecovery, type RunInspection } from "./recovery.js";

export interface RunRequest extends AgentRunOptions {
  /** Optional caller-correlated UUID; existing IDs are never overwritten or replayed. */
  runId?: string;
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
  /** Caller confirms the old owner and its children stopped; requires a proven completed boundary. */
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
    if (
      request.runId !== undefined &&
      (typeof request.runId !== "string" ||
        !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(request.runId))
    )
      throw new RunControlError("invalid_input", "Caller runId must be a UUID.");
    if (typeof request.goal !== "string" || !request.goal.trim())
      throw new RunControlError("invalid_input", "The run goal must be a non-empty string.");
    const workflow = withExecutionDefaults(
      request.workflow,
      request.config.runtime.maxFixIterations,
    );
    buildWorkflowGraph(workflow);
    const cwd = resolve(request.cwd ?? process.cwd());
    const store = this.#store(request);
    const runId = request.runId ?? randomUUID();
    return store.withRunLock(runId, async () => {
      if (request.runId !== undefined) {
        try {
          await store.loadRun(runId);
          throw new RunControlError("run_exists", "Run ID already exists; refusing replay.");
        } catch (error) {
          if (!(error instanceof Error) || !("code" in error) || error.code !== "not_found")
            throw error;
        }
      }
      const workspace = await new LocalWorkspaceManager(store.directory).prepare(
        runId,
        cwd,
        request.config.runtime.workspace,
      );
      try {
        const run = await store.createRun(
          {
            goal: request.goal,
            workflow,
            cwd: workspace.info.cwd,
            workspace: workspace.info,
            projectInstructions: await readProjectInstructions(workspace.info.cwd),
          },
          runId,
        );
        return await this.#execute(request, store, run, []);
      } finally {
        await workspace.release();
      }
    });
  }

  async resume(request: ResumeRequest): Promise<RunResult> {
    const store = this.#store(request);
    const saved = await store.loadRun(request.runId);
    const history = await store.readEvents(request.runId);
    if (
      saved.state.status !== "paused" &&
      !(saved.state.status === "running" && request.recoverInterrupted)
    )
      throw new RunControlError(
        "run_not_paused",
        "Only a paused run can resume; do not replay an interrupted running attempt blindly.",
      );
    if (saved.state.status === "running" && request.recoverInterrupted)
      requireRecovery(saved, history);
    return store.withRunLock(
      request.runId,
      async () => {
        const current = await store.loadRun(request.runId);
        const currentEvents = await store.readEvents(request.runId);
        if (
          current.state.revision !== saved.state.revision ||
          currentEvents.at(-1)?.eventId !== history.at(-1)?.eventId
        )
          throw new RunControlError(
            "stale_resume",
            "This run changed while resume was acquiring ownership; inspect its new boundary before retrying.",
          );
        const manager = new LocalWorkspaceManager(store.directory);
        const workspace = saved.input.workspace
          ? await manager.resume(request.runId, saved.input.workspace, request.recoverInterrupted)
          : await manager.prepare(request.runId, saved.input.cwd);
        try {
          return await this.#resumeLocked(request, store);
        } finally {
          await workspace.release();
        }
      },
      request.recoverInterrupted,
    );
  }

  async #resumeLocked(request: ResumeRequest, store: LocalRunStore): Promise<RunResult> {
    // Reload after acquiring workspace ownership; another invocation may have finished first.
    const run = await store.loadRun(request.runId);
    const graph = buildWorkflowGraph(run.input.workflow);
    if (run.state.status === "running" && request.recoverInterrupted) {
      const history = await store.readEvents(request.runId);
      const checkpoint = requireRecovery(run, history);
      const tail = history.at(-1);
      // Record the decision before replacing state. An interruption between these
      // writes can reconcile the same boundary without invoking any work twice.
      if (!((tail?.type === "run.paused" || tail?.type === "run.completed") && tail.recovery))
        await store.appendEvent(
          request.runId,
          checkpoint.terminal
            ? {
                type: "run.completed",
                runId: request.runId,
                recovery: checkpoint.boundary,
                at: now(),
              }
            : {
                type: "run.paused",
                runId: request.runId,
                stepId: checkpoint.nextStep,
                reason: "recovered_completed_checkpoint",
                recovery: checkpoint.boundary,
                at: now(),
              },
        );
      run.state = await store.updateRun(request.runId, {
        status: checkpoint.terminal ? "completed" : "paused",
        currentStep: checkpoint.nextStep ?? null,
        ...(checkpoint.outcome ? { lastOutcome: checkpoint.outcome } : {}),
      });
      if (checkpoint.terminal)
        return {
          runId: request.runId,
          status: "completed",
          ...(checkpoint.stepId ? { lastStep: checkpoint.stepId } : {}),
        };
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

  async removeWorkspace(
    request: ReadRunRequest & { recoverInterrupted?: boolean },
  ): Promise<{ runId: string; cwd: string; removed: true }> {
    const store = this.#store(request);
    await store.loadRun(request.runId);
    return store.withRunLock(
      request.runId,
      async () => {
        const run = await store.loadRun(request.runId);
        if (!["completed", "failed"].includes(run.state.status))
          throw new RunControlError(
            "workspace_run_active",
            "Only completed or failed runs may have their worktree removed; paused runs keep their workspace for resume.",
          );
        if (run.input.workspace?.mode !== "worktree")
          throw new RunControlError(
            "shared_workspace",
            "This run has no isolated worktree to remove.",
          );
        await new LocalWorkspaceManager(store.directory).remove(
          request.runId,
          run.input.workspace,
          request.recoverInterrupted,
        );
        await store.appendEvent(request.runId, {
          type: "workspace.removed",
          runId: request.runId,
          workspace: run.input.workspace,
          at: now(),
        });
        return { runId: request.runId, cwd: run.input.cwd, removed: true };
      },
      request.recoverInterrupted,
    );
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

  async inspectRun(request: ReadRunRequest): Promise<RunInspection> {
    const store = this.#store(request);
    const run = await store.loadRun(request.runId);
    return inspectRun(run, await store.readEvents(request.runId));
  }

  resolveApproval(request: ResolveApprovalRequest): Promise<RunResult> {
    const snapshot = { ...request };
    const store = this.#store(snapshot);
    // Preserve local decision ordering; the run lease also excludes other processes.
    const previous = this.#approvalControls.get(snapshot.runId) ?? Promise.resolve();
    const operation = previous
      .catch(() => undefined)
      .then(() =>
        store.withRunLock(
          snapshot.runId,
          () => resolveApprovalDecision(snapshot, store, this.#options.emit),
          snapshot.recoverInterrupted,
        ),
      );
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
    run.state = await store.updateRun(run.state.runId, { owner: currentProcessOwner() });
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
