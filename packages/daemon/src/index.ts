import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ProjectRegistry, type RegisteredProject } from "@veyraoss/project";
import { isJsonValue, isProjectDescriptor } from "@veyraoss/protocol";
import {
  acquireLocalLock,
  createSecretRedactor,
  currentProcessOwner,
  inspectProcessOwner,
} from "@veyraoss/runtime";
import {
  DaemonError,
  isDaemonMetadata,
  locateDaemon,
  privateDirectory,
  readMetadata,
  writePrivate,
  type DaemonLocation,
  type DaemonMetadata,
} from "./files.js";

export { DaemonError, type DaemonMetadata } from "./files.js";
export interface DaemonOptions {
  registryRoot?: string;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  onLog?: (entry: DaemonLog) => void;
}
export interface DaemonLog {
  at: string;
  type: "daemon.ready" | "daemon.stopping" | "daemon.request.failed";
  message: string;
}
export interface DaemonHandle {
  metadata: DaemonMetadata;
  closed: Promise<void>;
  signal: AbortSignal;
  stop(): Promise<void>;
}
export type DaemonStatus =
  | { status: "stopped" }
  | { status: "running"; metadata: DaemonMetadata }
  | { status: "unavailable"; message: string };
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
type LifecycleMethod = "health" | "projects.list" | "stop";

