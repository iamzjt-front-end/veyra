import { stripVTControlCharacters } from "node:util";
import type { AgentResult, UsageMetadata } from "@veyra/protocol";

const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const count = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const id = (value: unknown): value is string =>
  typeof value === "string" && Boolean(value.trim()) && value.length <= 256;
const strings = (value: unknown): value is string[] =>
  Array.isArray(value) && value.length <= 1024 && value.every((item) => typeof item === "string");
export const failure = (code: string, message: string): AgentResult => ({
  status: "failure",
  summary: message,
  error: { code: `opencode_${code}`, message },
});
const needsInput = (code: string, message: string): AgentResult => ({
  status: "needs_input",
  summary: message,
  error: { code: `opencode_${code}`, message },
});

/** Bounded JSONL parser: accept only the final completed step's own text parts. */
export class OpenCodeOutput {
  #pending = "";
  #session?: string;
  #message?: string;
  #startId?: string;
  #reason?: string;
  #texts = new Map<string, string>();
  #finishes = new Map<string, { message: string; reason: string; usage: UsageMetadata }>();
  #records = 0;
  #invalid = false;
  #error?: AgentResult;
  #permission = false;
  #toolError = false;
  oversized = false;
  usage?: UsageMetadata;

  feed(chunk: string) {
    if (this.#invalid) return;
    this.#pending += chunk;
    let newline = this.#pending.indexOf("\n");
    while (newline >= 0) {
      this.#record(this.#pending.slice(0, newline));
      this.#pending = this.#pending.slice(newline + 1);
      if (this.#invalid) {
        this.#pending = "";
        return;
      }
      newline = this.#pending.indexOf("\n");
    }
    if (Buffer.byteLength(this.#pending) > 1024 * 1024) {
      this.oversized = true;
      this.#invalid = true;
      this.#pending = "";
    }
  }

  finish(): AgentResult | undefined {
    if (this.#pending && !this.#invalid) this.#record(this.#pending);
    this.#pending = "";
    this.usage = aggregate([...this.#finishes.values()].map((part) => part.usage));
    if (this.#invalid) return undefined;
    if (this.#error) return this.#error;
    if (this.#permission)
      return needsInput(
        "permission_required",
        "OpenCode rejected a native permission request; review its policy before retrying.",
      );
    if (this.#toolError)
      return failure(
        "tool_failed",
        "OpenCode reported a tool failure; inspect bounded diagnostics before retrying.",
      );
    if (this.#reason !== "stop" || !this.#texts.size) return undefined;
    let result: unknown;
    try {
      result = JSON.parse([...this.#texts.values()].join(""));
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

  #record(line: string) {
    if (!line.trim()) return;
    if (++this.#records > 10000 || Buffer.byteLength(line) > 1024 * 1024) {
      this.oversized = true;
      this.#invalid = true;
      return;
    }
    // Native headless permission rejection is printed as a UI line even in JSON mode.
    if (
      /^!\s+permission requested: .+; auto-rejecting$/.test(stripVTControlCharacters(line).trim())
    ) {
      this.#permission = true;
      return;
    }
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      this.#invalid = true;
      return;
    }
    if (
      !object(event) ||
      !id(event.sessionID) ||
      typeof event.type !== "string" ||
      (this.#session !== undefined && this.#session !== event.sessionID)
    ) {
      this.#invalid = true;
      return;
    }
    this.#session = event.sessionID;
    if (event.type === "error") {
      if (!object(event.error) || typeof event.error.name !== "string") {
        this.#invalid = true;
        return;
      }
      const accessRejected =
        event.error.name === "APIError" &&
        object(event.error.data) &&
        (event.error.data.statusCode === 401 || event.error.data.statusCode === 403);
      this.#error =
        event.error.name === "ProviderAuthError" || accessRejected
          ? needsInput(
              "auth_required",
              "OpenCode requires valid provider credentials and access; configure opencode auth login or its standard environment and retry.",
            )
          : event.error.name === "MessageAbortedError"
            ? failure("cancelled", "OpenCode execution was cancelled.")
            : failure(
                "provider_error",
                "OpenCode reported a provider/session error; inspect bounded diagnostics.",
              );
      return;
    }
    const part = event.part;
    const types: Record<string, string> = {
      step_start: "step-start",
      step_finish: "step-finish",
      text: "text",
      tool_use: "tool",
      reasoning: "reasoning",
    };
    if (
      !Object.hasOwn(types, event.type) ||
      !object(part) ||
      part.type !== types[event.type] ||
      part.sessionID !== this.#session ||
      !id(part.id) ||
      !id(part.messageID)
    ) {
      this.#invalid = true;
      return;
    }
    if (event.type === "step_start") {
      if (part.id === this.#startId) {
        if (part.messageID !== this.#message) this.#invalid = true;
        return;
      }
      if (this.#startId && this.#reason === undefined) {
        this.#invalid = true;
        return;
      }
      this.#startId = part.id;
      this.#message = part.messageID;
      this.#reason = undefined;
      this.#texts.clear();
      return;
    }
    if (part.messageID !== this.#message) {
      this.#invalid = true;
      return;
    }
    if (event.type === "step_finish") {
      if (typeof part.reason !== "string") {
        this.#invalid = true;
        return;
      }
      const value = { message: part.messageID, reason: part.reason, usage: partUsage(part.tokens) };
      const previous = this.#finishes.get(part.id);
      if (previous && JSON.stringify(previous) !== JSON.stringify(value)) {
        this.#invalid = true;
        return;
      }
      if (!previous && this.#reason !== undefined) {
        this.#invalid = true;
        return;
      }
      this.#reason = part.reason;
      this.#finishes.set(part.id, value);
      return;
    }
    if (event.type === "text") {
      if (
        typeof part.text !== "string" ||
        !object(part.time) ||
        !count(part.time.end) ||
        part.synthetic === true ||
        part.ignored === true
      ) {
        this.#invalid = true;
        return;
      }
      this.#texts.set(part.id, part.text);
      if (
        this.#texts.size > 1024 ||
        Buffer.byteLength([...this.#texts.values()].join("")) > 256 * 1024
      ) {
        this.oversized = true;
        this.#invalid = true;
      }
      return;
    }
    if (event.type === "tool_use") {
      if (
        !object(part.state) ||
        typeof part.state.status !== "string" ||
        !["completed", "error"].includes(part.state.status)
      ) {
        this.#invalid = true;
        return;
      }
      if (part.state.status === "error") this.#toolError = true;
    }
  }
}

function partUsage(source: unknown): UsageMetadata {
  if (!object(source)) return {};
  const result: UsageMetadata = {};
  const cache = object(source.cache) ? source.cache : {};
  if ([source.input, cache.read, cache.write].every(count)) {
    const input = (source.input as number) + (cache.read as number) + (cache.write as number);
    if (count(input)) result.inputTokens = input;
  }
  for (const [key, value] of [
    ["outputTokens", source.output],
    ["totalTokens", source.total],
    ["cachedInputTokens", cache.read],
    ["reasoningTokens", source.reasoning],
  ] as const)
    if (count(value)) result[key] = value;
  return result;
}

function aggregate(parts: UsageMetadata[]): UsageMetadata | undefined {
  if (!parts.length) return undefined;
  const result: UsageMetadata = {};
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "cachedInputTokens",
    "reasoningTokens",
  ] as const) {
    const values = parts.map((part) => part[key]);
    if (!values.every(count)) continue;
    const sum = values.reduce((total, value) => total + value, 0);
    if (count(sum)) result[key] = sum;
  }
  return Object.keys(result).length ? result : undefined;
}
