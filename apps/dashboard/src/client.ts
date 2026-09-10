import {
  isDaemonRunSummary,
  isRegisteredProject,
  isProjectSharedState,
  isDaemonRunView,
  isProjectHandoff,
  isProjectExecutionResult,
  isProjectReviewForResult,
  type DaemonRunSummary,
  type RegisteredProject,
  type DaemonMethod,
  type DaemonOperations,
  type ProjectId,
} from "@veyraoss/protocol";
import { isLocale, type RunEvidence } from "@veyraoss/ui";
export interface ProjectData {
  project: RegisteredProject["project"];
  readiness: { ready: boolean; message: string };
  sharedState?: ReturnType<typeof stateValue>;
}
const stateValue = (value: unknown) => (isProjectSharedState(value) ? value : undefined);
export interface WorkspaceData {
  projects: RegisteredProject[];
  runs: DaemonRunSummary[];
  issues: string[];
  hasMore: boolean;
}
const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === "object" && !Array.isArray(value);
export class ControlClient {
  private csrf = "";
  async connect() {
    const invitation = /^#bootstrap=([a-f0-9]{64})$/.exec(location.hash);
    const response = invitation
      ? await fetch("/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ token: invitation[1] }),
          credentials: "same-origin",
        })
      : await fetch("/api/session", { credentials: "same-origin" });
    const data: unknown = await response.json();
    if (!response.ok || !object(data) || typeof data.csrf !== "string")
      throw new Error(
        "Open Veyra from the Side Panel or run ve open to establish a local session.",
      );
    this.csrf = data.csrf;
    if (invitation)
      history.replaceState(
        null,
        "",
        `/#${typeof data.route === "string" && /^\/[a-zA-Z0-9/-]*$/.test(data.route) ? data.route : "/overview"}`,
      );
  }
  async tool<M extends DaemonMethod>(
    method: M,
    params: DaemonOperations[M]["input"],
  ): Promise<unknown> {
    const response = await fetch("/api/tool", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Veyra-CSRF": this.csrf },
      body: JSON.stringify({ version: 1, method, ...(params === undefined ? {} : { params }) }),
      credentials: "same-origin",
      signal: AbortSignal.timeout(20000),
    });
    const data: unknown = await response.json();
    if (!response.ok || !object(data) || data.ok !== true)
      throw new Error(
        object(data) && typeof data.error === "string"
          ? data.error
          : "Local request was not confirmed.",
      );
    return data.data;
  }
  async workspace(): Promise<WorkspaceData> {
    const values = await this.tool("projects.list", undefined);
    if (!Array.isArray(values) || !values.every(isRegisteredProject))
      throw new Error("Invalid Project discovery response.");
    const runs: DaemonRunSummary[] = [],
      issues: string[] = [];
    let hasMore = false;
    const available = values.filter((entry) => entry.status === "available");
    for (let offset = 0; offset < available.length; offset += 4) {
      await Promise.all(
        available.slice(offset, offset + 4).map(async (entry) => {
          try {
            const list = await this.tool("runs.list", { projectId: entry.project.id, limit: 20 });
            if (!object(list) || !Array.isArray(list.runs) || !list.runs.every(isDaemonRunSummary))
              throw new Error("Invalid run list.");
            runs.push(...list.runs);
            hasMore ||= list.hasMore === true;
          } catch {
            issues.push(entry.project.id);
          }
        }),
      );
    }
    return {
      projects: values,
      runs: runs.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
      issues,
      hasMore,
    };
  }
  async project(projectId: ProjectId): Promise<ProjectData> {
    const value = await this.tool("projects.get", { projectId });
    if (
      !object(value) ||
      !object(value.project) ||
      value.project.id !== projectId ||
      !object(value.readiness) ||
      typeof value.readiness.ready !== "boolean"
    )
      throw new Error("Project data is unavailable.");
    return {
      project: value.project as unknown as ProjectData["project"],
      readiness: value.readiness as unknown as ProjectData["readiness"],
      sharedState: stateValue(value.sharedState),
    };
  }
  async run(projectId: ProjectId, runId: string): Promise<RunEvidence> {
    const data = await this.tool("runs.get", { projectId, runId });
    if (!object(data)) throw new Error("Run is unavailable.");
    const { execution, ...run } = data;
    if (!isDaemonRunView(run) || run.projectId !== projectId || run.runId !== runId)
      throw new Error("Run identity does not match the selected Project.");
    const handoff = await this.tool("handoffs.get", { projectId, runId });
    if (!isProjectHandoff(handoff) || handoff.runId !== runId || handoff.projectId !== projectId)
      throw new Error("Handoff identity is invalid.");
    const payload = ["completed", "failed", "cancelled"].includes(run.status)
      ? await this.tool("results.get", { projectId, runId })
      : {};
    if (
      !object(payload) ||
      (payload.result &&
        (!isProjectExecutionResult(payload.result) ||
          payload.result.runId !== runId ||
          payload.result.projectId !== projectId ||
          payload.result.handoffId !== handoff.id))
    )
      throw new Error("Result evidence is invalid.");
    if (payload.review && !isProjectReviewForResult(payload.review, payload.result))
      throw new Error("Review evidence is invalid.");
    return {
      ...payload,
      run,
      handoff,
      result: payload.result as RunEvidence["result"],
      stage: object(execution) && execution.stage === "verify" ? "verify" : "execute",
    };
  }
  async cancel(projectId: ProjectId, runId: string) {
    await this.tool("runs.cancel", { projectId, runId });
  }
  async locale(value?: "zh-CN" | "en"): Promise<unknown> {
    const response = await fetch("/api/preferences", {
      method: value ? "POST" : "GET",
      headers: { "Content-Type": "application/json", "X-Veyra-CSRF": this.csrf },
      credentials: "same-origin",
      ...(value ? { body: JSON.stringify({ locale: value }) } : {}),
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) throw new Error("Language preference could not be saved. Try again.");
    const data: unknown = await response.json();
    if (!object(data) || !isLocale(data.locale))
      throw new Error("Invalid interface preference response.");
    return data.locale;
  }
  async logout() {
    const response = await fetch("/api/logout", {
      method: "POST",
      headers: { "X-Veyra-CSRF": this.csrf },
      credentials: "same-origin",
    });
    if (!response.ok) throw new Error("Sign out was not confirmed.");
  }
}
