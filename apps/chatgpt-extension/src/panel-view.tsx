import { useState } from "react";
import {
  Brand,
  Button,
  Icon,
  IconButton,
  Select,
  Status,
  Stepper,
  EmptyState,
  ErrorState,
  Skeleton,
  PathText,
  Collapsible,
  Drawer,
  CodeText,
  VerificationStatus,
  RunStatus,
  elapsed,
  runSteps,
} from "@veyraoss/ui";
import type { PanelSnapshot } from "./panel-store.js";

export interface PanelActions {
  select: (id: string) => void;
  bind: () => void;
  pause: () => void;
  unbind: () => void;
  cancel: () => void;
  reconnect: () => void;
  diagnostics: () => void;
  theme: () => void;
  openControl?: () => void;
}
export function PanelView({ state, actions }: { state: PanelSnapshot; actions: PanelActions }) {
  const [details, setDetails] = useState(false);
  const { binding, evidence, currentBound } = state;
  const project = state.projects.find((entry) => entry.project.id === state.projectId);
  const selected =
    currentBound && binding
      ? { name: binding.projectName, root: binding.projectRoot }
      : project?.project;
  const result = evidence.result;
  const paused = binding?.pausedByUser === true;
  const uncertain = binding?.phase === "paused" || !!state.error;
  const failed = evidence.run?.status === "failed";
  const working =
    currentBound &&
    ["running", "dispatching", "ready_to_deliver", "delivering"].includes(binding?.phase ?? "");
  const attention =
    !state.connected ||
    uncertain ||
    failed ||
    paused ||
    state.selected?.readiness.ready === false ||
    project?.status === "stale";
  const title = state.loading
    ? "Connecting"
    : working && !attention
      ? "Working"
      : attention
        ? "Needs attention"
        : "Ready";
  const steps = runSteps(evidence);
  const goal = evidence.handoff?.context.goal;
  const duration = elapsed(evidence.run?.createdAt, evidence.run?.updatedAt);
  return (
    <div className="v-panel">
      <header className="v-panel-header">
        <Brand />
        <div className="v-actions">
          <Status tone={attention ? "warning" : "accent"}>{title}</Status>
          <IconButton icon="settings" label="Diagnostics" onClick={actions.diagnostics} />
        </div>
      </header>
      <main className="v-panel-main">
        <section className="v-project-picker">
          {currentBound && selected ? (
            <>
              <div className="v-eyebrow">Current Project</div>
              <div className="v-project-bound">
                <span className="v-project-glyph">
                  <Icon name="folder" />
                </span>
                <div>
                  <h2>{selected.name}</h2>
                  <PathText path={selected.root} />
                </div>
                <Icon name="check" />
              </div>
              <p className="v-binding-note">
                <span className="v-dot v-tone-success" />
                Bound to this conversation
              </p>
            </>
          ) : (
            <>
              <Select
                id="project"
                label="Project"
                value={state.projectId}
                disabled={state.loading || state.busy}
                onChange={(event) => actions.select(event.target.value)}
                options={[
                  { value: "", label: "Choose a Project" },
                  ...state.projects.map((entry) => ({
                    value: entry.project.id,
                    label:
                      entry.project.name +
                      (entry.status === "stale" ? " · Location unavailable" : ""),
                    disabled: entry.status !== "available",
                  })),
                ]}
              />
              {selected && <PathText path={selected.root} />}
            </>
          )}
        </section>
        {state.loading ? (
          <Skeleton label="Connecting to Veyra" />
        ) : !state.connected ? (
          <EmptyState
            icon="panel"
            title="Connect to your workspace"
            action={
              <Button variant="primary" onClick={actions.reconnect}>
                Reconnect <Icon name="arrow" />
              </Button>
            }
          >
            Your local bridge is disconnected. Your Project and its work are safe.
            <p className="v-setup-hint">
              First time here? Run <CodeText>ve setup</CodeText> once.
            </p>
          </EmptyState>
        ) : !state.projects.length ? (
          <EmptyState
            title="Your first Project"
            action={
              <Button onClick={actions.diagnostics}>
                Setup guide <Icon name="arrow" />
              </Button>
            }
          >
            Run <CodeText>ve init</CodeText> in a local project. It will appear here when you
            reconnect.
          </EmptyState>
        ) : !currentBound ? (
          <div className="v-unbound v-enter">
            <span className="v-link-art" aria-hidden="true">
              <span>
                <Icon name="runs" />
              </span>
              <i />
              <span className="v-link-mark">
                <Icon name="code" />
              </span>
            </span>
            <h2>
              Same conversation.
              <br />
              Real progress.
            </h2>
            <p className="v-secondary">
              ChatGPT plans. Codex builds.
              <br />
              Bind this conversation to your local Project.
            </p>
            <Button
              variant="primary"
              className="v-full"
              disabled={
                !state.projectId ||
                !state.conversation ||
                state.busy ||
                state.selected?.readiness.ready === false ||
                project?.status === "stale"
              }
              onClick={actions.bind}
            >
              Bind conversation <Icon name="arrow" />
            </Button>
            {!state.conversation && (
              <p className="v-caption">Open a saved ChatGPT conversation to bind.</p>
            )}
            {state.selected?.readiness.ready === false && (
              <ErrorState title="Codex needs your attention">
                Open Codex and sign in with your existing account. Then reconnect.
              </ErrorState>
            )}
            <div className="v-recent">
              <h3>Projects</h3>
              {state.projects
                .filter((entry) => entry.status === "available")
                .slice(0, 5)
                .map((entry) => (
                  <button
                    type="button"
                    key={entry.project.id}
                    onClick={() => actions.select(entry.project.id)}
                  >
                    <span className="v-project-glyph">
                      <Icon name="folder" />
                    </span>
                    <span>{entry.project.name}</span>
                    <Icon name="chevron" />
                  </button>
                ))}
            </div>
          </div>
        ) : !binding?.runId ? (
          <div className="v-idle v-enter">
            <span className="v-idle-mark">
              <Icon name={paused ? "pause" : "check"} />
            </span>
            <h2>{paused ? "Paused, on your terms" : "Ready to work"}</h2>
            <p className="v-secondary">
              {paused
                ? "Resume when you’re ready. Your Project stays connected."
                : "ChatGPT plans. Codex builds."}
            </p>
            {!paused && <p className="v-caption">Tell ChatGPT what you want to build.</p>}
          </div>
        ) : (
          <section className="v-run-section">
            <div className="v-eyebrow">
              {failed
                ? "Needs attention"
                : paused
                  ? "Automation paused"
                  : result
                    ? "Execution completed"
                    : "Current task"}
            </div>
            <h1 className="v-task-title">{goal ?? "Loading the current task"}</h1>
            {goal && evidence.handoff?.context.plan?.summary !== goal && (
              <p className="v-task-summary">{evidence.handoff?.context.plan?.summary}</p>
            )}
            <Stepper steps={steps} />
            {result && (
              <div className="v-result-summary">
                <div>
                  <Icon name={failed ? "warning" : "check"} />
                  <strong>
                    {failed ? "Verification needs attention" : "Work is ready for review"}
                  </strong>
                </div>
                <p>
                  {result.changedFiles.length} files changed
                  {result.verification?.length
                    ? ` · ${result.verification.filter((check) => check.status === "passed").length}/${result.verification.length} checks passed`
                    : " · No verification evidence"}
                </p>
                <p className="v-caption">
                  {binding.lastResult?.delivery === "confirmed"
                    ? "Result returned to this conversation"
                    : "Waiting to return the result"}
                </p>
              </div>
            )}
            {!result && (
              <div className="v-executor-note">
                <span className="v-project-glyph">
                  <Icon name="code" />
                </span>
                <div>
                  <strong>
                    {evidence.stage === "verify"
                      ? "Checking the work"
                      : paused
                        ? "Automation paused"
                        : "Codex is working"}
                  </strong>
                  <p className="v-caption">
                    {paused
                      ? "The dispatched run may continue. Cancel to stop it."
                      : evidence.stage === "verify"
                        ? "Independent checks from your Project"
                        : "Using your existing native session"}
                  </p>
                </div>
              </div>
            )}
            <div className="v-run-footnote">
              <span>
                {duration ? `${duration} elapsed` : "Progress comes from Project evidence"}
              </span>
              {result && <span>{result.changedFiles.length} files</span>}
            </div>
          </section>
        )}
        {uncertain && state.connected && (
          <ErrorState title="Check this conversation before continuing">
            An action could not be confirmed. Nothing will be resent automatically. Your work
            remains in the Project.
            <Button variant="ghost" onClick={actions.diagnostics}>
              Inspect details <Icon name="arrow" />
            </Button>
          </ErrorState>
        )}
      </main>
      <footer className="v-panel-footer">
        {currentBound && (
          <>
            <div className="v-actions">
              <Button onClick={actions.pause} disabled={state.busy && !state.enabled}>
                <Icon name={paused ? "play" : "pause"} />
                {paused ? "Resume" : "Pause"}
              </Button>
              {binding?.runId && (
                <Button variant="primary" onClick={() => setDetails(true)}>
                  View run <Icon name="arrow" />
                </Button>
              )}
            </div>
            <div className="v-footer-meta">
              <span>
                ChatGPT <span aria-hidden="true">↔</span> Codex
              </span>
              <Button variant="ghost" onClick={actions.unbind}>
                Unbind
              </Button>
            </div>
          </>
        )}
        {!currentBound && (
          <div className="v-footer-meta">
            <span>Local by design. Yours by default.</span>
            <IconButton icon="sun" label="Switch theme" onClick={actions.theme} />
          </div>
        )}
      </footer>
      <Drawer open={details} onClose={() => setDetails(false)} title="Run details">
        <div className="v-detail-content">
          <h2>{goal ?? "Current run"}</h2>
          {actions.openControl && state.transport !== "http" && (
            <Button onClick={actions.openControl}>
              Open Control Center <Icon name="arrow" />
            </Button>
          )}
          <RunStatus status={evidence.run?.status ?? "pending"} />
          <section>
            <h3>Changed files</h3>
            {result?.changedFiles.length ? (
              result.changedFiles.map((path) => (
                <div key={path} className="v-file-row">
                  <Icon name="file" />
                  <PathText path={path} />
                </div>
              ))
            ) : (
              <p className="v-secondary">No changed-file evidence yet.</p>
            )}
          </section>
          <section>
            <h3>Verification</h3>
            {result?.verification?.map((check) => (
              <div key={check.id} className="v-check-row">
                <span>{check.id}</span>
                <VerificationStatus status={check.status} />
              </div>
            )) ?? <p className="v-secondary">No verification evidence yet.</p>}
          </section>
          <section>
            <h3>Review</h3>
            <p className="v-secondary">
              ChatGPT reviews the result in the bound conversation. No approval has been inferred
              from execution success.
            </p>
          </section>
          <Collapsible title="Run metadata">
            <CodeText>{binding?.runId}</CodeText>
            <p className="v-caption">Evidence belongs to this Project.</p>
          </Collapsible>
          {!result && (
            <Button variant="danger" onClick={actions.cancel}>
              <Icon name="stop" />
              Cancel run
            </Button>
          )}
        </div>
      </Drawer>
    </div>
  );
}
