import type {
  EventSink,
  ExecutionMetadata,
  SerializedError,
  VerificationResult,
  VerificationCommandSource,
} from "@veyra/protocol";
import {
  ProcessExecutionError,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
  createSecretRedactor,
} from "@veyra/runtime";

export const DEFAULT_VERIFICATION_TIMEOUT_MS = 300_000;

export interface VerificationRequest {
  commands: string[];
  /** Defaults to a trusted direct caller; provider-generated commands are not supported. */
  commandSource?: VerificationCommandSource;
  cwd?: string;
  env?: Record<string, string | undefined>;
  timeoutMs?: number;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  execution?: ExecutionMetadata;
}

export interface VerificationReport {
  success: boolean;
  results: VerificationResult[];
  durationMs: number;
}

export interface Verifier {
  verify(request: VerificationRequest): Promise<VerificationReport>;
}

export interface ShellVerifierOptions {
  runProcess?: ProcessRunner;
  emit?: EventSink;
  /** Additional known values supplied by the embedding application; never persisted. */
  redactValues?: readonly string[];
}

/** Executes trusted workflow command text sequentially; no LLM judgment or Core dependency. */
export class ShellVerifier implements Verifier {
  readonly #runProcess: ProcessRunner;
  readonly #emit?: EventSink;
  readonly #redactValues: readonly string[];

  constructor(options: ShellVerifierOptions = {}) {
    this.#runProcess = options.runProcess ?? runProcess;
    this.#emit = options.emit;
    this.#redactValues = [...(options.redactValues ?? [])];
  }

  async verify(request: VerificationRequest): Promise<VerificationReport> {
    const redactor = createSecretRedactor({ values: this.#redactValues, env: request.env });
    const commandSource = request.commandSource === undefined ? "caller" : request.commandSource;
    if (commandSource !== "workflow" && commandSource !== "caller")
      throw new Error(
        "Verifier commands must come from trusted workflow configuration or an explicit caller, never provider output.",
      );
    if (
      !Array.isArray(request.commands) ||
      request.commands.some((command) => typeof command !== "string" || !command.trim())
    ) {
      throw new Error("Verification commands must be an array of non-empty strings.");
    }
    if (this.#emit && !request.execution) {
      throw new Error(
        "Verification event emission requires runId and stepId in execution metadata.",
      );
    }
    const commands = [...request.commands];
    const execution = request.execution ? { ...request.execution } : undefined;
    const startedAt = performance.now();
    if (this.#emit && execution) {
      await this.#emit({
        type: "verification.started",
        ...execution,
        at: new Date().toISOString(),
        commands: commands.map((command) => redactor.text(command)),
        commandSource,
      });
    }
    const results: VerificationResult[] = [];
    for (const command of commands) {
      const commandStart = performance.now();
      let result: VerificationResult;
      try {
        const processResult = await this.#runProcess({
          executable: process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "/bin/sh",
          args: process.platform === "win32" ? ["/d", "/s", "/c", command] : ["-c", command],
          cwd: request.cwd,
          env: request.env,
          timeoutMs: request.timeoutMs ?? DEFAULT_VERIFICATION_TIMEOUT_MS,
          signal: request.signal,
          maxOutputBytes: request.maxOutputBytes,
        });
        result = normalize(command, processResult);
      } catch (error) {
        const processResult = error instanceof ProcessExecutionError ? error.result : undefined;
        result = {
          ...(processResult
            ? normalize(command, processResult)
            : {
                command,
                exitCode: null,
                stdout: "",
                stderr: "",
                durationMs: performance.now() - commandStart,
              }),
          success: false,
          error: {
            code:
              error instanceof ProcessExecutionError
                ? `process_${error.code}`
                : "verification_process_failed",
            message:
              error instanceof ProcessExecutionError
                ? error.message
                : "Verification process execution failed.",
          },
        };
      }
      if (execution) result.execution = { ...execution };
      result.command = redactor.text(result.command);
      result.stdout = redactor.text(result.stdout, { truncated: result.stdoutTruncated });
      result.stderr = redactor.text(result.stderr, { truncated: result.stderrTruncated });
      if (result.error) result.error.message = redactor.text(result.error.message);
      results.push(result);
      if (!result.success) break;
    }
    const report: VerificationReport = {
      success: results.every((result) => result.success),
      results,
      durationMs: performance.now() - startedAt,
    };
    if (this.#emit && execution) {
      await this.#emit({
        type: "verification.completed",
        ...execution,
        at: new Date().toISOString(),
        success: report.success,
        commandSource,
        results: structuredClone(results),
      });
    }
    return report;
  }
}

function normalize(command: string, result: ProcessResult): VerificationResult {
  let error: SerializedError | undefined;
  if (result.terminationReason) {
    error = {
      code: result.terminationReason === "timeout" ? "process_timeout" : "process_cancelled",
      message:
        result.terminationReason === "timeout"
          ? "Verification command timed out."
          : "Verification command was cancelled.",
    };
  }
  return {
    command,
    success: result.exitCode === 0 && result.signal === null && !error,
    exitCode: result.exitCode,
    ...(result.signal ? { signal: result.signal } : {}),
    stdout: result.stdout,
    stderr: result.stderr,
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    durationMs: result.durationMs,
    ...(error ? { error } : {}),
  };
}
