import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import type { ProjectId } from "@veyraoss/protocol";
import {
  I18nProvider,
  LocaleStore,
  RunOutcomes,
  runOutcomes,
  runSteps,
  type RunEvidence,
} from "../src/index.js";

function evidence(failed: boolean, verdict?: "pass" | "fail" | "needs_input"): RunEvidence {
  const base = fixtureProjectState("62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId);
  const { result: originalResult, review: originalReview } = base;
  const reference = originalResult?.evidence[0];
  if (!originalResult || !originalReview || !reference) throw new Error("Missing fixture state");
  const result = {
    ...originalResult,
    status: failed ? ("failed" as const) : ("completed" as const),
    executionStatus: "completed" as const,
    verification: ["test", "build", "diff"].map((id) => ({
      id,
      status: failed && id === "test" ? ("failed" as const) : ("passed" as const),
      evidence: { ...reference, stepId: id, eventId: `event-${id}` },
    })),
  };
  return {
    result,
    handoff: base.handoff,
    ...(verdict
      ? {
          review: {
            ...originalReview,
            verdict,
            nextAction: verdict === "pass" ? "complete" : verdict === "fail" ? "repair" : "wait",
          },
        }
      : {}),
  };
}
function render(data: RunEvidence, locale: "en" | "zh-CN" = "en") {
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { store: new LocaleStore(undefined, locale) },
      createElement(RunOutcomes, { evidence: data }),
    ),
  );
}
it.each([
  [true, "pass", "Approved", "审查认可"],
  [false, "fail", "Needs changes", "需要修改"],
  [true, "needs_input", "Needs your decision", "需要你决定"],
] as const)("separates verification failure=%s from review=%s", (failed, verdict, en, zh) => {
  const data = evidence(failed, verdict);
  const html = render(data);
  expect(html).toContain("Completed");
  expect(html).toContain(failed ? "1 failed · 2 passed" : "3 passed");
  expect(html).toContain(en);
  expect(render(data, "zh-CN")).toContain(zh);
  expect(html).not.toContain("All checks passed");
  expect(html).not.toContain("PASS");
  const steps = runSteps(data);
  expect(steps.find((step) => step.id === "execute")).toMatchObject({
    state: "passed",
    trailing: "Completed",
  });
  expect(steps.find((step) => step.id === "review")?.trailing).toBe(en);
});
it("keeps historical absence pending and never borrows another result's review", () => {
  const historical = evidence(true);
  if (!historical.result) throw new Error("Missing result");
  delete historical.result.executionStatus;
  expect(runOutcomes(historical).review).toBe("pending");
  expect(render(historical)).toContain("Waiting for ChatGPT");
  const mismatch = evidence(true, "pass");
  if (!mismatch.review) throw new Error("Missing review");
  mismatch.review.resultId = "another-result";
  expect(render(mismatch)).toContain("Waiting for ChatGPT");
  expect(render(mismatch)).not.toContain("Approved");
});
it("reports incomplete verification without fabricating a running reviewer or successful check", () => {
  const data = evidence(false);
  if (!data.result) throw new Error("Missing result");
  data.result.status = "failed";
  data.result.verification = [{ id: "test", status: "not_run" }];
  expect(runOutcomes(data)).toMatchObject({
    execution: "completed",
    verification: "incomplete",
    review: "pending",
  });
  expect(render(data)).toContain("1 not run");
  delete data.result.verification;
  expect(render(data)).toContain("No verification evidence");
});
it.each(["cancelled", "timed_out", "failed", "interrupted"] as const)(
  "does not hide execution %s behind a review",
  (executionStatus) => {
    const data = evidence(true, "pass");
    if (!data.result) throw new Error("Missing result");
    data.result.executionStatus = executionStatus;
    expect(runOutcomes(data).execution).toBe(executionStatus);
    expect(runSteps(data).find((step) => step.id === "execute")?.trailing).not.toBe("Completed");
  },
);
