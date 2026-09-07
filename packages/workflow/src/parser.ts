import type { StepInputReference, WorkflowDefinition, WorkflowStep } from "./index.js";
import { pointerSegments } from "./inputs.js";

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

function parseStep(value: unknown, field: string, depth: number): WorkflowStep {
  const raw = object(value, field);
  const type = text(raw.type, `${field}.type`);
  if (
    type !== "agent" &&
    type !== "command" &&
    type !== "human" &&
    type !== "parallel" &&
    type !== "router" &&
    type !== "subworkflow" &&
    type !== "end"
  ) {
    throw new WorkflowError(
      `${field}.type`,
      "expected agent, command, human, parallel, router, subworkflow, or end",
    );
  }
  const common = ["type", "metadata", "next", "on", "retry"];
  const keys =
    type === "end"
      ? ["type", "metadata"]
      : [
          ...common,
          ...(type === "subworkflow"
            ? ["use", "workflow", "outputs"]
            : type === "parallel"
              ? ["children", "concurrency", "failurePolicy"]
              : [
                  type === "router"
                    ? "route"
                    : type === "agent"
                      ? "agent"
                      : type === "command"
                        ? "run"
                        : "message",
                ]),
          ...(type === "agent" || type === "human" || type === "subworkflow" ? ["inputs"] : []),
        ];
  object(raw, field, keys);
  const step: WorkflowStep = { type };
  if (type === "subworkflow") {
    if (raw.use !== undefined) step.use = text(raw.use, `${field}.use`);
    if (raw.workflow !== undefined) {
      try {
        step.workflow = parseDefinition(raw.workflow, depth + 1);
      } catch (error) {
        if (error instanceof WorkflowError)
          throw new WorkflowError(`${field}.workflow.${error.field}`, error.detail);
        throw error;
      }
    }
    if (!step.use && !step.workflow)
      throw new WorkflowError(field, "subworkflow requires use or an inline workflow");
    if (raw.outputs !== undefined) step.outputs = parseReferences(raw.outputs, `${field}.outputs`);
    for (const [name, output] of Object.entries(step.outputs ?? {})) {
      if (
        step.workflow &&
        (!Object.hasOwn(step.workflow.steps, output.from) ||
          step.workflow.steps[output.from]?.type === "end")
      )
        throw new WorkflowError(
          `${field}.outputs.${name}.from`,
          "must reference a non-terminal output in the child workflow",
        );
    }
  }
  if (type === "parallel") {
    if (!Array.isArray(raw.children) || raw.children.length < 1 || raw.children.length > 32)
      throw new WorkflowError(`${field}.children`, "must list 1 to 32 independent child step IDs");
    step.children = raw.children.map((id, index) => text(id, `${field}.children[${index}]`));
    if (new Set(step.children).size !== step.children.length)
      throw new WorkflowError(`${field}.children`, "child step IDs must be unique");
    if (
      raw.concurrency !== undefined &&
      (typeof raw.concurrency !== "number" ||
        !Number.isSafeInteger(raw.concurrency) ||
        raw.concurrency < 1 ||
        raw.concurrency > 32)
    )
      throw new WorkflowError(`${field}.concurrency`, "must be an integer from 1 to 32");
    if (
      raw.failurePolicy !== undefined &&
      raw.failurePolicy !== "wait-all" &&
      raw.failurePolicy !== "fail-fast"
    )
      throw new WorkflowError(`${field}.failurePolicy`, "expected wait-all or fail-fast");
    step.concurrency = (raw.concurrency as number | undefined) ?? Math.min(4, step.children.length);
    step.failurePolicy = (raw.failurePolicy as "wait-all" | "fail-fast" | undefined) ?? "wait-all";
  }
  if (type === "agent") step.agent = text(raw.agent, `${field}.agent`);
  if (type === "router") {
    if (typeof raw.route === "string") {
      step.route = text(raw.route, `${field}.route`);
      if ([...step.route].length > 128)
        throw new WorkflowError(`${field}.route`, "route labels must be at most 128 characters");
    } else {
      step.route = parseReference(raw.route, `${field}.route`);
    }
    const routes = Object.keys(object(raw.on, `${field}.on`));
    if (routes.length < 1 || routes.length > 32 || routes.some((label) => [...label].length > 128))
      throw new WorkflowError(
        `${field}.on`,
        "must declare 1 to 32 routes with labels of at most 128 characters",
      );
  }
  if (type === "command") {
    if (!Array.isArray(raw.run) || raw.run.length === 0)
      throw new WorkflowError(`${field}.run`, "must be a non-empty array of commands");
    step.run = raw.run.map((command, i) => text(command, `${field}.run[${i}]`));
  }
  if (raw.message !== undefined) step.message = text(raw.message, `${field}.message`);
  if (raw.inputs !== undefined) {
    step.inputs = parseReferences(raw.inputs, `${field}.inputs`);
  }
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
  if (
    type === "router" &&
    typeof step.route === "string" &&
    !Object.hasOwn(step.on ?? {}, step.route) &&
    step.next === undefined
  )
    throw new WorkflowError(
      `${field}.route`,
      "static label must match a declared route or have a next fallback",
    );
  return step;
}

