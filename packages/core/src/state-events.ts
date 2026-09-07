import { isJsonValue, type VeyraEvent } from "@veyra/protocol";

type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const string = (value: unknown) => typeof value === "string";
const boolean = (value: unknown) => typeof value === "boolean";
const number = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;
const integer = (value: unknown) => number(value) && Number.isSafeInteger(value);
const timestamp = (value: unknown) =>
  typeof value === "string" &&
  /^\d{4}-\d\d-\d\dT/.test(value) &&
  Number.isFinite(Date.parse(value));
const optional = (value: unknown, predicate: (value: unknown) => boolean) =>
  value === undefined || predicate(value);
const array = (value: unknown, predicate: (value: unknown) => boolean) =>
  Array.isArray(value) && value.every(predicate);

function execution(value: RecordValue) {
  return (
    string(value.runId) &&
    string(value.stepId) &&
    optional(value.attemptId, string) &&
    optional(value.parentStepId, string) &&
    optional(value.attempt, integer)
  );
}

function timing(value: unknown): boolean {
  return (
    record(value) &&
    timestamp(value.startedAt) &&
    optional(value.completedAt, timestamp) &&
    optional(value.durationMs, number)
  );
}

function usage(value: unknown): boolean {
  return (
    record(value) &&
    ["inputTokens", "outputTokens", "totalTokens", "cachedInputTokens", "reasoningTokens"].every(
      (key) => optional(value[key], integer),
    ) &&
    optional(value.cost, (cost) => record(cost) && number(cost.amount) && string(cost.currency))
  );
}

function error(value: unknown): boolean {
  return (
    record(value) &&
    string(value.code) &&
    string(value.message) &&
    optional(value.retryable, boolean) &&
    optional(value.details, record)
  );
}

function artifact(value: unknown): boolean {
  return (
    record(value) &&
    string(value.id) &&
    string(value.kind) &&
    ["path", "mediaType"].every((key) => optional(value[key], string)) &&
    optional(value.sizeBytes, integer) &&
    optional(value.createdAt, timestamp) &&
    optional(value.producer, (producer) => record(producer) && execution(producer)) &&
    optional(value.metadata, record)
  );
}

function agentResult(value: unknown): boolean {
  return (
    record(value) &&
    string(value.status) &&
    ["success", "failure", "needs_input"].includes(value.status) &&
    string(value.summary) &&
    optional(value.outcome, string) &&
    optional(value.artifacts, (items) => array(items, artifact)) &&
    optional(value.data, record) &&
    optional(value.execution, (item) => record(item) && execution(item)) &&
    optional(value.timing, timing) &&
    optional(value.usage, usage) &&
    optional(value.error, error)
  );
}

function agentInput(value: unknown, event: RecordValue): boolean {
  return (
    record(value) &&
    execution(value) &&
    value.runId === event.runId &&
    value.stepId === event.stepId &&
    value.attemptId === event.attemptId &&
    value.attempt === event.attempt &&
    value.parentStepId === event.parentStepId &&
    string(value.role) &&
    string(value.goal) &&
    optional(value.instructions, string) &&
    optional(value.context, record) &&
    optional(value.artifacts, (items) => array(items, artifact)) &&
    Object.keys(value).every((key) =>
      [
        "runId",
        "stepId",
        "attemptId",
        "attempt",
        "parentStepId",
        "role",
        "goal",
        "instructions",
        "context",
        "artifacts",
      ].includes(key),
    )
  );
}

function verification(value: unknown): boolean {
  return (
    record(value) &&
    boolean(value.success) &&
    string(value.command) &&
    (value.exitCode === null ||
      (typeof value.exitCode === "number" && Number.isInteger(value.exitCode))) &&
    string(value.stdout) &&
    string(value.stderr) &&
    number(value.durationMs) &&
    optional(value.stdoutTruncated, boolean) &&
    optional(value.stderrTruncated, boolean) &&
    optional(value.signal, string) &&
    optional(value.error, error) &&
    optional(value.artifacts, (items) => array(items, artifact)) &&
    optional(value.execution, (item) => record(item) && execution(item))
  );
}

function parallelChild(value: unknown): boolean {
  return (
    record(value) &&
    string(value.stepId) &&
    string(value.status) &&
    ["pending", "success", "failure", "needs_input", "cancelled", "skipped"].includes(
      value.status,
    ) &&
    optional(value.attemptId, string) &&
    optional(value.attempt, integer) &&
    optional(value.outcome, string) &&
    optional(value.outputEventId, string) &&
    optional(value.error, error)
  );
}

