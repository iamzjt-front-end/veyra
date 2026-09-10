import { useI18n } from "@veyraoss/ui";
import {
  Brand,
  LanguageSelect,
  Button,
  Icon,
  Dropdown,
  VirtualList,
  EmptyState,
  ErrorState,
  PathText,
  RunStatus,
  Status,
  Stepper,
  Collapsible,
  CodeText,
  elapsed,
  runSteps,
  type IconName,
  type RunEvidence,
} from "@veyraoss/ui";
import { useState, type ReactNode } from "react";
import type { DaemonRunSummary, RegisteredProject } from "@veyraoss/protocol";
import type { ProjectData, WorkspaceData } from "./client.js";

export interface WorkspaceViewProps {
  data: WorkspaceData;
  route: string;
  project?: ProjectData;
  evidence?: RunEvidence;
  loading?: boolean;
  error?: string;
  navigate: (route: string) => void;
  reconnect: () => void;
  cancel: () => void;
  logout: () => void;
  theme: (theme: string) => void;
  runDetail?: ReactNode;
}
const runRoute = (run: { projectId: string; runId: string }) =>
  `/projects/${run.projectId}/runs/${run.runId}`;
export function RunRows({
  runs,
  projects,
  navigate,
}: {
  runs: DaemonRunSummary[];
  projects: RegisteredProject[];
  navigate: (route: string) => void;
}) {
  const { t, locale } = useI18n();
  const render = (run: DaemonRunSummary) => (
    <button
      type="button"
      className="v-run-table-row"
      key={`${run.projectId}/${run.runId}`}
      onClick={() => navigate(runRoute(run))}
    >
      <span className="v-run-cell-title">
        <Icon name={run.status === "failed" ? "warning" : "runs"} />
        <span>{run.goal}</span>
      </span>
      <span className="v-secondary">
        {projects.find((entry) => entry.project.id === run.projectId)?.project.name ?? t("Project")}
      </span>
      <RunStatus status={run.status} />
      <span className="v-duration">{elapsed(run.createdAt, run.updatedAt, locale)}</span>
    </button>
  );
  return (
    <div className="v-run-table">
      <div className="v-run-table-head">
        <span>{t("Task")}</span>
        <span>{t("Project")}</span>
        <span>{t("Status")}</span>
        <span>{t("Duration")}</span>
      </div>
      {runs.length > 30 ? (
        <VirtualList
          items={runs}
          label={t("Run history")}
          rowHeight={60}
          itemKey={(run) => `${run.projectId}/${run.runId}`}
          render={render}
        />
      ) : (
        runs.map(render)
      )}
    </div>
  );
}
function ProjectRows({
  data,
  navigate,
  compact = false,
}: {
  data: WorkspaceData;
  navigate: (route: string) => void;
  compact?: boolean;
}) {
  const { t } = useI18n();
  const [query, setQuery] = useState("");
  const projects = data.projects.filter((entry) =>
    entry.project.name.toLowerCase().includes(query.toLowerCase()),
  );
  const render = (entry: RegisteredProject) => {
    const last = data.runs.find((run) => run.projectId === entry.project.id);
    return (
      <button
        type="button"
        className="v-project-list-row"
        key={entry.project.id}
        onClick={() => navigate(`/projects/${entry.project.id}`)}
      >
        <span className="v-project-emblem">
          <Icon name="folder" />
        </span>
        <span className="v-project-label">
          <strong>{entry.project.name}</strong>
          <PathText path={entry.project.root} />
        </span>
        {entry.status === "stale" ? (
          <Status tone="warning">{t("Location unavailable")}</Status>
        ) : last?.status === "running" || last?.status === "queued" ? (
          <RunStatus status={last.status} />
        ) : (
          <span className="v-caption">
            {last?.status === "completed"
              ? t("Last run completed")
              : last?.status === "failed"
                ? t("Needs attention")
                : t("Ready")}
          </span>
        )}
        <Icon name="chevron" />
      </button>
    );
  };
  return (
    <div>
      {!compact && (
        <label className="v-search">
          <Icon name="search" />
          <input
            aria-label={t("Search projects")}
            placeholder={t("Find a Project…")}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
      )}
      <div className="v-project-list">
        {projects.length ? (
          !compact && projects.length > 30 ? (
            <VirtualList
              key={query}
              items={projects}
              label={t("Projects")}
              rowHeight={78}
              itemKey={(entry) => entry.project.id}
              render={render}
            />
          ) : (
            projects.slice(0, compact ? 6 : 30).map(render)
          )
        ) : (
          <EmptyState title={query ? t("No matching Projects") : t("Your first Project")}>
            {t("Create a local Project with ve init, or adjust your search.")}
          </EmptyState>
        )}
      </div>
    </div>
  );
}
function SettingsLink({
  navigate,
  active,
}: {
  navigate: (route: string) => void;
  active: boolean;
}) {
  const { t } = useI18n();
  const destination = "/settings";
  return (
    <a
      href={`#${destination}`}
      aria-current={active ? "page" : undefined}
      onClick={(event) => {
        event.preventDefault();
        navigate(destination);
      }}
    >
      <Icon name="settings" />
      {t("Settings")}
    </a>
  );
}
export function WorkspaceView(props: WorkspaceViewProps) {
  const { t, locale } = useI18n();
  const { data, route, project, evidence, navigate } = props;
  const page = route.startsWith("/projects/")
    ? "project"
    : route.startsWith("/runs")
      ? "runs"
      : route.startsWith("/settings")
        ? "settings"
        : route.startsWith("/projects")
          ? "projects"
          : "overview";
  const isRun = route.includes("/runs/");
  const active = data.runs.filter((run) =>
    ["running", "queued", "paused", "interrupted"].includes(run.status),
  );
  const title = isRun
    ? (evidence?.handoff?.context.goal ?? t("Run details"))
    : page === "project"
      ? (project?.project.name ?? t("Project"))
      : {
          overview: t("Your workspace"),
          projects: t("Projects"),
          runs: t("Runs"),
          settings: t("Settings"),
        }[page];
  const nav: { id: string; label: string; icon: IconName }[] = [
    { id: "overview", label: t("Overview"), icon: "home" },
    { id: "projects", label: t("Projects"), icon: "folder" },
    { id: "runs", label: t("Runs"), icon: "runs" },
  ];
  return (
    <div className="v-center-shell">
      <aside className="v-center-sidebar">
        <Brand />
        <nav aria-label={t("Primary")}>
          {nav.map((item) => (
            <a
              key={item.id}
              href={`#/${item.id}`}
              onClick={(event) => {
                event.preventDefault();
                navigate(`/${item.id}`);
              }}
              aria-current={
                page === item.id || (item.id === "projects" && page === "project")
                  ? "page"
                  : undefined
              }
            >
              <Icon name={item.icon} />
              {item.label}
            </a>
          ))}
        </nav>
        <div className="v-sidebar-bottom">
          <SettingsLink navigate={navigate} active={page === "settings"} />
          <div className="v-local-indicator">
            <Status tone={props.error ? "warning" : "accent"}>
              {props.error ? t("Needs attention") : t("Local workspace")}
            </Status>
          </div>
        </div>
      </aside>
      <div className="v-center-workspace">
        <header className="v-center-topbar">
          <div className="v-breadcrumb">
            <span>{isRun ? t("Runs") : page === "project" ? t("Projects") : t("Workspace")}</span>
            <Icon name="chevron" />
            <span>
              {isRun
                ? t("Run details")
                : page === "project"
                  ? (project?.project.name ?? t("Project"))
                  : t(
                      (
                        {
                          overview: "Overview",
                          projects: "Projects",
                          runs: "Runs",
                          settings: "Settings",
                        } as Record<string, string>
                      )[page] ?? page,
                    )}
            </span>
          </div>
          <div className="v-actions">
            <span className="v-caption">{t("Your project. Your agents.")}</span>
            <LanguageSelect />
            <Dropdown
              icon="sun"
              label={t("Appearance")}
              items={[
                { id: "light", label: t("Light") },
                { id: "dark", label: t("Dark") },
                { id: "system", label: t("System") },
              ]}
              onSelect={props.theme}
            />
          </div>
        </header>
        <main className="v-center-content">
          <div className="v-page-heading">
            <div>
              <span className="v-eyebrow">
                {page === "overview"
                  ? t("Veyra Control Center")
                  : isRun
                    ? (project?.project.name ?? t("Project run"))
                    : t("Workspace")}
              </span>
              <h1>{title}</h1>
              {page === "overview" && (
                <p className="v-secondary">
                  {t("A clear view of your Projects, progress and next steps.")}
                </p>
              )}
              {page === "project" && project && <PathText path={project.project.root} />}
            </div>
            {isRun && evidence?.run && <RunStatus status={evidence.run.status} />}
          </div>
          {props.error && (
            <ErrorState title={t("The local connection needs attention")}>
              {t(
                "Your work is saved in the Project. Reconnect, or reopen Veyra from the Side Panel.",
              )}
              <div className="v-actions">
                <Button onClick={props.reconnect}>{t("Reconnect")}</Button>
                <Collapsible title={t("Details")}>
                  <CodeText>{props.error}</CodeText>
                </Collapsible>
              </div>
            </ErrorState>
          )}
          {props.loading && (
            <div className="v-local-loading" role="status">
              {t("Loading Project evidence…")}
            </div>
          )}
          {page === "overview" && (
            <>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>{t("Active now")}</h2>
                  <span className="v-caption">{t("ChatGPT plans · Codex builds")}</span>
                </div>
                {active.length ? (
                  active.slice(0, 4).map((run) => (
                    <button
                      type="button"
                      className="v-active-run"
                      key={run.runId}
                      onClick={() => navigate(runRoute(run))}
                    >
                      <div className="v-active-marker">
                        <Icon name="code" />
                      </div>
                      <div>
                        <div className="v-active-project">
                          {
                            data.projects.find((entry) => entry.project.id === run.projectId)
                              ?.project.name
                          }
                        </div>
                        <h3>{run.goal}</h3>
                        <p>
                          {run.status === "running"
                            ? t("Codex is working on this Project")
                            : run.status === "queued"
                              ? t("Waiting for Codex")
                              : t("Your attention is needed")}
                        </p>
                      </div>
                      <div className="v-active-status">
                        <RunStatus status={run.status} />
                        <span>{elapsed(run.createdAt, run.updatedAt, locale)}</span>
                      </div>
                      <Icon name="arrow" />
                    </button>
                  ))
                ) : (
                  <div className="v-quiet-state">
                    <Icon name="check" />
                    <div>
                      <h3>{t("Room for your next idea")}</h3>
                      <p>
                        {t("Start in your bound ChatGPT conversation. Progress will appear here.")}
                      </p>
                    </div>
                  </div>
                )}
              </section>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>{t("Projects")}</h2>
                  <Button variant="ghost" onClick={() => navigate("/projects")}>
                    {t("View all")}
                    <Icon name="arrow" />
                  </Button>
                </div>
                {data.projects.length ? (
                  <ProjectRows data={data} navigate={navigate} compact />
                ) : (
                  <EmptyState title={t("Your first Project")}>
                    {t("Run ve init inside a local project, then open Veyra again.")}
                  </EmptyState>
                )}
              </section>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>{t("Recent runs")}</h2>
                  <Button variant="ghost" onClick={() => navigate("/runs")}>
                    {t("View all")}
                    <Icon name="arrow" />
                  </Button>
                </div>
                {data.runs.length ? (
                  <RunRows
                    runs={data.runs.slice(0, 6)}
                    projects={data.projects}
                    navigate={navigate}
                  />
                ) : (
                  <EmptyState icon="runs" title={t("No runs yet")}>
                    {t("Your first task starts in ChatGPT.")}
                  </EmptyState>
                )}
              </section>
            </>
          )}
          {page === "projects" && <ProjectRows data={data} navigate={navigate} />}
          {page === "runs" && (
            <>
              <p className="v-secondary v-page-intro">
                {t("Execution history, saved with each Project.")}
              </p>
              {data.runs.length ? (
                <RunRows runs={data.runs} projects={data.projects} navigate={navigate} />
              ) : (
                <EmptyState icon="runs" title={t("No runs yet")}>
                  {t("Start a task in your bound ChatGPT conversation.")}
                </EmptyState>
              )}
              {data.hasMore && (
                <p className="v-caption">{t("Showing the latest 20 runs per Project.")}</p>
              )}
            </>
          )}
          {page === "project" && !isRun && project && (
            <>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>{t("Current work")}</h2>
                  <Status tone={project.readiness.ready ? "accent" : "warning"}>
                    Codex · {project.readiness.ready ? t("Ready") : t("Needs attention")}
                  </Status>
                </div>
                {data.runs.filter((run) => run.projectId === project.project.id).length ? (
                  <RunRows
                    runs={data.runs.filter((run) => run.projectId === project.project.id)}
                    projects={data.projects}
                    navigate={navigate}
                  />
                ) : (
                  <div className="v-quiet-state">
                    <Icon name="code" />
                    <div>
                      <h3>{t("Ready for your next task")}</h3>
                      <p>{t("Bind this Project in ChatGPT to begin.")}</p>
                    </div>
                  </div>
                )}
              </section>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>{t("Shared context")}</h2>
                  <span className="v-caption">{t("Belongs to your Project")}</span>
                </div>
                <div className="v-context">
                  <h3>{t("Goal")}</h3>
                  <p>
                    {project.sharedState?.context.goal ??
                      t("Your plan will appear after the first handoff.")}
                  </p>
                  {project.sharedState?.context.constraints.length ? (
                    <>
                      <h3>{t("Constraints")}</h3>
                      <ul>
                        {project.sharedState.context.constraints.map((constraint) => (
                          <li key={constraint}>{constraint}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {project.sharedState?.context.decisions.length ? (
                    <>
                      <h3>{t("Decisions")}</h3>
                      {project.sharedState.context.decisions.map((decision) => (
                        <p key={decision.id}>{decision.summary}</p>
                      ))}
                    </>
                  ) : null}
                </div>
              </section>
              <Collapsible title={t("Project diagnostics")}>
                <CodeText>{project.project.id}</CodeText>
                <p className="v-secondary">{project.readiness.message}</p>
              </Collapsible>
            </>
          )}
          {page === "project" &&
            isRun &&
            evidence &&
            (props.runDetail ?? (
              <section className="v-center-section">
                <Stepper steps={runSteps(evidence, locale)} horizontal />
                <div className="v-context">
                  <h2>{t("Plan")}</h2>
                  <p>{evidence.handoff?.context.plan?.summary ?? evidence.handoff?.context.goal}</p>
                </div>
                <p className="v-secondary">{t("Detailed evidence is saved with this Project.")}</p>
                {evidence.run && ["running", "queued"].includes(evidence.run.status) && (
                  <Button variant="danger" onClick={props.cancel}>
                    <Icon name="stop" />
                    {t("Cancel run")}
                  </Button>
                )}
              </section>
            ))}
          {page === "settings" && (
            <div className="v-settings">
              <section>
                <h2>{t("Language")}</h2>
                <p className="v-secondary">{t("Choose your interface language.")}</p>
                <LanguageSelect expanded />
              </section>
              <section>
                <h2>{t("Appearance")}</h2>
                <p className="v-secondary">{t("Keep your workspace comfortable.")}</p>
                <div className="v-actions">
                  {["light", "dark", "system"].map((theme) => (
                    <Button key={theme} onClick={() => props.theme(theme)}>
                      {t(
                        (
                          { light: "Light", dark: "Dark", system: "System" } as Record<
                            string,
                            string
                          >
                        )[theme] ?? theme,
                      )}
                    </Button>
                  ))}
                </div>
              </section>
              <section>
                <h2>{t("Local connection")}</h2>
                <p className="v-secondary">
                  {t("Your workspace uses a local session. Native Codex keeps its existing login.")}
                </p>
                <p className="v-caption">
                  {t("No API key is required. No conversation history is collected.")}
                </p>
                <Button onClick={props.reconnect}>{t("Reconnect")}</Button>
              </section>
              <section>
                <h2>{t("Session")}</h2>
                <p className="v-secondary">
                  {t(
                    "Signing out closes this window’s access. It does not delete evidence or interrupt Codex.",
                  )}
                </p>
                <Button onClick={props.logout}>{t("Sign out of this window")}</Button>
              </section>
              <Collapsible title={t("Diagnostics")}>
                <p className="v-secondary">
                  {t(
                    "Project state and run evidence remain in each Project’s .veyra directory. Run ve doctor for local installation diagnostics.",
                  )}
                </p>
                <CodeText>
                  {data.projects
                    .map((entry) => `${entry.project.name}: ${entry.project.root}`)
                    .join("\n")}
                </CodeText>
              </Collapsible>
            </div>
          )}
          {!!data.issues.length && (
            <p className="v-caption v-evidence-notice">
              {t(
                "Some Project evidence could not be loaded. Open the affected Project to inspect its connection.",
              )}
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
