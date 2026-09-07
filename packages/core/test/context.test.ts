import { describe, expect, it } from "vitest";
import { RunContext } from "../src/context.js";

describe("bounded previous output context", () => {
  it("selects a small field from an older large output and uses its latest replacement", () => {
    const context = new RunContext(["source"]);
    context.add("source", { data: { small: 1, large: "x".repeat(100_000) } });
    for (let index = 0; index < 10; index++) context.add(`later-${index}`, { summary: "done" });
    const references = { selected: { from: "source", path: "/data/small" } };
    expect(context.input().context.steps).not.toHaveProperty("source");
    expect(context.input(references).context.inputs).toEqual({ selected: 1 });
    context.add("source", { data: { small: 2, large: "x".repeat(100_000) } });
    expect(context.input(references).context.inputs).toEqual({ selected: 2 });
    expect(Buffer.byteLength(JSON.stringify(context.input(references)))).toBeLessThan(66 * 1024);
  });
  it("keeps the latest result per recent step and deduplicates bounded artifact references", () => {
    const context = new RunContext();
    for (let index = 0; index < 30; index++)
      context.add(`step-${index}`, { summary: "done" }, [
        { id: `artifact-${index}`, kind: "diff" },
      ]);
    context.add("step-29", { summary: "updated" }, [
      { id: "artifact-29", kind: "diff", path: "latest.patch" },
    ]);
    const value = context.input();
    expect(Object.keys(value.context.steps as object)).toHaveLength(8);
    expect(value.context.steps).toMatchObject({ "step-29": { summary: "updated" } });
    expect(value.artifacts).toHaveLength(16);
    expect(value.artifacts.at(-1)?.path).toBe("latest.patch");
    expect(value.context.omittedSteps).toBe(22);
    expect(value.context.omittedArtifacts).toBe(14);
  });

  it("bounds actual JSON bytes including escaped content and keys, and marks truncation", () => {
    const context = new RunContext();
    for (let index = 0; index < 12; index++)
      context.add(`${index}${"\u0000".repeat(4000)}`, {
        type: "agent",
        outcome: "success",
        summary: "\u0000".repeat(20_000),
        data: { large: "x".repeat(100_000) },
      });
    const value = context.input();
    expect(Buffer.byteLength(JSON.stringify(value))).toBeLessThan(66 * 1024);
    expect(value.context.omittedSteps).toBeGreaterThan(0);
    expect(JSON.stringify(value)).toContain('"truncated":true');
  });

  it("returns independent snapshots and skips oversized artifact metadata", () => {
    const context = new RunContext();
    context.add("work", { summary: "original" }, [
      { id: "huge", kind: "log", metadata: { text: "x".repeat(2000) } },
    ]);
    const first = context.input();
    first.context.steps = {};
    expect(context.input().context.steps).toMatchObject({ work: { summary: "original" } });
    expect(context.input().artifacts).toEqual([]);
    expect(context.input().context.omittedArtifacts).toBe(1);
  });
});
