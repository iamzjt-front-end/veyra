import { translate, type Locale } from "./i18n/index.js";
import { isProjectReviewForResult, type ProjectExecutionStatus } from "@veyraoss/protocol";
import type {
  DaemonRunView,
  ProjectExecutionResult,
  ProjectHandoff,
  ProjectReview,
} from "@veyraoss/protocol";
import type { WorkflowStep } from "./components/index.js";

/** Read-only evidence projection. No timer, execution or browser dependency. */
export interface RunEvidence {
  run?: DaemonRunView;
  handoff?: ProjectHandoff;
  result?: ProjectExecutionResult | null;
  review?: ProjectReview;
  stage?: "execute" | "verify" | "review";
  workspaceDiff?: {
    available: boolean;
    patch?: string;
    truncated?: boolean;
    scope?: string;
    reason?: string;
    observedAt?: string;
    untrackedFiles?: string[];
  } | null;
  verificationEvidence?: {
    eventId?: string;
    stepId: string;
    success: boolean;
    results: {
      success: boolean;
      exitCode: number | null;
      command: string;
      stdout: string;
      stderr: string;
      truncated?: boolean;
      durationMs?: number;
    }[];
  }[];
}
export function elapsed(start?: string, end?: string, locale: Locale = "en"): string {
  if (!start || !end) return "";
  const seconds = Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 1000));
  if (!Number.isFinite(seconds)) return "";
  return seconds < 60
    ? translate(locale, "{seconds}s", { seconds })
    : translate(locale, "{minutes}m {seconds}s", {
        minutes: Math.floor(seconds / 60),
        seconds: seconds % 60,
      });
}
export function runSteps(data: RunEvidence, locale: Locale = "en"): WorkflowStep[] {
  const { run, handoff, result, review, stage } = data;
  const active = run?.status === "running";
  const outcomes = runOutcomes(data);
  const reviewForRun = isProjectReviewForResult(review, result) ? review : undefined;
  const checks = result?.verification;
  const verificationFailed = checks?.some((check) => check.status === "failed");
  const verified = !!checks?.length && checks.every((check) => check.status === "passed");
  return [
    {
      id: "plan",
      label: "Plan",
      state: handoff ? "passed" : "pending",
      detail: handoff ? "ChatGPT · Plan received" : "Waiting for ChatGPT",
    },
    {
      id: "execute",
      label: "Execute",
      state:
        outcomes.execution === "paused" || outcomes.execution === "interrupted"
          ? "paused"
          : outcomes.execution === "cancelled"
            ? "paused"
            : outcomes.execution === "failed" || outcomes.execution === "timed_out"
              ? "failed"
              : outcomes.execution === "completed" || stage === "verify" || stage === "review"
                ? "passed"
                : active
                  ? "running"
                  : "pending",
      trailing: translate(locale, executionLabels[outcomes.execution]),
      detail:
        active && stage !== "verify" ? "Codex is working on your plan" : "Codex · Native executor",
    },
    {
      id: "verify",
      label: "Verify",
      state: verificationFailed
        ? "failed"
        : verified
          ? "passed"
          : active && stage === "verify"
            ? "running"
            : "pending",
      detail: verificationFailed
        ? "A verification check needs attention"
        : verified
          ? translate(locale, "{count} checks passed", { count: checks.length })
          : active && stage === "verify"
            ? "Running Project checks"
            : "Independent Project checks",
    },
    {
      id: "review",
      label: "Review",
      state:
        reviewForRun?.verdict === "pass"
          ? "passed"
          : reviewForRun?.verdict === "fail"
            ? "failed"
            : reviewForRun?.verdict === "needs_input"
              ? "needs-attention"
              : "pending",
      trailing: translate(locale, reviewLabels[outcomes.review]),
      detail: reviewForRun ? translate(locale, "Review saved") : "Waiting for ChatGPT review",
    },
  ];
}

export const executionLabels: Record<ProjectExecutionStatus | "idle", string> = {
  idle: "Idle",
  queued: "Queued",
  running: "Working",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  timed_out: "Timed out",
  paused: "Paused",
  interrupted: "Interrupted",
};
export const reviewLabels = {
  pending: "Waiting for ChatGPT",
  approved: "Approved",
  needs_changes: "Needs changes",
  human_decision: "Needs your decision",
} as const;
/** Immutable envelope addresses remain stable even when two findings have identical text. */
export function reviewFindings(review?: ProjectReview) {
  return (review?.findings ?? []).map((finding, position) => ({
    ...finding,
    key: `${review?.id}/findings/${position}`,
  }));
}
/** Read-only projection of canonical persisted evidence. Verdicts never rewrite check outcomes. */
export function runOutcomes(data: RunEvidence) {
  const execution: ProjectExecutionStatus | "idle" =
    data.run?.executionStatus ?? data.result?.executionStatus ?? data.run?.status ?? "idle";
  const checks = data.result?.verification ?? [];
  const counts = { passed: 0, failed: 0, notRun: 0 };
  for (const check of checks) {
    if (check.status === "passed") counts.passed++;
    else if (check.status === "failed") counts.failed++;
    else counts.notRun++;
  }
  const verification =
    data.run?.status === "running" && data.stage === "verify"
      ? "running"
      : counts.failed
        ? "failed"
        : counts.notRun || (data.result && !checks.length)
          ? "incomplete"
          : counts.passed
            ? "passed"
            : "pending";
  const canonicalReview = isProjectReviewForResult(data.review, data.result)
    ? data.review
    : undefined;
  const review =
    canonicalReview?.verdict === "pass"
      ? "approved"
      : canonicalReview?.verdict === "fail"
        ? "needs_changes"
        : canonicalReview?.verdict === "needs_input"
          ? "human_decision"
          : "pending";
  return { execution, verification, review, counts, canonicalReview } as const;
}
export function verificationLabel(data: RunEvidence, locale: Locale): string {
  const { verification, counts } = runOutcomes(data);
  const t = (key: string, params?: Record<string, string | number>) =>
    translate(locale, key, params);
  if (verification === "running") return t("Checking the work");
  const parts = [];
  if (counts.failed) parts.push(t("{count} failed", { count: counts.failed }));
  if (counts.passed) parts.push(t("{count} passed", { count: counts.passed }));
  if (counts.notRun) parts.push(t("{count} not run", { count: counts.notRun }));
  return parts.join(" · ") || t(data.result ? "No verification evidence" : "Pending");
}
