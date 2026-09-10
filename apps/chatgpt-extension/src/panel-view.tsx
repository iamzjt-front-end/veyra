import { useI18n } from "@veyraoss/ui";
import { useState } from "react";
import {
  Brand,
  LanguageSelect,
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
  const { t, locale } = useI18n();
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
  const cancelled = evidence.run?.status === "cancelled";
  const queued = evidence.run?.status === "queued";
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
    ? t("Connecting")
    : working && !attention
      ? t("Working")
      : attention
        ? t("Needs attention")
        : t("Ready");
  const steps = runSteps(evidence, locale);
  const goal = evidence.handoff?.context.goal;
  const duration = elapsed(evidence.run?.createdAt, evidence.run?.updatedAt, locale);
  return (
    <div className="v-panel">
      <header className="v-panel-header">
        <Brand />
        <div className="v-actions">
          <Status tone={attention ? "warning" : "accent"}>{title}</Status>
          <LanguageSelect />
          <IconButton icon="settings" label={t("Diagnostics")} onClick={actions.diagnostics} />
        </div>
      </header>
      <main
        className="v-panel-main"
        // biome-ignore lint/a11y/noNoninteractiveTabindex: The panel scroll region needs a keyboard focus entry.
        tabIndex={0}
      >
        <section className="v-project-picker">
          {currentBound && selected ? (
            <>
              <div className="v-eyebrow">{t("Current Project")}</div>
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
                {t("Bound to this conversation")}
              </p>
            </>
          ) : (
            <>
              <Select
                id="project"
                label={t("Project")}
                value={state.projectId}
                disabled={state.loading || state.busy}
                onChange={(event) => actions.select(event.target.value)}
                options={[
                  { value: "", label: t("Choose a Project") },
                  ...state.projects.map((entry) => ({
                    value: entry.project.id,
                    label:
                      entry.project.name +
                      (entry.status === "stale" ? ` · ${t("Location unavailable")}` : ""),
                    disabled: entry.status !== "available",
                  })),
                ]}
              />
              {selected && <PathText path={selected.root} />}
            </>
          )}
        </section>
        {state.loading ? (
          <Skeleton label={t("Connecting to Veyra")} />
        ) : !state.connected ? (
          <EmptyState
            icon="panel"
            title={t("Connect to your workspace")}
            action={
              <Button variant="primary" onClick={actions.reconnect}>
                {t("Reconnect")}
                <Icon name="arrow" />
              </Button>
            }
          >
            {t("Your local bridge is disconnected. Your Project and its work are safe.")}
            <p className="v-setup-hint">{t("First time here? Run ve setup once.")}</p>
          </EmptyState>
        ) : !state.projects.length ? (
          <EmptyState
            title={t("Your first Project")}
            action={
              <Button onClick={actions.diagnostics}>
                {t("Setup guide")}
                <Icon name="arrow" />
              </Button>
            }
          >
            {t("Run ve init in a local project. It will appear here when you reconnect.")}
          </EmptyState>
        ) : project?.status === "stale" ? (
          <ErrorState title={t("Project location unavailable")}>
            {t(
              "Restore the local folder, or choose another Project. Saved evidence stays with the Project.",
            )}
          </ErrorState>
        ) : state.selected?.readiness.ready === false && !working ? (
          <ErrorState title={t("Codex needs your attention")}>
            {t("Open Codex and sign in with your existing account.")}
            <div className="v-actions">
              <Button onClick={actions.reconnect}>{t("Reconnect")}</Button>
            </div>
          </ErrorState>
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
              {t("Same conversation.")}
              <br />
              {t("Real progress.")}
            </h2>
            <p className="v-secondary">
              {t("ChatGPT plans. Codex builds.")}
              <br />
              {t("Bind this conversation to your local Project.")}
            </p>
            <Button
              variant="primary"
              className="v-full"
              disabled={
                !state.projectId ||
                !state.conversation ||
                state.busy ||
                state.selected?.readiness.ready === false
              }
              onClick={actions.bind}
            >
              {t("Bind conversation")}
              <Icon name="arrow" />
            </Button>
            {!state.conversation && (
              <p className="v-caption">{t("Open a saved ChatGPT conversation to bind.")}</p>
            )}
            {state.selected?.readiness.ready === false && (
              <ErrorState title={t("Codex needs your attention")}>
                {t("Open Codex and sign in with your existing account. Then reconnect.")}
              </ErrorState>
            )}
            <div className="v-recent">
              <h3>{t("Projects")}</h3>
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
            <h2>{paused ? t("Paused, on your terms") : t("Ready to work")}</h2>
            <p className="v-secondary">
              {paused
                ? t("Resume when you’re ready. Your Project stays connected.")
                : t("ChatGPT plans. Codex builds.")}
            </p>
            {!paused && <p className="v-caption">{t("Tell ChatGPT what you want to build.")}</p>}
          </div>
        ) : (
          <section className="v-run-section">
            <div className="v-eyebrow">
              {failed
                ? t("Needs attention")
                : paused
                  ? t("Automation paused")
                  : cancelled
                    ? t("Run cancelled")
                    : result
                      ? t("Execution completed")
                      : t("Current task")}
            </div>
            <h1 className="v-task-title">{goal ?? t("Loading the current task")}</h1>
            {goal && evidence.handoff?.context.plan?.summary !== goal && (
              <p className="v-task-summary">{evidence.handoff?.context.plan?.summary}</p>
            )}
            <Stepper steps={steps} />
            {result && (
              <div className="v-result-summary">
                <div>
                  <Icon name={failed ? "warning" : "check"} />
                  <strong>
                    {cancelled
                      ? t("Run cancelled")
                      : failed
                        ? t("Verification needs attention")
                        : t("Work is ready for review")}
                  </strong>
                </div>
                <p>
                  {t("{count} files changed", { count: result.changedFiles.length })}
                  {result.verification?.length
                    ? ` · ${t("{passed}/{total} checks passed", { passed: result.verification.filter((check) => check.status === "passed").length, total: result.verification.length })}`
                    : ` · ${t("No verification evidence")}`}
                </p>
                <p className="v-caption">
                  {binding.lastResult?.delivery === "confirmed"
                    ? t("Result returned to this conversation")
                    : t("Waiting to return the result")}
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
                      ? t("Checking the work")
                      : paused
                        ? t("Automation paused")
                        : queued
                          ? t("Waiting for Codex")
                          : t("Codex is working")}
                  </strong>
                  <p className="v-caption">
                    {paused
                      ? t("The dispatched run may continue. Cancel to stop it.")
                      : evidence.stage === "verify"
                        ? t("Independent checks from your Project")
                        : t("Using your existing native session")}
                  </p>
                </div>
              </div>
            )}
            <div className="v-run-footnote">
              <span>
                {duration
                  ? t("{duration} elapsed", { duration })
                  : t("Progress comes from Project evidence")}
              </span>
              {result && <span>{t("{count} files", { count: result.changedFiles.length })}</span>}
            </div>
          </section>
        )}
        {uncertain && state.connected && (
          <ErrorState title={t("Check this conversation before continuing")}>
            {t(
              "An action could not be confirmed. Nothing will be resent automatically. Your work remains in the Project.",
            )}
            {state.error && (
              <Collapsible title={t("Original error")}>
                <CodeText>{state.error}</CodeText>
              </Collapsible>
            )}
            <Button variant="ghost" onClick={actions.diagnostics}>
              {t("Inspect details")}
              <Icon name="arrow" />
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
                {paused ? t("Resume") : t("Pause")}
              </Button>
              {binding?.runId && (
                <Button variant="primary" onClick={() => setDetails(true)}>
                  {t("View run")}
                  <Icon name="arrow" />
                </Button>
              )}
            </div>
            <div className="v-footer-meta">
              <span>
                ChatGPT <span aria-hidden="true">↔</span> Codex
              </span>
              <Button variant="ghost" onClick={actions.unbind}>
                {t("Unbind")}
              </Button>
            </div>
          </>
        )}
        {!currentBound && (
          <div className="v-footer-meta">
            <span>{t("Local by design. Yours by default.")}</span>
            <IconButton icon="sun" label={t("Switch theme")} onClick={actions.theme} />
          </div>
        )}
      </footer>
      <Drawer open={details} onClose={() => setDetails(false)} title={t("Run details")}>
        <div className="v-detail-content">
          <h2>{goal ?? t("Current run")}</h2>
          {actions.openControl && state.transport !== "http" && (
            <Button onClick={actions.openControl}>
              {t("Open Control Center")}
              <Icon name="arrow" />
            </Button>
          )}
          <RunStatus status={evidence.run?.status ?? "pending"} />
          <section>
            <h3>{t("Changed files")}</h3>
            {result?.changedFiles.length ? (
              result.changedFiles.map((path) => (
                <div key={path} className="v-file-row">
                  <Icon name="file" />
                  <PathText path={path} />
                </div>
              ))
            ) : (
              <p className="v-secondary">{t("No changed-file evidence yet.")}</p>
            )}
          </section>
          <section>
            <h3>{t("Verification")}</h3>
            {result?.verification?.map((check) => (
              <div key={check.id} className="v-check-row">
                <span>
                  {t(
                    (
                      {
                        test: "Tests",
                        build: "Build",
                        check: "Typecheck",
                        typecheck: "Typecheck",
                        lint: "Lint",
                      } as Record<string, string>
                    )[check.id] ?? check.id,
                  )}
                </span>
                <VerificationStatus status={check.status} />
              </div>
            )) ?? <p className="v-secondary">{t("No verification evidence yet.")}</p>}
          </section>
          <section>
            <h3>{t("Review")}</h3>
            <p className="v-secondary">
              {t(
                "ChatGPT reviews the result in the bound conversation. No approval has been inferred from execution success.",
              )}
            </p>
          </section>
          <Collapsible title={t("Run metadata")}>
            <CodeText>{binding?.runId}</CodeText>
            <p className="v-caption">{t("Evidence belongs to this Project.")}</p>
          </Collapsible>
          {!result && (
            <Button variant="danger" onClick={actions.cancel}>
              <Icon name="stop" />
              {t("Cancel run")}
            </Button>
          )}
        </div>
      </Drawer>
    </div>
  );
}
