import { describe, expect, it } from "vitest";
import { CodexOutput } from "../src/output.js";

const valid = { status: "success", summary: "Done", changedFiles: [], commandsRun: [] };
const resultLine = (value: unknown) =>
  JSON.stringify({
    type: "item.completed",
    item: { type: "agent_message", text: JSON.stringify(value) },
  });
const end = JSON.stringify({ type: "turn.completed" });
describe("Codex JSONL", () => {
  it.each([
    { ...valid, extra: true },
    { ...valid, status: "complete" },
    { ...valid, summary: "" },
    { ...valid, changedFiles: [12] },
    { ...valid, commandsRun: [""] },
    {},
  ])("rejects invalid final payload %j", (value) => {
    const output = new CodexOutput();
    output.feed(`${resultLine(value)}\n${end}\n`);
    expect(output.finish()).toBeUndefined();
  });

  it.each(["not json\n", '{"type":"turn.failed"}\n', "null\n"])(
    "rejects malformed or failed event history %s",
    (prefix) => {
      const output = new CodexOutput();
      output.feed(`${prefix}${resultLine(valid)}\n${end}`);
      expect(output.finish()).toBeUndefined();
    },
  );

  it("requires a completion event and a valid final message", () => {
    const output = new CodexOutput();
    output.feed(resultLine(valid));
    expect(output.finish()).toBeUndefined();
  });

  it("uses the final agent message, allowing earlier commentary and unknown event types", () => {
    const output = new CodexOutput();
    output.feed(
      `${resultLine("Working...")}\n{"type":"future.event"}\n${resultLine(valid)}\n${end}\n`,
    );
    expect(output.finish()?.status).toBe("success");
  });

  it("drops oversized command records in chunks and still accepts the final result", () => {
    const output = new CodexOutput();
    output.feed('{"type":"item.completed","output":"');
    for (let index = 0; index < 30; index++) output.feed("x".repeat(65536));
    output.feed(`"}\n${resultLine(valid)}\n${end}`);
    expect(output.finish()?.status).toBe("success");
    expect(output.droppedRecords).toBe(true);
  });

  it("does not fabricate invalid token usage or cost", () => {
    const output = new CodexOutput();
    output.feed(
      `${resultLine(valid)}\n${JSON.stringify({ type: "turn.completed", usage: { input_tokens: -1, output_tokens: "5" } })}`,
    );
    expect(output.finish()?.status).toBe("success");
    expect(output.usage).toBeUndefined();
  });
});
