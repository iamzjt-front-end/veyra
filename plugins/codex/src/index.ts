import { ADAPTER_VERSION } from "./version.js";
import { PROMPT_SAFETY_GUIDANCE } from "@veyraoss/protocol";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AgentAdapter,
  type AgentDescriptor,
  type AgentReadiness,
  type AgentInput,
  type AgentResult,
  type AgentRunOptions,
  isJsonValue,
  type JsonObject,
} from "@veyraoss/protocol";
import {
  createSecretRedactor,
  type SecretRedactor,
  ProcessExecutionError,
  type ProcessResult,
  type ProcessRunner,
  runProcess,
} from "@veyraoss/runtime";
import { CodexOutput, resultSchema } from "./output.js";

export interface CodexAdapterOptions {
  mode?: "cli" | "sdk";
  workingDirectory?: string;
  executable?: string;
  model?: string;
  id?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface CodexDoctorResult {
  available: boolean | null;
  version?: string;
  authentication: "ready" | "not_authenticated" | "unknown";
  ready: boolean;
  message: string;
}

export class CodexAdapter implements AgentAdapter {
  readonly id: string;
  readonly provider = "codex";
  readonly #options: Readonly<CodexAdapterOptions>;
  readonly #runProcess: ProcessRunner;
  readonly #env: Readonly<NodeJS.ProcessEnv>;

  constructor(
    options: CodexAdapterOptions = {},
    dependencies: { runProcess?: ProcessRunner; env?: Readonly<NodeJS.ProcessEnv> } = {},
  ) {
    if (
      Object.keys(options).some(
        (key) =>
          ![
            "mode",
            "workingDirectory",
            "executable",
            "model",
            "id",
            "timeoutMs",
            "maxOutputBytes",
          ].includes(key),
      )
    )
      throw new Error("Unknown Codex adapter option.");
    if (options.mode !== undefined && options.mode !== "cli" && options.mode !== "sdk")
      throw new Error("Codex mode must be cli or sdk (planned).");
    for (const name of ["workingDirectory", "executable", "model", "id"] as const) {
      if (
        options[name] !== undefined &&
        (typeof options[name] !== "string" || !options[name]?.trim())
      )
        throw new Error(`${name} must be a non-empty string.`);
    }
    if (
      options.timeoutMs !== undefined &&
      (!Number.isSafeInteger(options.timeoutMs) ||
        options.timeoutMs <= 0 ||
        options.timeoutMs > 2 ** 31 - 1)
    )
      throw new Error("Codex timeoutMs must be a positive integer below 2^31.");
    if (
      options.maxOutputBytes !== undefined &&
      (!Number.isSafeInteger(options.maxOutputBytes) ||
        options.maxOutputBytes < 0 ||
        options.maxOutputBytes > 1024 * 1024)
    )
      throw new Error("Codex maxOutputBytes must be an integer from zero to 1 MiB per stream.");
    this.id = options.id ?? "codex";
    this.#options = Object.freeze({ ...options });
    this.#runProcess = dependencies.runProcess ?? runProcess;
    this.#env = dependencies.env ?? process.env;
  }

