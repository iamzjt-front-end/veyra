import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  isJsonValue,
  isWorkspaceInfo,
  type WorkspaceInfo,
  type JsonValue,
  type VeyraEvent,
} from "@veyra/protocol";
import {
  acquireLocalLock,
  LocalLockError,
  createSecretRedactor,
  isSecretField,
  isProcessOwner,
  type ProcessOwner,
  type SecretRedactor,
} from "@veyra/runtime";
import { parseWorkflow, buildWorkflowGraph, type WorkflowDefinition } from "@veyra/workflow";
import { isStoredEvent } from "./state-events.js";

export type RunStatus = "running" | "paused" | "completed" | "failed";

export interface StoredRunInput {
  version: 1;
  runId: string;
  goal: string;
  workflow: WorkflowDefinition;
  cwd: string;
  workspace?: WorkspaceInfo;
  createdAt: string;
}

export interface StoredRunState {
  version: 1;
  /** Monotonic state replacement counter; absent only in legacy snapshots. */
  revision?: number;
  runId: string;
  status: RunStatus;
  /** The current or next step to execute; absent only for a terminal run. */
  currentStep?: string;
  retryCounts: Record<string, number>;
  createdAt: string;
  updatedAt: string;
  lastOutcome?: string;
  /** Last execution owner; liveness is observed separately, never inferred from status alone. */
  owner?: ProcessOwner;
}

export interface StoredRun {
  input: StoredRunInput;
  state: StoredRunState;
}

export interface CreateRunInput {
  goal: string;
  workflow: WorkflowDefinition;
  cwd?: string;
  workspace?: WorkspaceInfo;
}

export interface RunStateUpdate {
  status?: RunStatus;
  currentStep?: string | null;
  retryCounts?: Record<string, number>;
  lastOutcome?: string;
  owner?: ProcessOwner;
}

export interface LocalRunStoreOptions {
  stateDir?: string;
  /** Known secret values supplied by the application; never persisted. */
  redactValues?: readonly string[];
}

export class StateStoreError extends Error {
  override readonly name = "StateStoreError";

  constructor(
    readonly code:
      | "invalid_input"
      | "not_found"
      | "corrupt_state"
      | "unsafe_path"
      | "io_error"
      | "lock_busy"
      | "invalid_lock"
      | "lock_timeout"
      | "lock_lost",
    readonly filePath: string,
    detail: string,
  ) {
    super(`${filePath}: ${detail}`);
  }
}

const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_JSON_BYTES = 16 * 1024 * 1024;

/** Local coordinated store. Scheduling, provider configuration, and credentials stay outside it. */
export class LocalRunStore {
  readonly directory: string;
  readonly #redactor: SecretRedactor;
  #pending: Promise<unknown> = Promise.resolve();

  constructor(options: LocalRunStoreOptions = {}) {
    this.directory = resolve(options.stateDir ?? ".veyra");
    this.#redactor = createSecretRedactor({ values: options.redactValues });
  }

  /** Redact complete diagnostics before callers create bounded excerpts. */
  redactText(value: string): string {
    return this.#redactor.text(value);
  }

  /** Hold a run-control lease across execution/approval; state operations take a separate short lock. */
  async withRunLock<T>(
    runId: string,
    action: () => Promise<T>,
    recoverInterrupted = false,
  ): Promise<T> {
    this.#runPath(runId);
    const lease = await acquireLocalLock({
      directory: await this.#lockDirectory("runs", runId),
      holder: runId,
      waitMs: 100,
      recoverStale: recoverInterrupted,
    }).catch((error) => {
      throw lockError(error, this.directory);
    });
    try {
      return await action();
    } finally {
      await lease.release();
    }
  }

  createRun(input: CreateRunInput, runId = randomUUID()): Promise<StoredRun> {
    return this.#mutate(async () => {
      if (
        typeof input.goal !== "string" ||
        !input.goal.trim() ||
        Object.keys(input).some((key) => !["goal", "workflow", "cwd", "workspace"].includes(key))
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
      this.#runPath(runId);
      if (await exists(this.#runPath(runId)))
        throw new StateStoreError("invalid_input", this.directory, "Run ID already exists.");
      if (
        input.workspace !== undefined &&
        (!isWorkspaceInfo(input.workspace) ||
          input.workspace.cwd !== resolve(input.cwd ?? process.cwd()))
      )
        throw new StateStoreError(
          "invalid_input",
          this.directory,
          "Invalid workspace snapshot or mismatched cwd.",
        );
      await this.#ensureLayout();
      const at = new Date().toISOString();
      const storedInput: StoredRunInput = {
        version: 1,
        runId,
        goal: input.goal,
        workflow,
        cwd: resolve(input.cwd ?? process.cwd()),
        ...(input.workspace ? { workspace: structuredClone(input.workspace) } : {}),
        createdAt: at,
      };
      const state: StoredRunState = {
        version: 1,
        revision: 1,
        runId,
        status: "running",
        currentStep: buildWorkflowGraph(workflow).scopes.get("")?.start as string,
        retryCounts: {},
        createdAt: at,
        updatedAt: at,
      };
      const staging = join(this.directory, "runs", `.tmp-${runId}`);
      await mkdir(staging, { mode: 0o700 });
      try {
        await mkdir(join(staging, "artifacts"), { mode: 0o700 });
        await this.#writeAtomic(join(staging, "input.json"), storedInput, (value) => {
          const parsed = parseInput(value, runId, staging, "invalid_input");
          if (
            parsed.cwd !== storedInput.cwd ||
            JSON.stringify(parsed.workspace) !== JSON.stringify(storedInput.workspace)
          )
            throw new StateStoreError(
              "invalid_input",
              staging,
              "Secret redaction changed the execution location; use a workspace path without credentials.",
            );
        });
        await this.#writeAtomic(join(staging, "state.json"), state, (value) =>
          parseState(value, storedInput, staging, "invalid_input"),
        );
        const events = await open(join(staging, "events.jsonl"), "wx", 0o600);
        try {
          await events.sync();
        } finally {
          await events.close();
        }
        await syncDirectory(staging);
        await rename(staging, this.#runPath(runId));
        await syncDirectory(join(this.directory, "runs"));
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
          (key) => !["status", "currentStep", "retryCounts", "lastOutcome", "owner"].includes(key),
        )
      ) {
        throw new StateStoreError(
          "invalid_input",
          this.#runPath(runId),
          "Unknown state update field.",
        );
      }
      const { input, state } = await this.#loadRun(runId);
      const next = {
        ...state,
        ...update,
        revision: (state.revision ?? 0) + 1,
        updatedAt: new Date().toISOString(),
      };
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
    return this.#read(() => this.#loadRun(runId));
  }

