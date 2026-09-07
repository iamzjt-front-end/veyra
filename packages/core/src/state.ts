import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isJsonValue, type JsonValue, type VeyraEvent } from "@veyra/protocol";
import { parseWorkflow, buildWorkflowGraph, type WorkflowDefinition } from "@veyra/workflow";
import { isStoredEvent } from "./state-events.js";

export type RunStatus = "running" | "paused" | "completed" | "failed";

export interface StoredRunInput {
  version: 1;
  runId: string;
  goal: string;
  workflow: WorkflowDefinition;
  cwd: string;
  createdAt: string;
}

export interface StoredRunState {
  version: 1;
  runId: string;
  status: RunStatus;
  /** The current or next step to execute; absent only for a terminal run. */
  currentStep?: string;
  retryCounts: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  lastOutcome?: string;
}

export interface StoredRun {
  input: StoredRunInput;
  state: StoredRunState;
}

export interface CreateRunInput {
  goal: string;
  workflow: WorkflowDefinition;
  cwd?: string;
}

export interface RunStateUpdate {
  status?: RunStatus;
  currentStep?: string | null;
  retryCounts?: Record<string, number>;
  lastOutcome?: string;
}

export interface LocalRunStoreOptions {
  stateDir?: string;
  /** Known secret values supplied by the application; never persisted. */
  redactValues?: readonly string[];
}

export class StateStoreError extends Error {
  override readonly name = "StateStoreError";

