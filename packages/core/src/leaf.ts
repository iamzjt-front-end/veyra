import type {
  AgentAdapter,
  AgentRole,
  AgentResult,
  AgentRunOptions,
  ExecutionMetadata,
  JsonObject,
  VeyraEvent,
  ProjectInstruction,
  EvidenceReference,
} from "@veyra/protocol";
import { getAgentRoleProfile, isJsonValue } from "@veyra/protocol";
import { createDeadline, ProcessExecutionError, type AgentRuntime } from "@veyra/runtime";
import type { VerificationReport, Verifier } from "@veyra/verifier";
import type { WorkflowStep } from "@veyra/workflow";
import type { RunContext } from "./context.js";
import { ExecutionError, fatalExecutionCodes } from "./execution-error.js";
import { StateStoreError } from "./state.js";
import { isStoredEvent } from "./state-events.js";
import { selectAgent } from "./agents.js";
import { selectAgentRoute } from "./agent-routing.js";
import { promptInstructions } from "./prompt.js";

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
  redactText: (value: string) => string;
  role?: AgentRole;
  instructions?: string;
  extraContext?: JsonObject;
  projectInstructions?: ProjectInstruction[];
  evidence?: EvidenceReference[];
}

/** Shared agent/command invocation for sequential and parallel scheduling. */
export async function executeLeaf(options: LeafOptions): Promise<LeafResult> {
  const caps = [options.step.timeoutMs, options.controls.timeoutMs].filter(
    (value): value is number => value !== undefined,
  );
  const timeoutMs = caps.length ? Math.min(...caps) : undefined;
  if (timeoutMs === undefined) return executeLeafWithinDeadline(options);
  const deadline = createDeadline(timeoutMs, options.controls.signal);
  try {
    const result = await executeLeafWithinDeadline({
      ...options,
      controls: { ...options.controls, timeoutMs, signal: deadline.signal },
    });
    if (deadline.timedOut())
      throw new ExecutionError(
        "step_timeout",
        `Step '${options.execution.stepId}' exceeded its ${timeoutMs}ms deadline; cancellation was requested and its invocation settled. Inspect execution diagnostics for cleanup failures.`,
      );
    return result;
  } catch (error) {
    if (
      !(error instanceof StateStoreError) &&
      !(
        error instanceof ExecutionError &&
        fatalExecutionCodes.has(error.code) &&
        error.code !== "run_cancelled"
      ) &&
      deadline.timedOut()
    )
      throw new ExecutionError(
        "step_timeout",
        `Step '${options.execution.stepId}' exceeded its ${timeoutMs}ms deadline; cancellation was requested and its invocation settled. Inspect execution diagnostics for cleanup failures.`,
      );
    throw error;
  } finally {
    deadline.dispose();
  }
}

async function executeLeafWithinDeadline(options: LeafOptions): Promise<LeafResult> {
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
  if (controls.signal?.aborted)
    throw new ExecutionError("run_cancelled", "Run was cancelled before invocation.");
  const stepId = active.stepId;
  let outputEvent: VeyraEvent | undefined;
  let outcome: string;
  let failureMessage: string | undefined;
  if (step.type === "agent") {
    const availableAgents = step.routing ? { ...agents } : agents;
    let key = step.agent as string;
    let routedSelection: ReturnType<typeof selectAgent> | undefined;
    if (step.routing) {
      const route = await selectAgentRoute({
        primary: key,
        policy: step.routing,
        requirements: step.requires ?? {},
        agents: availableAgents,
        role: options.role,
        controls,
      });
      await record({ type: "agent.routed", ...active, decision: route.decision, at: now() });
      if (!route.decision.selected || !route.selection)
        return {
          outcome: "failure",
          failureMessage:
            "No provider was eligible under the explicit routing policy; inspect agent.routed for the blocking reason.",
        };
      key = route.decision.selected;
      routedSelection = route.selection;
    }
    const adapter = Object.hasOwn(availableAgents, key) ? availableAgents[key] : undefined;
    if (!adapter)
      throw new ExecutionError(
        "missing_adapter",
        `Agent '${key}' for step '${stepId}' is not registered; inject its adapter before running.`,
      );
    const selection = routedSelection ?? selectAgent(adapter, key, step.requires, options.role);
    const profile = getAgentRoleProfile(selection.role);
    const metadata = {
      ...active,
      agentId: adapter.id,
      provider: adapter.provider,
      role: selection.role,
    };
    if (selection.descriptor || step.requires)
      await record({
        type: "agent.selected",
        ...metadata,
        binding: key,
        requirements: selection.requirements,
        ...(selection.descriptor ? { descriptor: selection.descriptor } : {}),
        at: now(),
      });
    const resolved = context.input(step.inputs, options.evidence);
    const input = {
      ...active,
      role: selection.role,
      goal,
      ...(profile ? { profile } : {}),
      ...promptInstructions({
        stepId,
        project: options.projectInstructions,
        profile,
        workflow: step.instructions,
        group: options.instructions,
      }),
      ...resolved,
      context: { ...resolved.context, ...options.extraContext },
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
    if (controls.signal?.aborted)
      throw new ExecutionError("run_cancelled", "Run was cancelled before invoking the agent.");
    try {
      result = await runtime.runAgent(adapter, savedInput.input, { ...controls });
    } catch (error) {
      const detail =
        error instanceof Error
          ? options.redactText(error.message).slice(0, 2048)
          : "The provider threw a non-Error value.";
      const failure =
        error instanceof ProcessExecutionError && error.code === "termination_failed"
          ? { code: "process_termination_failed", message: detail }
          : controls.signal?.aborted
            ? { code: "run_cancelled", message: "Run was cancelled during agent execution." }
            : {
                code: "agent_execution_failed",
                message: `Agent '${key}' at step '${stepId}' threw: ${detail}`,
              };
      await record({
        type: "agent.failed",
        ...metadata,
        error: failure,
        inputEventId: savedInput.eventId,
        at: now(),
      });
      throw new ExecutionError(failure.code, failure.message);
    }
    const event = {
      type: "agent.completed" as const,
      ...metadata,
      result,
      inputEventId: savedInput.eventId,
      at: now(),
    };
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
      commandSource: "workflow",
      at: now(),
    });
    let report: VerificationReport;
    if (controls.signal?.aborted)
      throw new ExecutionError("run_cancelled", "Run was cancelled before invoking the verifier.");
    try {
      report = await verifier.verify({
        commands: [...commands],
        commandSource: "workflow",
        ...controls,
        execution: { ...active },
        maxOutputBytes: 64 * 1024,
      });
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.code === "termination_failed")
        throw new ExecutionError(
          "process_termination_failed",
          options.redactText(error.message).slice(0, 2048),
        );
      if (controls.signal?.aborted)
        throw new ExecutionError("run_cancelled", "Run was cancelled during verification.");
      const detail =
        error instanceof Error
          ? options.redactText(error.message).slice(0, 2048)
          : "The verifier threw a non-Error value.";
      throw new ExecutionError(
        "verifier_execution_failed",
        `Verification at step '${stepId}' threw: ${detail}`,
      );
    }
    const event = {
      type: "verification.completed" as const,
      commandSource: "workflow" as const,
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
    const cleanupError = saved.results.find(
      (result) => result.error?.code === "process_termination_failed",
    )?.error;
    if (cleanupError) throw new ExecutionError(cleanupError.code, cleanupError.message);
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