  describe(): AgentDescriptor {
    return {
      schemaVersion: 1,
      id: this.id,
      provider: this.provider,
      adapterVersion: ADAPTER_VERSION,
      ...(this.#options.model ? { model: this.#options.model } : {}),
      roles: this.#options.mode === "sdk" ? [] : ["executor"],
      ...(this.#options.mode === "sdk"
        ? {}
        : {
            permissions: {
              mode: "unknown",
              source: "native-configuration" as const,
              sandbox: "workspace-write",
            },
          }),
      capabilities:
        this.#options.mode === "sdk"
          ? []
          : ["code-execution", "tool-use", "local-cli", "structured-output"],
    };
  }

  async checkReadiness(options: AgentRunOptions = {}): Promise<AgentReadiness> {
    if (this.#options.mode === "sdk")
      return {
        status: "unavailable",
        scope: "configuration",
        message: "Codex SDK mode is planned; select CLI mode.",
      };
    const result = await this.doctor(options);
    return {
      status: result.ready
        ? "ready"
        : result.available === false || result.authentication === "not_authenticated"
          ? "unavailable"
          : "unknown",
      scope: "local",
      message: result.message,
      ...(result.version ? { version: result.version } : {}),
    };
  }

  async run(input: AgentInput, options: AgentRunOptions = {}): Promise<AgentResult> {
    const start = performance.now();
    const startedAt = new Date().toISOString();
    const output = new CodexOutput();
    const redactor = createSecretRedactor({ env: this.#env });
    let processResult: ProcessResult | undefined;
    const finish = (result: AgentResult): AgentResult => ({
      ...result,
      execution: {
        runId: input.runId,
        stepId: input.stepId,
        ...(input.attemptId !== undefined ? { attemptId: input.attemptId } : {}),
        ...(input.attempt !== undefined ? { attempt: input.attempt } : {}),
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
              process: processEvidence(processResult, redactor),
              ...(output.droppedRecords ? { droppedOversizedRecords: true } : {}),
            },
          }
        : {}),
    });
    const failure = (code: string, message: string) =>
      finish({ status: "failure", summary: message, error: { code, message } });
    if (this.#options.mode === "sdk")
      return failure("codex_sdk_not_implemented", "Codex SDK mode is planned; select CLI mode.");
    if (!isJsonValue(input) || typeof input.goal !== "string" || !input.goal.trim())
      return failure("codex_invalid_input", "Codex input must contain a goal and plain JSON data.");
    if (options.signal?.aborted)
      return failure("codex_cancelled", "Codex execution was cancelled.");
    const prompt = buildPrompt(input, this.#env);
    if (Buffer.byteLength(prompt) > 256 * 1024)
      return failure(
        "codex_input_too_large",
        "Codex prompt exceeds 256 KiB; pass relevant context excerpts.",
      );
    let temporary: string | undefined;
    try {
      temporary = await mkdtemp(join(tmpdir(), "veyra-codex-"));
      const schemaPath = join(temporary, "result.schema.json");
      await writeFile(schemaPath, JSON.stringify(resultSchema), { mode: 0o600 });
      let streamed = false;
      processResult = await this.#runProcess({
        executable: this.#options.executable ?? "codex",
        args: [
          "exec",
          "--json",
          "--ephemeral",
          "--color",
          "never",
          "--sandbox",
          "workspace-write",
          "--output-schema",
          schemaPath,
          ...(this.#options.model ? ["--model", this.#options.model] : []),
          "-",
        ],
        stdin: prompt,
        cwd: options.cwd ?? this.#options.workingDirectory ?? process.cwd(),
        signal: options.signal,
        timeoutMs: options.timeoutMs ?? this.#options.timeoutMs ?? 15 * 60_000,
        maxOutputBytes: this.#options.maxOutputBytes ?? 64 * 1024,
        onStdout: (chunk) => {
          streamed = true;
          output.feed(chunk);
        },
      });
      if (!streamed) output.feed(processResult.stdout);
      const result = output.finish();
      if (processResult.terminationReason)
        return failure(
          processResult.terminationReason === "timeout" ? "codex_timeout" : "codex_cancelled",
          processResult.terminationReason === "timeout"
            ? "Codex execution timed out."
            : "Codex execution was cancelled.",
        );
      if (processResult.exitCode !== 0 || processResult.signal)
        return failure(
          "codex_process_failed",
          "Codex process exited unsuccessfully; inspect bounded process diagnostics.",
        );
      if ((!streamed && processResult.stdoutTruncated) || !result)
        return failure(
          "codex_invalid_output",
          "Codex did not emit a completed turn with a valid structured result.",
        );
      result.summary = redactor.text(result.summary);
      if (result.data) result.data = redactor.json(result.data) as JsonObject;
      return finish(result);
    } catch (error) {
      if (error instanceof ProcessExecutionError) {
        processResult = error.result;
        return failure(
          error.code === "executable_not_found" ? "codex_not_found" : `codex_${error.code}`,
          error.code === "executable_not_found"
            ? "Codex executable was not found; install it or configure its executable path."
            : "Codex could not execute through the local runtime; inspect its error code and bounded diagnostics.",
        );
      }
      return failure("codex_execution_failed", "Codex execution or temporary-file setup failed.");
    } finally {
      if (temporary) await rm(temporary, { recursive: true, force: true });
    }
  }

  async doctor(options: AgentRunOptions = {}): Promise<CodexDoctorResult> {
    const request = {
      executable: this.#options.executable ?? "codex",
      cwd: options.cwd ?? this.#options.workingDirectory ?? process.cwd(),
      timeoutMs: 5000,
      signal: options.signal,
      maxOutputBytes: 4096,
    };
    try {
      const version = await this.#runProcess({ ...request, args: ["--version"] });
      const match = /^codex(?:-cli)?\s+([\w.+-]+)/.exec(version.stdout.trim());
      if (version.exitCode !== 0 || version.terminationReason || !match)
        return {
          available: null,
          authentication: "unknown",
          ready: false,
          message: "Codex version check did not complete successfully.",
        };
      const auth = await this.#runProcess({ ...request, args: ["login", "status"] });
      const authentication =
        auth.terminationReason || auth.signal
          ? "unknown"
          : auth.exitCode === 0
            ? "ready"
            : auth.exitCode === 1
              ? "not_authenticated"
              : "unknown";
      return {
        available: true,
        version: match[1] ? createSecretRedactor({ env: this.#env }).text(match[1]) : undefined,
        authentication,
        ready: authentication === "ready",
        message:
          authentication === "ready"
            ? "Codex is installed and reports authenticated CLI access."
            : "Run codex login and retry the readiness check.",
      };
    } catch (error) {
      return {
        available:
          error instanceof ProcessExecutionError && error.code === "executable_not_found"
            ? false
            : null,
        authentication: "unknown",
        ready: false,
        message:
          "Codex readiness could not be checked; verify its executable and working directory.",
      };
    }
  }
}

export function buildPrompt(
  input: AgentInput,
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): string {
  if (!isJsonValue(input)) throw new Error("Codex prompt input must be plain JSON data.");
  return [
    "You are Veyra's executor for the supplied task. Preserve and follow user/project AGENTS.md instructions and existing execution policies. Make only the changes needed for the goal and current task, using prior planner/reviewer/verification context as evidence. Do not commit, push, publish, or deploy. If explicit human approval or unavailable access is required, stop and report needs_input. Never copy authentication files or expose credentials in output.",
    "Return the requested structured result: status, concise summary, changedFiles, and commandsRun. List only changes and commands actually performed. These are execution claims; separate deterministic verification will follow.",
    PROMPT_SAFETY_GUIDANCE,
    "Task envelope:",
    JSON.stringify(createSecretRedactor({ env }).json(input), null, 2),
  ].join("\n\n");
}

function processEvidence(result: ProcessResult, redactor: SecretRedactor): JsonObject {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    durationMs: result.durationMs,
    stdout: redactor.text(result.stdout, { truncated: result.stdoutTruncated }),
    stderr: redactor.text(result.stderr, { truncated: result.stderrTruncated }),
    stdoutTruncated: result.stdoutTruncated,
    stderrTruncated: result.stderrTruncated,
    ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
  };
}

export { ADAPTER_VERSION } from "./version.js";