function parallelResults(value: unknown): value is RecordValue[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 32 &&
    value.every(parallelChild) &&
    new Set(value.map((row) => row.stepId)).size === value.length
  );
}

/** Validate persisted event payloads before returning the public union to consumers. */
export function isStoredEvent(value: unknown): value is VeyraEvent {
  if (
    !isJsonValue(value) ||
    !record(value) ||
    !string(value.runId) ||
    !timestamp(value.at) ||
    !optional(value.eventId, string) ||
    !optional(value.sequence, integer)
  )
    return false;
  switch (value.type) {
    case "run.started":
      return string(value.goal) && optional(value.workflowName, string);
    case "run.completed":
      return optional(value.timing, timing) && optional(value.usage, usage);
    case "run.failed":
      return string(value.message) && optional(value.error, error);
    case "run.paused":
      return optional(value.stepId, string) && optional(value.reason, string);
    case "run.resumed":
      return optional(value.stepId, string);
  }
  if (!execution(value)) return false;
  switch (value.type) {
    case "step.started":
      return true;
    case "subworkflow.started":
      return string(value.workflowName) && string(value.childStepId) && record(value.inputs);
    case "subworkflow.completed":
      return (
        boolean(value.success) &&
        optional(value.outputs, record) &&
        optional(value.error, error) &&
        (value.success ? record(value.outputs) && value.error === undefined : error(value.error))
      );
    case "subworkflow.paused":
      return string(value.childStepId) && string(value.reason);
    case "router.selected":
      return (
        typeof value.route === "string" &&
        value.route.trim().length > 0 &&
        [...value.route].length <= 128 &&
        typeof value.target === "string" &&
        value.target.trim().length > 0 &&
        ["static", "input"].includes(value.selection as string) &&
        (value.selection === "static"
          ? value.source === undefined
          : record(value.source) && string(value.source.stepId) && string(value.source.path))
      );
    case "parallel.started":
      return (
        array(value.children, string) &&
        (value.children as unknown[]).length > 0 &&
        (value.children as unknown[]).length <= 32 &&
        new Set(value.children as unknown[]).size === (value.children as unknown[]).length &&
        integer(value.concurrency) &&
        (value.concurrency as number) >= 1 &&
        (value.concurrency as number) <= 32 &&
        ["wait-all", "fail-fast"].includes(value.failurePolicy as string)
      );
    case "parallel.child.completed":
      return (
        string(value.parentStepId) &&
        parallelChild(value.result) &&
        record(value.result) &&
        value.result.stepId === value.stepId &&
        value.result.status !== "pending" &&
        value.result.attemptId === value.attemptId &&
        value.result.attempt === value.attempt
      );
    case "parallel.completed":
      return (
        boolean(value.success) &&
        parallelResults(value.results) &&
        value.success === value.results.every((result) => result.status === "success") &&
        (value.success ||
          value.results.some((result) =>
            ["failure", "cancelled", "skipped"].includes(result.status as string),
          ))
      );
    case "parallel.paused":
      return (
        parallelResults(value.results) &&
        value.results.every((result) =>
          ["success", "needs_input", "pending"].includes(result.status as string),
        ) &&
        value.results.some(
          (result) => result.status === "needs_input" || result.status === "pending",
        )
      );
    case "step.retrying":
      return integer(value.retryCount) && integer(value.maxRetries);
    case "step.completed":
      return (
        optional(value.outcome, string) &&
        optional(value.artifacts, (items) => array(items, artifact))
      );
    case "step.failed":
      return string(value.message) && optional(value.error, error);
    case "agent.started":
    case "agent.input":
    case "agent.completed":
    case "agent.failed":
      return (
        string(value.agentId) &&
        optional(value.provider, string) &&
        optional(value.role, string) &&
        (value.type === "agent.started" ||
          (value.type === "agent.input"
            ? agentInput(value.input, value)
            : value.type === "agent.completed"
              ? agentResult(value.result)
              : error(value.error)))
      );
    case "verification.started":
      return array(value.commands, string);
    case "verification.completed":
      return boolean(value.success) && array(value.results, verification);
    case "approval.required":
      return (
        string(value.message) &&
        optional(value.approvalId, string) &&
        optional(value.context, record)
      );
    case "approval.resolved":
      return (
        string(value.decision) &&
        ["approved", "rejected"].includes(value.decision) &&
        optional(value.approvalId, string) &&
        optional(value.comment, string)
      );
    case "process.output":
      return (
        string(value.stream) &&
        ["stdout", "stderr"].includes(value.stream) &&
        artifact(value.artifact) &&
        optional(value.preview, string)
      );
    default:
      return false;
  }
}
