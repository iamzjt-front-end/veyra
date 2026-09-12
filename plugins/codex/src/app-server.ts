import { runProcess, type ProcessRequest, type ProcessRunner } from "@veyraoss/runtime";
import { withSharedAppServer } from "./shared-app-server.js";

export const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export interface AppServerOptions {
  executable: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  runner?: ProcessRunner;
}
export interface Rpc {
  readonly shared?: boolean;
  call(method: string, params: unknown): Promise<unknown>;
  notify(method: string, params?: unknown): void;
  onClose?(cleanup: () => Promise<void>): void;
}
export class NativeApprovalRequired extends Error {
  constructor() {
    super(
      "Codex requires a human decision. Open the selected Codex task; Veyra did not approve it.",
    );
  }
}
/** One owned stdio server. No desktop IPC impersonation, transcript hydration or request replay. */
export async function withAppServer<T>(
  options: AppServerOptions,
  action: (
    rpc: Rpc,
    subscribe: (listener: (method: string, params: unknown) => void) => void,
  ) => Promise<T>,
): Promise<T> {
  // Only a locally configured transport can select a socket. A handoff cannot set this value.
  const socketPath = options.env?.VEYRA_CODEX_SOCKET;
  if (socketPath !== undefined) return withSharedAppServer(socketPath, options, action);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let input: Parameters<NonNullable<ProcessRequest["onStdin"]>>[0] | undefined;
  let sequence = 0;
  let buffer = "";
  let listener: ((method: string, params: unknown) => void) | undefined;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();
  let fail!: (reason: Error) => void;
  const failed = new Promise<never>((_, reject) => {
    fail = reject;
  });
  void failed.catch(() => {});
  let ready!: () => void;
  const started = new Promise<void>((resolve) => {
    ready = resolve;
  });
  const write = (value: unknown) => {
    if (!input) throw new Error("Codex input is unavailable.");
    input.write(`${JSON.stringify(value)}\n`);
  };
  const rpc: Rpc = {
    notify: (method, params) => write({ method, ...(params === undefined ? {} : { params }) }),
    call(method, params) {
      const id = ++sequence;
      const response = new Promise<unknown>((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try {
          write({ id, method, params });
        } catch (error) {
          reject(error);
        }
      });
      return Promise.race([response, failed]);
    },
  };
  const process = (options.runner ?? runProcess)({
    executable: options.executable,
    args: ["app-server"],
    cwd: options.cwd,
    env: options.env,
    signal: controller.signal,
    timeoutMs: options.timeoutMs ?? 10_000,
    maxOutputBytes: 0,
    onStdin(value) {
      input = value;
      ready();
    },
    onStdout(chunk) {
      try {
        buffer += chunk;
        let newline = buffer.indexOf("\n");
        while (newline >= 0) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          newline = buffer.indexOf("\n");
          if (line.length > 1024 * 1024)
            throw new Error("Codex response exceeds the metadata limit.");
          if (!line.trim()) continue;
          const message: unknown = JSON.parse(line);
          if (!record(message)) throw new Error("Invalid Codex response.");
          if (typeof message.method === "string") {
            // Never automatically answer approval, tool or user-input requests.
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
          }
        }
        if (buffer.length > 1024 * 1024)
          throw new Error("Codex response exceeds the metadata limit.");
      } catch (error) {
        fail(error instanceof Error ? error : new Error("Codex protocol failed."));
        abort();
      }
    },
  });
  void process.then(
    (result) =>
      fail(
        new Error(
          result.terminationReason === "timeout"
            ? "Codex native request timed out."
            : options.signal?.aborted
              ? "Codex native request cancelled."
              : "Codex native connection closed; do not replay this task.",
        ),
      ),
    (error: unknown) =>
      fail(error instanceof Error ? error : new Error("Codex native process failed.")),
  );
  try {
    await Promise.race([started, failed]);
    await rpc.call("initialize", {
      clientInfo: { name: "veyra", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    rpc.notify("initialized");
    return await Promise.race([
      action(rpc, (next) => {
        listener = next;
      }),
      failed,
    ]);
  } finally {
    abort();
    await process.catch(() => {});
    pending.clear();
    options.signal?.removeEventListener("abort", abort);
  }
}
