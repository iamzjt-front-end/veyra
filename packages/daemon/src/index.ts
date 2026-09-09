import { randomUUID } from "node:crypto";
import { chmod, lstat, unlink } from "node:fs/promises";
import { connect, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { ProjectRegistry, type RegisteredProject } from "@veyraoss/project";
import {
  isDaemonRequest,
  isDaemonResponse,
  MAX_DAEMON_REQUEST_BYTES,
  MAX_DAEMON_RESPONSE_BYTES,
  type DaemonMethod,
  type DaemonOperations,
  type JsonValue,
} from "@veyraoss/protocol";
import { RunCoordinator, type ExecutionResolver } from "./runs.js";
import { startLoopback, type LoopbackHandle, type LoopbackOptions } from "./loopback.js";
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
export type { ExecutionSetup, ExecutionResolver } from "./runs.js";
export { projectTool, type LocalToolClient } from "./project-tool.js";
export type { LoopbackOptions } from "./loopback.js";
export interface DaemonOptions {
  registryRoot?: string;
  signal?: AbortSignal;
  env?: Readonly<Record<string, string | undefined>>;
  onLog?: (entry: DaemonLog) => void;
  resolveExecution?: ExecutionResolver;
  http?: LoopbackOptions;
  /** Opt-in lazy-service idle shutdown; never interrupts admitted runs. */
  idleTimeoutMs?: number;
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
  http?: Pick<LoopbackHandle, "url" | "pairingFile">;
  stop(): Promise<void>;
}
export type DaemonStatus =
  | { status: "stopped" }
  | { status: "running"; metadata: DaemonMetadata }
  | { status: "unavailable"; message: string };

/** A foreground local service; its launcher/service manager owns the process lifecycle. */
export async function startDaemon(options: DaemonOptions = {}): Promise<DaemonHandle> {
  if (options.signal?.aborted)
    throw new DaemonError("daemon_unavailable", "Daemon start was cancelled.");
  if (
    options.idleTimeoutMs !== undefined &&
    (!Number.isInteger(options.idleTimeoutMs) || options.idleTimeoutMs < 10)
  )
    throw new DaemonError("invalid_request", "Idle timeout must be at least 10 ms.");
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
  const coordinator = new RunCoordinator({
    registry,
    resolveExecution: options.resolveExecution,
    env: options.env,
    onActivity: () => scheduleIdle(),
  });
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
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    if (
      options.idleTimeoutMs &&
      !shutdown &&
      !controller.signal.aborted &&
      !operations.size &&
      !coordinator.activeCount
    )
      idleTimer = setTimeout(() => {
        void stop().catch(() => {});
      }, options.idleTimeoutMs);
  };
  let shutdown: Promise<void> | undefined;
  let http: LoopbackHandle | undefined;
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
    socket.setTimeout(35000, () => socket.destroy());
    let bytes = 0;
    let pending = "";
    let handled = false;
    const reply = (value: unknown) => {
      const source = JSON.stringify(value);
      socket.end(
        `${Buffer.byteLength(source) + 1 <= MAX_DAEMON_RESPONSE_BYTES ? source : JSON.stringify({ version: 1, ok: false, error: { code: "invalid_request", message: "Response exceeds local payload limit." } })}\n`,
      );
    };
    socket.setEncoding("utf8");
    socket.on("data", (chunk: string) => {
      if (handled) return;
      bytes += Buffer.byteLength(chunk);
      if (bytes > MAX_DAEMON_REQUEST_BYTES) {
        handled = true;
        reply(failure("invalid_request", "Daemon request exceeds 256 KiB."));
        return;
      }
      pending += chunk;
      if (!pending.includes("\n")) return;
      handled = true;
      const work = (async () => {
        try {
          const request: unknown = JSON.parse(pending);
          if (!isDaemonRequest(request))
            throw new DaemonError(
              "invalid_request",
              "Unknown or invalid versioned daemon request.",
            );
          let result: unknown;
          switch (request.method) {
            case "health":
              result = metadata;
              break;
            case "stop":
              result = { stopping: true };
              break;
            case "projects.list":
              result = await registry.list({ signal: controller.signal });
              break;
            case "projects.get":
              result = await coordinator.project(request.params.projectId);
              break;
            case "projects.register":
              result = await registry.register(request.params.path);
              break;
            case "runs.dispatch":
              result = await coordinator.dispatch(request.params.projectId, request.params.handoff);
              break;
            case "runs.get":
              result = await coordinator.get(request.params.projectId, request.params.runId);
              break;
            case "runs.wait":
              result = await coordinator.wait(
                request.params.projectId,
                request.params.runId,
                request.params.waitMs,
              );
              break;
            case "runs.cancel":
              result = await coordinator.cancel(request.params.projectId, request.params.runId);
              break;
            case "handoffs.get":
              result = await coordinator.handoff(request.params.projectId, request.params.runId);
              break;
            case "results.get":
              result = await coordinator.result(request.params.projectId, request.params.runId);
              break;
          }
          const response = redactor.json({ version: 1, ok: true, result } as JsonValue, false);
          if (!isDaemonResponse(response, request.method))
            throw new DaemonError(
              "operation_failed",
              "Local operation produced an invalid or oversized response.",
            );
          reply(response);
          if (request.method === "stop")
            socket.once("close", () => {
              void stop().catch(() => {});
            });
        } catch (error) {
          const message =
            error instanceof DaemonError
              ? error.message
              : "Local daemon operation failed; inspect project/registry state and persisted run evidence.";
          await log("daemon.request.failed", message);
          reply(
            failure(
              error instanceof DaemonError ? error.code : "operation_failed",
              redactor.text(message),
            ),
          );
        }
      })();
      operations.add(work);
      scheduleIdle();
      void work
        .finally(() => {
          operations.delete(work);
          scheduleIdle();
        })
        .catch(() => socket.destroy());
    });
  });
  server.maxConnections = 32;
  const stop = (): Promise<void> =>
    (shutdown ??= (async () => {
      clearTimeout(idleTimer);
      controller.abort();
      const executionShutdown = coordinator.stop();
      options.signal?.removeEventListener("abort", onAbort);
      for (const socket of sockets) socket.destroy();
      try {
        await http?.stop();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        await executionShutdown;
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
    if (options.http)
      http = await startLoopback(
        options.http,
        new DaemonClient(options),
        location.directory,
        options.env,
      );
    scheduleIdle();
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
      ...(http ? { http: { url: http.url, pairingFile: http.pairingFile } } : {}),
      stop,
    };
  } catch (error) {
    await http?.stop();
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

export class DaemonClient {
  constructor(private readonly options: { registryRoot?: string } = {}) {}

  async call<M extends DaemonMethod>(
    method: M,
    input: DaemonOperations[M]["input"],
  ): Promise<DaemonOperations[M]["output"]> {
    const request = { version: 1, method, ...(input === undefined ? {} : { params: input }) };
    if (!isDaemonRequest(request))
      throw new DaemonError("invalid_request", "Invalid or oversized versioned daemon request.");
    const location = await locateDaemon(this.options.registryRoot);
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
    return new Promise<DaemonOperations[M]["output"]>((resolve, reject) => {
      const socket = connect(location.socketPath);
      let source = "";
      let bytes = 0;
      let settled = false;
      const finish = (error?: Error, value?: DaemonOperations[M]["output"]) => {
        if (settled) return;
        settled = true;
        socket.destroy();
        if (error) reject(error);
        else resolve(value as DaemonOperations[M]["output"]);
      };
      socket.setEncoding("utf8");
      socket.setTimeout(35000, () =>
        finish(new DaemonError("daemon_unavailable", "Daemon request timed out.")),
      );
      socket.once("error", () =>
        finish(new DaemonError("daemon_unavailable", "Could not reach the local daemon.")),
      );
      socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
      socket.on("data", (chunk: string) => {
        bytes += Buffer.byteLength(chunk);
        source += chunk;
        if (bytes > MAX_DAEMON_RESPONSE_BYTES) {
          finish(new DaemonError("daemon_unavailable", "Daemon response exceeds payload limit."));
          return;
        }
        if (!source.includes("\n")) return;
        try {
          const value: unknown = JSON.parse(source);
          if (!isDaemonResponse(value, method))
            throw new DaemonError("daemon_unavailable", "Invalid or oversized daemon response.");
          if (!value.ok) {
            finish(new DaemonError(value.error.code, value.error.message));
            return;
          }
          finish(undefined, value.result);
        } catch (error) {
          finish(
            error instanceof DaemonError
              ? error
              : new DaemonError("daemon_unavailable", "Invalid daemon JSON response."),
          );
        }
      });
      socket.once("close", () => {
        if (!settled)
          finish(
            new DaemonError("daemon_unavailable", "Daemon connection closed before completion."),
          );
      });
    });
  }
}

export async function daemonStatus(options: { registryRoot?: string } = {}): Promise<DaemonStatus> {
  try {
    const location = await locateDaemon(options.registryRoot);
    const metadata = location ? await readMetadata(location) : undefined;
    if (!metadata || inspectProcessOwner(metadata.owner) === "dead") return { status: "stopped" };
    const result = await new DaemonClient(options).call("health", undefined);
    if (!location || !isDaemonMetadata(result, location) || result.id !== metadata.id)
      throw new Error("Mismatched daemon identity");
    return { status: "running", metadata: result };
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
  return new DaemonClient(options).call("projects.list", undefined);
}
export async function stopDaemon(options: { registryRoot?: string } = {}): Promise<void> {
  if ((await daemonStatus(options)).status === "stopped") return;
  await new DaemonClient(options).call("stop", undefined);
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
