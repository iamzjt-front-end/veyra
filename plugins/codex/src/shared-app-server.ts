import { lstat } from "node:fs/promises";
import { createConnection } from "node:net";
import { dirname, isAbsolute } from "node:path";
import WebSocket from "ws";
import { NativeApprovalRequired, record, type AppServerOptions, type Rpc } from "./app-server.js";

/** Public app-server WebSocket protocol over a private Unix socket; never desktop private IPC. */
export async function withSharedAppServer<T>(
  socketPath: string,
  options: AppServerOptions,
  action: (
    rpc: Rpc,
    subscribe: (listener: (method: string, params: unknown) => void) => void,
  ) => Promise<T>,
): Promise<T> {
  if (
    !isAbsolute(socketPath) ||
    Buffer.byteLength(socketPath) >= 104 ||
    [...socketPath].some((character) => character.charCodeAt(0) < 32)
  )
    throw new Error("Shared Codex requires an absolute local socket path.");
  const [socket, parent] = await Promise.all([lstat(socketPath), lstat(dirname(socketPath))]);
  if (
    !socket.isSocket() ||
    socket.uid !== process.getuid?.() ||
    socket.mode & 0o077 ||
    !parent.isDirectory() ||
    parent.isSymbolicLink() ||
    parent.uid !== process.getuid?.() ||
    parent.mode & 0o077
  )
    throw new Error("Shared Codex socket must be private and owned by this user.");
  if (options.signal?.aborted) throw new Error("Codex native request cancelled.");
  const ws = new WebSocket("ws://localhost/rpc", {
    createConnection: () => createConnection(socketPath),
    maxPayload: 1024 * 1024,
    perMessageDeflate: false,
    handshakeTimeout: 5000,
  });
  let sequence = 0;
  let cleaning = false;
  let listener: ((method: string, params: unknown) => void) | undefined;
  const cleanups: (() => Promise<void>)[] = [];
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let fail!: (error: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  void failed.catch(() => {});
  const closed = new Promise<void>((resolve) => ws.once("close", resolve));
  const write = (value: unknown) => {
    if (ws.readyState !== WebSocket.OPEN) throw new Error("Shared Codex connection is closed.");
    ws.send(JSON.stringify(value));
  };
  const rpc: Rpc = {
    shared: true,
    onClose: (cleanup) => cleanups.push(cleanup),
    notify: (method, params) => write({ method, ...(params === undefined ? {} : { params }) }),
    call(method, params) {
      const id = ++sequence;
      const response = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          write({ id, method, params });
        } catch (error) {
          pending.delete(id);
          reject(error);
        }
      });
      if (!cleaning) return Promise.race([response, failed]);
      // Interrupt only an acknowledged owned turn before detaching; a shared server is never killed.
      let timer: ReturnType<typeof setTimeout>;
      const deadline = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Codex stop acknowledgement timed out.")), 3000);
      });
      return Promise.race([response, deadline]).finally(() => clearTimeout(timer));
    },
  };
  ws.on("message", (data, binary) => {
    try {
      if (binary) throw new Error("Unexpected binary Codex response.");
      const message: unknown = JSON.parse(data.toString());
      if (!record(message)) throw new Error("Invalid Codex response.");
      if (typeof message.method === "string") {
        if (message.id !== undefined) throw new NativeApprovalRequired();
        listener?.(message.method, message.params);
      } else if (typeof message.id === "number") {
        const waiting = pending.get(message.id);
        if (!waiting) throw new Error("Codex response identity mismatch.");
        pending.delete(message.id);
        if (record(message.error))
          waiting.reject(new Error(String(message.error.message).slice(0, 512)));
        else if ("result" in message) waiting.resolve(message.result);
        else throw new Error("Incomplete Codex response.");
      } else throw new Error("Codex response has no identity.");
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Codex protocol failed."));
    }
  });
  const disconnect = () => {
    const error = new Error(
      "Shared Codex connection closed; execution may continue. Do not replay this task.",
    );
    for (const request of pending.values()) request.reject(error);
    pending.clear();
    fail(error);
  };
  ws.on("error", disconnect);
  ws.on("close", disconnect);
  const abort = () => fail(new Error("Codex native request cancelled."));
  options.signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(
    () => fail(new Error("Codex native request timed out.")),
    options.timeoutMs ?? 10_000,
  );
  let result!: T;
  let failure: unknown;
  let rejected = false;
  try {
    if (options.signal?.aborted) abort();
    await Promise.race([new Promise<void>((resolve) => ws.once("open", resolve)), failed]);
    await rpc.call("initialize", {
      clientInfo: { name: "veyra", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    result = await Promise.race([
      action(rpc, (next) => {
        listener = next;
      }),
      failed,
    ]);
  } catch (error) {
    rejected = true;
    failure = error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
    cleaning = true;
    try {
      for (const cleanup of cleanups) await cleanup();
    } catch {
      rejected = true;
      failure = new Error(
        "Codex stop could not be confirmed. Inspect the selected task; nothing will be replayed.",
      );
    } finally {
      ws.terminate();
      await closed;
      pending.clear();
    }
  }
  if (rejected) throw failure;
  return result;
}
