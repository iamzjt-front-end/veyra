import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import {
  isJsonValue,
  isWorkspaceInfo,
  type WorkspaceInfo,
  type JsonValue,
  type VeyraEvent,
  type SerializedError,
} from "@veyraoss/protocol";
import {
  acquireLocalLock,
  LocalLockError,
  createSecretRedactor,
  isSecretField,
  isProcessOwner,
  type ProcessOwner,
  type SecretRedactor,
} from "@veyraoss/runtime";
import { parseWorkflow, buildWorkflowGraph, type WorkflowDefinition } from "@veyraoss/workflow";
import { isStoredEvent, isSerializedError } from "./state-events.js";
import { digest, eventArtifact, eventView, MAX_INLINE_EVENT_BYTES } from "./artifacts.js";
import type { PruneRunsOptions, PruneRunsResult } from "./retention.js";
import { isProjectInstructions, type ProjectInstruction } from "@veyraoss/protocol";

export type RunStatus = "running" | "paused" | "completed" | "failed";

export interface StoredRunInput {
  version: 1;
  runId: string;
  goal: string;
  workflow: WorkflowDefinition;
  cwd: string;
  workspace?: WorkspaceInfo;
  projectInstructions?: ProjectInstruction[];
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
  /** Terminal failure reason, including run_cancelled or step_timeout; optional for legacy state. */
  error?: SerializedError;
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
  projectInstructions?: ProjectInstruction[];
}

export interface RunStateUpdate {
  status?: RunStatus;
  currentStep?: string | null;
  retryCounts?: Record<string, number>;
  lastOutcome?: string;
  /** Terminal failure reason, including run_cancelled or step_timeout; optional for legacy state. */
  error?: SerializedError;
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
        Object.keys(input).some(
          (key) => !["goal", "workflow", "cwd", "workspace", "projectInstructions"].includes(key),
        ) ||
        (input.projectInstructions !== undefined &&
          !isProjectInstructions(input.projectInstructions))
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
        ...(input.projectInstructions !== undefined
          ? { projectInstructions: structuredClone(input.projectInstructions) }
          : {}),
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
          (key) =>
            !["status", "currentStep", "retryCounts", "lastOutcome", "owner", "error"].includes(
              key,
            ),
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
      if (
        !isStoredEvent(event) ||
        event.runId !== runId ||
        event.type === "event.stored" ||
        event.payload !== undefined
      ) {
        throw new StateStoreError(
          "invalid_input",
          path,
          "Event must match its run and the serializable event contract.",
        );
      }
      const previous = await this.#readEvents(runId);
      const recorded = { ...event, eventId: randomUUID(), sequence: previous.length + 1 };
      let serialized = this.#serialize(recorded, path);
      const safeEvent: unknown = JSON.parse(serialized);
      if (!isStoredEvent(safeEvent) || safeEvent.runId !== runId)
        throw new StateStoreError(
          "invalid_input",
          path,
          "Redaction changed structural event fields; remove secrets from execution identifiers.",
        );
      if (Buffer.byteLength(serialized) > MAX_INLINE_EVENT_BYTES) {
        const artifact = eventArtifact(safeEvent, `${serialized}\n`);
        const artifactDir = join(this.#runPath(runId), "artifacts");
        await directory(artifactDir);
        const artifactPath = join(artifactDir, `${artifact.id}.json`);
        if (await exists(artifactPath))
          throw new StateStoreError(
            "unsafe_path",
            artifactPath,
            "Refusing to replace an existing artifact.",
          );
        const view = eventView({ ...safeEvent, payload: artifact });
        const inline = this.#serialize(view, path);
        if (!isStoredEvent(view) || Buffer.byteLength(inline) > MAX_INLINE_EVENT_BYTES)
          throw new StateStoreError(
            "invalid_input",
            path,
            "Artifact metadata exceeds the inline event limit.",
          );
        // Publish and sync the complete redacted payload before its event-log reference.
        await this.#writeAtomic(artifactPath, safeEvent);
        safeEvent.payload = artifact;
        serialized = inline;
      }
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
    return this.#read(() => this.#listRuns());
  }

