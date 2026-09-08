import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  isJsonValue,
  isProjectDescriptor,
  isProjectId,
  type ProjectDescriptor,
  type ProjectId,
  type RegisteredProject,
} from "@veyraoss/protocol";
import { acquireLocalLock } from "@veyraoss/runtime";
import { assertUniqueProjectIds, loadProject, openProject, ProjectError } from "./index.js";

export type { RegisteredProject } from "@veyraoss/protocol";

export class RegistryError extends Error {
  override readonly name = "RegistryError";
  constructor(
    readonly code: "invalid_registry" | "invalid_project_id" | "registry_full",
    message: string,
  ) {
    super(message);
  }
}

const MAX_BYTES = 1024 * 1024;
const MAX_PROJECTS = 1000;

/** Locator-only, local-filesystem registry. Always inject root in tests. */
export class ProjectRegistry {
  readonly root: string;
  constructor(options: { root?: string } = {}) {
    const root = options.root ?? join(homedir(), ".veyra");
    if (typeof root !== "string" || !root.trim() || root.includes("\0"))
      throw new RegistryError("invalid_registry", "Registry root must be a local directory.");
    this.root = resolve(root);
  }

  async register(path: string): Promise<RegisteredProject> {
    const project = await openProject(path);
    await this.mutate((projects) => {
      assertUniqueProjectIds([...projects, project]);
      const index = projects.findIndex((item) => item.id === project.id);
      if (index < 0) projects.push(project);
      else projects[index] = project;
      if (projects.length > MAX_PROJECTS)
        throw new RegistryError("registry_full", "Registry is limited to 1000 Projects.");
    });
    return this.inspect(project);
  }

  async unregister(id: ProjectId): Promise<boolean> {
    this.validateId(id);
    let removed = false;
    await this.mutate((projects) => {
      const index = projects.findIndex((project) => project.id === id);
      if (index >= 0) {
        projects.splice(index, 1);
        removed = true;
      }
    });
    return removed;
  }

  async list(options: { signal?: AbortSignal } = {}): Promise<RegisteredProject[]> {
    options.signal?.throwIfAborted();
    const root = await this.directory(false);
    if (!root) return [];
    const projects = await this.read(root);
    // Bounded sequential probes avoid thousands of concurrent file handles.
    const entries: RegisteredProject[] = [];
    for (const project of projects) {
      options.signal?.throwIfAborted();
      entries.push(await this.inspect(project));
    }
    return entries;
  }

  async get(id: ProjectId): Promise<RegisteredProject | undefined> {
    this.validateId(id);
    const root = await this.directory(false);
    if (!root) return;
    const project = (await this.read(root)).find((entry) => entry.id === id);
    return project ? this.inspect(project) : undefined;
  }

  private validateId(id: ProjectId) {
    if (!isProjectId(id)) throw new RegistryError("invalid_project_id", "Expected a Project UUID.");
  }

  private async inspect(project: ProjectDescriptor): Promise<RegisteredProject> {
    try {
      const current = await loadProject(project.root);
      return current.id === project.id
        ? { project: current, status: "available" }
        : { project, status: "stale", reason: "identity_changed" };
    } catch (error) {
      return {
        project,
        status: "stale",
        reason:
          error instanceof ProjectError && error.code === "invalid_path"
            ? "unavailable_path"
            : error instanceof ProjectError && error.code === "project_path_mismatch"
              ? "identity_changed"
              : "invalid_metadata",
      };
    }
  }

  private async directory(create: boolean): Promise<string | undefined> {
    if (create) await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      const stat = await lstat(this.root);
      if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Unsafe directory");
      return await realpath(this.root);
    } catch (error) {
      if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw new RegistryError(
        "invalid_registry",
        "Registry root is inaccessible or linked; preserve it for inspection.",
      );
    }
  }

  private async read(root: string): Promise<ProjectDescriptor[]> {
    const path = join(root, "projects.json");
    try {
      const stat = await lstat(path);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > MAX_BYTES)
        throw new Error("Unsafe registry");
      const file = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      let source: string;
      try {
        const opened = await file.stat();
        // A concurrent rename may unlink the old snapshot after we opened it.
        // O_NOFOLLOW + fstat still validates the file we actually read.
        if (!opened.isFile() || opened.nlink > 1) throw new Error("Registry changed");
        const buffer = Buffer.alloc(MAX_BYTES + 1);
        let length = 0;
        while (length < buffer.length) {
          const read = await file.read(buffer, length, buffer.length - length, null);
          if (!read.bytesRead) break;
          length += read.bytesRead;
        }
        if (length > MAX_BYTES) throw new Error("Oversized registry");
        source = buffer.subarray(0, length).toString("utf8");
      } finally {
        await file.close();
      }
      const value: unknown = JSON.parse(source);
      if (
        !isJsonValue(value) ||
        !value ||
        typeof value !== "object" ||
        Array.isArray(value) ||
        Object.keys(value).length !== 2 ||
        value.version !== 1 ||
        !Array.isArray(value.projects) ||
        value.projects.length > MAX_PROJECTS ||
        !value.projects.every(isProjectDescriptor)
      )
        throw new Error("Invalid registry");
      const projects = value.projects as unknown as ProjectDescriptor[];
      assertUniqueProjectIds(projects);
      if (new Set(projects.map((project) => project.id)).size !== projects.length)
        throw new Error("Duplicate registry entries");
      return projects;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new RegistryError(
        "invalid_registry",
        "Registry is invalid or unsafe; preserve projects.json for inspection.",
      );
    }
  }

  private async mutate(update: (projects: ProjectDescriptor[]) => void) {
    const root = (await this.directory(true)) as string;
    const lock = await acquireLocalLock({
      directory: join(root, ".projects-lock"),
      holder: "project-registry",
      waitMs: 10_000,
      recoverStale: true,
    });
    try {
      const projects = await this.read(root);
      update(projects);
      projects.sort((a, b) => a.id.localeCompare(b.id));
      const source = `${JSON.stringify({ version: 1, projects }, null, 2)}\n`;
      if (Buffer.byteLength(source) > MAX_BYTES)
        throw new RegistryError("registry_full", "Registry is limited to 1 MiB.");
      const temporary = join(root, `.projects-${randomUUID()}.tmp`);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(source);
        await file.sync();
        await file.close();
        await rename(temporary, join(root, "projects.json"));
        const directory = await open(root, constants.O_RDONLY);
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
    } finally {
      await lock.release();
    }
  }
}
