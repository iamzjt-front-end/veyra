import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

export const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export interface ProcessRequest {
  executable: string;
  args?: readonly string[];
  /** Optional UTF-8 input, capped at 1 MiB, followed by EOF. */
  stdin?: string;
  cwd?: string;
  /** Inherit the current environment; undefined removes an inherited variable. */
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Maximum retained raw bytes per stream. Streaming continues after this limit. */
  maxOutputBytes?: number;
  terminationGraceMs?: number;
  /** Synchronous callbacks, receiving decoded UTF-8 chunks. */
  onStdout?: (chunk: string) => void;
  onStderr?: (chunk: string) => void;
}

export interface ProcessResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
  durationMs: number;
  terminationReason?: "timeout" | "cancelled";
}

export type ProcessRunner = (request: ProcessRequest) => Promise<ProcessResult>;

export class ProcessExecutionError extends Error {
  override readonly name = "ProcessExecutionError";

  constructor(
    readonly code:
      | "invalid_request"
      | "invalid_cwd"
      | "executable_not_found"
      | "spawn_failed"
      | "stdin_failed"
      | "output_callback_failed"
      | "termination_failed",
    message: string,
    readonly systemCode?: string,
    readonly result?: ProcessResult,
  ) {
    super(message);
  }
}

/** Execute one local program without a shell; no provider or workflow policy lives here. */
export const runProcess: ProcessRunner = async (request) => {
  validateRequest(request);
  if (request.cwd !== undefined) {
    try {
      if (!(await stat(request.cwd)).isDirectory()) throw new Error("not a directory");
    } catch (error) {
      throw new ProcessExecutionError(
        "invalid_cwd",
        "Working directory is unavailable.",
        codeOf(error),
      );
    }
  }

  const start = performance.now();
  const limit = request.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const stdout = new RetainedOutput(limit);
  const stderr = new RetainedOutput(limit);
  if (request.signal?.aborted) {
    return {
      exitCode: null,
      signal: null,
      stdout: "",
      stderr: "",
      stdoutTruncated: false,
      stderrTruncated: false,
      durationMs: 0,
      terminationReason: "cancelled",
    };
  }

  return new Promise((resolve, reject) => {
    const child = spawn(request.executable, [...(request.args ?? [])], {
      cwd: request.cwd,
      env: { ...process.env, ...request.env },
      shell: false,
      detached: process.platform !== "win32",
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let closed = false;
    let stopping = false;
    let cleanupFinished = false;
    let exitCode: number | null = null;
    let exitSignal: NodeJS.Signals | null = null;
    let terminationReason: ProcessResult["terminationReason"];
    let failure: ProcessExecutionError | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;

    function finish() {
      if (!closed || (stopping && !cleanupFinished)) return;
      clearTimeout(timeout);
      clearTimeout(escalation);
      request.signal?.removeEventListener("abort", abort);
      const result: ProcessResult = {
        exitCode,
        signal: exitSignal,
        stdout: stdout.text(),
        stderr: stderr.text(),
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
        durationMs: Math.max(0, performance.now() - start),
        ...(terminationReason ? { terminationReason } : {}),
      };
      if (failure) {
        reject(
          new ProcessExecutionError(failure.code, failure.message, failure.systemCode, result),
        );
      } else {
        resolve(result);
      }
    }

    function signalChild(signal: NodeJS.Signals) {
      if (!child.pid) return;
      try {
        if (process.platform === "win32") child.kill(signal);
        else process.kill(-child.pid, signal);
      } catch (error) {
        if (codeOf(error) !== "ESRCH") {
          return new ProcessExecutionError(
            "termination_failed",
            "Unable to terminate the local process group.",
            codeOf(error),
          );
        }
      }
    }

    function escalate(reapRetries = 0) {
      const cleanupFailure = signalChild("SIGKILL");
      // macOS may report EPERM for a group awaiting reaping even after SIGTERM
      // succeeded. Yield to child-exit handling before retrying the same group.
      if (
        process.platform === "darwin" &&
        cleanupFailure?.systemCode === "EPERM" &&
        reapRetries < 5
      ) {
        escalation = setTimeout(() => escalate(reapRetries + 1), 10);
        return;
      }
      failure ??= cleanupFailure;
      cleanupFinished = true;
      finish();
    }

    function stop(reason?: ProcessResult["terminationReason"]) {
      if (stopping) return;
      stopping = true;
      terminationReason = reason;
      clearTimeout(timeout);
      if (process.platform === "win32" && child.pid) {
        const taskkill = spawn(
          join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/PID", String(child.pid), "/T", "/F"],
          { windowsHide: true, stdio: "ignore", timeout: 5000 },
        );
        let taskkillError: string | undefined;
        taskkill.once("error", (error) => {
          taskkillError = codeOf(error);
        });
        taskkill.once("close", (code) => {
          if (code !== 0) {
            failure ??= new ProcessExecutionError(
              "termination_failed",
              "Windows process-tree termination failed; only direct-child cleanup was attempted.",
              taskkillError,
            );
            signalChild("SIGKILL");
            child.stdout.destroy();
            child.stderr.destroy();
          }
          cleanupFinished = true;
          finish();
        });
        return;
      }
      signalChild("SIGTERM");
      // Keep escalation even if the leader closes first: descendants may ignore SIGTERM.
      escalation = setTimeout(() => escalate(), request.terminationGraceMs ?? 500);
    }

    function abort() {
      stop("cancelled");
    }

    function forward(callback: ProcessRequest["onStdout"], chunk: string) {
      if (!callback || !chunk || failure) return;
      try {
        callback(chunk);
      } catch {
        failure = new ProcessExecutionError(
          "output_callback_failed",
          "Process output callback failed.",
        );
        stop();
      }
    }

    child.stdout.on("data", (chunk: Buffer) => forward(request.onStdout, stdout.append(chunk)));
    child.stderr.on("data", (chunk: Buffer) => forward(request.onStderr, stderr.append(chunk)));
    child.stdin.on("error", (error) => {
      // Early process exit can close stdin before all input is consumed.
      if (codeOf(error) === "EPIPE") return;
      failure = new ProcessExecutionError(
        "stdin_failed",
        "Unable to write local process input.",
        codeOf(error),
      );
      stop();
    });
    child.once("error", (error) => {
      const code = codeOf(error);
      failure = new ProcessExecutionError(
        code === "ENOENT" ? "executable_not_found" : "spawn_failed",
        code === "ENOENT" ? "Local executable was not found." : "Local process could not start.",
        code,
      );
    });
    child.once("close", (code, signal) => {
      closed = true;
      exitCode =
        failure?.code === "executable_not_found" || failure?.code === "spawn_failed" ? null : code;
      exitSignal = signal;
      forward(request.onStdout, stdout.end());
      forward(request.onStderr, stderr.end());
      finish();
    });
    request.signal?.addEventListener("abort", abort, { once: true });
    if (request.timeoutMs !== undefined)
      timeout = setTimeout(() => stop("timeout"), request.timeoutMs);
    if (request.signal?.aborted) abort();
    child.stdin.end(request.stdin ?? "");
  });
};

class RetainedOutput {
  readonly #decoder = new StringDecoder("utf8");
  readonly #chunks: Buffer[] = [];
  #retained = 0;
  truncated = false;

  constructor(readonly limit: number) {}

  append(chunk: Buffer): string {
    const count = Math.min(chunk.length, this.limit - this.#retained);
    if (count > 0) this.#chunks.push(Buffer.from(chunk.subarray(0, count)));
    this.#retained += count;
    if (count < chunk.length) this.truncated = true;
    return this.#decoder.write(chunk);
  }

  end(): string {
    return this.#decoder.end();
  }

  text(): string {
    const decoder = new StringDecoder("utf8");
    const value = decoder.write(Buffer.concat(this.#chunks, this.#retained));
    return value + (this.truncated ? "" : decoder.end());
  }
}

function codeOf(error: unknown): string | undefined {
  return error instanceof Error && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function validateRequest(request: ProcessRequest) {
  if (
    request.stdin !== undefined &&
    (typeof request.stdin !== "string" || Buffer.byteLength(request.stdin) > 1024 * 1024)
  )
    throw new ProcessExecutionError(
      "invalid_request",
      "Process stdin must be a UTF-8 string no larger than 1 MiB.",
    );
  if (
    !request.executable ||
    request.executable.includes("\0") ||
    request.args?.some((arg) => arg.includes("\0"))
  ) {
    throw new ProcessExecutionError(
      "invalid_request",
      "Executable and arguments must be valid strings without NUL bytes.",
    );
  }
  for (const [name, value, minimum, maximum] of [
    ["timeoutMs", request.timeoutMs, 1, 2 ** 31 - 1],
    ["terminationGraceMs", request.terminationGraceMs, 0, 2 ** 31 - 1],
    ["maxOutputBytes", request.maxOutputBytes, 0, Number.MAX_SAFE_INTEGER],
  ] as const) {
    if (
      value !== undefined &&
      (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    ) {
      throw new ProcessExecutionError(
        "invalid_request",
        `${name} must be an integer between ${minimum} and ${maximum}.`,
      );
    }
  }
}
