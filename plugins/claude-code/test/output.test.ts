import { isJsonValue } from "@veyraoss/protocol";
import { describe, expect, it } from "vitest";
import { ClaudeCodeOutput } from "../src/output.js";

export const resultMessage = {
  type: "result",
  subtype: "success",
  is_error: false,
  permission_denials: [],
  structured_output: {
    status: "success",
    summary: "Repaired the greeting",
    changedFiles: ["src/message.js"],
    commandsRun: ["node --test"],
  },
  usage: {
    input_tokens: 10,
    cache_creation_input_tokens: 3,
    cache_read_input_tokens: 7,
    output_tokens: 5,
  },
  total_cost_usd: 0.01,
};
function parse(value: unknown) {
  const output = new ClaudeCodeOutput();
  output.feed(JSON.stringify(value));
  return { result: output.finish(), usage: output.usage };
}

describe("Claude Code JSON results", () => {
  it("parses arbitrary chunks and preserves truthful usage, cost and execution claims", () => {
    const output = new ClaudeCodeOutput();
    const json = JSON.stringify(resultMessage);
    for (let i = 0; i < json.length; i += 11) output.feed(json.slice(i, i + 11));
    const result = output.finish();
    expect(result).toEqual({
      status: "success",
      summary: "Repaired the greeting",
      data: { changedFiles: ["src/message.js"], commandsRun: ["node --test"] },
    });
    expect(output.usage).toEqual({
      inputTokens: 20,
      cachedInputTokens: 7,
      outputTokens: 5,
      totalTokens: 25,
      cost: { amount: 0.01, currency: "USD" },
    });
    expect(isJsonValue(result)).toBe(true);
  });
  it.each(["failure", "needs_input"])("preserves the reported %s status", (status) => {
    expect(
      parse({ ...resultMessage, structured_output: { ...resultMessage.structured_output, status } })
        .result?.status,
    ).toBe(status);
  });
  it.each(
    [
      {},
      [],
      null,
      { type: "assistant" },
      { ...resultMessage, type: "other" },
      { ...resultMessage, is_error: undefined },
      {
        ...resultMessage,
        structured_output: undefined,
        result: JSON.stringify(resultMessage.structured_output),
      },
      { ...resultMessage, permission_denials: {} },
      ...[
        [],
        {},
        { ...resultMessage.structured_output, summary: " " },
        { ...resultMessage.structured_output, status: "pass" },
        { ...resultMessage.structured_output, changedFiles: [42] },
        { ...resultMessage.structured_output, commandsRun: [""] },
        { ...resultMessage.structured_output, extra: true },
        { ...resultMessage.structured_output, summary: "x".repeat(256 * 1024) },
      ].map((structured_output) => ({ ...resultMessage, structured_output })),
    ].map((value) => [value]),
  )("rejects malformed, ambiguous or excessive result %#", (value) => {
    expect(parse(value).result).toBeUndefined();
  });
  it.each([
    "error_max_turns",
    "error_max_budget_usd",
    "error_max_structured_output_retries",
    "error_during_execution",
    "unrecognized",
  ])("normalizes %s without echoing raw errors", (subtype) => {
    const parsed = parse({
      ...resultMessage,
      subtype,
      is_error: true,
      errors: ["private failure detail"],
    });
    expect(parsed.result).toMatchObject({
      status: "failure",
      error: {
        code: `claude_code_${subtype === "unrecognized" ? "error_during_execution" : subtype}`,
      },
    });
    expect(JSON.stringify(parsed.result)).not.toContain("private failure detail");
    expect(parsed.usage?.totalTokens).toBe(25);
  });
  it("does not accept an is_error success result", () => {
    expect(parse({ ...resultMessage, is_error: true }).result?.status).toBe("failure");
  });
  it.each([
    { terminal_reason: "aborted_streaming" },
    { terminal_reason: "max_turns" },
    { stop_reason: "max_tokens" },
    { stop_reason: "refusal" },
  ])("rejects an incomplete turn despite a success envelope %j", (fields) => {
    expect(parse({ ...resultMessage, ...fields }).result).toMatchObject({
      status: "failure",
      error: { code: "claude_code_incomplete" },
    });
  });
  it.each([
    { permission_denials: [{ tool_name: "Bash", tool_input: { command: "private command" } }] },
    { stop_reason: "tool_deferred" },
    { deferred_tool_use: { name: "Bash" } },
  ])("pauses a native permission request %j even if the model claimed success", (fields) => {
    const result = parse({ ...resultMessage, ...fields }).result;
    expect(result).toMatchObject({
      status: "needs_input",
      error: { code: "claude_code_permission_required" },
    });
    expect(JSON.stringify(result)).not.toContain("private command");
  });
  it("omits unknown, invalid and overflowing accounting without inventing zero", () => {
    expect(parse({ ...resultMessage, usage: {}, total_cost_usd: undefined }).usage).toBeUndefined();
    expect(
      parse({ ...resultMessage, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: -1 })
        .usage,
    ).toEqual({ outputTokens: 5 });
    expect(
      parse({
        ...resultMessage,
        usage: { ...resultMessage.usage, input_tokens: Number.MAX_SAFE_INTEGER, output_tokens: -1 },
        total_cost_usd: "1",
      }).usage,
    ).toEqual({ cachedInputTokens: 7 });
    expect(
      parse({
        ...resultMessage,
        usage: {
          ...resultMessage.usage,
          input_tokens: Number.MAX_SAFE_INTEGER,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
        total_cost_usd: 0,
      }).usage,
    ).toEqual({
      inputTokens: Number.MAX_SAFE_INTEGER,
      cachedInputTokens: 0,
      outputTokens: 5,
      cost: { amount: 0, currency: "USD" },
    });
  });
  it("rejects multiple JSON records, incomplete output and an oversized envelope", () => {
    for (const text of [
      "not JSON",
      JSON.stringify(resultMessage).slice(0, -1),
      `${JSON.stringify(resultMessage)}\n${JSON.stringify(resultMessage)}`,
    ]) {
      const output = new ClaudeCodeOutput();
      output.feed(text);
      expect(output.finish()).toBeUndefined();
    }
    const output = new ClaudeCodeOutput();
    output.feed("中".repeat(400_000));
    output.feed(JSON.stringify(resultMessage));
    expect(output.oversized).toBe(true);
    expect(output.finish()).toBeUndefined();
  });
});
