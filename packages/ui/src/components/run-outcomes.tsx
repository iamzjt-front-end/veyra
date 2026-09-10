import { useI18n } from "../i18n/react.js";
import {
  executionLabels,
  reviewLabels,
  runOutcomes,
  verificationLabel,
  type RunEvidence,
} from "../run.js";
import { Status, type Tone } from "./index.js";

export function RunOutcomes({ evidence }: { evidence: RunEvidence }) {
  const { t, locale } = useI18n();
  const outcome = runOutcomes(evidence);
  const rows: { label: string; value: string; tone: Tone }[] = [
    {
      label: "Run",
      value: t(executionLabels[outcome.execution]),
      tone: ["failed", "timed_out", "interrupted"].includes(outcome.execution)
        ? "danger"
        : "neutral",
    },
    {
      label: "Verification",
      value: verificationLabel(evidence, locale),
      tone:
        outcome.verification === "failed"
          ? "danger"
          : outcome.verification === "passed"
            ? "success"
            : "neutral",
    },
    {
      label: "Review",
      value: t(reviewLabels[outcome.review]),
      tone:
        outcome.review === "approved"
          ? "success"
          : ["needs_changes", "human_decision"].includes(outcome.review)
            ? "warning"
            : "neutral",
    },
  ];
  return (
    <dl className="v-run-outcomes" aria-label={t("Run outcomes")}>
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{t(row.label)}</dt>
          <dd>
            <Status tone={row.tone}>{row.value}</Status>
          </dd>
        </div>
      ))}
    </dl>
  );
}
