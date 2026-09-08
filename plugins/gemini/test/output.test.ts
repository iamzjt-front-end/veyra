import { describe, expect, it } from "vitest";
import { normalizeUsage, parseOutput } from "../src/output.js";
import { input, plan, review } from "./fixtures.js";

describe("Gemini role output validation", () => {
  it("normalizes plans and deduplicates only supplied evidence", () => {
    const result = parseOutput(
      "planner",
      JSON.stringify({ ...plan, artifactIds: ["test-log", "test-log"] }),
      input.artifacts ?? [],
    );
    expect(result).toEqual({
      status: "success",
      summary: plan.summary,
      data: { instructions: plan.instructions, acceptanceCriteria: plan.acceptanceCriteria },
      artifacts: input.artifacts,
    });
  });
  it.each(["pass", "fail"])(
    "preserves review %s as outcome independently of technical success",
    (outcome) => {
      const requiredFixes = outcome === "fail" ? ["Fix the greeting"] : [];
      expect(
        parseOutput(
          "reviewer",
          JSON.stringify({ ...review, outcome, requiredFixes }),
          input.artifacts ?? [],
        ),
      ).toMatchObject({
        status: "success",
        outcome,
        data: { requiredFixes, evidenceArtifactIds: ["test-log"] },
      });
    },
  );
  it.each(
    [
      null,
      [],
      {},
      { ...plan, summary: " " },
      { ...plan, instructions: 1 },
      { ...plan, acceptanceCriteria: [] },
      { ...plan, acceptanceCriteria: [null] },
      { ...plan, artifactIds: ["invented"] },
      { ...plan, extra: true },
      { ...plan, artifactIds: [""] },
      { ...plan, acceptanceCriteria: new Array(1025).fill("criterion") },
    ].map((value) => [value]),
  )("rejects an invalid plan %#", (value) => {
    expect(() => parseOutput("planner", JSON.stringify(value), input.artifacts ?? [])).toThrow();
  });
  it.each([
    { ...review, outcome: "success" },
    { ...review, outcome: "fail" },
    { ...review, requiredFixes: ["repair"] },
    { ...review, requiredFixes: [2] },
    { ...review, evidenceArtifactIds: ["invented"] },
    { ...review, summary: "" },
    { ...review, extra: true },
  ])("rejects an invalid review %#", (value) => {
    expect(() => parseOutput("reviewer", JSON.stringify(value), input.artifacts ?? [])).toThrow();
  });
  it("does not treat a code fence as structured JSON", () => {
    expect(() =>
      parseOutput("planner", `\`\`\`json\n${JSON.stringify(plan)}\n\`\`\``, []),
    ).toThrow();
  });
  it("preserves separate reported cache/thought accounting and omits unknown costs/totals", () => {
    expect(
      normalizeUsage({
        promptTokenCount: 20,
        cachedContentTokenCount: 7,
        candidatesTokenCount: 5,
        thoughtsTokenCount: 3,
        totalTokenCount: 28,
      }),
    ).toEqual({
      inputTokens: 20,
      cachedInputTokens: 7,
      outputTokens: 5,
      reasoningTokens: 3,
      totalTokens: 28,
    });
    expect(normalizeUsage({ promptTokenCount: 20, candidatesTokenCount: 5 })).toEqual({
      inputTokens: 20,
      outputTokens: 5,
    });
    expect(
      normalizeUsage({
        promptTokenCount: -1,
        candidatesTokenCount: 1.5,
        thoughtsTokenCount: "4",
        totalTokenCount: Number.MAX_SAFE_INTEGER + 1,
      }),
    ).toBeUndefined();
    expect(normalizeUsage({ promptTokenCount: 0, totalTokenCount: 0 })).toEqual({
      inputTokens: 0,
      totalTokens: 0,
    });
    expect(normalizeUsage(null)).toBeUndefined();
  });
});
