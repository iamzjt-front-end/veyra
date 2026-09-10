import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import {
  isDaemonRequest,
  isProjectReview,
  isProjectReviewForResult,
  isProjectSharedState,
  isProjectExecutionResult,
  serializeProjectEnvelope,
  parseProjectEnvelope,
  type ProjectId,
} from "../src/index.js";

describe("canonical review and independent execution lifecycle", () => {
  const state = fixtureProjectState(randomUUID() as ProjectId);
  const review = {
    ...state.review!,
    handoffId: state.handoff!.id,
    findings: [
      {
        severity: "warning" as const,
        description: "Configured test failed; collection completed.",
      },
    ],
    sourceVerdict: "PASS" as const,
  };
  it("round-trips findings and original verdict without upgrading verification", () => {
    const result = {
      ...state.result!,
      executionStatus: "completed" as const,
      status: "failed" as const,
    };
    expect(isProjectExecutionResult(result)).toBe(true);
    expect(isProjectReviewForResult(review, result)).toBe(true);
    expect(parseProjectEnvelope(serializeProjectEnvelope(review))).toEqual(review);
    expect(isProjectSharedState({ ...state, result, review })).toBe(true);
    expect(result.status).toBe("failed");
  });
  it("accepts historical state with an old review or no review", () => {
    expect(isProjectSharedState(state)).toBe(true);
    const { review: _review, ...legacy } = state;
    expect(isProjectSharedState(legacy)).toBe(true);
  });
  it.each([
    { findings: [{ severity: "error", description: "bad" }] },
    { findings: [{ severity: "info", description: "", command: "execute" }] },
    { findings: Array.from({ length: 65 }, () => ({ severity: "info", description: "x" })) },
    { sourceVerdict: "FAIL" },
    { token: "secret" },
    { nextAction: "shell" },
  ])("rejects malformed or expanded authority: %j", (change) => {
    expect(isProjectReview({ ...review, ...change })).toBe(false);
  });
  it.each(["projectId", "runId", "resultId", "handoffId"])("rejects wrong %s", (field) => {
    expect(isProjectReviewForResult({ ...review, [field]: randomUUID() }, state.result)).toBe(
      false,
    );
  });
  it("validates scoped review tool inputs and reviewer provenance", () => {
    const runId = randomUUID();
    const request = {
      version: 1,
      method: "reviews.submit",
      params: { projectId: state.projectId, runId, review: { ...review, runId, evidence: [] } },
    };
    expect(isDaemonRequest(request)).toBe(true);
    expect(
      isDaemonRequest({ ...request, params: { ...request.params, projectId: randomUUID() } }),
    ).toBe(false);
    expect(
      isDaemonRequest({ ...request, params: { ...request.params, runId: randomUUID() } }),
    ).toBe(false);
    expect(
      isDaemonRequest({
        ...request,
        params: {
          ...request.params,
          review: { ...request.params.review, provenance: { ...review.provenance, role: "human" } },
        },
      }),
    ).toBe(false);
  });
});
