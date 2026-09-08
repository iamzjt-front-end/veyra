import type { AgentResult, UsageMetadata } from "@veyra/protocol";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 1024 && value.every((item) => typeof item === "string");

export function cliFailure(code: string, message: string): AgentResult {
  return { status: "failure", summary: message, error: { code: `gemini_cli_${code}`, message } };
}

export function cliExitError(exitCode: number | null): AgentResult | undefined {
  if (exitCode === 41) {
    const message =
      "Gemini CLI authentication failed; configure native login or a supported credential in its environment, then retry.";
    return {
      status: "needs_input",
      summary: message,
      error: { code: "gemini_cli_auth_required", message },
    };
  }
  const errors: Record<number, [string, string]> = {
    42: [
      "invalid_request",
      "Gemini CLI rejected the input or command-line arguments; check the installed CLI's supported flags.",
    ],
    52: [
      "invalid_config",
      "Gemini CLI configuration is invalid; correct its native settings before retrying.",
    ],
    53: ["turn_limit", "Gemini CLI reached its native session turn limit."],
    130: ["cancelled", "Gemini CLI execution was cancelled."],
  };
  const error = exitCode === null ? undefined : errors[exitCode];
  return error ? cliFailure(...error) : undefined;
}

/** One JSON envelope, assembled separately from bounded diagnostic retention. */
export class GeminiCliOutput {
  #text = "";
  #bytes = 0;
  oversized = false;
  usage?: UsageMetadata;

  feed(chunk: string) {
    if (this.oversized) return;
    this.#bytes += Buffer.byteLength(chunk);
    if (this.#bytes > 1024 * 1024) {
      this.oversized = true;
      this.#text = "";
    } else this.#text += chunk;
  }

  finish(): AgentResult | undefined {
    if (this.oversized) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(this.#text);
    } catch {
      return undefined;
    }
    if (!object(value)) return undefined;
    this.usage = cliUsage(value.stats);
    if (value.error !== undefined) {
      if (
        !object(value.error) ||
        typeof value.error.type !== "string" ||
        typeof value.error.message !== "string"
      )
        return undefined;
      return (
        (typeof value.error.code === "number" ? cliExitError(value.error.code) : undefined) ??
        cliFailure(
          "provider_error",
          "Gemini CLI reported an execution error; inspect bounded diagnostics.",
        )
      );
    }
    const tools = object(value.stats) && object(value.stats.tools) ? value.stats.tools : undefined;
    const decisions = tools && object(tools.totalDecisions) ? tools.totalDecisions : undefined;
    if (decisions?.reject !== undefined && !count(decisions.reject)) return undefined;
    if (count(decisions?.reject) && decisions.reject > 0) {
      const message =
        "Gemini CLI reported rejected tool permissions; review native policy before retrying.";
      return {
        status: "needs_input",
        summary: message,
        error: { code: "gemini_cli_permission_required", message },
      };
    }
    if (value.warnings !== undefined) {
      if (!strings(value.warnings)) return undefined;
      // Native hooks, loop detection and turn limits may stop a run with exit 0.
      if (value.warnings.length)
        return cliFailure(
          "incomplete",
          "Gemini CLI emitted execution warnings; inspect bounded diagnostics before retrying.",
        );
    }
    if (typeof value.response !== "string" || Buffer.byteLength(value.response) > 256 * 1024)
      return undefined;
    let result: unknown;
    try {
      result = JSON.parse(value.response);
    } catch {
      return undefined;
    }
    if (
      !object(result) ||
      Object.keys(result).length !== 4 ||
      Object.keys(result).some(
        (key) => !["status", "summary", "changedFiles", "commandsRun"].includes(key),
      ) ||
      typeof result.status !== "string" ||
      !["success", "failure", "needs_input"].includes(result.status) ||
      typeof result.summary !== "string" ||
      !result.summary.trim() ||
      !strings(result.changedFiles) ||
      !strings(result.commandsRun)
    )
      return undefined;
    return {
      status: result.status as AgentResult["status"],
      summary: result.summary,
      data: { changedFiles: result.changedFiles, commandsRun: result.commandsRun },
    };
  }
}

function cliUsage(stats: unknown): UsageMetadata | undefined {
  if (!object(stats) || !object(stats.models)) return undefined;
  const models = Object.values(stats.models);
  if (!models.length || models.length > 64) return undefined;
  const usage: UsageMetadata = {};
  for (const [source, target] of [
    ["prompt", "inputTokens"],
    ["candidates", "outputTokens"],
    ["total", "totalTokens"],
    ["cached", "cachedInputTokens"],
    ["thoughts", "reasoningTokens"],
  ] as const) {
    const values = models.map((model) =>
      object(model) && object(model.tokens) ? model.tokens[source] : undefined,
    );
    if (!values.every(count)) continue;
    const total = values.reduce((sum, value) => sum + value, 0);
    if (count(total)) usage[target] = total;
  }
  return Object.keys(usage).length ? usage : undefined;
}
