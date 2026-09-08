import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

export class WorkspaceError extends Error {
  override readonly name = "WorkspaceError";
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export interface WorkspaceLease {
  release(): Promise<void>;
}

/** A cooperative workspace lease, not a sandbox or the general run-state lock. */
export async function acquireWorkspaceLease(
  parent: string,
  root: string,
  runId: string,
  recoverInterrupted = false,
): Promise<WorkspaceLease> {
  const path = join(parent, "veyra-workspace.lock");
  const guard = `${path}.guard`;
  const token = randomUUID();
  const owner = { pid: process.pid, runId, root, token };
  await guarded(guard, async () => {
    if (await exists(path)) {
      const previous = await readOwner(path);
      if (
        !recoverInterrupted ||
        previous.runId !== runId ||
        previous.root !== root ||
        !dead(previous.pid)
      )
        throw new WorkspaceError(
          "workspace_busy",
          `Workspace ${root} is owned by run ${previous.runId} (PID ${previous.pid}). Wait for it to stop; interrupted runs require explicit recovery.`,
        );
      // Every acquire/release uses the guard, so stale retirement cannot delete a new owner.
      await rm(path, { recursive: true });
    }
    await mkdir(path, { mode: 0o700 });
    try {
      await writeFile(join(path, "owner.json"), JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    } catch (error) {
      await rm(path, { recursive: true });
      throw error;
    }
  });
  let released = false;
  return {
    async release() {
      if (released) return;
      await guarded(guard, async () => {
        const current = await readOwner(path);
        if (current.token !== token || current.pid !== process.pid)
          throw new WorkspaceError(
            "workspace_lease_changed",
            `Workspace lease changed at ${path}; preserve it for inspection.`,
          );
        await rm(path, { recursive: true });
        released = true;
      });
    },
  };
}

async function guarded<T>(path: string, operation: () => Promise<T>): Promise<T> {
  let acquired = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await mkdir(path, { mode: 0o700 });
      acquired = true;
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if ((await lstat(path)).isSymbolicLink())
        throw new WorkspaceError(
          "invalid_workspace_lease",
          `Refusing a linked lease guard at ${path}.`,
        );
      await delay(20);
    }
  }
  if (!acquired)
    throw new WorkspaceError(
      "workspace_guard_busy",
      `Workspace lease update is busy at ${path}. If its process crashed, inspect and remove only that stale guard before retrying.`,
    );
  try {
    return await operation();
  } finally {
    await rm(path, { recursive: true });
  }
}

async function readOwner(path: string) {
  const file = join(path, "owner.json");
  if (!(await lstat(path)).isDirectory() || (await lstat(path)).isSymbolicLink())
    throw new WorkspaceError("invalid_workspace_lease", `Invalid workspace lease at ${path}.`);
  const stat = await lstat(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536)
    throw new WorkspaceError(
      "invalid_workspace_lease",
      `Invalid workspace lease owner at ${file}.`,
    );
  const value = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.pid) ||
    (value.pid as number) < 1 ||
    typeof value.runId !== "string" ||
    typeof value.root !== "string" ||
    typeof value.token !== "string"
  )
    throw new WorkspaceError(
      "invalid_workspace_lease",
      `Invalid workspace lease owner at ${file}.`,
    );
  return value as { pid: number; runId: string; root: string; token: string };
}

function dead(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

export async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
