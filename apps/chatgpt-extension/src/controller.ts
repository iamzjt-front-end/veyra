import { isDaemonRunView, isProjectExecutionResult, isProjectId } from "@veyraoss/protocol";
import { LocalClient } from "./client.js";
import {
  EXTENSION_ORIGIN,
  conversationUrl,
  instruction,
  object,
  parseHandoff,
  parsePairing,
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
      if (value.type === "status")
        return {
          paired: !!state.pairing && state.pairing.expiresAt > Date.now(),
          binding: state.binding,
        };
      if (value.type === "pair") {
        if (state.binding && !["paused", "stopped"].includes(state.binding.phase))
          throw new Error("请先停止当前绑定。");
        const pairing = parsePairing(value.pairing);
        await new LocalClient(pairing, this.request).call("projects.list", undefined);
        await this.host.save({ pairing });
        return { paired: true };
      }
      if (value.type === "projects") return client().call("projects.list", undefined);
      if (value.type === "stop") {
        const binding = state.binding;
        if (binding) {
          binding.phase = "stopped";
          binding.delivery = undefined;
          binding.message = "自动派发和回传已停止。";
          await this.host.save(state);
          await this.host.send(binding.tabId, { type: "disarm" }).catch(() => {});
          if (binding.runId) {
            try {
              await client().call("runs.cancel", {
                projectId: binding.projectId,
                runId: binding.runId,
              });
            } catch {
              binding.message = "回传已停止，但取消请求未确认；请在本机检查该 run。";
              await this.host.save(state);
            }
          }
        }
        return { binding };
      }
      if (value.type === "bind") {
        if (state.binding && !["paused", "stopped"].includes(state.binding.phase))
          throw new Error("请先停止当前绑定。");
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
        const binding: Binding = {
          id: crypto.randomUUID(),
          tabId: tab.id,
          epoch: prepared.epoch,
          conversation,
          projectId: value.projectId,
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
      binding.count++;
      binding.message = "正在派发原生执行器。";
      // Persist the intent before crossing the network; ambiguous responses are never replayed.
      await this.host.save(state);
      try {
        await client().call("runs.dispatch", { projectId: binding.projectId, handoff });
        binding.phase = "running";
        binding.message = "原生执行中；可随时停止。";
      } catch (error) {
        binding.phase = "paused";
        binding.message = `派发未确认，不会重试：${error instanceof Error ? error.message : "请检查本机 run。"}`;
      }
    } else if (value.type === "poll" && binding.phase === "running" && binding.runId) {
      const locator = { projectId: binding.projectId, runId: binding.runId };
      const run = await client().call("runs.get", locator);
      if (
        !isDaemonRunView(run) ||
        run.projectId !== locator.projectId ||
        run.runId !== locator.runId
      )
        throw new Error("Run 身份不匹配。");
      if (!["queued", "running"].includes(run.status)) {
        if (["paused", "interrupted"].includes(run.status)) {
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
      binding.runId = undefined;
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
  async detached(tabId: number) {
    const state = await this.host.read();
    if (state.binding?.tabId === tabId) {
      state.binding.phase = "paused";
      state.binding.delivery = undefined;
      state.binding.message = "页面已关闭、刷新或切换；自动回传已暂停，运行证据保留在 Project。";
      await this.host.save(state);
    }
  }
}