  async listRuns(): Promise<StoredRunState[]> {
    return this.#read(async () => {
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
    });
  }

  async readEvents(runId: string): Promise<VeyraEvent[]> {
    return this.#read(async () => {
      await this.#loadRun(runId);
      return this.#readEvents(runId);
    });
  }

  setActiveRun(runId: string | null): Promise<void> {
    return this.#mutate(async () => {
      await this.#ensureLayout();
      if (runId !== null) await this.#loadRun(runId);
      await this.#writeActive(runId);
    });
  }

  async getActiveRun(): Promise<StoredRun | null> {
    return this.#read(async () => {
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
        !(
          pointer.runId === null ||
          (typeof pointer.runId === "string" && RUN_ID.test(pointer.runId))
        )
      )
        corrupt(path, "Invalid active run pointer.");
      if (pointer.runId === null) return null;
      return this.#loadRun(pointer.runId as string);
    });
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

  async #lockDirectory(...parts: string[]) {
    await this.#ensureLayout();
    let path = join(this.directory, "state", "locks");
    for (const part of ["", ...parts]) {
      path = join(path, part);
      await mkdir(path, { recursive: true, mode: 0o700 });
      await directory(path);
    }
    return path;
  }

  async #coordinate<T>(action: () => Promise<T>): Promise<T> {
    const lock = await acquireLocalLock({
      directory: await this.#lockDirectory("store"),
      holder: "store",
      waitMs: 30_000,
      recoverStale: true,
    });
    try {
      return await action();
    } finally {
      await lock.release();
    }
  }

  async #read<T>(action: () => Promise<T>): Promise<T> {
    await this.#pending;
    try {
      // A nonexistent store stays nonexistent during read-only discovery.
      return await ((await exists(this.directory)) ? this.#coordinate(action) : action());
    } catch (error) {
      throw lockError(error, this.directory);
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
    const text = JSON.stringify(redact(value, this.#redactor));
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
      await syncDirectory(dirname(path));
    } finally {
      if (created) await rm(temp, { force: true });
    }
  }

  #mutate<T>(action: () => Promise<T>): Promise<T> {
    const operation = this.#pending
      .then(() => this.#coordinate(action))
      .catch((error: unknown) => {
        if (error instanceof LocalLockError) throw lockError(error, this.directory);
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

function lockError(error: unknown, path: string): unknown {
  return error instanceof LocalLockError
    ? new StateStoreError(error.code, path, error.message)
    : error;
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
      (key) =>
        !["version", "runId", "goal", "workflow", "cwd", "workspace", "createdAt"].includes(key),
    ) ||
    value.version !== 1 ||
    value.runId !== runId ||
    typeof value.goal !== "string" ||
    !value.goal.trim() ||
    typeof value.cwd !== "string" ||
    !value.cwd.trim() ||
    (value.workspace !== undefined &&
      (!isWorkspaceInfo(value.workspace) || value.workspace.cwd !== value.cwd)) ||
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
    ...(isWorkspaceInfo(value.workspace) ? { workspace: value.workspace } : {}),
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
          "revision",
          "runId",
          "status",
          "currentStep",
          "retryCounts",
          "createdAt",
          "updatedAt",
          "lastOutcome",
          "owner",
        ].includes(key),
    ) ||
    value.version !== 1 ||
    (value.revision !== undefined &&
      (!Number.isSafeInteger(value.revision) || (value.revision as number) < 1)) ||
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
    (value.owner !== undefined && !isProcessOwner(value.owner)) ||
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

function redact(value: JsonValue, redactor: SecretRedactor, path: string[] = []): JsonValue {
  if (typeof value === "string") return redactor.text(value);
  if (Array.isArray(value)) return value.map((item) => redact(item, redactor, path));
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
      Object.entries(value).map(([key, item]) => {
        const safeKey = redactor.text(key);
        if (structuralKeys && safeKey !== key)
          throw new StateStoreError(
            "invalid_input",
            "workflow/state",
            "Redaction would change a structural identifier; remove credentials from identifiers.",
          );
        return [
          safeKey,
          !structuralKeys && isSecretField(key)
            ? "[REDACTED]"
            : typeof item === "string" && value[`${key}Truncated`] === true
              ? redactor.text(item, { truncated: true })
              : redact(item, redactor, [...path, key]),
        ];
      }),
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

async function syncDirectory(path: string) {
  // Node cannot portably open directories for syncing on Windows. File sync and
  // atomic rename still apply there; filesystem/power-loss guarantees vary.
  if (process.platform === "win32") return;
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
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
