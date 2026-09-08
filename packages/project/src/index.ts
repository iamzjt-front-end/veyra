import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import {
  isProjectDescriptor,
  isProjectBindings,
  type ProjectBindings,
  type ProjectDescriptor,
  type ProjectId,
} from "@veyraoss/protocol";
import { acquireLocalLock } from "@veyraoss/runtime";

export type { ProjectDescriptor, ProjectId } from "@veyraoss/protocol";
export { ProjectRegistry, RegistryError, type RegisteredProject } from "./registry.js";
export { ProjectStateStore, ProjectStateError } from "./state.js";
export { ProjectHandoffStore, ProjectHandoffError } from "./handoffs.js";

export class ProjectError extends Error {
  override readonly name = "ProjectError";
  constructor(
    readonly code:
      | "invalid_path"
      | "project_missing"
      | "invalid_project"
      | "project_exists"
      | "project_path_mismatch"
      | "invalid_bindings"
      | "bindings_conflict"
      | "duplicate_project",
    message: string,
  ) {
    super(message);
  }
}

/** Paths are derived, never supplied by metadata; directories are created only when needed. */
export function projectPaths(project: ProjectDescriptor) {
  if (!isProjectDescriptor(project))
    throw new ProjectError("invalid_project", "Invalid Project descriptor.");
  const directory = join(project.root, ".veyra");
  return {
    directory,
    metadata: join(directory, "project.yaml"),
    state: join(directory, "state.json"),
    context: join(directory, "context"),
    handoffs: join(directory, "handoffs"),
    runs: join(directory, "runs"),
    artifacts: join(directory, "artifacts"),
  };
}

async function canonicalDirectory(path: string) {
  if (typeof path !== "string" || !path.trim() || path.includes("\0"))
    throw new ProjectError("invalid_path", "Project path must name an existing local directory.");
  try {
    const root = await realpath(resolve(path));
    if (!(await lstat(root)).isDirectory()) throw new Error("Not a directory");
    return root;
  } catch {
    throw new ProjectError(
      "invalid_path",
      "Project path does not exist or is not an accessible directory.",
    );
  }
}

async function checkStateDirectory(root: string) {
  const directory = join(root, ".veyra");
  try {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(directory)) !== directory)
      throw new ProjectError(
        "invalid_project",
        "Project .veyra must be a real directory inside its canonical root.",
      );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ProjectError("project_missing", "No Project metadata at this root.");
    throw error;
  }
}

/** Creates identity only, preserving veyra.yaml and all existing application/run files. */
export async function initializeProject(
  path: string,
  options: { name?: string } = {},
): Promise<ProjectDescriptor> {
  const root = await canonicalDirectory(path);
  const project: ProjectDescriptor = {
    version: 1,
    id: randomUUID() as ProjectId,
    name: options.name ?? (basename(root) || root),
    root,
    createdAt: new Date().toISOString(),
  };
  if (!isProjectDescriptor(project))
    throw new ProjectError("invalid_project", "Invalid Project display name.");
  const paths = projectPaths(project);
  await mkdir(paths.directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "EEXIST") throw error;
  });
  await checkStateDirectory(root);
  const temporary = join(paths.directory, `.project-${randomUUID()}.tmp`);
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(stringify(project));
    await file.sync();
    await file.close();
    await checkStateDirectory(root);
    // Publish a complete file exclusively. Concurrent initializers cannot overwrite the winner.
    await link(temporary, paths.metadata);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST")
      throw new ProjectError(
        "project_exists",
        "Project metadata already exists; open the existing Project.",
      );
    throw error;
  } finally {
    await file.close();
    await unlink(temporary);
  }
  return project;
}

/** Loads exactly this root; unlike openProject it does not search ancestors. */
export async function loadProject(path: string): Promise<ProjectDescriptor> {
  return (await readProjectMetadata(path)).project;
}

