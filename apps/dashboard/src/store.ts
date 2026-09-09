import { isProjectId } from "@veyraoss/protocol";
import type { RunEvidence } from "@veyraoss/ui";
import { ControlClient, type ProjectData, type WorkspaceData } from "./client.js";
export interface WorkspaceSnapshot {
  data: WorkspaceData;
  route: string;
  loading: boolean;
  error?: string;
  project?: ProjectData;
  evidence?: RunEvidence;
}
/** One update per meaningful state event. Stale route responses never replace the current view. */
export class WorkspaceStore {
  private value: WorkspaceSnapshot = {
    data: { projects: [], runs: [], issues: [], hasMore: false },
    route: "/overview",
    loading: true,
  };
  private listeners = new Set<() => void>();
  private revision = 0;
  private pending?: Promise<void>;
  private dirty = false;
  private closed = false;
  constructor(private readonly client = new ControlClient()) {}
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(value: WorkspaceSnapshot) {
    if (this.closed || JSON.stringify(value) === JSON.stringify(this.value)) return;
    this.value = value;
    for (const listener of this.listeners) listener();
  }
  async connect() {
    this.closed = false;
    try {
      await this.client.connect();
      this.route(location.hash.slice(1));
      await this.refresh();
    } catch (error) {
      this.fail(error);
    }
  }
  route(route: string) {
    const next =
      /^\/(?:overview|settings|runs|projects(?:\/[a-f0-9-]{36}(?:\/runs\/[a-f0-9-]{36})?)?)$/.test(
        route,
      )
        ? route
        : "/overview";
    if (next === this.value.route) return;
    this.revision++;
    this.set({
      ...this.value,
      route: next,
      project: undefined,
      evidence: undefined,
      error: undefined,
      loading: true,
    });
    void this.refresh();
  }
  refresh(): Promise<void> {
    if (this.closed) return Promise.resolve();
    if (this.pending) {
      this.dirty = true;
      return this.pending;
    }
    const revision = this.revision,
      route = this.value.route;
    this.pending = (async () => {
      try {
        const data = await this.client.workspace();
        const parts = route.split("/");
        const project =
          parts[1] === "projects" && isProjectId(parts[2])
            ? await this.client.project(parts[2])
            : undefined;
        let evidence =
          project && parts[3] === "runs" && parts[4]
            ? await this.client.run(project.project.id, parts[4])
            : undefined;
        const review = project?.sharedState?.review;
        if (
          evidence &&
          review &&
          review.runId === evidence.run?.runId &&
          review.resultId === evidence.result?.id
        )
          evidence = { ...evidence, review };
        if (revision === this.revision)
          this.set({ data, route, project, evidence, loading: false });
      } catch (error) {
        if (revision === this.revision) this.fail(error);
      }
    })().finally(() => {
      this.pending = undefined;
      if (this.dirty) {
        this.dirty = false;
        void this.refresh();
      }
    });
    return this.pending;
  }
  fail(error: unknown) {
    this.set({
      ...this.value,
      loading: false,
      error: error instanceof Error ? error.message : "Local evidence is unavailable.",
    });
  }
  async cancel() {
    const run = this.value.evidence?.run;
    if (!run) return;
    try {
      await this.client.cancel(run.projectId, run.runId);
      await this.refresh();
    } catch (error) {
      this.fail(error);
    }
  }
  async logout() {
    await this.client.logout();
    this.close();
  }
  close() {
    this.closed = true;
    this.revision++;
    this.dirty = false;
  }
}
