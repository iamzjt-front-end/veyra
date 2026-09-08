import type { AgentResult, UsageMetadata } from "@veyra/protocol";

export const resultSchema = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["success", "failure", "needs_input"] },
    summary: { type: "string" },
    changedFiles: { type: "array", items: { type: "string" } },
    commandsRun: { type: "array", items: { type: "string" } },
  },
  required: ["status", "summary", "changedFiles", "commandsRun"],
  additionalProperties: false,
};

/** JSON print mode emits one result, without verbose conversation/thinking records. */
export class ClaudeCodeOutput {
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
    if (
      !object(value) ||
      value.type !== "result" ||
      typeof value.is_error !== "boolean" ||
      typeof value.subtype !== "string"
    )
      return undefined;
    this.usage = normalizeUsage(value);
    if (value.is_error || value.subtype !== "success") {
      const messages: Record<string, string> = {
        error_max_turns: "Claude Code reached its configured turn limit.",
        error_max_budget_usd: "Claude Code reached its native cost limit.",
        error_max_structured_output_retries:
          "Claude Code could not produce the required structured result.",
        error_during_execution:
          "Claude Code reported an execution error; inspect bounded diagnostics.",
      };
      const code = Object.hasOwn(messages, value.subtype)
        ? value.subtype
        : "error_during_execution";
      return failure(`claude_code_${code}`, messages[code] as string);
    }
    if (value.permission_denials !== undefined && !Array.isArray(value.permission_denials))
      return undefined;
    if (
      (Array.isArray(value.permission_denials) && value.permission_denials.length > 0) ||
      value.stop_reason === "tool_deferred" ||
      value.deferred_tool_use !== undefined
    ) {
      const message =
        "Claude Code requires tool permission or external input; review native permissions before retrying.";
      return {
        status: "needs_input",
        summary: message,
        error: { code: "claude_code_permission_required", message },
      };
    }
    // Never infer success from free text, an exit code, or a partially valid object.
    if (
      (value.terminal_reason !== undefined && value.terminal_reason !== "completed") ||
      (typeof value.stop_reason === "string" &&
        ["max_tokens", "model_context_window_exceeded", "refusal"].includes(value.stop_reason))
    )
      return failure("claude_code_incomplete", "Claude Code did not complete its execution turn.");
    const result = value.structured_output;
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
      !strings(result.commandsRun) ||
      Buffer.byteLength(JSON.stringify(result)) > 256 * 1024
    )
      return undefined;
    return {
      status: result.status as AgentResult["status"],
      summary: result.summary,
      data: { changedFiles: result.changedFiles, commandsRun: result.commandsRun },
    };
  }
}

function failure(code: string, message: string): AgentResult {
  return { status: "failure", summary: message, error: { code, message } };
}

function normalizeUsage(result: Record<string, unknown>): UsageMetadata | undefined {
  const usage: UsageMetadata = {};
  if (object(result.usage)) {
    const source = result.usage;
    // Anthropic's input_tokens excludes both cache buckets; missing is not zero.
    const counts = [
      source.input_tokens,
      source.cache_creation_input_tokens,
      source.cache_read_input_tokens,
    ];
    if (counts.every(count)) {
      const sum = counts.reduce((a, b) => a + b, 0);
      if (count(sum)) usage.inputTokens = sum;
    }
    if (count(source.output_tokens)) usage.outputTokens = source.output_tokens;
    if (count(source.cache_read_input_tokens))
      usage.cachedInputTokens = source.cache_read_input_tokens;
    if (
      usage.inputTokens !== undefined &&
      usage.outputTokens !== undefined &&
      count(usage.inputTokens + usage.outputTokens)
    )
      usage.totalTokens = usage.inputTokens + usage.outputTokens;
  }
  if (
    typeof result.total_cost_usd === "number" &&
    Number.isFinite(result.total_cost_usd) &&
    result.total_cost_usd >= 0
  )
    usage.cost = { amount: result.total_cost_usd, currency: "USD" };
  return Object.keys(usage).length ? usage : undefined;
}
function count(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= 1024 &&
    value.every((item) => typeof item === "string" && item.trim())
  );
}
