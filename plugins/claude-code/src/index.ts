import { PROMPT_SAFETY_GUIDANCE } from "@veyra/protocol";
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
import { ClaudeCodeOutput, resultSchema } from "./output.js";
import { redactor } from "./redact.js";

export interface ClaudeCodeAdapterOptions {
  id?: string;
  model?: string;
  executable?: string;
  workingDirectory?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
  maxTurns?: number;
  /** Native Claude Code allow rules; no permissions are added by default. */
  allowedTools?: string[];
}

const validTimeout = (value: number) =>
  Number.isSafeInteger(value) && value >= 1 && value <= 86_400_000;
const hasControlCharacter = (value: string) => [...value].some((char) => char.charCodeAt(0) < 32);

export class ClaudeCodeAdapter implements AgentAdapter {
  readonly id: string;
  readonly provider = "claude-code";
  readonly #options: Readonly<ClaudeCodeAdapterOptions>;
  readonly #runner: ProcessRunner;
  readonly #env: NodeJS.ProcessEnv;

  constructor(
    options: ClaudeCodeAdapterOptions = {},
    dependencies: { runProcess?: ProcessRunner; env?: NodeJS.ProcessEnv } = {},
  ) {
    if (
      options === null ||
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
            "maxTurns",
            "allowedTools",
          ].includes(key),
      )
    )
      throw new Error("Claude Code options must contain only supported plain JSON fields.");
    for (const name of ["id", "model", "executable", "workingDirectory"] as const) {
      const value = options[name];
      const max = name === "id" ? 128 : name === "model" ? 512 : 4096;
      if (
        value !== undefined &&
        (typeof value !== "string" ||
          !value.trim() ||
          value.length > max ||
          hasControlCharacter(value))
      )
        throw new Error(
          `Claude Code ${name} must be a non-empty string of at most ${max} characters without control characters.`,
        );
    }
    if (options.timeoutMs !== undefined && !validTimeout(options.timeoutMs))
      throw new Error("Claude Code timeoutMs must be an integer from 1 through 86400000.");
    if (
      options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) ||
        options.maxOutputBytes < 0 ||
        options.maxOutputBytes > 1024 * 1024)
    )
      throw new Error(
        "Claude Code maxOutputBytes must be an integer from zero to 1 MiB per stream.",
      );
    if (
      options.maxTurns !== undefined &&
      (!Number.isSafeInteger(options.maxTurns) || options.maxTurns < 1 || options.maxTurns > 1000)
    )
      throw new Error("Claude Code maxTurns must be an integer from 1 through 1000.");
    if (
      options.allowedTools !== undefined &&
      (!Array.isArray(options.allowedTools) ||
        options.allowedTools.length > 32 ||
        options.allowedTools.some(
          (tool) =>
            typeof tool !== "string" ||
            !tool.trim() ||
            tool.length > 512 ||
            hasControlCharacter(tool),
        ))
    )
      throw new Error(
        "Claude Code allowedTools must contain at most 32 non-empty native permission rules of at most 512 characters.",
      );
    this.id = options.id ?? "claude-code";
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
      permissions: {
        mode: "default",
        source: "adapter-argument",
        toolAllowRules: this.#options.allowedTools?.length ?? 0,
      },
      capabilities: ["code-execution", "tool-use", "local-cli", "structured-output"],
    };
  }

  async run(input: AgentInput, controls: AgentRunOptions = {}): Promise<AgentResult> {
    const start = performance.now();
    const startedAt = new Date().toISOString();
    const output = new ClaudeCodeOutput();
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
    const failure = (code: string, message: string) =>
      finish({ status: "failure", summary: message, error: { code, message } });
    if (!isJsonValue(input) || typeof input.goal !== "string" || !input.goal.trim())
      return failure(
        "claude_code_invalid_input",
        "Claude Code input must contain a goal and plain JSON data.",
      );
    if (input.role !== "executor")
      return failure(
        "claude_code_unsupported_role",
        "Claude Code implements only the executor role.",
      );
    if (controls.signal?.aborted)
      return failure("claude_code_cancelled", "Claude Code execution was cancelled.");
    const timeoutMs = controls.timeoutMs ?? this.#options.timeoutMs ?? 15 * 60_000;
    if (!validTimeout(timeoutMs))
      return failure(
        "claude_code_invalid_timeout",
        "Claude Code timeout must be an integer from 1 through 86400000 milliseconds.",
      );
    const prompt = buildPrompt(input, this.#env);
    if (Buffer.byteLength(prompt) > 256 * 1024)
      return failure(
        "claude_code_input_too_large",
        "Claude Code prompt exceeds 256 KiB; pass relevant context excerpts.",
      );
    try {
      let streamed = false;
      processResult = await this.#runner({
        executable: this.#options.executable ?? "claude",
        args: [
          "--print",
          "--input-format",
          "text",
          "--output-format",
          "json",
          "--no-session-persistence",
          "--permission-mode",
          "default",
          "--max-turns",
          String(this.#options.maxTurns ?? 20),
          "--json-schema",
          JSON.stringify(resultSchema),
          ...(this.#options.model ? [`--model=${this.#options.model}`] : []),
          ...(this.#options.allowedTools?.length
            ? [`--allowedTools=${this.#options.allowedTools.join(",")}`]
            : []),
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
          processResult.terminationReason === "timeout"
            ? "claude_code_timeout"
            : "claude_code_cancelled",
          processResult.terminationReason === "timeout"
            ? "Claude Code execution timed out."
            : "Claude Code execution was cancelled.",
        );
      if (processResult.signal || (processResult.exitCode !== 0 && result?.status !== "failure"))
        return failure(
          "claude_code_process_failed",
          "Claude Code process exited unsuccessfully; inspect bounded diagnostics.",
        );
      if (!result)
        return failure(
          "claude_code_invalid_output",
          "Claude Code did not emit a valid structured result; check CLI support for --print, --output-format json and --json-schema.",
        );
      const safe = {
        ...result,
        summary: redact.text(result.summary),
        ...(result.data ? { data: redact.json(result.data) as JsonObject } : {}),
      };
      return finish(safe);
    } catch (error) {
      if (error instanceof ProcessExecutionError) {
        processResult = error.result;
        return failure(
          error.code === "executable_not_found"
            ? "claude_code_not_found"
            : `claude_code_${error.code}`,
          error.code === "executable_not_found"
            ? "Claude Code executable was not found; install it or configure its executable path."
            : "Claude Code could not execute through the local runtime; inspect its error code and bounded diagnostics.",
        );
      }
      return failure("claude_code_execution_failed", "Claude Code execution failed.");
    }
  }

  async checkReadiness(controls: AgentRunOptions = {}): Promise<AgentReadiness> {
    const unknown = (message: string): AgentReadiness => ({
      status: "unknown",
      scope: "local",
      message,
    });
    if (controls.signal?.aborted) return unknown("Claude Code readiness check was cancelled.");
    const timeoutMs = controls.timeoutMs ?? 5000;
    if (!validTimeout(timeoutMs))
      return unknown(
        "Claude Code readiness timeout must be an integer from 1 through 86400000 milliseconds.",
      );
    const deadline = createDeadline(timeoutMs, controls.signal);
    const request = {
      executable: this.#options.executable ?? "claude",
      cwd: controls.cwd ?? this.#options.workingDirectory ?? process.cwd(),
      signal: deadline.signal,
      timeoutMs,
      maxOutputBytes: 4096,
    };
    const completed = (result: ProcessResult) =>
      !deadline.signal.aborted &&
      !result.terminationReason &&
      !result.signal &&
      !result.stdoutTruncated;
    try {
      const version = await this.#runner({ ...request, args: ["--version"] });
      const match = /^(\d+\.\d+\.\d+(?:-[\w.-]+)?) \(Claude Code\)$/.exec(version.stdout.trim());
      if (!completed(version) || version.exitCode !== 0 || !match)
        return unknown("Claude Code version check did not complete successfully.");
      const help = await this.#runner({ ...request, args: ["--help"], maxOutputBytes: 64 * 1024 });
      if (!completed(help) || help.exitCode !== 0)
        return unknown("Claude Code CLI support check did not complete successfully.");
      if (
        ![
          "--print",
          "--output-format",
          "--json-schema",
          "--no-session-persistence",
          "--permission-mode",
        ].every((flag) => help.stdout.includes(flag))
      )
        return {
          status: "unavailable",
          scope: "local",
          version: match[1],
          message:
            "Claude Code lacks required non-interactive structured-output flags; update the installed CLI.",
        };
      const auth = await this.#runner({ ...request, args: ["auth", "status"] });
      if (!completed(auth) || (auth.exitCode !== 0 && auth.exitCode !== 1))
        return unknown("Claude Code authentication check did not complete successfully.");
      let value: unknown;
      try {
        value = JSON.parse(auth.stdout);
      } catch {
        return unknown("Claude Code authentication status was not valid JSON.");
      }
      if (
        !value ||
        typeof value !== "object" ||
        !("loggedIn" in value) ||
        typeof value.loggedIn !== "boolean"
      )
        return unknown("Claude Code authentication status did not include loggedIn.");
      const ready = value.loggedIn && auth.exitCode === 0;
      return {
        status: ready ? "ready" : "unavailable",
        scope: "local",
        version: match[1],
        message: ready
          ? "Claude Code is installed and reports authenticated CLI access; model access was not tested."
          : "Claude Code is not authenticated; run claude auth login and retry the readiness check.",
      };
    } catch (error) {
      if (error instanceof ProcessExecutionError && error.code === "executable_not_found")
        return {
          status: "unavailable",
          scope: "local",
          message:
            "Claude Code executable was not found; install it or configure its executable path.",
        };
      return unknown(
        "Claude Code readiness could not be checked; verify its executable, working directory and timeout.",
      );
    } finally {
      deadline.dispose();
    }
  }
}

export function buildPrompt(input: AgentInput, env: NodeJS.ProcessEnv = process.env): string {
  if (!isJsonValue(input)) throw new Error("Claude Code input must be plain JSON data.");
  return [
    "You are Veyra's executor for the supplied task. Read and follow user/project AGENTS.md and CLAUDE.md instructions and existing execution policies. Make only the changes needed for the goal and current task. Treat supplied planner/reviewer/verification context as evidence. Do not delegate to subagents, commit, push, publish, deploy, or start background jobs. If explicit human approval or unavailable access is required, stop and report needs_input. Never read/copy authentication files or expose credentials in output.",
    "Return the requested structured result: status, concise summary, changedFiles and commandsRun. List only changes and commands actually performed. These are execution claims; independent deterministic verification will follow.",
    PROMPT_SAFETY_GUIDANCE,
    "Task envelope:",
    JSON.stringify(redactor(env).json(input), null, 2),
  ].join("\n\n");
}
