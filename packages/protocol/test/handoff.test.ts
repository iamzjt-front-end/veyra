import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import type { ProjectId } from "@veyraoss/protocol";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import {
  parseProjectEnvelope,
  serializeProjectEnvelope,
  isProjectHandoff,
  isProjectExecutionResult,
  isProjectResultForHandoff,
} from "../src/index.js";

const fixture = fixtureProjectState(randomUUID() as ProjectId);
const handoff = {
  ...fixture.handoff,
  references: [
    { kind: "file", path: "src/main.ts", startLine: 2, endLine: 8 },
    { kind: "artifact", id: "earlier-diff", runId: "previous-run", summary: "Prior work" },
  ],
  requestedVerification: [
    { id: "verify", kind: "test", description: "Existing trusted acceptance test" },
  ],
};
const result = {
  ...fixture.result,
  diff: { summary: "One file", source: "git", artifact: fixture.result?.artifacts[0] },
  risks: [{ code: "known-limitation", summary: "Review edge cases", source: "executor" }],
  verification: [{ id: "verify", status: "passed", evidence: fixture.result?.evidence[0] }],
};

it("serializes the same interchange deterministically regardless of object insertion order", () => {
  function reverse(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(reverse);
    if (value && typeof value === "object")
      return Object.fromEntries(
        Object.entries(value)
          .reverse()
          .map(([key, item]) => [key, reverse(item)]),
      );
    return value;
  }
  for (const payload of [handoff, result, fixture.review]) {
    const wire = serializeProjectEnvelope(payload);
    expect(wire).toBe(serializeProjectEnvelope(reverse(payload)));
    expect(parseProjectEnvelope(wire)).toEqual(payload);
  }
  expect(isProjectResultForHandoff(result, handoff)).toBe(true);
  expect(isProjectResultForHandoff({ ...result, verification: [] }, handoff)).toBe(false);
  const tasks = [
    { id: "first", description: "First" },
    { id: "second", description: "Second" },
  ];
  const ordered = {
    ...handoff,
    context: {
      ...handoff.context,
      currentTask: "first",
      plan: { ...handoff.context?.plan, tasks },
    },
  };
  expect(serializeProjectEnvelope(ordered).indexOf('"id":"first"')).toBeLessThan(
    serializeProjectEnvelope(ordered).indexOf('"id":"second"'),
  );
});

it.each([
  { references: [{ kind: "file", path: "../auth.json" }] },
  { references: [{ kind: "file", path: "/outside" }] },
  { references: [{ kind: "file", path: "source.ts", startLine: 3, endLine: 1 }] },
  { requestedVerification: [{ id: "verify", kind: "shell", command: "untrusted command" }] },
  {
    requestedVerification: [
      { id: "same", kind: "test" },
      { id: "same", kind: "build" },
    ],
  },
  { credentials: "secret" },
  { chatHistory: ["private chat"] },
  { version: 2 },
])("rejects untrusted or unsupported handoff fields %#", (change) => {
  const value = { ...handoff, ...change };
  expect(isProjectHandoff(value)).toBe(false);
  expect(() => parseProjectEnvelope(JSON.stringify(value))).toThrow("Invalid");
});

it("requires real verifier references for pass/fail claims and checks diff producer scoping", () => {
  expect(
    isProjectExecutionResult({
      ...result,
      verification: [
        { id: "different-check", status: "passed", evidence: fixture.result?.evidence[0] },
      ],
    }),
  ).toBe(false);
  expect(
    isProjectExecutionResult({ ...result, verification: [{ id: "verify", status: "passed" }] }),
  ).toBe(false);
  expect(
    isProjectExecutionResult({ ...result, verification: [{ id: "verify", status: "not_run" }] }),
  ).toBe(false);
  expect(
    isProjectExecutionResult({
      ...result,
      status: "failed",
      verification: [{ id: "verify", status: "not_run" }],
    }),
  ).toBe(true);
  expect(
    isProjectExecutionResult({
      ...result,
      diff: { ...result.diff, artifact: { ...result.diff.artifact, producer: { runId: "other" } } },
    }),
  ).toBe(false);
});

it("bounds parser input and serializer output without invoking getters or echoing private data", () => {
  expect(() => parseProjectEnvelope(" ".repeat(65537))).toThrow("oversized");
  expect(() => parseProjectEnvelope("secret-not-json")).toThrow("Invalid");
  expect(() =>
    serializeProjectEnvelope({
      ...handoff,
      references: Array(128).fill({
        kind: "artifact",
        id: "large",
        runId: "previous",
        summary: "x".repeat(2048),
      }),
    }),
  ).toThrow("oversized");
  let called = false;
  expect(() =>
    serializeProjectEnvelope({
      ...handoff,
      get credentials() {
        called = true;
        return "secret";
      },
    }),
  ).toThrow("Invalid");
  expect(called).toBe(false);
});