async function readProjectMetadata(path: string): Promise<{
  project: ProjectDescriptor;
  bindings?: ProjectBindings;
}> {
  const root = await canonicalDirectory(path);
  await checkStateDirectory(root);
  const metadata = join(root, ".veyra", "project.yaml");
  try {
    const file = await open(
      metadata,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let source: string;
    try {
      const opened = await file.stat();
      // An already-open old inode may be unlinked by a concurrent atomic binding update.
      if (!opened.isFile() || opened.nlink > 1 || opened.size > 65536)
        throw new Error("Unsafe metadata");
      const buffer = Buffer.alloc(65537);
      let length = 0;
      while (length < buffer.length) {
        const read = await file.read(buffer, length, buffer.length - length, null);
        if (!read.bytesRead) break;
        length += read.bytesRead;
      }
      if (length > 65536) throw new Error("Metadata too large");
      source = buffer.subarray(0, length).toString("utf8");
    } finally {
      await file.close();
    }
    await checkStateDirectory(root);
    const document = parseDocument(source, { uniqueKeys: true });
    if (document.errors.length) throw new Error("Invalid YAML");
    const value: unknown = document.toJS({ maxAliasCount: 0 });
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid metadata");
    const { bindings, ...project } = value as Record<string, unknown>;
    if (!isProjectDescriptor(project)) throw new Error("Invalid metadata");
    if (
      bindings !== undefined &&
      (!isProjectBindings(bindings) || bindings.projectId !== project.id)
    )
      throw new Error("Invalid bindings");
    if (project.root !== root)
      throw new ProjectError(
        "project_path_mismatch",
        "Project moved or its identity was copied: stored root differs from its canonical location. Preserve metadata and resolve the relocation explicitly.",
      );
    return { project, ...(bindings ? { bindings: bindings as ProjectBindings } : {}) };
  } catch (error) {
    if (error instanceof ProjectError) throw error;
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      throw new ProjectError("project_missing", "No Project metadata at this root.");
    // Parser diagnostics may include user data. Do not echo raw metadata.
    throw new ProjectError(
      "invalid_project",
      "Project metadata is unreadable, invalid or unsafe; preserve it for inspection.",
    );
  }
}

export async function loadProjectBindings(
  project: ProjectDescriptor,
): Promise<ProjectBindings | undefined> {
  projectPaths(project);
  const current = await readProjectMetadata(project.root);
  if (current.project.id !== project.id)
    throw new ProjectError("invalid_project", "Project identity changed; reopen the Project.");
  return current.bindings;
}

/** Compare-and-swap role configuration without copying it into the global locator registry. */
export async function saveProjectBindings(
  project: ProjectDescriptor,
  roles: ProjectBindings["roles"],
  expectedRevision: number,
): Promise<ProjectBindings> {
  const paths = projectPaths(project);
  const next: ProjectBindings = {
    version: 1,
    projectId: project.id,
    roles,
    revision: expectedRevision + 1,
    updatedAt: new Date().toISOString(),
  };
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || !isProjectBindings(next))
    throw new ProjectError(
      "invalid_bindings",
      "Expected bounded role bindings and a non-negative revision.",
    );
  // Freeze the caller's mutable input before yielding or acquiring a lock.
  const saved: ProjectBindings = JSON.parse(JSON.stringify(next));
  await loadProjectBindings(project);
  const lock = await acquireLocalLock({
    directory: join(paths.directory, ".project-lock"),
    holder: project.id,
    waitMs: 10000,
    recoverStale: true,
  });
  try {
    const current = await readProjectMetadata(project.root);
    if (current.project.id !== project.id)
      throw new ProjectError("invalid_project", "Project identity changed; reopen the Project.");
    if ((current.bindings?.revision ?? 0) !== expectedRevision)
      throw new ProjectError(
        "bindings_conflict",
        "Project bindings changed; reload before saving.",
      );
    const source = stringify({ ...current.project, bindings: saved });
    if (Buffer.byteLength(source) > 65536)
      throw new ProjectError("invalid_bindings", "Project metadata exceeds its size limit.");
    const temporary = join(paths.directory, `.project-${randomUUID()}.tmp`);
    const file = await open(temporary, "wx", 0o600);
    try {
      await file.writeFile(source);
      await file.sync();
      await file.close();
      await loadProjectBindings(project);
      await rename(temporary, paths.metadata);
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
    return saved;
  } finally {
    await lock.release();
  }
}

/** Nearest initialized physical ancestor; symlink aliases resolve before traversal. */
export async function openProject(from: string): Promise<ProjectDescriptor> {
  let root = await canonicalDirectory(from);
  for (;;) {
    try {
      return await loadProject(root);
    } catch (error) {
      if (!(error instanceof ProjectError) || error.code !== "project_missing") throw error;
    }
    const parent = dirname(root);
    if (parent === root)
      throw new ProjectError(
        "project_missing",
        "No initialized Project in this directory or its ancestors.",
      );
    root = parent;
  }
}

/** Explicit collection check; no hidden global cache or cross-project filesystem scan. */
export function assertUniqueProjectIds(projects: readonly ProjectDescriptor[]): void {
  const ids = new Map<ProjectId, string>();
  const roots = new Map<string, ProjectId>();
  for (const project of projects) {
    if (!isProjectDescriptor(project))
      throw new ProjectError("invalid_project", "Invalid Project descriptor.");
    if (
      (ids.has(project.id) && ids.get(project.id) !== project.root) ||
      (roots.has(project.root) && roots.get(project.root) !== project.id)
    )
      throw new ProjectError(
        "duplicate_project",
        "Project identity conflicts with another canonical location or identity.",
      );
    ids.set(project.id, project.root);
    roots.set(project.root, project.id);
  }
}
