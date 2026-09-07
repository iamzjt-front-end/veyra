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

const MAX_LINE_CHARS = 1024 * 1024;

/** Consume JSONL incrementally so final events survive bounded stdout retention. */
export class CodexOutput {
  #pending = "";
  #droppingLine = false;
  #message = "";
  completed = false;
  failed = false;
  invalid = false;
  droppedRecords = false;
  usage?: UsageMetadata;

  feed(chunk: string) {
    this.#pending += chunk;
    let newline = this.#pending.indexOf("\n");
    while (newline >= 0) {
      const line = this.#pending.slice(0, newline);
      this.#pending = this.#pending.slice(newline + 1);
      if (!this.#droppingLine) this.#record(line);
      this.#droppingLine = false;
      newline = this.#pending.indexOf("\n");
    }
    if (this.#pending.length > MAX_LINE_CHARS) {
      this.#pending = "";
      this.#droppingLine = true;
      this.droppedRecords = true;
    }
  }

  finish(): AgentResult | undefined {
    if (this.#pending && !this.#droppingLine) this.#record(this.#pending);
    this.#pending = "";
    if (!this.completed || this.failed || this.invalid || !this.#message) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(this.#message);
    } catch {
      return undefined;
    }
    if (
      !object(value) ||
      Object.keys(value).length !== 4 ||
      Object.keys(value).some(
        (key) => !["status", "summary", "changedFiles", "commandsRun"].includes(key),
      ) ||
      (value.status !== "success" &&
        value.status !== "failure" &&
        value.status !== "needs_input") ||
      typeof value.summary !== "string" ||
      !value.summary.trim() ||
      !strings(value.changedFiles) ||
      !strings(value.commandsRun)
    )
      return undefined;
    return {
      status: value.status,
      summary: value.summary,
      data: { changedFiles: value.changedFiles, commandsRun: value.commandsRun },
    };
  }

  #record(line: string) {
    if (!line.trim()) return;
    if (line.length > MAX_LINE_CHARS) {
      this.droppedRecords = true;
      return;
    }
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      this.invalid = true;
      return;
    }
    if (!object(value) || typeof value.type !== "string") {
      this.invalid = true;
      return;
    }
    if (value.type === "turn.failed") this.failed = true;
    if (value.type === "turn.completed") {
      this.completed = true;
      if (object(value.usage)) {
        const usage: UsageMetadata = {};
        for (const [key, count] of [
          ["inputTokens", value.usage.input_tokens],
          ["outputTokens", value.usage.output_tokens],
          ["cachedInputTokens", value.usage.cached_input_tokens],
          ["reasoningTokens", value.usage.reasoning_output_tokens],
        ] as const) {
          if (typeof count === "number" && Number.isSafeInteger(count) && count >= 0)
            usage[key] = count;
        }
        if (
          usage.inputTokens !== undefined &&
          usage.outputTokens !== undefined &&
          Number.isSafeInteger(usage.inputTokens + usage.outputTokens)
        )
          usage.totalTokens = usage.inputTokens + usage.outputTokens;
        if (Object.keys(usage).length) this.usage = usage;
      }
    }
    if (
      value.type === "item.completed" &&
      object(value.item) &&
      value.item.type === "agent_message" &&
      typeof value.item.text === "string"
    )
      this.#message = value.item.text;
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function strings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string" && item.trim());
}
