import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseDocument, stringify } from "yaml";
import { isProjectDescriptor, type ProjectDescriptor, type ProjectId } from "@veyraoss/protocol";

export type { ProjectDescriptor, ProjectId } from "@veyraoss/protocol";
export { ProjectRegistry, RegistryError, type RegisteredProject } from "./registry.js";
export { ProjectStateStore, ProjectStateError } from "./state.js";

export class ProjectError extends Error {
  override readonly name = "ProjectError";
  constructor(
    readonly code:
      | "invalid_path"
      | "project_missing"
      | "invalid_project"
      | "project_exists"
      | "project_path_mismatch"
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
  const root = await canonicalDirectory(path);
  await checkStateDirectory(root);
  const metadata = join(root, ".veyra", "project.yaml");
  try {
    const stat = await lstat(metadata);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 65536)
      throw new ProjectError(
        "invalid_project",
        "Project metadata must be a bounded, unlinked regular file.",
      );
    const file = await open(
      metadata,
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    let source: string;
    try {
      const opened = await file.stat();
      if (
        !opened.isFile() ||
        opened.ino !== stat.ino ||
        opened.dev !== stat.dev ||
        opened.nlink !== 1
      )
        throw new Error("Metadata changed while opening");
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
    const project: unknown = document.toJS({ maxAliasCount: 0 });
    if (!isProjectDescriptor(project)) throw new Error("Invalid metadata");
    if (project.root !== root)
      throw new ProjectError(
        "project_path_mismatch",
        "Project moved or its identity was copied: stored root differs from its canonical location. Preserve metadata and resolve the relocation explicitly.",
      );
    return project;
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
