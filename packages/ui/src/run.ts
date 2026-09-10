import { translate, type Locale } from "./i18n/index.js";
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
  const reviewForRun =
    review && result && review.runId === result.runId && review.resultId === result.id
      ? review
      : undefined;
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
        run?.status === "paused" || run?.status === "interrupted"
          ? "paused"
          : run?.status === "cancelled"
            ? "paused"
            : result?.status === "failed" && !verificationFailed
              ? "failed"
              : result || stage === "verify" || stage === "review"
                ? "passed"
                : active
                  ? "running"
                  : "pending",
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
      detail: reviewForRun?.summary ?? "Waiting for ChatGPT review",
    },
  ];
}
