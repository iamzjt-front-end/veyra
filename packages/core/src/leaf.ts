import type {
  AgentAdapter,
  AgentResult,
  AgentRunOptions,
  ExecutionMetadata,
  VeyraEvent,
} from "@veyra/protocol";
import { isJsonValue } from "@veyra/protocol";
import type { AgentRuntime } from "@veyra/runtime";
import type { VerificationReport, Verifier } from "@veyra/verifier";
import type { WorkflowStep } from "@veyra/workflow";
import type { RunContext } from "./context.js";
import { ExecutionError } from "./execution-error.js";
import { isStoredEvent } from "./state-events.js";

export type RecordEvent = (
  event: VeyraEvent,
  propagateListenerError?: boolean,
) => Promise<VeyraEvent>;
export interface LeafResult {
  outcome: string;
  failureMessage?: string;
  pauseReason?: string;
  outputEvent?: VeyraEvent;
}
export interface LeafOptions {
  step: WorkflowStep;
  execution: ExecutionMetadata;
  agents: Record<string, AgentAdapter>;
  goal: string;
  context: RunContext;
  controls: AgentRunOptions;
  record: RecordEvent;
  runtime: AgentRuntime;
  verifier: Verifier;
}

/** Shared agent/command invocation for sequential and parallel scheduling. */
export async function executeLeaf(options: LeafOptions): Promise<LeafResult> {
  const {
    step,
    execution: active,
    agents,
    goal,
    context,
    controls,
    record,
    runtime,
    verifier,
  } = options;
  const stepId = active.stepId;
  let outputEvent: VeyraEvent | undefined;
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
    const input = {
      ...active,
      role: key,
      goal,
      instructions: `Complete workflow step '${stepId}'. Use the relevant earlier outputs and deterministic evidence in context.steps, explicitly selected values in context.inputs, and any subworkflow parameters in context.workflowInputs. Preserve project instructions.`,
      ...context.input(step.inputs),
    };
    if (Buffer.byteLength(JSON.stringify(input)) > 256 * 1024)
      throw new ExecutionError(
        "input_too_large",
        "Resolved agent input exceeds 256 KiB; reduce the goal/context or use artifact references.",
      );
    const savedInput = await record({ type: "agent.input", ...metadata, input, at: now() });
    if (savedInput.type !== "agent.input")
      throw new ExecutionError("invalid_event", "Stored agent input event type changed.");
    if (Buffer.byteLength(JSON.stringify(savedInput.input)) > 256 * 1024)
      throw new ExecutionError(
        "input_too_large",
        "Redacted agent input exceeds 256 KiB; reduce the goal/context or use artifact references.",
      );
    await record({ type: "agent.started", ...metadata, at: now() });
    let result: AgentResult;
    try {
      result = await runtime.runAgent(adapter, savedInput.input, { ...controls });
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
    outputEvent = saved;
    if (controls.signal?.aborted) throw new ExecutionError("run_cancelled", "Run was cancelled.");
    if (result.status === "needs_input")
      return { outcome, pauseReason: result.summary, outputEvent: saved };
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
      report = await verifier.verify({
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
    outputEvent = saved;
    if (!saved.success) failureMessage = `Deterministic verification failed at step '${stepId}'.`;
  } else {
    throw new ExecutionError(
      "unsupported_step",
      `Step type '${step.type}' cannot execute in v0.1.`,
    );
  }
  return {
    outcome,
    ...(failureMessage ? { failureMessage } : {}),
    ...(outputEvent ? { outputEvent } : {}),
  };
}

const now = () => new Date().toISOString();
