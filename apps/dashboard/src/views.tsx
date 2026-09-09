import {
  Brand,
  Button,
  Icon,
  IconButton,
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
  const [limit, setLimit] = useState(30);
  return (
    <div className="v-run-table">
      <div className="v-run-table-head">
        <span>Task</span>
        <span>Project</span>
        <span>Status</span>
        <span>Duration</span>
      </div>
      {runs.slice(0, limit).map((run) => (
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
            {projects.find((entry) => entry.project.id === run.projectId)?.project.name ??
              "Project"}
          </span>
          <RunStatus status={run.status} />
          <span className="v-duration">{elapsed(run.createdAt, run.updatedAt)}</span>
        </button>
      ))}
      {runs.length > limit && (
        <Button variant="ghost" onClick={() => setLimit(limit + 30)}>
          Show more runs
        </Button>
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
  const [query, setQuery] = useState("");
  const projects = data.projects.filter((entry) =>
    entry.project.name.toLowerCase().includes(query.toLowerCase()),
  );
  const [limit, setLimit] = useState(30);
  return (
    <div>
      {!compact && (
        <label className="v-search">
          <Icon name="search" />
          <input
            aria-label="Search projects"
            placeholder="Find a Project…"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setLimit(30);
            }}
          />
        </label>
      )}
      <div className="v-project-list">
        {projects.slice(0, compact ? 6 : limit).map((entry) => {
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
                <Status tone="warning">Location unavailable</Status>
              ) : last?.status === "running" || last?.status === "queued" ? (
                <RunStatus status={last.status} />
              ) : (
                <span className="v-caption">
                  {last?.status === "completed"
                    ? "Last run completed"
                    : last?.status === "failed"
                      ? "Needs attention"
                      : "Ready"}
                </span>
              )}
              <Icon name="chevron" />
            </button>
          );
        })}
      </div>
      {!compact && projects.length > limit && (
        <Button variant="ghost" onClick={() => setLimit(limit + 30)}>
          Show more Projects
        </Button>
      )}
    </div>
  );
}
export function WorkspaceView(props: WorkspaceViewProps) {
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
    ? (evidence?.handoff?.context.goal ?? "Run details")
    : page === "project"
      ? (project?.project.name ?? "Project")
      : { overview: "Your workspace", projects: "Projects", runs: "Runs", settings: "Settings" }[
          page
        ];
  const nav: { id: string; label: string; icon: IconName }[] = [
    { id: "overview", label: "Overview", icon: "home" },
    { id: "projects", label: "Projects", icon: "folder" },
    { id: "runs", label: "Runs", icon: "runs" },
  ];
  return (
    <div className="v-center-shell">
      <aside className="v-center-sidebar">
        <Brand />
        <nav aria-label="Primary">
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
          <a href="/#/settings" aria-current={page === "settings" ? "page" : undefined}>
            <Icon name="settings" />
            Settings
          </a>
          <div className="v-local-indicator">
            <Status tone={props.error ? "warning" : "accent"}>
              {props.error ? "Needs attention" : "Local workspace"}
            </Status>
          </div>
        </div>
      </aside>
      <div className="v-center-workspace">
        <header className="v-center-topbar">
          <div className="v-breadcrumb">
            <span>{isRun ? "Runs" : page === "project" ? "Projects" : "Workspace"}</span>
            <Icon name="chevron" />
            <span>
              {isRun
                ? "Run details"
                : page === "project"
                  ? (project?.project.name ?? "Project")
                  : page[0]?.toUpperCase() + page.slice(1)}
            </span>
          </div>
          <div className="v-actions">
            <span className="v-caption">Your project. Your agents.</span>
            <IconButton
              icon="sun"
              label="Switch theme"
              onClick={() =>
                props.theme(document.documentElement.dataset.theme === "dark" ? "light" : "dark")
              }
            />
          </div>
        </header>
        <main className="v-center-content">
          <div className="v-page-heading">
            <div>
              <span className="v-eyebrow">
                {page === "overview"
                  ? "Veyra Control Center"
                  : isRun
                    ? (project?.project.name ?? "Project run")
                    : "Workspace"}
              </span>
              <h1>{title}</h1>
              {page === "overview" && (
                <p className="v-secondary">
                  A clear view of your Projects, progress and next steps.
                </p>
              )}
              {page === "project" && project && <PathText path={project.project.root} />}
            </div>
            {isRun && evidence?.run && <RunStatus status={evidence.run.status} />}
          </div>
          {props.error && (
            <ErrorState title="The local connection needs attention">
              Your work is saved in the Project. Reconnect, or reopen Veyra from the Side Panel.
              <div className="v-actions">
                <Button onClick={props.reconnect}>Reconnect</Button>
                <Collapsible title="Details">
                  <CodeText>{props.error}</CodeText>
                </Collapsible>
              </div>
            </ErrorState>
          )}
          {props.loading && (
            <div className="v-local-loading" role="status">
              Loading Project evidence…
            </div>
          )}
          {page === "overview" && (
            <>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>Active now</h2>
                  <span className="v-caption">ChatGPT plans · Codex builds</span>
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
                            ? "Codex is working on this Project"
                            : run.status === "queued"
                              ? "Waiting for Codex"
                              : "Your attention is needed"}
                        </p>
                      </div>
                      <div className="v-active-status">
                        <RunStatus status={run.status} />
                        <span>{elapsed(run.createdAt, run.updatedAt)}</span>
                      </div>
                      <Icon name="arrow" />
                    </button>
                  ))
                ) : (
                  <div className="v-quiet-state">
                    <Icon name="check" />
                    <div>
                      <h3>Room for your next idea</h3>
                      <p>Start in your bound ChatGPT conversation. Progress will appear here.</p>
                    </div>
                  </div>
                )}
              </section>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>Projects</h2>
                  <Button variant="ghost" onClick={() => navigate("/projects")}>
                    View all <Icon name="arrow" />
                  </Button>
                </div>
                {data.projects.length ? (
                  <ProjectRows data={data} navigate={navigate} compact />
                ) : (
                  <EmptyState title="Your first Project">
                    Run <CodeText>ve init</CodeText> inside a local project, then open Veyra again.
                  </EmptyState>
                )}
              </section>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>Recent runs</h2>
                  <Button variant="ghost" onClick={() => navigate("/runs")}>
                    View all <Icon name="arrow" />
                  </Button>
                </div>
                {data.runs.length ? (
                  <RunRows
                    runs={data.runs.slice(0, 6)}
                    projects={data.projects}
                    navigate={navigate}
                  />
                ) : (
                  <EmptyState icon="runs" title="No runs yet">
                    Your first task starts in ChatGPT.
                  </EmptyState>
                )}
              </section>
            </>
          )}
          {page === "projects" && <ProjectRows data={data} navigate={navigate} />}
          {page === "runs" && (
            <>
              <p className="v-secondary v-page-intro">
                Execution history, saved with each Project.
              </p>
              {data.runs.length ? (
                <RunRows runs={data.runs} projects={data.projects} navigate={navigate} />
              ) : (
                <EmptyState icon="runs" title="No runs yet">
                  Start a task in your bound ChatGPT conversation.
                </EmptyState>
              )}
              {data.hasMore && <p className="v-caption">Showing the latest 20 runs per Project.</p>}
            </>
          )}
          {page === "project" && !isRun && project && (
            <>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>Current work</h2>
                  <Status tone={project.readiness.ready ? "accent" : "warning"}>
                    Codex · {project.readiness.ready ? "Ready" : "Needs attention"}
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
                      <h3>Ready for your next task</h3>
                      <p>Bind this Project in ChatGPT to begin.</p>
                    </div>
                  </div>
                )}
              </section>
              <section className="v-center-section">
                <div className="v-section-heading">
                  <h2>Shared context</h2>
                  <span className="v-caption">Belongs to your Project</span>
                </div>
                <div className="v-context">
                  <h3>Goal</h3>
                  <p>
                    {project.sharedState?.context.goal ??
                      "Your plan will appear after the first handoff."}
                  </p>
                  {project.sharedState?.context.constraints.length ? (
                    <>
                      <h3>Constraints</h3>
                      <ul>
                        {project.sharedState.context.constraints.map((constraint) => (
                          <li key={constraint}>{constraint}</li>
                        ))}
                      </ul>
                    </>
                  ) : null}
                  {project.sharedState?.context.decisions.length ? (
                    <>
                      <h3>Decisions</h3>
                      {project.sharedState.context.decisions.map((decision) => (
                        <p key={decision.id}>{decision.summary}</p>
                      ))}
                    </>
                  ) : null}
                </div>
              </section>
              <Collapsible title="Project diagnostics">
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
                <Stepper steps={runSteps(evidence)} horizontal />
                <div className="v-context">
                  <h2>Plan</h2>
                  <p>{evidence.handoff?.context.plan?.summary ?? evidence.handoff?.context.goal}</p>
                </div>
                <p className="v-secondary">Detailed evidence is saved with this Project.</p>
                {evidence.run && ["running", "queued"].includes(evidence.run.status) && (
                  <Button variant="danger" onClick={props.cancel}>
                    <Icon name="stop" />
                    Cancel run
                  </Button>
                )}
              </section>
            ))}
          {page === "settings" && (
            <div className="v-settings">
              <section>
                <h2>Appearance</h2>
                <p className="v-secondary">Keep your workspace comfortable.</p>
                <div className="v-actions">
                  {["light", "dark", "system"].map((theme) => (
                    <Button key={theme} onClick={() => props.theme(theme)}>
                      {theme[0]?.toUpperCase() + theme.slice(1)}
                    </Button>
                  ))}
                </div>
              </section>
              <section>
                <h2>Local connection</h2>
                <p className="v-secondary">
                  Your workspace uses a local session. Native Codex keeps its existing login.
                </p>
                <p className="v-caption">
                  No API key is required. No conversation history is collected.
                </p>
                <Button onClick={props.reconnect}>Reconnect</Button>
              </section>
              <section>
                <h2>Session</h2>
                <p className="v-secondary">
                  Signing out closes this window’s access. It does not delete evidence or interrupt
                  Codex.
                </p>
                <Button onClick={props.logout}>Sign out of this window</Button>
              </section>
              <Collapsible title="Diagnostics">
                <p className="v-secondary">
                  Project state and run evidence remain in each Project’s .veyra directory. Run ve
                  doctor for local installation diagnostics.
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
              Some Project evidence could not be loaded. Open the affected Project to inspect its
              connection.
            </p>
          )}
        </main>
      </div>
    </div>
  );
}
