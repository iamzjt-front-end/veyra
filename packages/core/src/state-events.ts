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

function reviewVote(value: unknown): value is RecordValue {
  return (
    record(value) &&
    string(value.stepId) &&
    ["pass", "fail", "error"].includes(value.verdict as string) &&
    optional(value.outputEventId, string) &&
    optional(value.attemptId, string) &&
    optional(value.attempt, integer) &&
    optional(value.error, error) &&
    (value.verdict === "error"
      ? error(value.error)
      : value.error === undefined && string(value.outputEventId))
  );
}
function verificationEvidence(value: unknown): value is RecordValue[] {
  return (
    Array.isArray(value) &&
    value.length <= 16 &&
    value.every(
      (check) =>
        record(check) &&
        string(check.stepId) &&
        boolean(check.success) &&
        optional(check.outputEventId, string) &&
        (!check.success || string(check.outputEventId)),
    ) &&
    new Set(value.map((check) => check.stepId)).size === value.length
  );
}
function reviewVotes(value: unknown): value is RecordValue[] {
  return (
    Array.isArray(value) &&
    value.length <= 32 &&
    value.every(reviewVote) &&
    new Set(value.map((review) => review.stepId)).size === value.length
  );
}
function consensusMode(value: RecordValue, count: number): boolean {
  return (
    ["all-pass", "quorum", "judge"].includes(value.mode as string) &&
    (value.mode === "quorum"
      ? integer(value.quorum) && (value.quorum as number) >= 1 && (value.quorum as number) <= count
      : value.quorum === undefined)
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
    case "consensus.started":
      return (
        Array.isArray(value.reviewers) &&
        value.reviewers.length >= 2 &&
        value.reviewers.length <= 32 &&
        value.reviewers.every(string) &&
        new Set(value.reviewers).size === value.reviewers.length &&
        consensusMode(value, value.reviewers.length) &&
        (value.mode === "judge"
          ? string(value.judge) && !value.reviewers.includes(value.judge)
          : value.judge === undefined) &&
        verificationEvidence(value.verification)
      );
    case "consensus.paused":
      return ["reviewers", "judge"].includes(value.phase as string);
    case "consensus.completed": {
      if (
        !reviewVotes(value.reviews) ||
        !consensusMode(value, value.reviews.length || 32) ||
        !verificationEvidence(value.verification) ||
        !["pass", "fail"].includes(value.outcome as string) ||
        !optional(value.judge, reviewVote) ||
        (value.mode !== "judge" && value.judge !== undefined) ||
        !optional(value.reason, string)
      )
        return false;
      if (value.outcome === "fail") return string(value.reason);
      return (
        value.reason === undefined &&
        value.reviews.length >= 2 &&
        value.reviews.every((review) => review.verdict !== "error") &&
        value.verification.every((check) => check.success) &&
        (value.mode === "all-pass"
          ? value.reviews.every((review) => review.verdict === "pass")
          : value.mode === "quorum"
            ? value.reviews.filter((review) => review.verdict === "pass").length >=
              (value.quorum as number)
            : record(value.judge) && value.judge.verdict === "pass")
      );
    }
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
      return (
        integer(value.retryCount) &&
        integer(value.maxRetries) &&
        optional(value.delayMs, (value) => integer(value) && (value as number) <= 3_600_000)
      );
    case "budget.checked":
      return (
        ["before", "after"].includes(value.phase as string) &&
        boolean(value.allowed) &&
        optional(value.reason, string)
      );
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
