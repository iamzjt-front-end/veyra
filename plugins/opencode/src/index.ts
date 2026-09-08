import { resolve } from "node:path";
import {
  type AgentAdapter,
  type AgentDescriptor,
  type AgentReadiness,
  type AgentInput,
  type AgentResult,
  type AgentRunOptions,
  type JsonObject,
  isJsonValue,
} from "@veyra/protocol";
import {
  createDeadline,
  ProcessExecutionError,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "@veyra/runtime";
import { buildPrompt, redactor } from "./input.js";
import { failure as resultFailure, OpenCodeOutput } from "./output.js";

export interface OpenCodeAdapterOptions {
  id?: string;
  model?: string;
  executable?: string;
  workingDirectory?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const validTimeout = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= 86_400_000;

const supported = (version: string) => {
  if (version.length > 128) return false;
  const match = /^1\.(\d+)\.(\d+)$/.exec(version);
  return Boolean(
    match &&
    Number.isSafeInteger(Number(match[1])) &&
    Number.isSafeInteger(Number(match[2])) &&
    (Number(match[1]) > 18 || (Number(match[1]) === 18 && Number(match[2]) >= 29)),
  );
};
const nativeEnv = {
  OPENCODE_DISABLE_SHARE: "true",
  OPENCODE_AUTO_SHARE: "false",
  OPENCODE_DISABLE_AUTOUPDATE: "true",
  OPENCODE_DISABLE_TERMINAL_TITLE: "true",
};

/** Native OpenCode authentication and policy remain owned by the installed CLI. */
export class OpenCodeAdapter implements AgentAdapter {
  readonly id: string;
  readonly provider = "opencode";
  readonly #options: Readonly<OpenCodeAdapterOptions>;
  readonly #runner: ProcessRunner;
  readonly #env: NodeJS.ProcessEnv;

  constructor(
    options: OpenCodeAdapterOptions = {},
    dependencies: { runProcess?: ProcessRunner; env?: NodeJS.ProcessEnv } = {},
  ) {
    if (
      !options ||
      typeof options !== "object" ||
      Array.isArray(options) ||
      !isJsonValue(options) ||
      Object.keys(options).some(
        (key) =>
          ![
            "id",
            "model",
            "executable",
            "workingDirectory",
            "timeoutMs",
            "maxOutputBytes",
          ].includes(key),
      )
    )
      throw new Error("OpenCode options must contain only supported plain JSON fields.");
    for (const name of ["id", "model", "executable", "workingDirectory"] as const) {
      const value = options[name];
      const max = name === "id" ? 128 : name === "model" ? 512 : 4096;
      if (
        value !== undefined &&
        (typeof value !== "string" ||
          !value.trim() ||
          value.length > max ||
          [...value].some((char) => char.charCodeAt(0) < 32))
      )
        throw new Error(
          `OpenCode ${name} must be a non-empty string of at most ${max} characters without control characters.`,
        );
    }
    if (options.model !== undefined && !/^[^/\s]+\/[^\s]+$/.test(options.model))
      throw new Error("OpenCode model must use provider/model syntax without whitespace.");
    if (options.timeoutMs !== undefined && !validTimeout(options.timeoutMs))
      throw new Error("OpenCode timeoutMs must be an integer from 1 through 86400000.");
    if (
      options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) ||
        options.maxOutputBytes < 0 ||
        options.maxOutputBytes > 1024 * 1024)
    )
      throw new Error("OpenCode maxOutputBytes must be an integer from zero to 1 MiB per stream.");
    this.id = options.id ?? "opencode";
    this.#options = Object.freeze(structuredClone(options));
    this.#runner = dependencies.runProcess ?? runProcess;
    this.#env = dependencies.env ?? process.env;
  }

  describe(): AgentDescriptor {
    return {
      schemaVersion: 1,
      id: this.id,
      provider: this.provider,
      adapterVersion: "0.1.0",
      ...(this.#options.model ? { model: this.#options.model } : {}),
      roles: ["executor"],
      capabilities: ["code-execution", "tool-use", "local-cli", "structured-output"],
    };
  }

  async run(input: AgentInput, controls: AgentRunOptions = {}): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const output = new OpenCodeOutput();
    const redact = redactor(this.#env);
    let processResult: ProcessResult | undefined;
    const finish = (result: AgentResult): AgentResult => ({
      ...result,
      execution: {
        runId: input.runId,
        stepId: input.stepId,
        ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
        ...(input.parentStepId !== undefined ? { parentStepId: input.parentStepId } : {}),
      },
      timing: {
        startedAt,
        completedAt: new Date().toISOString(),
        durationMs: performance.now() - start,
      },
      ...(output.usage ? { usage: output.usage } : {}),
      ...(processResult
        ? {
            data: {
              ...result.data,
              process: {
                exitCode: processResult.exitCode,
                signal: processResult.signal,
                durationMs: processResult.durationMs,
                stdout: redact.text(processResult.stdout),
                stderr: redact.text(processResult.stderr),
                stdoutTruncated: processResult.stdoutTruncated,
                stderrTruncated: processResult.stderrTruncated,
                ...(processResult.terminationReason
                  ? { terminationReason: processResult.terminationReason }
                  : {}),
              },
              ...(output.oversized ? { oversizedResult: true } : {}),
            },
          }
        : {}),
    });
    const failure = (code: string, message: string) => finish(resultFailure(code, message));
    if (!isJsonValue(input) || typeof input.goal !== "string" || !input.goal.trim())
      return failure("invalid_input", "OpenCode input must contain a goal and plain JSON data.");
    if (input.role !== "executor")
      return failure("unsupported_role", "OpenCode implements only the executor role.");
    if (controls.signal?.aborted) return failure("cancelled", "OpenCode execution was cancelled.");
    const timeoutMs = controls.timeoutMs ?? this.#options.timeoutMs ?? 15 * 60_000;
    if (!validTimeout(timeoutMs))
      return failure(
        "invalid_timeout",
        "OpenCode timeout must be an integer from 1 through 86400000 milliseconds.",
      );
    const prompt = buildPrompt(input, this.#env);
    if (Buffer.byteLength(prompt) > 256 * 1024)
      return failure(
        "input_too_large",
        "OpenCode prompt exceeds 256 KiB; pass relevant context excerpts.",
      );
    const deadline = createDeadline(timeoutMs, controls.signal);
    const cwd = resolve(controls.cwd ?? this.#options.workingDirectory ?? process.cwd());
    const executable = this.#options.executable ?? "opencode";
    try {
      // This release range implements the sharing-disable switch used by every invocation.
      const version = await this.#runner({
        executable,
        args: ["--version"],
        cwd,
        env: { ...nativeEnv, OPENCODE_DISABLE_MODELS_FETCH: "true" },
        signal: deadline.signal,
        timeoutMs: Math.min(5000, timeoutMs),
        maxOutputBytes: 4096,
      });
      if (deadline.signal.aborted || version.terminationReason)
        return failure(
          deadline.timedOut() || version.terminationReason === "timeout" ? "timeout" : "cancelled",
          "OpenCode version preflight was interrupted.",
        );
      if (
        version.exitCode !== 0 ||
        version.signal ||
        version.stdoutTruncated ||
        !supported(version.stdout.trim())
      )
        return failure(
          "unsupported_version",
          "OpenCode requires stable 1.x version 1.18.29 or newer for the verified native contract and disabled sharing.",
        );
      let streamed = false;
      processResult = await this.#runner({
        executable,
        args: [
          "run",
          "--format",
          "json",
          "--dir",
          cwd,
          "--title",
          "Veyra executor",
          "--no-auto",
          "--no-thinking",
          ...(this.#options.model ? [`--model=${this.#options.model}`] : []),
        ],
        stdin: prompt,
        cwd,
        env: { ...nativeEnv, PWD: cwd },
        timeoutMs,
        signal: deadline.signal,
        maxOutputBytes: this.#options.maxOutputBytes ?? 64 * 1024,
        onStdout: (chunk) => {
          streamed = true;
          output.feed(chunk);
        },
      });
      if (!streamed && !processResult.stdoutTruncated) output.feed(processResult.stdout);
      const result = output.finish();
      if (deadline.signal.aborted || processResult.terminationReason)
        return failure(
          deadline.timedOut() || processResult.terminationReason === "timeout"
            ? "timeout"
            : "cancelled",
          deadline.timedOut() || processResult.terminationReason === "timeout"
            ? "OpenCode execution timed out."
            : "OpenCode execution was cancelled.",
        );
      if (processResult.signal)
        return failure("process_failed", "OpenCode process was terminated by a signal.");
      if (processResult.exitCode === 130)
        return failure("cancelled", "OpenCode execution was cancelled.");
      if (processResult.exitCode !== 0 && (!result || result.status === "success"))
        return failure(
          "process_failed",
          "OpenCode process exited unsuccessfully; inspect bounded diagnostics.",
        );
      if (!result)
        return failure(
          "invalid_output",
          "OpenCode did not return the required executor JSON; check CLI support for headless JSON output and the model response.",
        );
      return finish({
        ...result,
        summary: redact.text(result.summary),
        ...(result.data ? { data: redact.json(result.data) as JsonObject } : {}),
      });
    } catch (error) {
      if (error instanceof ProcessExecutionError) {
        processResult = error.result;
        return failure(
          error.code === "executable_not_found" ? "not_found" : error.code,
          error.code === "executable_not_found"
            ? "OpenCode executable was not found; install it or configure its executable path."
            : "OpenCode could not execute through the local runtime; inspect its error code and bounded diagnostics.",
        );
      }
      return failure("execution_failed", "OpenCode execution failed.");
    } finally {
      deadline.dispose();
    }
  }

  async checkReadiness(controls: AgentRunOptions = {}): Promise<AgentReadiness> {
    const unknown = (message: string): AgentReadiness => ({
      status: "unknown",
      scope: "local",
      message,
    });
    if (controls.signal?.aborted) return unknown("OpenCode readiness check was cancelled.");
    const timeoutMs = controls.timeoutMs ?? 5000;
    if (!validTimeout(timeoutMs))
      return unknown(
        "OpenCode readiness timeout must be an integer from 1 through 86400000 milliseconds.",
      );
    const deadline = createDeadline(timeoutMs, controls.signal);
    const request = {
      executable: this.#options.executable ?? "opencode",
      cwd: controls.cwd ?? this.#options.workingDirectory ?? process.cwd(),
      signal: deadline.signal,
      timeoutMs,
      maxOutputBytes: 4096,
      env: { ...nativeEnv, OPENCODE_DISABLE_MODELS_FETCH: "true" },
    };
    const completed = (result: ProcessResult) =>
      !deadline.signal.aborted &&
      !result.terminationReason &&
      !result.signal &&
      !result.stdoutTruncated &&
      !result.stderrTruncated &&
      result.exitCode === 0;
    try {
      const version = await this.#runner({ ...request, args: ["--version"] });
      const match = /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(version.stdout.trim());
      if (!completed(version) || !match)
        return unknown("OpenCode version check did not complete successfully.");
      if (!supported(version.stdout.trim()))
        return {
          status: "unavailable",
          scope: "local",
          version: match[1],
          message:
            "Update OpenCode to stable 1.x version 1.18.29 or newer for the supported native contract and disabled sharing.",
        };
      const help = await this.#runner({
        ...request,
        args: ["run", "--help"],
        maxOutputBytes: 64 * 1024,
      });
      if (!completed(help)) return unknown("OpenCode support check did not complete successfully.");
      if (
        !["--format", "--dir", "--title", "--auto", "--thinking"].every((flag) =>
          `${help.stdout}\n${help.stderr}`.includes(flag),
        )
      )
        return {
          status: "unavailable",
          scope: "local",
          version: match[1],
          message:
            "OpenCode lacks required headless JSON/approval flags; update the installed CLI.",
        };
      return {
        status: "ready",
        scope: "local",
        version: match[1],
        message:
          "OpenCode is installed with the required headless JSON flags. Provider authentication and model access were not tested; configure native access with opencode auth login or its standard environment.",
      };
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.code === "executable_not_found")
        return {
          status: "unavailable",
          scope: "local",
          message:
            "OpenCode executable was not found; install it or configure its executable path.",
        };
      return unknown(
        "OpenCode readiness could not be checked; verify its executable, working directory and timeout.",
      );
    } finally {
      deadline.dispose();
    }
  }
}