  async #listRuns(): Promise<StoredRunState[]> {
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
      const id = await this.#activeRunId();
      return id === null ? null : this.#loadRun(id);
    });
  }

  async #activeRunId(): Promise<string | null> {
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
    return pointer.runId as string;
  }

  /** Preview by default; remove only terminal, old, unselected runs with no retained worktree. */
  async pruneRuns(options: PruneRunsOptions = {}): Promise<PruneRunsResult> {
    if (!object(options as unknown))
      throw new StateStoreError(
        "invalid_input",
        this.directory,
        "Prune options must be an object.",
      );
    const olderThanDays = options.olderThanDays ?? 30;
    const keepLast = options.keepLast ?? 20;
    if (
      Object.keys(options).some((key) => !["olderThanDays", "keepLast", "apply"].includes(key)) ||
      !Number.isSafeInteger(olderThanDays) ||
      olderThanDays < 0 ||
      olderThanDays > 365_000 ||
      !Number.isSafeInteger(keepLast) ||
      keepLast < 0 ||
      keepLast > 100_000 ||
      (options.apply !== undefined && typeof options.apply !== "boolean")
    )
      throw new StateStoreError(
        "invalid_input",
        this.directory,
        "Prune expects olderThanDays (0–365000), keepLast (0–100000) and an explicit boolean apply flag.",
      );
    const cutoff = new Date(Date.now() - olderThanDays * 86_400_000).toISOString();
    const planned = await this.#read(() => this.#prunePlan(cutoff, keepLast));
    const result: PruneRunsResult = {
      dryRun: !options.apply,
      cutoff,
      keepLast,
      ...planned,
      removed: [],
    };
    if (!options.apply) return result;
    for (const candidate of planned.candidates) {
      try {
        await this.withRunLock(candidate.runId, async () => {
          const trash = await this.#mutate(async () => {
            // Recheck current selection, newest-run protection and workspace availability under coordination.
            const fresh = await this.#prunePlan(cutoff, keepLast);
            if (!fresh.candidates.some((run) => run.runId === candidate.runId)) {
              result.skipped.push({ runId: candidate.runId, reason: "changed_since_preview" });
              return undefined;
            }
            await this.#readEvents(candidate.runId);
            const trashDir = join(this.directory, "state", "trash");
            await mkdir(trashDir, { recursive: true, mode: 0o700 });
            await directory(trashDir);
            const target = join(trashDir, `${candidate.runId}-${randomUUID()}`);
            if (await exists(target))
              throw new StateStoreError(
                "unsafe_path",
                target,
                "Refusing to replace an existing cleanup target.",
              );
            await rename(this.#runPath(candidate.runId), target);
            try {
              await syncDirectory(join(this.directory, "runs"));
              await syncDirectory(trashDir);
            } catch {
              throw new StateStoreError(
                "io_error",
                target,
                "History moved out of the live run list but cleanup publication failed; inspect this exact retained directory.",
              );
            }
            return target;
          });
          if (!trash) return;
          try {
            await rm(trash, { recursive: true });
            await syncDirectory(dirname(trash));
          } catch {
            throw new StateStoreError(
              "io_error",
              trash,
              "History left the live run list but cleanup is incomplete; inspect this exact trash directory.",
            );
          }
          result.removed.push(candidate);
        });
      } catch (error) {
        if (
          error instanceof StateStoreError &&
          ["lock_busy", "lock_timeout", "not_found"].includes(error.code)
        )
          result.skipped.push({ runId: candidate.runId, reason: error.code });
        else throw error;
      }
    }
    return result;
  }

  async #prunePlan(cutoff: string, keepLast: number) {
    const states = await this.#listRuns();
    const active = await this.#activeRunId();
    const candidates: PruneRunsResult["candidates"] = [];
    const skipped: PruneRunsResult["skipped"] = [];
    for (const [index, state] of states.entries()) {
      const reason =
        state.runId === active
          ? "active_selection"
          : !["completed", "failed"].includes(state.status)
            ? "nonterminal"
            : index < keepLast
              ? "keep_last"
              : Date.parse(state.updatedAt) >= Date.parse(cutoff)
                ? "recent"
                : undefined;
      if (reason) {
        skipped.push({ runId: state.runId, reason });
        continue;
      }
      const run = await this.#loadRun(state.runId);
      if (run.input.workspace?.mode === "worktree" && (await exists(run.input.workspace.root))) {
        skipped.push({ runId: state.runId, reason: "workspace_present" });
        continue;
      }
      candidates.push({
        runId: state.runId,
        updatedAt: state.updatedAt,
        sizeBytes: await treeBytes(this.#runPath(state.runId)),
      });
    }
    return { candidates, skipped };
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
    const records = text
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
              event.payload !== undefined ||
              event.runId !== runId ||
              event.sequence !== index + 1 ||
              !event.eventId
            )
              return corrupt(path, `Invalid event contract on line ${index + 1}.`);
            return event;
          })
      : [];
    const events: VeyraEvent[] = [];
    for (const record of records) {
      if (record.type !== "event.stored") {
        events.push(record);
        continue;
      }
      const artifact = record.artifact;
      const artifactDir = join(this.#runPath(runId), "artifacts");
      await directory(artifactDir);
      const artifactPath = join(artifactDir, `${artifact.id}.json`);
      await regularFile(artifactPath);
      const stat = await lstat(artifactPath);
      if (stat.size !== artifact.sizeBytes || stat.size > MAX_JSON_BYTES + 1)
        corrupt(artifactPath, "Stored event payload size disagrees with its reference.");
      const serialized = await readFile(artifactPath, "utf8");
      if (digest(serialized) !== artifact.metadata?.sha256)
        corrupt(artifactPath, "Stored event payload digest disagrees with its reference.");
      let event: unknown;
      try {
        event = JSON.parse(serialized);
      } catch {
        corrupt(artifactPath, "Invalid stored event payload JSON.");
      }
      if (
        !isStoredEvent(event) ||
        event.type === "event.stored" ||
        event.payload !== undefined ||
        event.type !== record.eventType ||
        event.runId !== runId ||
        event.eventId !== record.eventId ||
        event.sequence !== record.sequence ||
        JSON.stringify(eventArtifact(event, serialized)) !== JSON.stringify(artifact)
      )
        corrupt(artifactPath, "Stored event payload identity disagrees with its reference.");
      const expanded = { ...event, payload: artifact };
      if (JSON.stringify(eventView(expanded)) !== JSON.stringify(record))
        corrupt(artifactPath, "Stored event preview disagrees with its payload.");
      events.push(expanded);
    }
    return events;
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
        ![
          "version",
          "runId",
          "goal",
          "workflow",
          "cwd",
          "workspace",
          "projectInstructions",
          "createdAt",
        ].includes(key),
    ) ||
    value.version !== 1 ||
    value.runId !== runId ||
    typeof value.goal !== "string" ||
    !value.goal.trim() ||
    typeof value.cwd !== "string" ||
    !value.cwd.trim() ||
    (value.projectInstructions !== undefined &&
      !isProjectInstructions(value.projectInstructions)) ||
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
    ...(isProjectInstructions(value.projectInstructions)
      ? { projectInstructions: value.projectInstructions }
      : {}),
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
          "error",
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
    (value.error !== undefined && (value.status !== "failed" || !isSerializedError(value.error))) ||
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

async function treeBytes(path: string): Promise<number> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
    throw new StateStoreError(
      "unsafe_path",
      path,
      "Refusing cleanup of linked or special run content.",
    );
  if (info.isFile()) return info.size;
  let total = 0;
  for (const name of await readdir(path)) total += await treeBytes(join(path, name));
  return total;
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
