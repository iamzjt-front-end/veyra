import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  isProjectHandoff,
  isProjectExecutionResult,
  type JsonValue,
  type ProjectDescriptor,
  type ProjectHandoff,
  type ProjectExecutionResult,
} from "@veyraoss/protocol";
import { createSecretRedactor, type SecretRedactor } from "@veyraoss/runtime";
import { loadProject, projectPaths } from "./index.js";

export class ProjectHandoffError extends Error {
  override readonly name = "ProjectHandoffError";
  constructor(
    readonly code: "invalid_handoff" | "handoff_exists",
    message: string,
  ) {
    super(message);
  }
}
/** Immutable bounded envelopes. Detailed history stays in the existing run/event/artifact store. */
export class ProjectHandoffStore {
  private readonly project: ProjectDescriptor;
  private readonly redactor: SecretRedactor;
  constructor(options: { project: ProjectDescriptor; redactValues?: readonly string[] }) {
    projectPaths(options.project);
    this.project = { ...options.project };
    this.redactor = createSecretRedactor({ values: options.redactValues });
  }
  async getHandoff(runId: string): Promise<ProjectHandoff | undefined> {
    const value = await this.read(runId, "handoff");
    return value === undefined
      ? undefined
      : (this.validate(value, runId, "handoff") as ProjectHandoff);
  }
  async getResult(runId: string): Promise<ProjectExecutionResult | undefined> {
    const value = await this.read(runId, "result");
    if (value === undefined) return;
    const result = this.validate(value, runId, "result") as ProjectExecutionResult;
    const handoff = await this.getHandoff(runId);
    if (!handoff || result.handoffId !== handoff.id)
      throw new ProjectHandoffError(
        "invalid_handoff",
        "Result does not reference this run's handoff.",
      );
    return result;
  }
  async createHandoff(handoff: ProjectHandoff): Promise<ProjectHandoff> {
    if (!isProjectHandoff(handoff))
      throw new ProjectHandoffError("invalid_handoff", "Invalid handoff.");
    const safe = this.validate(handoff, handoff?.runId, "handoff") as ProjectHandoff;
    await this.write(safe, "handoff");
    return safe;
  }
  async createResult(result: ProjectExecutionResult): Promise<ProjectExecutionResult> {
    if (!isProjectExecutionResult(result))
      throw new ProjectHandoffError("invalid_handoff", "Invalid result.");
    const safe = this.validate(result, result?.runId, "result") as ProjectExecutionResult;
    const handoff = await this.getHandoff(safe.runId);
    if (!handoff || handoff.id !== safe.handoffId)
      throw new ProjectHandoffError(
        "invalid_handoff",
        "Result does not reference this run's handoff.",
      );
    await this.write(safe, "result");
    return safe;
  }
  private validate(value: unknown, runId: string, kind: "handoff" | "result") {
    this.validateId(runId);
    const guard = kind === "handoff" ? isProjectHandoff : isProjectExecutionResult;
    if (!guard(value) || value.projectId !== this.project.id || value.runId !== runId)
      throw new ProjectHandoffError(
        "invalid_handoff",
        "Invalid, oversized or mismatched Project envelope.",
      );
    const safe = this.redactor.json(value as unknown as JsonValue);
    if (!guard(safe))
      throw new ProjectHandoffError(
        "invalid_handoff",
        "Redaction changed structural envelope fields.",
      );
    return safe;
  }
  private validateId(runId: string) {
    if (
      typeof runId !== "string" ||
      !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)
    )
      throw new ProjectHandoffError("invalid_handoff", "Run locator must be a UUID.");
  }
  private async directory(create: boolean) {
    if ((await loadProject(this.project.root)).id !== this.project.id)
      throw new ProjectHandoffError("invalid_handoff", "Project identity changed.");
    const directory = projectPaths(this.project).handoffs;
    if (create)
      await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    try {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
        throw new Error("Unsafe handoff directory");
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new ProjectHandoffError(
        "invalid_handoff",
        "Handoff directory is inaccessible or linked.",
      );
    }
    return directory;
  }
  private async read(runId: string, kind: "handoff" | "result"): Promise<unknown> {
    this.validateId(runId);
    const directory = await this.directory(false);
    if (!directory) return;
    const path = join(directory, `${runId}.${kind}.json`);
    try {
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        const stat = await file.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > 65536)
          throw new Error("Unsafe handoff");
        const buffer = Buffer.alloc(65537);
        let length = 0;
        while (length < buffer.length) {
          const result = await file.read(buffer, length, buffer.length - length, null);
          if (!result.bytesRead) break;
          length += result.bytesRead;
        }
        if (length > 65536) throw new Error("Oversized handoff");
        return JSON.parse(buffer.subarray(0, length).toString("utf8"));
      } finally {
        await file.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        try {
          await lstat(path);
        } catch (missing) {
          if ((missing as NodeJS.ErrnoException).code === "ENOENT") return;
        }
      }
      throw new ProjectHandoffError(
        "invalid_handoff",
        "Envelope is unreadable or unsafe; preserve it for inspection.",
      );
    }
  }
  private async write(value: ProjectHandoff | ProjectExecutionResult, kind: "handoff" | "result") {
    const directory = (await this.directory(true)) as string;
    const path = join(directory, `${value.runId}.${kind}.json`);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(JSON.stringify(value));
      await file.sync();
      await file.close();
      await link(temporary, path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST")
        throw new ProjectHandoffError(
          "handoff_exists",
          "Envelope already exists; refusing to overwrite or replay it.",
        );
      throw error;
    } finally {
      await file.close();
      await unlink(temporary);
    }
    const folder = await open(directory, constants.O_RDONLY);
    try {
      await folder.sync();
    } finally {
      await folder.close();
    }
  }
}
