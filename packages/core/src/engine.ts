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
  type JsonValue,
  type SerializedError,
  type VeyraEvent,
} from "@veyra/protocol";
import { type AgentRuntime, LocalAgentRuntime } from "@veyra/runtime";
import { ShellVerifier, type VerificationReport, type Verifier } from "@veyra/verifier";
import { parseWorkflow, resolveNextStep, type WorkflowDefinition } from "@veyra/workflow";
import { RunContext } from "./context.js";
import { isStoredEvent } from "./state-events.js";
import { LocalRunStore, StateStoreError } from "./state.js";

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

  constructor(options: VeyraEngineOptions = {}) {
    this.#options = { ...options, redactValues: [...(options.redactValues ?? [])] };
    this.#runtime = options.runtime ?? new LocalAgentRuntime();
    this.#verifier = options.verifier ?? new ShellVerifier();
  }

  async run(request: RunRequest): Promise<RunResult> {
    const workflow = parseWorkflow(request.workflow);
    const cwd = resolve(request.cwd ?? process.cwd());
    const agents = Object.fromEntries(Object.entries(request.agents));
    const controls: AgentRunOptions = { cwd, signal: request.signal, timeoutMs: request.timeoutMs };
    const store =
      this.#options.store ??
      new LocalRunStore({
        stateDir: resolve(cwd, request.config.runtime.stateDir),
        redactValues: this.#options.redactValues,
      });
    const run = await store.createRun({ goal: request.goal, workflow, cwd });
    const runId = run.state.runId;
    // Execute the validated, redacted snapshot that a later reader will see.
    const goal = run.input.goal;
    const steps = run.input.workflow.steps;
    const context = new RunContext();
    const attempts = new Map<string, number>();
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
      await record({
        type: "run.started",
        runId,
        goal,
        workflowName: run.input.workflow.name,
        at: now(),
      });
      let transitions = 0;
      while (stepId) {
        if (controls.signal?.aborted)
          throw new ExecutionError("run_cancelled", "Run was cancelled.");
        // A final backstop only; workflow-specific repair limits are the next TODO.
        if (++transitions > 1000)
          throw new ExecutionError(
            "transition_limit",
            "Run exceeded the 1000-step execution safety limit.",
          );
        const step = steps[stepId];
        if (!step)
          throw new ExecutionError("missing_step", `Workflow step '${stepId}' is missing.`);
        const attempt = (attempts.get(stepId) ?? 0) + 1;
        attempts.set(stepId, attempt);
        active = { runId, stepId, attemptId: randomUUID(), attempt };
        stepSettled = false;
        await store.updateRun(runId, { status: "running", currentStep: stepId });
        await record({ type: "step.started", ...active, at: now() });

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
          context.add(
            stepId,
            {
              type: "agent",
              outcome,
              summary: result.summary,
              ...(result.data ? { data: result.data } : {}),
            },
            result.artifacts,
          );
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
          context.add(
            stepId,
            { type: "command", outcome, results: saved.results as unknown as JsonValue[] },
            saved.results.flatMap((item) => item.artifacts ?? []),
          );
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