/** A foreground local service; its launcher/service manager owns the process lifecycle. */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  if (options.signal?.aborted)
    throw new DaemonError("daemon_unavailable", "Daemon start was cancelled.");
  const location = (await locateDaemon(options.registryRoot, true)) as DaemonLocation;
  const lock = await acquireLocalLock({
    directory: join(location.directory, ".instance-lock"),
    holder: "veyra-daemon",
    waitMs: 100,
    recoverStale: true,
  }).catch(() => {
    throw new DaemonError(
      "daemon_running",
      "A daemon owns this registry root; inspect ve daemon status before retrying.",
    );
  });
  const registry = new ProjectRegistry({ root: location.registryRoot });
  const metadata: DaemonMetadata = {
    version: 1,
    id: randomUUID(),
    owner: currentProcessOwner(),
    registryRoot: location.registryRoot,
    socketPath: location.socketPath,
    startedAt: new Date().toISOString(),
  };
  const redactor = createSecretRedactor({ env: options.env });
  const records: DaemonLog[] = [];
  let logging: Promise<void> | undefined;
  let logDirty = false;
  const log = (type: DaemonLog["type"], message: string) => {
    const entry: DaemonLog = {
      at: new Date().toISOString(),
      type,
      message: redactor.text(message).slice(0, 512),
    };
    records.push(entry);
    if (records.length > 64) records.shift();
    logDirty = true;
    logging ??= (async () => {
      while (logDirty) {
        logDirty = false;
        await writePrivate(
          location.log,
          `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
        );
      }
    })().finally(() => {
      logging = undefined;
    });
    try {
      options.onLog?.({ ...entry });
    } catch {
      /* A rendering callback cannot control daemon lifecycle. */
    }
    return logging;
  };
  const controller = new AbortController();
  const sockets = new Set<Socket>();
  const operations = new Set<Promise<void>>();
  let shutdown: Promise<void> | undefined;
  let resolveClosed: () => void = () => {};
  const closed = new Promise<void>((resolve) => {
    resolveClosed = resolve;
  });
  const server = createServer((socket) => {
    if (operations.size >= 32) {
      socket.on("error", () => {});
      socket.end(
        `${JSON.stringify(failure("daemon_unavailable", "Daemon is busy; retry later."))}\n`,
      );
      return;
    }
    sockets.add(socket);
    socket.on("error", () => {});
    socket.once("close", () => sockets.delete(socket));
    socket.setTimeout(10000, () => socket.destroy());
    let bytes = 0;
    let pending = "";
    let handled = false;
    const reply = (value: unknown) => {
      const source = JSON.stringify(value);
      socket.end(
        `${Buffer.byteLength(source) <= MAX_RESPONSE_BYTES ? source : JSON.stringify({ version: 1, ok: false, error: { code: "invalid_request", message: "Response exceeds local payload limit." } })}\n`,
      );
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024) {
        handled = true;
        reply(failure("invalid_request", "Lifecycle request exceeds 1 KiB."));
        return;
      }
      pending += chunk;
      if (!pending.includes("\n")) return;
      handled = true;
      const work = (async () => {
        try {
          const request: unknown = JSON.parse(pending);
          if (
            !isJsonValue(request) ||
            !request ||
            typeof request !== "object" ||
            Array.isArray(request) ||
            Object.keys(request).length !== 2 ||
            request.version !== 1 ||
            !["health", "projects.list", "stop"].includes(String(request.method))
          )
            throw new DaemonError(
              "invalid_request",
              "Unknown or invalid daemon lifecycle request.",
            );
          const result =
            request.method === "health"
              ? metadata
              : request.method === "projects.list"
                ? await registry.list({ signal: controller.signal })
                : { stopping: true };
          reply({ version: 1, ok: true, result });
          if (request.method === "stop")
            socket.once("close", () => {
              void stop().catch(() => {});
            });
        } catch (error) {
          const message =
            error instanceof DaemonError
              ? error.message
              : "Local daemon operation failed; inspect project/registry metadata.";
          await log("daemon.request.failed", message);
          reply(
            failure(
              error instanceof DaemonError ? error.code : "daemon_unavailable",
              redactor.text(message),
            ),
          );
        }
      })();
      operations.add(work);
      void work.finally(() => operations.delete(work)).catch(() => socket.destroy());
    });
  });
  server.maxConnections = 32;
  const stop = (): Promise<void> =>
    (shutdown ??= (async () => {
      controller.abort();
      options.signal?.removeEventListener("abort", onAbort);
      for (const socket of sockets) socket.destroy();
      try {
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await Promise.allSettled([...operations]);
        await log(
          "daemon.stopping",
          "Local daemon stopped; Project state remains at its Project roots.",
        );
      } finally {
        try {
          if ((await readMetadata(location))?.id === metadata.id) await unlink(location.metadata);
        } finally {
          try {
            await lock.release();
          } finally {
            resolveClosed();
          }
        }
      }
    })());
  const onAbort = () => {
    void stop().catch(() => {});
  };
  try {
    const previous = await readMetadata(location);
    if (previous && inspectProcessOwner(previous.owner) !== "dead")
      throw new DaemonError(
        "daemon_running",
        "Discovery belongs to a live or unknown owner; refusing replacement.",
      );
    await privateDirectory(location.socketDirectory, true);
    try {
      const socket = await lstat(location.socketPath);
      if (!socket.isSocket() || socket.uid !== process.getuid?.())
        throw new DaemonError("invalid_daemon_state", "Refusing an unexpected socket path.");
      // Only a dead recorded owner permits stale socket removal.
      if (!previous)
        throw new DaemonError(
          "invalid_daemon_state",
          "Socket exists without discovery metadata; preserve it for inspection.",
        );
      await unlink(location.socketPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(location.socketPath, () => {
        server.removeListener("error", reject);
        resolve();
      });
    });
    server.on("error", () => {
      void stop().catch(() => {});
    });
    await chmod(location.socketPath, 0o600);
    await writePrivate(location.metadata, `${JSON.stringify(metadata)}\n`);
    await log(
      "daemon.ready",
      "Local daemon ready; no provider authentication or cloud service required.",
    );
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) await stop();
    return {
      metadata: { ...metadata, owner: { ...metadata.owner } },
      closed,
      signal: controller.signal,
      stop,
    };
  } catch (error) {
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    if ((await readMetadata(location).catch(() => undefined))?.id === metadata.id)
      await unlink(location.metadata);
    await lock.release();
    throw error;
  }
}

function failure(code: string, message: string) {
  return { version: 1, ok: false, error: { code, message } };
}

async function requestDaemon(
  method: LifecycleMethod,
  registryRoot?: string,
): Promise<{ result: unknown; location: DaemonLocation }> {
  const location = await locateDaemon(registryRoot);
  const metadata = location ? await readMetadata(location) : undefined;
  if (!location || !metadata || inspectProcessOwner(metadata.owner) === "dead")
    throw new DaemonError(
      "daemon_unavailable",
      "No running daemon. Start ve daemon start for this registry root.",
    );
  if (!(await privateDirectory(location.socketDirectory, false)))
    throw new DaemonError("daemon_unavailable", "Daemon socket directory is missing.");
  const stat = await lstat(location.socketPath).catch(() => undefined);
  if (!stat?.isSocket() || stat.uid !== process.getuid?.() || (stat.mode & 0o077) !== 0)
    throw new DaemonError("daemon_unavailable", "Daemon socket is missing or unsafe.");
  const result = await new Promise<unknown>((resolve, reject) => {
    const socket = connect(location.socketPath);
    let source = "";
    let bytes = 0;
    let settled = false;
    const finish = (error?: Error, value?: unknown) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(10000, () =>
      finish(new DaemonError("daemon_unavailable", "Daemon request timed out.")),
    );
    socket.once("error", () =>
      finish(new DaemonError("daemon_unavailable", "Could not reach the local daemon.")),
    );
    socket.once("connect", () => socket.write(`${JSON.stringify({ version: 1, method })}\n`));
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      source += chunk;
      if (bytes > MAX_RESPONSE_BYTES) {
        finish(new DaemonError("daemon_unavailable", "Daemon response exceeds payload limit."));
        return;
      }
      if (!source.includes("\n")) return;
      try {
        const value = JSON.parse(source);
        if (
          !isJsonValue(value) ||
          !value ||
          typeof value !== "object" ||
          Array.isArray(value) ||
          value.version !== 1 ||
          typeof value.ok !== "boolean"
        )
          throw new Error("Invalid response");
        if (!value.ok)
          throw new DaemonError("daemon_unavailable", "Local daemon operation failed.");
        finish(undefined, value.result);
      } catch {
        finish(new DaemonError("daemon_unavailable", "Invalid or failed local daemon response."));
      }
    });
    socket.once("close", () => {
      if (!settled)
        finish(
          new DaemonError("daemon_unavailable", "Daemon connection closed before completion."),
        );
    });
  });
  return { result, location };
}

export async function daemonStatus(options: { registryRoot?: string } = {}): Promise<DaemonStatus> {
  try {
    const location = await locateDaemon(options.registryRoot);
    const metadata = location ? await readMetadata(location) : undefined;
    if (!metadata || inspectProcessOwner(metadata.owner) === "dead") return { status: "stopped" };
    const reply = await requestDaemon("health", options.registryRoot);
    if (!isDaemonMetadata(reply.result, reply.location) || reply.result.id !== metadata.id)
      throw new Error("Mismatched daemon identity");
    return { status: "running", metadata: reply.result };
  } catch {
    return {
      status: "unavailable",
      message: "Daemon is unreachable or discovery metadata is unsafe; preserve it for inspection.",
    };
  }
}
export async function daemonProjects(
  options: { registryRoot?: string } = {},
): Promise<RegisteredProject[]> {
  const { result } = await requestDaemon("projects.list", options.registryRoot);
  if (
    !Array.isArray(result) ||
    result.length > 1000 ||
    !result.every(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        isProjectDescriptor(entry.project) &&
        ["available", "stale"].includes(entry.status) &&
        Object.keys(entry).every((key) => ["project", "status", "reason"].includes(key)),
    )
  )
    throw new DaemonError("daemon_unavailable", "Daemon returned an invalid Project list.");
  return result;
}
export async function stopDaemon(options: { registryRoot?: string } = {}): Promise<void> {
  if ((await daemonStatus(options)).status === "stopped") return;
  const { result } = await requestDaemon("stop", options.registryRoot);
  if (!result || typeof result !== "object" || !("stopping" in result) || result.stopping !== true)
    throw new DaemonError("daemon_unavailable", "Daemon did not acknowledge shutdown.");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const location = await locateDaemon(options.registryRoot);
    if (!location || !(await readMetadata(location))) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new DaemonError(
    "daemon_unavailable",
    "Daemon shutdown did not complete within 10 seconds.",
  );
}
