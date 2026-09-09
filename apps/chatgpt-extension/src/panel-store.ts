import {
  isDaemonRunView,
  isProjectHandoff,
  isProjectExecutionResult,
  type RegisteredProject,
} from "@veyraoss/protocol";
import type { RunEvidence } from "@veyraoss/ui";
import { object, type Binding, type ProjectView } from "./contracts.js";

export interface PanelSnapshot {
  loading: boolean;
  busy: boolean;
  projects: RegisteredProject[];
  projectId: string;
  connected: boolean;
  currentBound: boolean;
  conversation?: string;
  tabId?: number;
  enabled: boolean;
  binding?: Binding;
  selected?: ProjectView;
  evidence: RunEvidence;
  error?: string;
  transport?: string;
}
export const initialPanel: PanelSnapshot = {
  loading: true,
  busy: false,
  projects: [],
  projectId: "",
  connected: false,
  currentBound: false,
  enabled: false,
  evidence: {},
};
export async function surfaceCall(type: string, params: Record<string, unknown> = {}) {
  const response: unknown = await chrome.runtime.sendMessage({ type, ...params });
  if (!object(response) || response.ok !== true)
    throw new Error(
      object(response) && typeof response.error === "string"
        ? response.error
        : "Veyra did not confirm this action.",
    );
  return response.data;
}
/** One immutable snapshot per meaningful event; zero network/timers while idle. */
export class PanelStore {
  private state: PanelSnapshot = initialPanel;
  private listeners = new Set<() => void>();
  private serial = Promise.resolve();
  private evidenceKey = "";
  private closed = false;
  constructor(private readonly call = surfaceCall) {}
  snapshot = () => this.state;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };
  private set(change: Partial<PanelSnapshot>) {
    if (this.closed) return;
    const state = { ...this.state, ...change };
    if (JSON.stringify(state) === JSON.stringify(this.state)) return;
    this.state = state;
    for (const listener of this.listeners) listener();
  }
  async openControl() {
    try {
      const value = await this.call("control", {
        expectedConversation: this.state.conversation,
        expectedTabId: this.state.tabId,
      });
      if (
        !object(value) ||
        typeof value.url !== "string" ||
        !/^http:\/\/127\.0\.0\.1:[0-9]+\/#bootstrap=[a-f0-9]{64}$/.test(value.url)
      )
        throw new Error("The local GUI invitation was not confirmed.");
      await chrome.tabs.create({ url: value.url });
    } catch (error) {
      this.set({
        error: error instanceof Error ? error.message : "The Control Center could not open.",
      });
    }
  }
  close() {
    this.closed = true;
    this.listeners.clear();
  }
  async connect() {
    this.set({ loading: true, error: undefined });
    try {
      const projects = await this.call("projects");
      if (!Array.isArray(projects)) throw new Error("Project discovery is unavailable.");
      const list = projects as RegisteredProject[];
      const preferred =
        this.state.projectId ||
        (list.length === 1 && list[0]?.status === "available" ? list[0].project.id : "");
      this.set({ projects: list, projectId: preferred });
      await this.refresh(true);
    } catch (error) {
      this.set({ error: String(error instanceof Error ? error.message : error), connected: false });
    } finally {
      this.set({ loading: false });
    }
  }
  refresh(inspect = false): Promise<void> {
    const refresh = this.serial.then(async () => {
      if (this.closed) return;
      try {
        const value = await this.call(inspect ? "status" : "snapshot", {
          projectId: this.state.projectId,
        });
        if (!object(value)) throw new Error("Veyra state is unavailable.");
        const binding =
          value.currentBound && object(value.binding)
            ? (value.binding as unknown as Binding)
            : undefined;
        this.set({
          connected: object(value.connectivity) && value.connectivity.status === "connected",
          currentBound: value.currentBound === true,
          enabled: value.enabled === true,
          binding,
          conversation: typeof value.conversation === "string" ? value.conversation : undefined,
          tabId: typeof value.tabId === "number" ? value.tabId : undefined,
          selected: object(value.selected) ? (value.selected as unknown as ProjectView) : undefined,
          projectId: binding?.projectId ?? this.state.projectId,
          transport: String(value.transport ?? "native"),
        });
        const key = binding?.runId
          ? `${binding.id}:${binding.runId}:${binding.runStatus}:${binding.stage}`
          : "";
        if (key !== this.evidenceKey) {
          if (!binding?.runId) {
            this.evidenceKey = "";
            this.set({ evidence: {} });
          } else {
            const data = await this.call("evidence");
            if (!object(data) || !object(data.run)) return;
            const { execution, ...run } = data.run;
            if (
              !isDaemonRunView(run) ||
              run.projectId !== binding.projectId ||
              run.runId !== binding.runId ||
              !isProjectHandoff(data.handoff) ||
              data.handoff.runId !== run.runId
            )
              throw new Error("Run evidence did not match the bound Project.");
            const result = data.result;
            if (
              result &&
              (!isProjectExecutionResult(result) ||
                result.runId !== run.runId ||
                result.projectId !== run.projectId)
            )
              throw new Error("Result evidence did not match the selected run.");
            this.evidenceKey = key;
            this.set({
              evidence: {
                ...data,
                run,
                handoff: data.handoff,
                result: result as RunEvidence["result"],
                stage: object(execution) && execution.stage === "verify" ? "verify" : "execute",
              },
            });
          }
        }
      } catch (error) {
        this.set({
          error: error instanceof Error ? error.message : "Veyra could not load the current state.",
        });
      }
    });
    this.serial = refresh.catch(() => {});
    return refresh;
  }
  async select(projectId: string) {
    this.evidenceKey = "";
    this.set({ projectId, error: undefined });
    await this.refresh(true);
  }
  async act(type: "bind" | "disable" | "resume" | "unbind" | "stop") {
    if (this.state.busy && !["disable", "unbind", "stop"].includes(type)) return;
    const { projectId, conversation, tabId } = this.state;
    this.set({ busy: true, error: undefined });
    try {
      await this.call(type, {
        projectId,
        maxRuns: 3,
        expectedConversation: conversation,
        expectedTabId: tabId,
      });
    } catch (error) {
      this.set({
        error:
          error instanceof Error
            ? error.message
            : "Action was not confirmed. Check the conversation before trying again.",
      });
    } finally {
      this.set({ busy: false });
      await this.refresh();
    }
  }
}