function parseReference(value: unknown, field: string): StepInputReference {
  const ref = object(value, field, ["from", "path"]);
  const from = text(ref.from, `${field}.from`);
  try {
    pointerSegments(ref.path as string);
  } catch {
    throw new WorkflowError(
      `${field}.path`,
      "expected an RFC 6901 JSON Pointer (up to 1024 characters and 32 segments)",
    );
  }
  return { from, path: ref.path as string };
}

function parseReferences(value: unknown, field: string): Record<string, StepInputReference> {
  const entries = Object.entries(object(value, field));
  if (entries.length > 16) throw new WorkflowError(field, "at most 16 named inputs are allowed");
  return Object.fromEntries(
    entries.map(([name, reference]) => {
      text(name, `${field} key`);
      if ([...name].length > 128)
        throw new WorkflowError(`${field} key`, "input names must be at most 128 characters");
      return [name, parseReference(reference, `${field}.${name}`)];
    }),
  );
}

/** Parse provider-neutral graph data; no YAML, process, or agent execution occurs here. */
export function parseWorkflow(value: unknown): WorkflowDefinition {
  return parseDefinition(value, 0);
}

function parseDefinition(value: unknown, depth: number): WorkflowDefinition {
  if (depth > 8)
    throw new WorkflowError("workflow", "subworkflow nesting exceeds the maximum depth of 8");
  const root = object(value, "root", ["name", "version", "start", "steps"]);
  const name = text(root.name, "name");
  if (root.version !== 1) throw new WorkflowError("version", "expected schema version 1");
  const start = text(root.start, "start");
  const steps = Object.fromEntries(
    Object.entries(object(root.steps, "steps")).map(([id, value]): [string, WorkflowStep] => [
      text(id, "steps key"),
      parseStep(value, `steps.${id}`, depth),
    ]),
  );
  if (!Object.hasOwn(steps, start))
    throw new WorkflowError("start", `step '${start}' does not exist`);
  for (const [id, step] of Object.entries(steps)) {
    if (
      step.route &&
      typeof step.route !== "string" &&
      (!Object.hasOwn(steps, step.route.from) ||
        steps[step.route.from]?.type === "end" ||
        step.route.from === id)
    )
      throw new WorkflowError(
        `steps.${id}.route.from`,
        "must reference a different non-terminal output step in this workflow",
      );
    for (const [name, reference] of Object.entries(step.inputs ?? {})) {
      if (!Object.hasOwn(steps, reference.from) || steps[reference.from]?.type === "end")
        throw new WorkflowError(
          `steps.${id}.inputs.${name}.from`,
          "must reference a non-terminal output step in this workflow",
        );
    }
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
  const owners = new Map<string, string>();
  for (const [id, step] of Object.entries(steps)) {
    if (step.type !== "parallel") continue;
    for (const [index, childId] of (step.children ?? []).entries()) {
      const child = Object.hasOwn(steps, childId) ? steps[childId] : undefined;
      const field = `steps.${id}.children[${index}]`;
      if (
        !child ||
        (child.type !== "agent" && child.type !== "command") ||
        child.next !== undefined ||
        child.on !== undefined
      )
        throw new WorkflowError(
          field,
          "must reference an agent or command leaf without next/on transitions",
        );
      if (owners.has(childId))
        throw new WorkflowError(field, "a child may belong to only one parallel group");
      if (
        Object.values(child.inputs ?? {}).some(
          (input) => input.from === id || step.children?.includes(input.from),
        )
      )
        throw new WorkflowError(
          field,
          "parallel children must select inputs from outside their group",
        );
      owners.set(childId, id);
    }
  }
  if (owners.has(start))
    throw new WorkflowError("start", "enter the owning parallel group instead of a child");
  for (const [id, step] of Object.entries(steps)) {
    const targets = [
      ...Object.entries(step.on ?? {}).map(([label, target]) => [`on.${label}`, target]),
      ...(step.next ? [["next", step.next]] : []),
    ];
    for (const [field, target] of targets)
      if (target && owners.has(target))
        throw new WorkflowError(
          `steps.${id}.${field}`,
          "enter the owning parallel group instead of a child",
        );
  }
  return { name, version: 1, start, steps };
}
