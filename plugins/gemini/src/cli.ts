import { ADAPTER_VERSION } from "./version.js";
import {
  type AgentAdapter,
  type AgentDescriptor,
  type AgentReadiness,
  type AgentInput,
  type AgentResult,
  type AgentRunOptions,
  type JsonObject,
  isJsonValue,
} from "@veyraoss/protocol";
import {
  createDeadline,
  ProcessExecutionError,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "@veyraoss/runtime";
import { cliPrompt, cliRedactor } from "./cli-input.js";
import { cliExitError, cliFailure, GeminiCliOutput } from "./cli-output.js";

export interface GeminiCliAdapterOptions {
  id?: string;
  model?: string;
  executable?: string;
  workingDirectory?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

const validTimeout = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= 86_400_000;

/** Native Gemini CLI authentication and policy remain owned by the installed CLI. */
export class GeminiCliAdapter implements AgentAdapter {
  readonly id: string;
  readonly provider = "gemini-cli";
  readonly #options: Readonly<GeminiCliAdapterOptions>;
  readonly #runner: ProcessRunner;
  readonly #env: NodeJS.ProcessEnv;

  constructor(
    options: GeminiCliAdapterOptions = {},
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
      throw new Error("Gemini CLI options must contain only supported plain JSON fields.");
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
          `Gemini CLI ${name} must be a non-empty string of at most ${max} characters without control characters.`,
        );
    }
    if (options.timeoutMs !== undefined && !validTimeout(options.timeoutMs))
      throw new Error("Gemini CLI timeoutMs must be an integer from 1 through 86400000.");
    if (
      options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) ||
        options.maxOutputBytes < 0 ||
        options.maxOutputBytes > 1024 * 1024)
    )
      throw new Error(
        "Gemini CLI maxOutputBytes must be an integer from zero to 1 MiB per stream.",
      );
    this.id = options.id ?? "gemini-cli";
    this.#options = Object.freeze(structuredClone(options));
    this.#runner = dependencies.runProcess ?? runProcess;
    this.#env = dependencies.env ?? process.env;
  }

  describe(): AgentDescriptor {
    return {
      schemaVersion: 1,
      id: this.id,
      provider: this.provider,
      adapterVersion: ADAPTER_VERSION,
      ...(this.#options.model ? { model: this.#options.model } : {}),
      roles: ["executor"],
      permissions: { mode: "default", source: "adapter-argument" },
      capabilities: ["code-execution", "tool-use", "local-cli", "structured-output"],
    };
  }

  async run(input: AgentInput, controls: AgentRunOptions = {}): Promise<AgentResult> {
    const startedAt = new Date().toISOString();
    const start = performance.now();
    const output = new GeminiCliOutput();
    const redact = cliRedactor(this.#env);
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
                stdout: redact.text(processResult.stdout, {
                  truncated: processResult.stdoutTruncated,
                }),
                stderr: redact.text(processResult.stderr, {
                  truncated: processResult.stderrTruncated,
                }),
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
    const failure = (code: string, message: string) => finish(cliFailure(code, message));
    if (!isJsonValue(input) || typeof input.goal !== "string" || !input.goal.trim())
      return failure("invalid_input", "Gemini CLI input must contain a goal and plain JSON data.");
    if (input.role !== "executor")
      return failure("unsupported_role", "Gemini CLI implements only the executor role.");
    if (controls.signal?.aborted)
      return failure("cancelled", "Gemini CLI execution was cancelled.");
    const timeoutMs = controls.timeoutMs ?? this.#options.timeoutMs ?? 15 * 60_000;
    if (!validTimeout(timeoutMs))
      return failure(
        "invalid_timeout",
        "Gemini CLI timeout must be an integer from 1 through 86400000 milliseconds.",
      );
    const prompt = cliPrompt(input, this.#env);
    if (Buffer.byteLength(prompt) > 256 * 1024)
      return failure(
        "input_too_large",
        "Gemini CLI prompt exceeds 256 KiB; pass relevant context excerpts.",
      );
    try {
      let streamed = false;
      processResult = await this.#runner({
        executable: this.#options.executable ?? "gemini",
        args: [
          "--prompt",
          "Execute the preceding Veyra task envelope and return the requested JSON result.",
          "--output-format",
          "json",
          "--approval-mode",
          "default",
          ...(this.#options.model ? [`--model=${this.#options.model}`] : []),
        ],
        stdin: prompt,
        cwd: controls.cwd ?? this.#options.workingDirectory ?? process.cwd(),
        timeoutMs,
        signal: controls.signal,
        maxOutputBytes: this.#options.maxOutputBytes ?? 64 * 1024,
        onStdout: (chunk) => {
          streamed = true;
          output.feed(chunk);
        },
      });
      if (!streamed && !processResult.stdoutTruncated) output.feed(processResult.stdout);
      const result = output.finish();
      if (processResult.terminationReason)
        return failure(
          processResult.terminationReason === "timeout" ? "timeout" : "cancelled",
          processResult.terminationReason === "timeout"
            ? "Gemini CLI execution timed out."
            : "Gemini CLI execution was cancelled.",
        );
      if (processResult.signal)
        return failure("process_failed", "Gemini CLI process was terminated by a signal.");
      const exitError = cliExitError(processResult.exitCode);
      if (exitError) return finish(exitError);
      if (processResult.exitCode !== 0 && result?.status !== "failure")
        return failure(
          "process_failed",
          "Gemini CLI process exited unsuccessfully; inspect bounded diagnostics.",
        );
      if (!result)
        return failure(
          "invalid_output",
          "Gemini CLI did not return the required executor JSON; check CLI support for headless JSON output and the model response.",
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
            ? "Gemini CLI executable was not found; install it or configure its executable path."
            : "Gemini CLI could not execute through the local runtime; inspect its error code and bounded diagnostics.",
        );
      }
      return failure("execution_failed", "Gemini CLI execution failed.");
    }
  }

  async checkReadiness(controls: AgentRunOptions = {}): Promise<AgentReadiness> {
    const unknown = (message: string): AgentReadiness => ({
      status: "unknown",
      scope: "local",
      message,
    });
    if (controls.signal?.aborted) return unknown("Gemini CLI readiness check was cancelled.");
    const timeoutMs = controls.timeoutMs ?? 5000;
    if (!validTimeout(timeoutMs))
      return unknown(
        "Gemini CLI readiness timeout must be an integer from 1 through 86400000 milliseconds.",
      );
    const deadline = createDeadline(timeoutMs, controls.signal);
    const request = {
      executable: this.#options.executable ?? "gemini",
      cwd: controls.cwd ?? this.#options.workingDirectory ?? process.cwd(),
      signal: deadline.signal,
      timeoutMs,
      maxOutputBytes: 4096,
    };
    const completed = (result: ProcessResult) =>
      !deadline.signal.aborted &&
      !result.terminationReason &&
      !result.signal &&
      !result.stdoutTruncated &&
      result.exitCode === 0;
    try {
      const version = await this.#runner({ ...request, args: ["--version"] });
      const match = /^(\d+\.\d+\.\d+(?:-[\w.-]+)?)$/.exec(version.stdout.trim());
      if (!completed(version) || !match)
        return unknown("Gemini CLI version check did not complete successfully.");
      const help = await this.#runner({ ...request, args: ["--help"], maxOutputBytes: 64 * 1024 });
      if (!completed(help))
        return unknown("Gemini CLI support check did not complete successfully.");
      if (
        !["--prompt", "--output-format", "--approval-mode"].every((flag) =>
          help.stdout.includes(flag),
        )
      )
        return {
          status: "unavailable",
          scope: "local",
          version: match[1],
          message:
            "Gemini CLI lacks required headless JSON/approval flags; update the installed CLI.",
        };
      const env = this.#env;
      const nativeAuthHint =
        env.GOOGLE_GENAI_USE_GCA === "true" ||
        env.GOOGLE_GENAI_USE_VERTEXAI === "true" ||
        env.CLOUD_SHELL === "true" ||
        env.GEMINI_CLI_USE_COMPUTE_ADC === "true" ||
        Boolean(env.GOOGLE_GEMINI_BASE_URL);
      if (!nativeAuthHint && env.GEMINI_API_KEY?.trim())
        return {
          status: "ready",
          scope: "configuration",
          version: match[1],
          message:
            "Gemini CLI is installed and GEMINI_API_KEY is present. Native settings may select another auth method; credentials and model access were not tested.",
        };
      return {
        status: "unknown",
        scope: "local",
        version: match[1],
        message: nativeAuthHint
          ? "Gemini CLI is installed and native authentication environment configuration is present. Offline checks cannot validate login, ADC or gateway access; confirm native authentication with gemini."
          : "Gemini CLI is installed. Offline checks cannot determine native login or saved credentials; configure authentication with gemini or set GEMINI_API_KEY before running.",
      };
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.code === "executable_not_found")
        return {
          status: "unavailable",
          scope: "local",
          message:
            "Gemini CLI executable was not found; install it or configure its executable path.",
        };
      return unknown(
        "Gemini CLI readiness could not be checked; verify its executable, working directory and timeout.",
      );
    } finally {
      deadline.dispose();
    }
  }
}
