import { isDaemonRunView, isProjectExecutionResult, isProjectId } from "@veyraoss/protocol";
import { exchangePairing, LocalClient } from "./client.js";
import {
  EXTENSION_ORIGIN,
  conversationUrl,
  instruction,
  object,
  parseHandoff,
  parsePairing,
  parseInvitation,
  resultMessage,
  type Binding,
  type Pairing,
  type ProjectView,
} from "./contracts.js";

export interface SessionState {
  pairing?: Pairing;
  binding?: Binding;
}
export interface Sender {
  url?: string;
  tabId?: number;
}
export interface ExtensionHost {
  read(): Promise<SessionState>;
  save(state: SessionState): Promise<void>;
  activeTab(): Promise<{ id?: number; url?: string }>;
  tab(id: number): Promise<{ id?: number; url?: string }>;
  send(id: number, message: unknown): Promise<unknown>;
}

/** Session-local bridge coordination only; all execution stays in the daemon. */
export class BridgeController {
  private readiness?: { projectId: string; at: number; view: ProjectView };
  constructor(
    private readonly host: ExtensionHost,
    private readonly request: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}
  async handle(value: unknown, sender: Sender): Promise<unknown> {
    if (!object(value) || typeof value.type !== "string") throw new Error("无效扩展消息。");
    const state = await this.host.read();
    const popup = sender.url === `${EXTENSION_ORIGIN}/popup.html`;
    const client = () => {
      if (!state.pairing) throw new Error("请先导入本机 daemon 配对文件。");
      return new LocalClient(parsePairing(state.pairing), this.request);
    };
    if (popup) {
      if (value.type === "status") return this.status(state, value.projectId);
      if (value.type === "inspect") {
        if (!isProjectId(value.projectId)) throw new Error("请选择 Project。");
        this.readiness = undefined;
        return this.status(state, value.projectId);
      }
      if (value.type === "pair") {
        if (state.binding && !["paused", "stopped"].includes(state.binding.phase))
          throw new Error("请先停止当前绑定。");
        const pairing = await exchangePairing(parseInvitation(value.pairing), this.request);
        this.readiness = undefined;
        await this.host.save({ pairing });
        return { paired: true };
      }
      if (value.type === "projects") return client().call("projects.list", undefined);
      if (["stop", "disable", "unpair"].includes(value.type)) {
        const binding = state.binding;
        if (binding) {
          binding.phase = "stopped";
          binding.delivery = undefined;
          if (binding.lastResult?.delivery === "pending") binding.lastResult.delivery = "stopped";
          binding.message = "Disabled：自动派发和回传已停止。";
          await this.host.save(state);
          await this.host.send(binding.tabId, { type: "disarm" }).catch(() => {});
          if (binding.runId && value.type !== "disable") {
            try {
              const run = await client().call("runs.cancel", {
                projectId: binding.projectId,
                runId: binding.runId,
              });
              this.observeRun(binding, run);
            } catch {
              binding.message = "回传已停止，但取消请求未确认；请在本机检查该 run。";
              await this.host.save(state);
            }
          }
          if (binding.runId && value.type === "disable") {
            binding.message =
              "Disabled：已停止自动桥接，已派发的 run 继续执行；需要时点击 Cancel Run。";
          }
          await this.host.save(state);
        }
        if (value.type === "unpair") {
          // Keep the grant locally on an ambiguous response so the user can retry or stop the daemon.
          await client().revoke();
          await this.host.save({ binding });
          this.readiness = undefined;
        }
        return { binding };
      }
      if (value.type === "bind") {
        if (state.binding && !["paused", "stopped"].includes(state.binding.phase))
          throw new Error("请先停止当前绑定。");
        if (state.binding?.runId) {
          this.observeRun(
            state.binding,
            await client().call("runs.get", {
              projectId: state.binding.projectId,
              runId: state.binding.runId,
            }),
          );
          if (!["completed", "failed", "cancelled"].includes(state.binding.runStatus ?? ""))
            throw new Error(
              "之前的 Run 尚未结束；请先 Cancel Run 或在本地完成审批/恢复，再更换绑定。",
            );
        }
        if (
          !isProjectId(value.projectId) ||
          !Number.isInteger(value.maxRuns) ||
          Number(value.maxRuns) < 1 ||
          Number(value.maxRuns) > 5
        )
          throw new Error("请选择 Project 和 1–5 次执行上限。");
        const tab = await this.host.activeTab();
        const conversation = conversationUrl(tab.url ?? "");
        if (tab.id === undefined || !conversation)
          throw new Error("请先打开 chatgpt.com 上已有 conversation（/c/...），再绑定。");
        const prepared = await this.host.send(tab.id, { type: "prepare" });
        if (
          !object(prepared) ||
          prepared.conversation !== conversation ||
          typeof prepared.epoch !== "string"
        )
          throw new Error("请刷新 ChatGPT 页面后重试。");
        const view = (await client().call("projects.get", {
          projectId: value.projectId,
        })) as ProjectView;
        if (!object(view) || !object(view.readiness) || view.readiness.ready !== true)
          throw new Error(
            object(view) && object(view.readiness) && typeof view.readiness.message === "string"
              ? view.readiness.message
              : "原生执行器尚未就绪。",
          );
        if (
          !object(view.project) ||
          view.project.id !== value.projectId ||
          typeof view.project.name !== "string" ||
          typeof view.project.root !== "string" ||
          !view.project.root.startsWith("/")
        )
          throw new Error("Project 返回身份或路径无效。");
        this.readiness = { projectId: value.projectId, at: Date.now(), view };
        const binding: Binding = {
          id: crypto.randomUUID(),
          tabId: tab.id,
          epoch: prepared.epoch,
          conversation,
          projectId: value.projectId,
          projectName: view.project.name,
          projectRoot: view.project.root,
          nextRunId: crypto.randomUUID(),
          count: 0,
          maxRuns: Number(value.maxRuns),
          phase: "armed",
          message: "等待新的显式 handoff。",
        };
        state.binding = binding;
        await this.host.save(state);
        try {
          const response = await this.host.send(tab.id, {
            type: "arm",
            binding,
            text: `Veyra binding ${binding.id}. Experimental Bridge 已绑定当前会话到 Project。只使用以下项目工程状态，不需要复制其他对话或配置 API Key。\n${JSON.stringify(view)}\n${instruction(binding)}`,
          });
          if (!object(response) || response.ok !== true)
            throw new Error(
              object(response) && typeof response.error === "string"
                ? response.error
                : "输入框必须为空且 ChatGPT 已完成生成；绑定消息未确认发送。",
            );
        } catch (error) {
          binding.phase = "paused";
          binding.message = `绑定消息发送未确认：${error instanceof Error ? error.message : "检查当前会话后重新绑定。"}`;
          await this.host.save(state);
          throw error;
        }
        return { binding };
      }
      throw new Error("未知扩展操作。");
    }
    const binding = state.binding;
    if (
      !binding ||
      sender.tabId !== binding.tabId ||
      conversationUrl(sender.url ?? "") !== binding.conversation ||
      value.epoch !== binding.epoch ||
      value.bindingId !== binding.id
    )
      throw new Error("当前页面没有绑定权限。");
    const tab = await this.host.tab(binding.tabId);
    if (conversationUrl(tab.url ?? "") !== binding.conversation)
      throw new Error("会话已切换；不会派发或回传。");
    if (["paused", "stopped"].includes(binding.phase)) return { binding };
    if (value.type === "error") {
      binding.phase = "paused";
      binding.message =
        typeof value.message === "string"
          ? value.message.slice(0, 512)
          : "页面操作无法确认，请本地检查。";
    } else if (value.type === "dispatch") {
      if (binding.phase !== "armed" || binding.count >= binding.maxRuns)
        throw new Error("当前绑定不能继续派发。");
      if (typeof value.source !== "string") throw new Error("缺少显式 handoff。");
      const handoff = parseHandoff(value.source, binding.projectId, binding.nextRunId);
      binding.phase = "dispatching";
      binding.runId = handoff.runId;
      binding.runStatus = "dispatching";
      binding.agentStatus = "unknown";
      binding.count++;
      binding.message = "正在派发原生执行器。";
      // Persist the intent before crossing the network; ambiguous responses are never replayed.
      await this.host.save(state);
      try {
        const run = await client().call("runs.dispatch", { projectId: binding.projectId, handoff });
        this.observeRun(binding, run);
        binding.phase = "running";
        binding.message = "原生执行中；可随时停止。";
      } catch (error) {
        binding.phase = "paused";
        binding.message = `派发未确认，不会重试：${error instanceof Error ? error.message : "请检查本机 run。"}`;
      }
    } else if (value.type === "poll" && binding.phase === "running" && binding.runId) {
      const locator = { projectId: binding.projectId, runId: binding.runId };
      const run = await client().call("runs.get", locator);
      this.observeRun(binding, run);
      if (!["queued", "running"].includes(binding.runStatus ?? "")) {
        if (["paused", "interrupted"].includes(binding.runStatus ?? "")) {
          binding.phase = "paused";
          binding.message = "Run 需要本地审批或恢复；扩展不能代替审批。";
        } else {
          const data = await client().call("results.get", locator);
          if (
            !object(data) ||
            !isProjectExecutionResult(data.result) ||
            data.result.projectId !== locator.projectId ||
            data.result.runId !== locator.runId
          )
            throw new Error("执行结果缺失或身份不匹配；请检查本机证据。");
          binding.nextRunId = crypto.randomUUID();
          const id = crypto.randomUUID();
          binding.delivery = { id, text: resultMessage(binding, data, id) };
          binding.lastResult = {
            runId: data.result.runId,
            status: data.result.status,
            summary: data.result.summary.slice(0, 1024),
            delivery: "pending",
          };
          binding.phase = "ready_to_deliver";
          binding.message = "等待当前会话输入框空闲后自动回传。";
        }
      }
    } else if (value.type === "claim" && binding.phase === "ready_to_deliver" && binding.delivery) {
      binding.phase = "delivering";
      binding.message = "正在向当前会话回传；未确认时不会重复发送。";
      await this.host.save(state);
      return { binding, delivery: binding.delivery };
    } else if (
      value.type === "defer" &&
      binding.phase === "delivering" &&
      value.deliveryId === binding.delivery?.id
    ) {
      binding.phase = "ready_to_deliver";
    } else if (
      value.type === "ack" &&
      binding.phase === "delivering" &&
      value.deliveryId === binding.delivery?.id
    ) {
      binding.delivery = undefined;
      if (binding.lastResult) binding.lastResult.delivery = "confirmed";
      binding.phase = binding.count >= binding.maxRuns ? "stopped" : "armed";
      binding.message =
        binding.phase === "stopped"
          ? "已回传，自动执行次数用尽。"
          : "已回传，等待 GPT Review 或新的 repair handoff。";
    }
    await this.host.save(state);
    // Pending result bodies are available only through an explicit one-time claim.
    return { binding: { ...binding, delivery: undefined } };
  }
  private observeRun(binding: Binding, value: unknown) {
    if (!object(value)) throw new Error("Run 响应无效。");
    const { execution, ...run } = value;
    if (!isDaemonRunView(run) || run.projectId !== binding.projectId || run.runId !== binding.runId)
      throw new Error("Run 身份不匹配。");
    binding.runStatus = run.status;
    if (object(execution) && typeof execution.agentStatus === "string")
      binding.agentStatus = execution.agentStatus.slice(0, 128);
  }
  private async status(state: SessionState, selectedId: unknown) {
    const tab = await this.host.activeTab();
    const conversation = conversationUrl(tab.url ?? "");
    const currentBound =
      !!state.binding &&
      tab.id === state.binding.tabId &&
      conversation === state.binding.conversation;
    const paired = !!state.pairing && state.pairing.expiresAt > Date.now();
    let connectivity = { status: "disconnected", message: "未配对或授权已过期。" };
    let selected: ProjectView | undefined;
    let readinessAt: number | undefined;
    if (paired && state.pairing) {
      try {
        const client = new LocalClient(parsePairing(state.pairing), this.request);
        await client.call("projects.list", undefined);
        connectivity = { status: "connected", message: "本机 Daemon 已连接且授权有效。" };
        const activeBinding =
          currentBound && !["paused", "stopped"].includes(state.binding?.phase ?? "stopped");
        const projectId = activeBinding
          ? state.binding?.projectId
          : isProjectId(selectedId)
            ? selectedId
            : currentBound
              ? state.binding?.projectId
              : undefined;
        if (isProjectId(projectId)) {
          if (this.readiness?.projectId !== projectId || Date.now() - this.readiness.at > 30000) {
            const view = (await client.call("projects.get", { projectId })) as ProjectView;
            if (
              !object(view) ||
              !object(view.project) ||
              view.project.id !== projectId ||
              typeof view.project.root !== "string" ||
              !object(view.readiness) ||
              typeof view.readiness.ready !== "boolean"
            )
              throw new Error("Project readiness 响应无效。");
            this.readiness = { projectId, at: Date.now(), view };
          }
          selected = this.readiness.view;
          readinessAt = this.readiness.at;
        }
        if (state.binding?.runId) {
          const run = await client.call("runs.get", {
            projectId: state.binding.projectId,
            runId: state.binding.runId,
          });
          this.observeRun(state.binding, run);
          await this.host.save(state);
        }
      } catch (error) {
        connectivity = {
          status: "unavailable",
          message: error instanceof Error ? error.message : "本机请求失败。",
        };
      }
    }
    return {
      paired,
      expiresAt: state.pairing?.expiresAt,
      connectivity,
      conversation,
      currentBound,
      enabled: currentBound && !["paused", "stopped"].includes(state.binding?.phase ?? "stopped"),
      binding: state.binding ? { ...state.binding, delivery: undefined } : undefined,
      selected: selected ? { project: selected.project, readiness: selected.readiness } : undefined,
      readinessAt,
    };
  }
  async detached(tabId: number) {
    const state = await this.host.read();
    if (state.binding?.tabId === tabId) {
      state.binding.phase = "paused";
      state.binding.delivery = undefined;
      if (state.binding.lastResult?.delivery === "pending")
        state.binding.lastResult.delivery = "stopped";
      state.binding.message = "页面已关闭、刷新或切换；自动回传已暂停，运行证据保留在 Project。";
      await this.host.save(state);
    }
  }
}
