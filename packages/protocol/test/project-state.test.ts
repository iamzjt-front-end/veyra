import { describe, expect, it } from "vitest";
import type { ProjectId } from "@veyraoss/protocol";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import {
  isProjectSharedState,
  isProjectHandoff,
  isProjectExecutionResult,
  isProjectReview,
} from "../src/index.js";

const id = "f1cafe00-1897-4555-a629-123456789012" as ProjectId;

describe("Shared Project State contracts", () => {
  it("round-trips bounded provider-neutral envelopes with existing evidence and artifact references", () => {
    const state = fixtureProjectState(id);
    expect(isProjectSharedState(JSON.parse(JSON.stringify(state)))).toBe(true);
    expect(isProjectHandoff(state.handoff)).toBe(true);
    expect(isProjectExecutionResult(state.result)).toBe(true);
    expect(isProjectReview(state.review)).toBe(true);
  });
  it.each([
    "unknown",
    "version",
    "wrong-project",
    "wrong-handoff",
    "wrong-result",
    "wrong-run",
    "traversal",
    "duplicate-task",
    "missing-task",
    "provenance",
    "history",
    "credentials",
    "oversized",
    "unbounded-list",
  ])("rejects %s", (kind) => {
    const state = JSON.parse(JSON.stringify(fixtureProjectState(id)));
    if (kind === "unknown") state.extra = {};
    if (kind === "version") state.version = 2;
    if (kind === "wrong-project") state.handoff.projectId = "f1cafe00-1897-4555-a629-123456789013";
    if (kind === "wrong-handoff") state.result.handoffId = "different";
    if (kind === "wrong-result") state.review.resultId = "different";
    if (kind === "wrong-run") state.result.evidence[0].runId = "different";
    if (kind === "traversal") state.result.artifacts[0].path = "../unrelated";
    if (kind === "duplicate-task") state.context.plan.tasks.push(state.context.plan.tasks[0]);
    if (kind === "missing-task") state.context.currentTask = "missing";
    if (kind === "provenance") delete state.context.decisions[0].provenance;
    if (kind === "history") state.handoff.history = ["unrelated chat"];
    if (kind === "credentials") state.context.plan.apiKey = "test-value";
    if (kind === "oversized") state.context.goal = "x".repeat(8193);
    if (kind === "unbounded-list") state.context.constraints = Array(101).fill("constraint");
    expect(isProjectSharedState(state)).toBe(false);
  });
  it("rejects accessors and cycles without executing user code", () => {
    const state = fixtureProjectState(id);
    Object.defineProperty(state, "context", {
      get: () => {
        throw new Error("Must not execute");
      },
    });
    expect(isProjectSharedState(state)).toBe(false);
    const cyclic: Record<string, unknown> = { ...fixtureProjectState(id) };
    cyclic.extra = cyclic;
    expect(isProjectSharedState(cyclic)).toBe(false);
  });
});
