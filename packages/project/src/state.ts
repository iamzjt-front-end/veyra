import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  isJsonValue,
  isProjectSharedState,
  MAX_PROJECT_STATE_BYTES,
  type ProjectDescriptor,
  type ProjectSharedState,
  type ProjectStateUpdate,
} from "@veyraoss/protocol";
import { acquireLocalLock, createSecretRedactor, type SecretRedactor } from "@veyraoss/runtime";
import { loadProject, projectPaths } from "./index.js";

export class ProjectStateError extends Error {
  override readonly name = "ProjectStateError";
  constructor(
    readonly code: "invalid_shared_state" | "state_conflict" | "project_identity_changed",
    message: string,
  ) {
    super(message);
  }
}

/** Latest bounded engineering state. Existing Core run events/artifacts retain detailed history. */
export class ProjectStateStore {
  private readonly project: ProjectDescriptor;
  private readonly redactor: SecretRedactor;
  constructor(options: {
    project: ProjectDescriptor;
    redactValues?: readonly string[];
    env?: Readonly<Record<string, string | undefined>>;
  }) {
    projectPaths(options.project);
    this.project = { ...options.project };
    this.redactor = createSecretRedactor({ values: options.redactValues, env: options.env });
  }

  async read(): Promise<ProjectSharedState | undefined> {
    await this.checkProject();
    const path = projectPaths(this.project).state;
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let source: string;
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink > 1 || stat.size > MAX_PROJECT_STATE_BYTES)
          throw new Error("Unsafe file");
        const buffer = Buffer.alloc(MAX_PROJECT_STATE_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await file.read(buffer, length, buffer.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > MAX_PROJECT_STATE_BYTES) throw new Error("Oversized state");
        source = buffer.subarray(0, length).toString("utf8");
      } finally {
        await file.close();
      }
      return this.validate(JSON.parse(source));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        // A dangling symlink is unsafe, not an absent state to overwrite.
        try {
          await lstat(path);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") return;
          throw missing;
        }
      }
      throw new ProjectStateError(
        "invalid_shared_state",
        "Shared Project State is invalid or unsafe; preserve state.json for inspection.",
      );
    }
  }

  /** Compare-and-swap a complete bounded snapshot; 0 means no prior state. */
  async save(update: ProjectStateUpdate, expectedRevision: number): Promise<ProjectSharedState> {
    if (
      !Number.isSafeInteger(expectedRevision) ||
      expectedRevision < 0 ||
      expectedRevision >= Number.MAX_SAFE_INTEGER ||
      !isJsonValue(update) ||
      !update ||
      typeof update !== "object" ||
      Array.isArray(update) ||
      Object.keys(update).some(
        (key) => !["context", "provenance", "handoff", "result", "review"].includes(key),
      )
    )
      throw new ProjectStateError(
        "invalid_shared_state",
        "Expected a bounded state update and non-negative revision.",
      );
    const next = this.validate({
      ...update,
      version: 1,
      projectId: this.project.id,
      revision: expectedRevision + 1,
      updatedAt: new Date().toISOString(),
    });
    await this.checkProject();
    const paths = projectPaths(this.project);
    const lock = await acquireLocalLock({
      directory: join(paths.directory, ".state-lock"),
      holder: this.project.id,
      waitMs: 10000,
      recoverStale: true,
    });
    try {
      const current = await this.read();
      if ((current?.revision ?? 0) !== expectedRevision)
        throw new ProjectStateError(
          "state_conflict",
          "Shared state changed; reload and reconcile before saving.",
        );
      const temporary = join(paths.directory, `.state-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(next));
        await file.sync();
        await file.close();
        await this.checkProject();
        await rename(temporary, paths.state);
        const directory = await open(paths.directory, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await file.close();
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
      }
      return next;
    } finally {
      await lock.release();
    }
  }

  private validate(value: unknown): ProjectSharedState {
    if (!isProjectSharedState(value) || value.projectId !== this.project.id)
      throw new ProjectStateError(
        "invalid_shared_state",
        "Invalid, oversized or mismatched Project Shared State.",
      );
    // Known values and recognizable credential formats use the same redactor as Core/Runtime.
    const safe = this.redactor.json(value as unknown as import("@veyraoss/protocol").JsonValue);
    if (!isProjectSharedState(safe))
      throw new ProjectStateError(
        "invalid_shared_state",
        "Redacted shared state has invalid identifiers or exceeds its limit.",
      );
    return safe;
  }

  private async checkProject() {
    const current = await loadProject(this.project.root);
    if (current.id !== this.project.id)
      throw new ProjectStateError(
        "project_identity_changed",
        "Project identity changed; reopen the Project before accessing shared state.",
      );
  }
}
