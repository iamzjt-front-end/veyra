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
            {elapsed(run?.createdAt, run?.updatedAt)}{" "}
            {run?.status === "running" ? "at last update" : "total"}
          </span>
          <span className="v-caption">Codex · Native executor</span>
        </div>
        {run && ["running", "queued"].includes(run.status) && (
          <Button variant="danger" onClick={cancel}>
            <Icon name="stop" />
            Cancel run
          </Button>
        )}
      </div>
      <section className="v-run-workflow" aria-label="Workflow timeline">
        <Stepper horizontal steps={runSteps(evidence)} />
      </section>
      <div className="v-run-outcome">
        <div>
          <h2>
            {result?.verification?.some((check) => check.status === "failed")
              ? "Verification needs attention"
              : result?.status === "completed"
                ? "Execution completed"
                : result?.status === "cancelled"
                  ? "Run cancelled"
                  : result?.status === "failed"
                    ? "Execution needs attention"
                    : evidence.stage === "verify"
                      ? "Checking the work"
                      : "Work is in progress"}
          </h2>
          <p>
            {result?.summary ??
              handoff?.context.plan?.summary ??
              "Waiting for the next Project update."}
          </p>
        </div>
        {result && (
          <span className="v-caption">{result.changedFiles.length} files reported changed</span>
        )}
      </div>
      <section className="v-center-section" ref={diffRef}>
        <div className="v-section-heading">
          <h2>Changes</h2>
          <span className="v-caption">Code and evidence, together</span>
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
              Current workspace snapshot · Includes pre-existing edits. Compare with the run’s
              reported files and verification before reviewing.
            </p>
          </>
        ) : (
          <div className="v-no-patch">
            <Icon name="file" />
            <p>
              {run?.status === "running"
                ? "The workspace diff becomes available with the execution result."
                : (workspaceDiff?.reason ?? "No Git patch was captured for this run.")}
            </p>
          </div>
        )}
        {!!result?.changedFiles.length && (
          <Collapsible title={`${result.changedFiles.length} files reported by the executor`}>
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
                  <CopyButton text={path} label={`Copy ${path}`} />
                </div>
              ))}
            </div>
          </Collapsible>
        )}
        {!!workspaceDiff?.untrackedFiles?.length && (
          <Collapsible
            title={`${workspaceDiff.untrackedFiles.length} untracked files (content not included in Git patch)`}
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
            <h2>Verification</h2>
            <span className="v-caption">Independent checks</span>
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
                      test: "Tests",
                      build: "Build",
                      typecheck: "Typecheck",
                      lint: "Lint",
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
                          <span className="v-caption">{(duration / 1000).toFixed(1)}s</span>
                        ) : null}
                      </span>
                    }
                  >
                    <div className="v-check-evidence">
                      <VerificationStatus status={check.status} />
                      {duration ? (
                        <span className="v-caption">{(duration / 1000).toFixed(1)}s</span>
                      ) : null}
                    </div>
                    {captured?.results.map((item, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: Command ordinal is its identity within a fixed immutable verification event.
                      <div key={`${item.command}-${index}`} className="v-command-evidence">
                        <CodeText>{item.command}</CodeText>
                        <p className="v-caption">
                          Exit {item.exitCode ?? "unavailable"} ·{" "}
                          {item.success ? "Completed successfully" : "Check failed"}
                        </p>
                        <pre>{item.stderr || item.stdout || "No text output captured."}</pre>
                        {item.truncated && (
                          <p className="v-caption">
                            Output truncated; complete evidence remains in the Project.
                          </p>
                        )}
                      </div>
                    )) ?? <p className="v-caption">Detailed command evidence is unavailable.</p>}
                  </Collapsible>
                );
              })}
            </div>
          ) : (
            <div className="v-evidence-empty">
              <Status tone={evidence.stage === "verify" ? "accent" : "neutral"}>
                {evidence.stage === "verify"
                  ? "Running Project checks"
                  : "No verification result yet"}
              </Status>
              <p>Only checks with recorded evidence appear here.</p>
            </div>
          )}
        </section>
        <section className="v-center-section">
          <div className="v-section-heading">
            <h2>Review</h2>
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
                ? "Approved"
                : review?.verdict === "fail"
                  ? "Changes requested"
                  : review?.verdict === "needs_input"
                    ? "Human decision needed"
                    : "Review pending"}
            </Status>
            <p>
              {review?.summary ??
                "ChatGPT reviews the returned result in the bound conversation. No review verdict has been recorded for this result yet."}
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
                  title="Review evidence reference"
                >
                  <PathText path={ref.path} />
                  <p className="v-caption">{ref.selector}</p>
                </Collapsible>
              );
            })}
            {review?.nextAction === "repair" && (
              <p className="v-caption">Continue the repair in the bound ChatGPT conversation.</p>
            )}
          </div>
          {!!result?.risks?.length && (
            <Collapsible title="Execution findings">
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
          <h2>Artifacts</h2>
          <span className="v-caption">Saved with your Project</span>
        </div>
        {result?.artifacts.length ? (
          <div className="v-artifact-list">
            {result.artifacts.slice(0, 128).map((artifact) => (
              <div key={artifact.id}>
                <Icon name="file" />
                <span>
                  <strong>{artifact.id}</strong>
                  <PathText path={artifact.path ?? "Path not recorded"} />
                </span>
                <span className="v-caption">{artifact.kind}</span>
                {artifact.path && (
                  <CopyButton text={artifact.path} label={`Copy artifact ${artifact.id} path`} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <p className="v-secondary v-caption">No artifacts recorded for this run.</p>
        )}
      </section>
      <Collapsible title="Plan and acceptance criteria">
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
      <Collapsible title="Run metadata">
        <div className="v-metadata">
          <span>Run</span>
          <CodeText>{run?.runId}</CodeText>
          {run && <CopyButton text={run.runId} label="Copy Run ID" />}
          <span>Project</span>
          <CodeText>{run?.projectId}</CodeText>
          <span />
          <span>Started</span>
          <CodeText>{run?.createdAt}</CodeText>
          <span />
          <span>Updated</span>
          <CodeText>{run?.updatedAt}</CodeText>
          <span />
          <span>Snapshot</span>
          <CodeText>{workspaceDiff?.observedAt ?? "Not captured"}</CodeText>
        </div>
      </Collapsible>
    </div>
  );
}