  constructor(
    readonly code: "invalid_input" | "not_found" | "corrupt_state" | "unsafe_path" | "io_error",
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath}: ${detail}`);
  }
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_FIELD =
  /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|passwd|secret|authorization|cookie|private[_-]?key)$|^(?:env|environment)$/i;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

/** Local single-writer store. Scheduling, provider configuration, and credentials stay outside it. */
export class LocalRunStore {
  readonly directory: string;
  readonly #redactValues: readonly string[];
  #pending: Promise<unknown> = Promise.resolve();

  constructor(options: LocalRunStoreOptions = {}) {
    this.directory = resolve(options.stateDir ?? ".veyra");
    this.#redactValues = [...(options.redactValues ?? [])]
      .filter(Boolean)
      .sort((a, b) => b.length - a.length);
  }

  createRun(input: CreateRunInput): Promise<StoredRun> {
    return this.#mutate(async () => {
      if (
        typeof input.goal !== "string" ||
        !input.goal.trim() ||
        Object.keys(input).some((key) => !["goal", "workflow", "cwd"].includes(key))
      ) {
        throw new StateStoreError(
          "invalid_input",
          this.directory,
          "Expected a goal, workflow, and optional cwd; config/environment are not persisted.",
        );
      }
      let workflow: WorkflowDefinition;
      try {
        workflow = parseWorkflow(input.workflow);
        buildWorkflowGraph(workflow);
      } catch {
        throw new StateStoreError(
          "invalid_input",
          this.directory,
          "Cannot persist an invalid workflow.",
        );
      }
      if (input.cwd !== undefined && (typeof input.cwd !== "string" || !input.cwd.trim())) {
        throw new StateStoreError("invalid_input", this.directory, "cwd must be a non-empty path.");
      }
      await this.#ensureLayout();
      const runId = randomUUID();
      const at = new Date().toISOString();
      const storedInput: StoredRunInput = {
        version: 1,
        runId,
        goal: input.goal,
        workflow,
        cwd: resolve(input.cwd ?? process.cwd()),
        createdAt: at,
      };
      const state: StoredRunState = {
        version: 1,
        runId,
        status: "running",
        currentStep: workflow.start,
        retryCounts: {},
        createdAt: at,
        updatedAt: at,
      };
      const staging = join(this.directory, "runs", `.tmp-${runId}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        await mkdir(join(staging, "artifacts"), { mode: 0o700 });
        await this.#writeAtomic(join(staging, "input.json"), storedInput, (value) =>
          parseInput(value, runId, staging, "invalid_input"),
        );
        await this.#writeAtomic(join(staging, "state.json"), state, (value) =>
          parseState(value, storedInput, staging, "invalid_input"),
        );
        const events = await open(join(staging, "events.jsonl"), "wx", 0o600);
        await events.close();
        await rename(staging, this.#runPath(runId));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
      await this.#writeActive(runId);
      return this.#loadRun(runId);
    });
  }

  updateRun(runId: string, update: RunStateUpdate): Promise<StoredRunState> {
    return this.#mutate(async () => {
      if (
        Object.keys(update).some(
          (key) => !["status", "currentStep", "retryCounts", "lastOutcome"].includes(key),
        )
      ) {
        throw new StateStoreError(
          "invalid_input",
          this.#runPath(runId),
          "Unknown state update field.",
        );
      }
      const { input, state } = await this.#loadRun(runId);
      const next = { ...state, ...update, updatedAt: new Date().toISOString() };
      if (next.currentStep === null) delete next.currentStep;
      const path = join(this.#runPath(runId), "state.json");
      const validated = parseState(next, input, path, "invalid_input");
      await this.#writeAtomic(path, validated, (value) =>
        parseState(value, input, path, "invalid_input"),
      );
      return (await this.#loadRun(runId)).state;
    });
  }

  appendEvent(runId: string, event: VeyraEvent): Promise<VeyraEvent> {
    return this.#mutate(async () => {
      await this.#loadRun(runId);
      const path = join(this.#runPath(runId), "events.jsonl");
      if (!isStoredEvent(event) || event.runId !== runId) {
        throw new StateStoreError(
          "invalid_input",
          path,
          "Event must match its run and the serializable event contract.",
        );
      }
      const previous = await this.#readEvents(runId);
      const recorded = { ...event, eventId: randomUUID(), sequence: previous.length + 1 };
      const serialized = this.#serialize(recorded, path);
      const safeEvent: unknown = JSON.parse(serialized);
      if (!isStoredEvent(safeEvent) || safeEvent.runId !== runId)
        throw new StateStoreError(
          "invalid_input",
          path,
          "Redaction changed structural event fields; remove secrets from execution identifiers.",
        );
      const handle = await open(path, "a", 0o600);
      try {
        await handle.writeFile(`${serialized}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      return safeEvent;
    });
  }

  async loadRun(runId: string): Promise<StoredRun> {
    await this.#pending;
    return this.#loadRun(runId);
  }

  async listRuns(): Promise<StoredRunState[]> {
    await this.#pending;
    const runs = join(this.directory, "runs");
    if (!(await exists(this.directory))) return [];
    await directory(this.directory);
    if (!(await exists(runs))) return [];
    await directory(runs);
    const records: StoredRunState[] = [];
    for (const name of await readdir(runs)) {
      if (RUN_ID.test(name)) records.push((await this.#loadRun(name)).state);
    }
    return records.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.runId.localeCompare(b.runId),
    );
  }

  async readEvents(runId: string): Promise<VeyraEvent[]> {
    await this.#pending;
    await this.#loadRun(runId);
    return this.#readEvents(runId);
  }

  setActiveRun(runId: string | null): Promise<void> {
    return this.#mutate(async () => {
      await this.#ensureLayout();
      if (runId !== null) await this.#loadRun(runId);
      await this.#writeActive(runId);
    });
  }

  async getActiveRun(): Promise<StoredRun | null> {
    await this.#pending;
    const path = this.#activePath();
    if (!(await exists(this.directory))) return null;
    await directory(this.directory);
    const stateDir = join(this.directory, "state");
    if (!(await exists(stateDir))) return null;
    await directory(stateDir);
    if (!(await exists(path))) return null;
    const pointer = await readJson(path);
    if (
      !object(pointer) ||
      pointer.version !== 1 ||
      !(pointer.runId === null || (typeof pointer.runId === "string" && RUN_ID.test(pointer.runId)))
    )
      corrupt(path, "Invalid active run pointer.");
    if (pointer.runId === null) return null;
    return this.#loadRun(pointer.runId as string);
  }

  #activePath() {
    return join(this.directory, "state", "active.json");
  }

  async #writeActive(runId: string | null) {
    const path = this.#activePath();
    await this.#writeAtomic(path, { version: 1, runId }, (value) => {
      if (!object(value) || value.version !== 1 || value.runId !== runId)
        throw new StateStoreError(
          "invalid_input",
          path,
          "Redaction must not alter the active run identifier.",
        );
    });
  }

  #runPath(runId: string) {
    if (!RUN_ID.test(runId))
      throw new StateStoreError(
        "invalid_input",
        this.directory,
        "Run ID must be a UUID, not a path.",
      );
    return join(this.directory, "runs", runId);
  }

  async #ensureLayout() {
    for (const path of [
      this.directory,
      join(this.directory, "state"),
      join(this.directory, "runs"),
    ]) {
      await mkdir(path, { recursive: true, mode: 0o700 });
      await directory(path);
    }
  }

  async #loadRun(runId: string): Promise<StoredRun> {
    const path = this.#runPath(runId);
    for (const dir of [this.directory, join(this.directory, "runs"), path]) await directory(dir);
    const inputPath = join(path, "input.json");
    const input = parseInput(await readJson(inputPath), runId, inputPath, "corrupt_state");
    const statePath = join(path, "state.json");
    return {
      input,
      state: parseState(await readJson(statePath), input, statePath, "corrupt_state"),
    };
  }

  async #readEvents(runId: string): Promise<VeyraEvent[]> {
    const path = join(this.#runPath(runId), "events.jsonl");
    await regularFile(path);
    const text = await readFile(path, "utf8");
    if (text && !text.endsWith("\n"))
      corrupt(
        path,
        "Incomplete final event record; preserve the file and repair it before resuming.",
      );
    return text
      ? text
          .slice(0, -1)
          .split("\n")
          .map((line, index) => {
            let event: unknown;
            try {
              event = JSON.parse(line);
            } catch {
              return corrupt(path, `Invalid JSON on event line ${index + 1}.`);
            }
            if (
              !isStoredEvent(event) ||
              event.runId !== runId ||
              event.sequence !== index + 1 ||
              !event.eventId
            )
              return corrupt(path, `Invalid event contract on line ${index + 1}.`);
            return event;
          })
      : [];
  }

  #serialize(value: unknown, path: string) {
    if (!isJsonValue(value))
      throw new StateStoreError(
        "invalid_input",
        path,
        "Only plain JSON-compatible data may be persisted.",
      );
    const text = JSON.stringify(redact(value, this.#redactValues));
    if (Buffer.byteLength(text) > MAX_JSON_BYTES)
      throw new StateStoreError(
        "invalid_input",
        path,
        "JSON record exceeds 16 MiB; store large output in artifacts.",
      );
    return text;
  }

  async #writeAtomic(path: string, value: unknown, validate?: (value: unknown) => unknown) {
    if (await exists(path)) await regularFile(path);
    const serialized = this.#serialize(value, path);
    validate?.(JSON.parse(serialized));
    const temp = `${path}.${randomUUID()}.tmp`;
    let created = false;
    try {
      const handle = await open(temp, "wx", 0o600);
      created = true;
      try {
        await handle.writeFile(`${serialized}\n`, "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(temp, path);
    } finally {
      if (created) await rm(temp, { force: true });
    }
  }

  #mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#pending.then(action).catch((error: unknown) => {
      if (error instanceof StateStoreError) throw error;
      throw new StateStoreError(
        "io_error",
        this.directory,
        `Local state operation failed (${systemCode(error)}). Check directory permissions and available disk space.`,
      );
    });
    this.#pending = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function timestamp(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function parseInput(
  value: unknown,
  runId: string,
  path: string,
  code: "invalid_input" | "corrupt_state",
): StoredRunInput {
  if (
    !isJsonValue(value) ||
    !object(value) ||
    Object.keys(value).some(
      (key) => !["version", "runId", "goal", "workflow", "cwd", "createdAt"].includes(key),
    ) ||
    value.version !== 1 ||
    value.runId !== runId ||
    typeof value.goal !== "string" ||
    !value.goal.trim() ||
    typeof value.cwd !== "string" ||
    !value.cwd.trim() ||
    !timestamp(value.createdAt)
  )
    throw new StateStoreError(
      code,
      path,
      "Invalid input snapshot; restore a valid copy before resuming.",
    );
  let workflow: WorkflowDefinition;
  try {
    workflow = parseWorkflow(value.workflow);
    buildWorkflowGraph(workflow);
  } catch {
    throw new StateStoreError(
      code,
      path,
      "Invalid workflow snapshot; restore a valid copy before resuming.",
    );
  }
  return {
    version: 1,
    runId,
    goal: value.goal,
    cwd: value.cwd,
    createdAt: value.createdAt,
    workflow,
  };
}

function parseState(
  value: unknown,
  input: StoredRunInput,
  path: string,
  code: "invalid_input" | "corrupt_state",
): StoredRunState {
  const steps = buildWorkflowGraph(input.workflow).steps;
  if (
    !isJsonValue(value) ||
    !object(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "version",
          "runId",
          "status",
          "currentStep",
          "retryCounts",
          "createdAt",
          "updatedAt",
          "lastOutcome",
        ].includes(key),
    ) ||
    value.version !== 1 ||
    value.runId !== input.runId ||
    typeof value.status !== "string" ||
    !["running", "paused", "completed", "failed"].includes(value.status) ||
    !timestamp(value.createdAt) ||
    value.createdAt !== input.createdAt ||
    !timestamp(value.updatedAt) ||
    !object(value.retryCounts) ||
    Object.entries(value.retryCounts).some(
      ([step, count]) =>
        !Object.hasOwn(steps, step) ||
        typeof count !== "number" ||
        !Number.isSafeInteger(count) ||
        count < 0,
    ) ||
    (value.lastOutcome !== undefined && typeof value.lastOutcome !== "string") ||
    (value.currentStep !== undefined &&
      (typeof value.currentStep !== "string" || !Object.hasOwn(steps, value.currentStep))) ||
    ((value.status === "running" || value.status === "paused") && value.currentStep === undefined)
  ) {
    throw new StateStoreError(
      code,
      path,
      "Invalid run state; check schema version 1, status, step, retry counts, and timestamps before resuming.",
    );
  }
  return structuredClone(value) as unknown as StoredRunState;
}

function redact(value: JsonValue, secrets: readonly string[], path: string[] = []): JsonValue {
  if (typeof value === "string") {
    return value
      .split("[REDACTED]")
      .map((part) => {
        let result = part;
        for (const secret of secrets) result = result.split(secret).join("[REDACTED]");
        return result;
      })
      .join("[REDACTED]");
  }
  if (Array.isArray(value)) return value.map((item) => redact(item, secrets, path));
  if (value && typeof value === "object") {
    let structuralKeys = path.join(".") === "retryCounts";
    for (let offset = 0; path[offset] === "workflow" && path[offset + 1] === "steps"; offset += 3) {
      if (
        path.length === offset + 2 ||
        (path.length === offset + 4 && ["on", "inputs", "outputs"].includes(path[offset + 3] ?? ""))
      )
        structuralKeys = true;
    }
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        !structuralKeys && SECRET_FIELD.test(key)
          ? "[REDACTED]"
          : redact(item, secrets, [...path, key]),
      ]),
    );
  }
  return value;
}

async function exists(path: string) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (systemCode(error) === "ENOENT") return false;
    throw error;
  }
}

async function directory(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new StateStoreError(
        "unsafe_path",
        path,
        "Expected a real directory, not a file or symlink.",
      );
  } catch (error) {
    if (systemCode(error) === "ENOENT")
      throw new StateStoreError(
        "not_found",
        path,
        "Run state directory is missing; select an existing run or restore it from backup.",
      );
    throw error;
  }
}

async function regularFile(path: string) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new StateStoreError(
        "unsafe_path",
        path,
        "Expected a regular state file, not a symlink.",
      );
  } catch (error) {
    if (systemCode(error) === "ENOENT")
      throw new StateStoreError(
        "not_found",
        path,
        "Required state file is missing; restore it before resuming.",
      );
    throw error;
  }
}

async function readJson(path: string): Promise<unknown> {
  await regularFile(path);
  const text = await readFile(path, "utf8");
  try {
    return JSON.parse(text);
  } catch {
    return corrupt(
      path,
      "Invalid or incomplete JSON; preserve the file and restore a valid copy before resuming.",
    );
  }
}

function corrupt(path: string, detail: string): never {
  throw new StateStoreError("corrupt_state", path, detail);
}
function systemCode(error: unknown) {
  return error instanceof Error && "code" in error ? String(error.code) : "unknown error";
}
