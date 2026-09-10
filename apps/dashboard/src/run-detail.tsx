import { useI18n } from "@veyraoss/ui";
import { useMemo, useRef, useState } from "react";
import {
  Button,
  Icon,
  Stepper,
  runSteps,
  elapsed,
  VerificationStatus,
  Status,
  Collapsible,
  CodeText,
  CopyButton,
  PathText,
  type RunEvidence,
} from "@veyraoss/ui";
import { DiffView } from "./diff-view.js";
import { parseDiff } from "./diff.js";
export function RunDetail({
  evidence,
  projectRoot,
  cancel,
}: {
  evidence: RunEvidence;
  projectRoot: string;
  cancel: () => void;
}) {
  const { t, locale } = useI18n();
  const { run, handoff, result, workspaceDiff, verificationEvidence } = evidence;
  const [selected, select] = useState<string>();
  const diffRef = useRef<HTMLElement>(null);
  const files = useMemo(() => parseDiff(workspaceDiff?.patch ?? "").files, [workspaceDiff?.patch]);
  const review =
    evidence.review &&
    result &&
    evidence.review.runId === result.runId &&
    evidence.review.resultId === result.id &&
    evidence.review.projectId === result.projectId
      ? evidence.review
      : undefined;
  const focusFile = (path: string) => {
    select(path);
    diffRef.current?.scrollIntoView({ block: "start", behavior: "instant" });
  };
  const relativeFile = (path: string) =>
    path.startsWith(`${projectRoot}/`) ? path.slice(projectRoot.length + 1) : path;
  return (
    <div className="v-run-detail">
      <div className="v-run-summary">
        <div className="v-actions">
          <span className="v-caption">
            <Icon name="clock" />
            {elapsed(run?.createdAt, run?.updatedAt, locale)}{" "}
            {run?.status === "running" ? t("at last update") : t("total")}
          </span>
          <span className="v-caption">{t("Codex · Native executor")}</span>
        </div>
        {run && ["running", "queued"].includes(run.status) && (
          <Button variant="danger" onClick={cancel}>
            <Icon name="stop" />
            {t("Cancel run")}
          </Button>
        )}
      </div>
      <section className="v-run-workflow" aria-label={t("Workflow timeline")}>
        <Stepper horizontal steps={runSteps(evidence, locale)} />
      </section>
      <div className="v-run-outcome">
        <div>
          <h2>
            {result?.verification?.some((check) => check.status === "failed")
              ? t("Verification needs attention")
              : result?.status === "completed"
                ? t("Execution completed")
                : result?.status === "cancelled"
                  ? t("Run cancelled")
                  : result?.status === "failed"
                    ? t("Execution needs attention")
                    : evidence.stage === "verify"
                      ? t("Checking the work")
                      : t("Work is in progress")}
          </h2>
          <p>
            {result?.summary ??
              handoff?.context.plan?.summary ??
              t("Waiting for the next Project update.")}
          </p>
        </div>
        {result && (
          <span className="v-caption">
            {t("{count} files reported changed", { count: result.changedFiles.length })}
          </span>
        )}
      </div>
      <section className="v-center-section" ref={diffRef}>
        <div className="v-section-heading">
          <h2>{t("Changes")}</h2>
          <span className="v-caption">{t("Code and evidence, together")}</span>
        </div>
        {workspaceDiff?.available && workspaceDiff.patch ? (
          <>
            <DiffView
              patch={workspaceDiff.patch}
              selected={selected}
              onSelect={select}
              upstreamTruncated={workspaceDiff.truncated}
            />
            <p className="v-caption v-workspace-scope">
              {t(
                "Current workspace snapshot · Includes pre-existing edits. Compare with the run’s reported files and verification before reviewing.",
              )}
            </p>
          </>
        ) : (
          <div className="v-no-patch">
            <Icon name="file" />
            <p>
              {run?.status === "running"
                ? t("The workspace diff becomes available with the execution result.")
                : (workspaceDiff?.reason ?? t("No Git patch was captured for this run."))}
            </p>
          </div>
        )}
        {!!result?.changedFiles.length && (
          <Collapsible
            title={t("{count} files reported by the executor", {
              count: result.changedFiles.length,
            })}
          >
            <div className="v-reported-files">
              {result.changedFiles.slice(0, 128).map((path) => (
                <div key={path}>
                  <Icon name="file" />
                  {files.some((file) => file.path === path) ? (
                    <Button variant="ghost" onClick={() => focusFile(path)}>
                      {path}
                    </Button>
                  ) : (
                    <PathText path={path} />
                  )}
                  <CopyButton text={path} label={t("Copy {path}", { path })} />
                </div>
              ))}
            </div>
          </Collapsible>
        )}
        {!!workspaceDiff?.untrackedFiles?.length && (
          <Collapsible
            title={t("{count} untracked files (content not included in Git patch)", {
              count: workspaceDiff.untrackedFiles.length,
            })}
          >
            {workspaceDiff.untrackedFiles.slice(0, 128).map((path) => (
              <p key={path}>
                <PathText path={path} />
              </p>
            ))}
          </Collapsible>
        )}
      </section>
      <div className="v-run-evidence-columns">
        <section className="v-center-section">
          <div className="v-section-heading">
            <h2>{t("Verification")}</h2>
            <span className="v-caption">{t("Independent checks")}</span>
          </div>
          {result?.verification?.length ? (
            <div className="v-verification-list">
              {result.verification.map((check) => {
                const captured = check.evidence
                  ? verificationEvidence?.find(
                      (item) =>
                        item.eventId === check.evidence?.eventId && item.stepId === check.id,
                    )
                  : undefined;
                const duration = captured?.results.reduce(
                  (sum, item) => sum + (item.durationMs ?? 0),
                  0,
                );
                const label =
                  (
                    {
                      test: t("Tests"),
                      build: t("Build"),
                      typecheck: t("Typecheck"),
                      lint: t("Lint"),
                    } as Record<string, string>
                  )[check.id] ?? check.id;
                return (
                  <Collapsible
                    key={check.id}
                    title={
                      <span className="v-check-title">
                        <span>{label}</span>
                        <VerificationStatus status={check.status} />
                        {duration ? (
                          <span className="v-caption">
                            {t("{seconds}s", { seconds: (duration / 1000).toFixed(1) })}
                          </span>
                        ) : null}
                      </span>
                    }
                  >
                    <div className="v-check-evidence">
                      <VerificationStatus status={check.status} />
                      {duration ? (
                        <span className="v-caption">
                          {t("{seconds}s", { seconds: (duration / 1000).toFixed(1) })}
                        </span>
                      ) : null}
                    </div>
                    {captured?.results.map((item, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: Command ordinal is its identity within a fixed immutable verification event.
                      <div key={`${item.command}-${index}`} className="v-command-evidence">
                        <CodeText>{item.command}</CodeText>
                        <p className="v-caption">
                          {t("Exit {code}", { code: item.exitCode ?? t("unavailable") })} ·{" "}
                          {item.success ? t("Completed successfully") : t("Check failed")}
                        </p>
                        <pre>{item.stderr || item.stdout || t("No text output captured.")}</pre>
                        {item.truncated && (
                          <p className="v-caption">
                            {t("Output truncated; complete evidence remains in the Project.")}
                          </p>
                        )}
                      </div>
                    )) ?? (
                      <p className="v-caption">{t("Detailed command evidence is unavailable.")}</p>
                    )}
                  </Collapsible>
                );
              })}
            </div>
          ) : (
            <div className="v-evidence-empty">
              <Status tone={evidence.stage === "verify" ? "accent" : "neutral"}>
                {evidence.stage === "verify"
                  ? t("Running Project checks")
                  : t("No verification result yet")}
              </Status>
              <p>{t("Only checks with recorded evidence appear here.")}</p>
            </div>
          )}
        </section>
        <section className="v-center-section">
          <div className="v-section-heading">
            <h2>{t("Review")}</h2>
            <span className="v-caption">{review?.provenance.actor ?? "ChatGPT"}</span>
          </div>
          <div className="v-review">
            <Status
              tone={
                review?.verdict === "pass"
                  ? "success"
                  : review?.verdict === "fail"
                    ? "danger"
                    : review?.verdict === "needs_input"
                      ? "warning"
                      : "neutral"
              }
            >
              {review?.verdict === "pass"
                ? t("Approved")
                : review?.verdict === "fail"
                  ? t("Changes requested")
                  : review?.verdict === "needs_input"
                    ? t("Human decision needed")
                    : t("Review pending")}
            </Status>
            <p>
              {review?.summary ??
                t(
                  "ChatGPT reviews the returned result in the bound conversation. No review verdict has been recorded for this result yet.",
                )}
            </p>
            {review?.evidence.map((ref) => {
              const path = relativeFile(ref.path);
              return files.some((file) => file.path === path) ? (
                <Button
                  key={`${ref.source}:${ref.eventId}:${ref.path}:${ref.selector}`}
                  variant="ghost"
                  onClick={() => focusFile(path)}
                >
                  <Icon name="file" />
                  {path}
                </Button>
              ) : (
                <Collapsible
                  key={`${ref.source}:${ref.eventId}:${ref.path}:${ref.selector}`}
                  title={t("Review evidence reference")}
                >
                  <PathText path={ref.path} />
                  <p className="v-caption">{ref.selector}</p>
                </Collapsible>
              );
            })}
            {review?.nextAction === "repair" && (
              <p className="v-caption">
                {t("Continue the repair in the bound ChatGPT conversation.")}
              </p>
            )}
          </div>
          {!!result?.risks?.length && (
            <Collapsible title={t("Execution findings")}>
              {result.risks.map((risk) => (
                <div key={risk.code}>
                  <span className="v-caption">{risk.source}</span>
                  <p>{risk.summary}</p>
                </div>
              ))}
            </Collapsible>
          )}
        </section>
      </div>
      <section className="v-center-section">
        <div className="v-section-heading">
          <h2>{t("Artifacts")}</h2>
          <span className="v-caption">{t("Saved with your Project")}</span>
        </div>
        {result?.artifacts.length ? (
          <div className="v-artifact-list">
            {result.artifacts.slice(0, 128).map((artifact) => (
              <div key={artifact.id}>
                <Icon name="file" />
                <span>
                  <strong>{artifact.id}</strong>
                  <PathText path={artifact.path ?? t("Path not recorded")} />
                </span>
                <span className="v-caption">{artifact.kind}</span>
                {artifact.path && (
                  <CopyButton
                    text={artifact.path}
                    label={t("Copy artifact {id} path", { id: artifact.id })}
                  />
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="v-secondary v-caption">{t("No artifacts recorded for this run.")}</p>
        )}
      </section>
      <Collapsible title={t("Plan and acceptance criteria")}>
        <p>{handoff?.context.plan?.summary ?? handoff?.context.goal}</p>
        <ul>
          {handoff?.context.plan?.acceptanceCriteria.map((criterion) => (
            <li key={criterion}>{criterion}</li>
          ))}
        </ul>
        {handoff?.context.constraints.map((constraint) => (
          <p key={constraint}>{constraint}</p>
        ))}
      </Collapsible>
      <Collapsible title={t("Run metadata")}>
        <div className="v-metadata">
          <span>{t("Run")}</span>
          <CodeText>{run?.runId}</CodeText>
          {run && <CopyButton text={run.runId} label={t("Copy Run ID")} />}
          <span>{t("Project")}</span>
          <CodeText>{run?.projectId}</CodeText>
          <span />
          <span>{t("Started")}</span>
          <CodeText>{run?.createdAt}</CodeText>
          <span />
          <span>{t("Updated")}</span>
          <CodeText>{run?.updatedAt}</CodeText>
          <span />
          <span>{t("Snapshot")}</span>
          <CodeText>{workspaceDiff?.observedAt ?? t("Not captured")}</CodeText>
        </div>
      </Collapsible>
    </div>
  );
}
