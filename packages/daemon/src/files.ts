import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { ProjectRegistry } from "@veyraoss/project";
import { isJsonValue } from "@veyraoss/protocol";
import { isProcessOwner, type ProcessOwner } from "@veyraoss/runtime";

export class DaemonError extends Error {
  override readonly name = "DaemonError";
  constructor(
    readonly code:
      "daemon_unavailable" | "daemon_running" | "invalid_daemon_state" | "invalid_request",
    message: string,
  ) {
    super(message);
  }
}
export interface DaemonMetadata {
  version: 1;
  id: string;
  owner: ProcessOwner;
  registryRoot: string;
  socketPath: string;
  startedAt: string;
}
export interface DaemonLocation {
  registryRoot: string;
  directory: string;
  socketDirectory: string;
  socketPath: string;
  metadata: string;
  log: string;
}

export async function privateDirectory(path: string, create: boolean): Promise<boolean> {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  try {
    const stat = await lstat(path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.uid !== process.getuid?.() ||
      (stat.mode & 0o077) !== 0
    )
      throw new Error("Not a private directory");
    return true;
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new DaemonError(
      "invalid_daemon_state",
      "Daemon directory must be an unlinked directory owned by this user with mode 0700.",
    );
  }
}
export async function locateDaemon(
  registryRoot: string | undefined,
  create = false,
): Promise<DaemonLocation | undefined> {
  if (process.platform === "win32" || !process.getuid)
    throw new DaemonError("daemon_unavailable", "Local daemon currently supports macOS/Linux.");
  const requested = new ProjectRegistry(registryRoot === undefined ? {} : { root: registryRoot })
    .root;
  if (create) await mkdir(requested, { recursive: true, mode: 0o700 });
  let root: string;
  try {
    const stat = await lstat(requested);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Invalid registry root");
    root = await realpath(requested);
  } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw new DaemonError("invalid_daemon_state", "Registry root is inaccessible or linked.");
  }
  const directory = join(root, "daemon");
  if (!(await privateDirectory(directory, create))) return;
  // macOS has a short Unix socket path limit. Keep the socket in a user-private
  // short /tmp directory; durable discovery/state stays at the registry root.
  const socketDirectory = join(await realpath("/tmp"), `veyra-${process.getuid()}`);
  const socketPath = join(
    socketDirectory,
    `${createHash("sha256").update(root).digest("hex").slice(0, 32)}.sock`,
  );
  return {
    registryRoot: root,
    directory,
    socketDirectory,
    socketPath,
    metadata: join(directory, "daemon.json"),
    log: join(directory, "daemon.jsonl"),
  };
}
export function isDaemonMetadata(
  value: unknown,
  location: DaemonLocation,
): value is DaemonMetadata {
  if (!isJsonValue(value) || !value || typeof value !== "object" || Array.isArray(value))
    return false;
  return (
    Object.keys(value).length === 6 &&
    value.version === 1 &&
    typeof value.id === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(value.id) &&
    isProcessOwner(value.owner) &&
    value.registryRoot === location.registryRoot &&
    value.socketPath === location.socketPath &&
    typeof value.startedAt === "string" &&
    Number.isFinite(Date.parse(value.startedAt))
  );
}
export async function readPrivate(path: string, maxBytes: number): Promise<string | undefined> {
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.nlink > 1 ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        stat.size > maxBytes
      )
        throw new Error("Unsafe metadata");
      const buffer = Buffer.alloc(maxBytes + 1);
      let length = 0;
      while (length < buffer.length) {
        const result = await file.read(buffer, length, buffer.length - length, null);
        if (!result.bytesRead) break;
        length += result.bytesRead;
      }
      if (length > maxBytes) throw new Error("Oversized metadata");
      return buffer.subarray(0, length).toString("utf8");
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
    throw new DaemonError(
      "invalid_daemon_state",
      "Daemon metadata is invalid or unsafe; preserve it for inspection.",
    );
  }
}
export async function readMetadata(location: DaemonLocation): Promise<DaemonMetadata | undefined> {
  const source = await readPrivate(location.metadata, 8192);
  if (source === undefined) return;
  try {
    const value: unknown = JSON.parse(source);
    if (isDaemonMetadata(value, location)) return value;
  } catch {
    /* Do not echo raw metadata. */
  }
  throw new DaemonError(
    "invalid_daemon_state",
    "Daemon discovery metadata is invalid; preserve it for inspection.",
  );
}
export async function writePrivate(path: string, source: string) {
  await readPrivate(path, 65536);
  const temporary = `${path}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx", 0o600);
  try {
    await file.writeFile(source);
    await file.sync();
    await file.close();
    await rename(temporary, path);
  } finally {
    await file.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}
