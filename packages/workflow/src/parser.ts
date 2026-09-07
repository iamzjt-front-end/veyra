import type { WorkflowDefinition, WorkflowStep } from "./index.js";

export class WorkflowError extends Error {
  constructor(
    readonly field: string,
    readonly detail: string,
    readonly filePath?: string,
  ) {
    super(`${filePath ?? "workflow"}: ${field}: ${detail}`);
    this.name = "WorkflowError";
  }
}

function object(value: unknown, field: string, keys?: readonly string[]): Record<string, unknown> {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null)
  ) {
    throw new WorkflowError(field, "must be an object");
  }
  for (const key of Object.keys(value)) {
    if (keys && !keys.includes(key))
      throw new WorkflowError(`${field}.${key}`, "unknown field for this node");
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new WorkflowError(field, "must be a non-empty string");
  return value;
}

function json(value: unknown, field: string, parents = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (value === null || typeof value !== "object")
    throw new WorkflowError(field, "must be JSON-compatible");
  if (parents.has(value)) throw new WorkflowError(field, "must not contain cycles");
  parents.add(value);
  try {
    return Array.isArray(value)
      ? value.map((item, i) => json(item, `${field}[${i}]`, parents))
      : Object.fromEntries(
          Object.entries(object(value, field)).map(([key, item]) => [
            key,
            json(item, `${field}.${key}`, parents),
          ]),
        );
  } finally {
    parents.delete(value);
  }
}

function parseStep(value: unknown, field: string): WorkflowStep {
  const raw = object(value, field);
  const type = text(raw.type, `${field}.type`);
  if (["parallel", "router", "subworkflow"].includes(type)) {
    throw new WorkflowError(`${field}.type`, `${type} is reserved and unsupported in v0.1`);
  }
  if (type !== "agent" && type !== "command" && type !== "human" && type !== "end") {
    throw new WorkflowError(`${field}.type`, "expected agent, command, human, or end");
  }
  const common = ["type", "metadata", "next", "on", "retry"];
  const keys =
    type === "end"
      ? ["type", "metadata"]
      : [...common, type === "agent" ? "agent" : type === "command" ? "run" : "message"];
  object(raw, field, keys);
  const step: WorkflowStep = { type };
  if (type === "agent") step.agent = text(raw.agent, `${field}.agent`);
  if (type === "command") {
    if (!Array.isArray(raw.run) || raw.run.length === 0)
      throw new WorkflowError(`${field}.run`, "must be a non-empty array of commands");
    step.run = raw.run.map((command, i) => text(command, `${field}.run[${i}]`));
  }
  if (raw.message !== undefined) step.message = text(raw.message, `${field}.message`);
  if (raw.next !== undefined) step.next = text(raw.next, `${field}.next`);
  if (raw.on !== undefined) {
    step.on = Object.fromEntries(
      Object.entries(object(raw.on, `${field}.on`)).map(([outcome, target]) => [
        text(outcome, `${field}.on outcome`),
        text(target, `${field}.on.${outcome}`),
      ]),
    );
  }
  if (raw.retry !== undefined) {
    const retry = object(raw.retry, `${field}.retry`, ["max"]);
    if (typeof retry.max !== "number" || !Number.isSafeInteger(retry.max) || retry.max < 0) {
      throw new WorkflowError(`${field}.retry.max`, "must be a non-negative safe integer");
    }
    step.retry = { max: retry.max };
  }
  if (raw.metadata !== undefined) {
    step.metadata = json(object(raw.metadata, `${field}.metadata`), `${field}.metadata`) as Record<
      string,
      unknown
    >;
  }
  return step;
}

/** Parse provider-neutral graph data; no YAML, process, or agent execution occurs here. */
export function parseWorkflow(value: unknown): WorkflowDefinition {
  const root = object(value, "root", ["name", "version", "start", "steps"]);
  const name = text(root.name, "name");
  if (root.version !== 1) throw new WorkflowError("version", "expected schema version 1");
  const start = text(root.start, "start");
  const steps = Object.fromEntries(
    Object.entries(object(root.steps, "steps")).map(([id, value]): [string, WorkflowStep] => [
      text(id, "steps key"),
      parseStep(value, `steps.${id}`),
    ]),
  );
  if (!Object.hasOwn(steps, start))
    throw new WorkflowError("start", `step '${start}' does not exist`);
  for (const [id, step] of Object.entries(steps)) {
    const targets = Object.entries(step.on ?? {}).map(([outcome, target]): [string, string] => [
      `steps.${id}.on.${outcome}`,
      target,
    ]);
    if (step.next !== undefined) targets.push([`steps.${id}.next`, step.next]);
    for (const [field, target] of targets) {
      if (!Object.hasOwn(steps, target)) {
        throw new WorkflowError(field, `target step '${target}' does not exist`);
      }
    }
  }
  return { name, version: 1, start, steps };
}
