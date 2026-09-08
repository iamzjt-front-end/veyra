import { describe, expect, it } from "vitest";
import { OpenCodeOutput } from "../src/output.js";
import { claim, events, part, record } from "./fixtures.js";

const parse = (text: string) => {
  const output = new OpenCodeOutput();
  output.feed(text);
  return { result: output.finish(), usage: output.usage };
};
const finish = (fields: Record<string, unknown> = {}) =>
  record("step_finish", { part: part("step-finish", { reason: "stop", ...fields }) });
const tokens = { input: 10, output: 4, reasoning: 2, total: 21, cache: { read: 3, write: 2 } };

describe("OpenCode native event normalization", () => {
  it("does not coerce untrusted error/status objects", () => {
    const malformed = { toString: "invalid", valueOf: "invalid" };
    expect(
      parse(record("error", { error: { name: "APIError", data: { statusCode: malformed } } }))
        .result?.error?.code,
    ).toBe("opencode_provider_error");
    expect(
      parse(events() + record("tool_use", { part: part("tool", { state: { status: malformed } }) }))
        .result,
    ).toBeUndefined();
  });
  it.each([401, 403])("pauses on native API credential/access rejection %s", (statusCode) => {
    expect(
      parse(
        record("error", {
          error: {
            name: "APIError",
            data: { message: "Invalid API Key", statusCode, isRetryable: false },
          },
        }),
      ).result,
    ).toMatchObject({ status: "needs_input", error: { code: "opencode_auth_required" } });
  });
  it.each(["success", "failure", "needs_input"])(
    "normalizes a complete %s executor result across arbitrary chunks",
    (status) => {
      const output = new OpenCodeOutput();
      const text = events({ ...claim, status });
      for (let index = 0; index < text.length; index += 7)
        output.feed(text.slice(index, index + 7));
      expect(output.finish()).toMatchObject({ status, summary: claim.summary });
    },
  );
  it("uses only text from the final step after tool iterations and replaces duplicate text records", () => {
    const first = events({ ...claim, summary: "intermediate" }, "tool-calls");
    const next =
      record("step_start", { part: part("step-start", { id: "next-start" }) }) +
      record("text", {
        part: part("text", { id: "next-text", text: "old incomplete text", time: { end: 2 } }),
      }) +
      record("text", {
        part: part("text", { id: "next-text", text: JSON.stringify(claim), time: { end: 2 } }),
      }) +
      finish({ id: "next-finish" });
    expect(parse(first + next).result?.summary).toBe(claim.summary);
  });
  it("concatenates distinct completed text parts and accepts a final line without newline", () => {
    const text = JSON.stringify(claim);
    const stream =
      record("step_start", { part: part("step-start") }) +
      record("text", {
        part: part("text", { id: "a", text: text.slice(0, 20), time: { end: 2 } }),
      }) +
      record("text", { part: part("text", { id: "b", text: text.slice(20), time: { end: 3 } }) }) +
      finish();
    expect(parse(stream.trimEnd()).result?.status).toBe("success");
  });
  it.each([
    "",
    "null\n",
    "[]\n",
    "{}\n",
    "human output\n",
    record("unknown"),
    events({}, "stop"),
    events({ ...claim, extra: true }),
    events({ ...claim, status: "passed" }),
    events({ ...claim, summary: " " }),
    events({ ...claim, changedFiles: "file" }),
    events({ ...claim, commandsRun: [3] }),
    events({ ...claim, changedFiles: Array(1025).fill("path") }),
    events(claim, "tool-calls"),
    events(claim, "length"),
    events().replace('"sessionID":"session"', '"sessionID":"different"'),
    events().replace('"messageID":"message"', '"messageID":"different"'),
    events().replace('"end":2', '"end":"no"'),
  ])("rejects invalid, incomplete and mismatched records %#", (text) => {
    expect(parse(text).result).toBeUndefined();
  });
  it("rejects text without a matching start and a new step missing final completion", () => {
    expect(
      parse(
        record("text", { part: part("text", { text: JSON.stringify(claim), time: { end: 1 } }) }) +
          finish(),
      ).result,
    ).toBeUndefined();
    expect(
      parse(events() + record("step_start", { part: part("step-start", { id: "new" }) })).result,
    ).toBeUndefined();
  });
  it("normalizes provider errors and permission rejections without echoing native messages", () => {
    const error = (name: string) =>
      record("error", { error: { name, data: { message: "private provider error" } } });
    expect(parse(events() + error("ProviderAuthError")).result).toMatchObject({
      status: "needs_input",
      error: { code: "opencode_auth_required" },
    });
    expect(parse(error("APIError")).result?.error?.code).toBe("opencode_provider_error");
    expect(parse(error("MessageAbortedError")).result?.error?.code).toBe("opencode_cancelled");
    expect(JSON.stringify(parse(error("APIError")))).not.toContain("private provider error");
    expect(
      parse(`${events()}\u001b[33m!\u001b[0m permission requested: edit (file); auto-rejecting\n`)
        .result?.status,
    ).toBe("needs_input");
  });
  it("does not let a success claim hide tool failures", () => {
    expect(
      parse(
        events() +
          record("tool_use", {
            part: part("tool", { state: { status: "error", error: "failure" } }),
          }),
      ).result?.error?.code,
    ).toBe("opencode_tool_failed");
  });
  it("ignores reasoning/tool content and never parses their text as the final result", () => {
    const stream =
      events() +
      record("reasoning", { part: part("reasoning", { text: "private thinking" }) }) +
      record("tool_use", {
        part: part("tool", { state: { status: "completed", output: "private tool output" } }),
      });
    expect(parse(stream).result?.status).toBe("success");
    expect(JSON.stringify(parse(stream))).not.toMatch(/private thinking|private tool output/);
  });
  it("sums unique reported step usage without counting replayed finish events twice", () => {
    const first = events(claim, "tool-calls").replace(
      finish({ reason: "tool-calls" }),
      finish({ reason: "tool-calls", tokens }),
    );
    const last =
      record("step_start", { part: part("step-start", { id: "next-start" }) }) +
      record("text", { part: part("text", { text: JSON.stringify(claim), time: { end: 2 } }) }) +
      finish({ id: "last-finish", tokens });
    const parsed = parse(first + last + finish({ id: "last-finish", tokens }));
    expect(parsed.result?.status).toBe("success");
    expect(parsed.usage).toEqual({
      inputTokens: 30,
      outputTokens: 8,
      reasoningTokens: 4,
      cachedInputTokens: 6,
      totalTokens: 42,
    });
  });
  it("rejects conflicting finish replays", () => {
    expect(parse(events() + finish({ reason: "length" })).result).toBeUndefined();
    expect(
      parse(events() + record("step_start", { part: part("step-start", { messageID: "foreign" }) }))
        .result,
    ).toBeUndefined();
  });
  it("omits unknown, invalid and incomplete usage and does not treat native zero cost as known pricing", () => {
    expect(parse(events()).usage).toBeUndefined();
    expect(
      parse(events().replace(finish(), finish({ tokens: { input: 2, output: 3 }, cost: 0 }))).usage,
    ).toEqual({ outputTokens: 3 });
    expect(
      parse(
        events().replace(
          finish(),
          finish({ tokens: { input: -1, output: 0.5, total: Number.MAX_SAFE_INTEGER + 1 } }),
        ),
      ).usage,
    ).toBeUndefined();
    expect(
      parse(
        events().replace(
          finish(),
          finish({ tokens: { ...tokens, input: Number.MAX_SAFE_INTEGER } }),
        ),
      ).usage,
    ).not.toHaveProperty("inputTokens");
  });
  it("bounds a huge line, final response and total event count and never accepts a later success", () => {
    for (const text of [
      "x".repeat(1024 * 1024 + 1),
      record("reasoning", { data: "x".repeat(1024 * 1024) }),
      events({ ...claim, summary: "x".repeat(256 * 1024) }),
      record("step_start", { part: part("step-start") }).repeat(10001),
    ]) {
      const output = new OpenCodeOutput();
      output.feed(text);
      output.feed(events());
      expect(output.oversized).toBe(true);
      expect(output.finish()).toBeUndefined();
    }
  });
});
