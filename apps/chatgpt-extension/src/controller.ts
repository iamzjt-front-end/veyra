import { isExtensionSurface } from "./surfaces.js";
import {
  isDaemonRunView,
  isProjectExecutionResult,
  isProjectHandoff,
  isProjectId,
  isProjectReview,
  isNativeConversation,
  serializeProjectEnvelope,
} from "@veyraoss/protocol";
import type { NativeTransport } from "./native-client.js";
import { exchangePairing, LocalClient } from "./client.js";
import { PAGE_CONNECTION_CHANGED } from "./page-connection.js";
import { BUILD_ID } from "./build-info.js";
import { checkpoint, handoffFingerprint } from "./checkpoints.js";
import {
  conversationUrl,
  object,
  parseHandoff,
  parseReview,
  parsePairing,
  parseInvitation,
  resultMessage,
  bindingMessage,
  type Binding,
  type Pairing,
  type ProjectView,
} from "./contracts.js";

export interface SessionState {
  pairing?: Pairing;
  transport?: "http" | "native";
  binding?: Binding;
  bindings?: Record<string, Binding>;
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
export interface BridgeReadiness {
  ready: boolean;
  reason: "ready" | "unbound" | "paused" | "connecting" | "project" | "page" | "bootstrap";
  receiver: "unknown" | "confirmed" | "unavailable" | "different_build";
  buildId: string;
  pageBuildId?: string;
}

/** Session-local bridge coordination only; all execution stays in the daemon. */
export class BridgeController {
  private connectivity?: { status: string; message: string };
  private actionEpoch = 0;
  private readiness?: { projectId: string; at: number; view: ProjectView };
  private receiver?: {
    bindingId: string;
    epoch: string;
    status: BridgeReadiness["receiver"];
    buildId?: string;
  };
  constructor(
    private readonly host: ExtensionHost,
    private readonly request: typeof fetch = (...args) => globalThis.fetch(...args),
    private readonly native?: NativeTransport,
  ) {}
  async handle(value: unknown, sender: Sender): Promise<unknown> {
    if (!object(value) || typeof value.type !== "string") throw new Error("无效扩展消息。");
    const popup = isExtensionSurface(sender.url);
    if (popup && ["disable", "unbind"].includes(value.type)) this.actionEpoch++;
    const actionEpoch = this.actionEpoch;
    const state = await this.host.read();
    const client = () => this.client(state);
    if (!popup && value.type === "hello")
      return actionEpoch === this.actionEpoch
        ? this.restore(state, value, sender)
        : { restored: false };
    if (popup) {
      if (
        ["bind", "disable", "resume", "unbind", "stop", "control"].includes(value.type) &&
        value.expectedConversation !== undefined
      ) {
        const tab = await this.host.activeTab();
        if (
          tab.id !== value.expectedTabId ||
          conversationUrl(tab.url ?? "") !== value.expectedConversation
        )
          throw new Error(
            "Conversation changed. Return to the selected conversation; nothing was sent.",
          );
      }
      if (value.type === "control") {
        const binding = state.binding,
          tab = await this.host.activeTab();
        if (
          !binding ||
          tab.id !== binding.tabId ||
          conversationUrl(tab.url ?? "") !== binding.conversation ||
          state.pairing ||
          state.transport === "http" ||
          !this.native?.openControl
        )
          throw new Error(
            "Open the bound conversation using the Native Bridge to view this Project.",
          );
        const opened = await this.native.openControl(binding.projectId, binding.runId);
        const current = await this.host.activeTab();
        if (
          actionEpoch !== this.actionEpoch ||
          current.id !== tab.id ||
          conversationUrl(current.url ?? "") !== binding.conversation
        )
          throw new Error("Conversation changed. The Control Center was not opened.");
        if (
          !object(opened) ||
          typeof opened.url !== "string" ||
          !/^http:\/\/127\.0\.0\.1:[0-9]+\/#bootstrap=[a-f0-9]{64}$/.test(opened.url)
        )
          throw new Error("Local GUI invitation is invalid.");
        return { url: opened.url };
      }
      if (value.type === "evidence") {
        const tab = await this.host.activeTab();
        const binding = state.binding;
        if (
          !binding?.runId ||
          tab.id !== binding.tabId ||
          conversationUrl(tab.url ?? "") !== binding.conversation
        )
          return {};
        const locator = { projectId: binding.projectId, runId: binding.runId };
        const run = await client().call("runs.get", locator);
        const handoff = await client().call("handoffs.get", locator);
        const terminal =
          object(run) && ["completed", "failed", "cancelled"].includes(String(run.status));
        const result = terminal ? await client().call("results.get", locator) : {};
        const current = await this.host.activeTab();
        if (
          current.id !== tab.id ||
          conversationUrl(current.url ?? "") !== binding.conversation ||
          actionEpoch !== this.actionEpoch
        )
          return {};
        return { run, handoff, ...(object(result) ? result : {}) };
      }
      if (value.type === "status" || value.type === "snapshot")
        return this.status(state, value.projectId, value.type === "status");
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
        await this.host.save({ pairing, transport: "http", bindings: state.bindings });
        return { paired: true };
      }
      if (value.type === "native") {
        if (state.binding && !["paused", "stopped"].includes(state.binding.phase))
          throw new Error("请先 Pause 当前绑定，再切换连接方式。");
        state.transport = "native";
        state.pairing = undefined;
        await this.host.save(state);
        return this.status(state, undefined);
      }
      if (value.type === "resume") {
        const tab = await this.host.activeTab();
        const selected = state.bindings?.[conversationUrl(tab.url ?? "") ?? ""] ?? state.binding;
        if (!selected || selected.conversation !== conversationUrl(tab.url ?? ""))
          throw new Error("当前对话没有可恢复的绑定。");
        const humanReview =
          selected.phase === "stopped" &&
          selected.review?.phase === "recorded" &&
          selected.lastResult?.delivery === "confirmed";
        if (!selected.pausedByUser && !humanReview)
          throw new Error("请先检查不确定发送或运行的证据，再显式 Unbind / Bind。");
        if (humanReview && selected.review) {
          if (!selected.runId || selected.review.runId !== selected.runId)
            throw new Error("人工决定对应的运行身份不匹配；没有恢复或执行任务。");
          const review = await client().call("reviews.get", {
            projectId: selected.projectId,
            runId: selected.runId,
          });
          if (
            !isProjectReview(review) ||
            review.id !== selected.review.id ||
            review.projectId !== selected.projectId ||
            review.runId !== selected.runId ||
            review.resultId !== selected.review.resultId ||
            !(review.verdict === "needs_input" || review.nextAction === "wait")
          )
            throw new Error("人工决定对应的审查证据不匹配；没有恢复或执行任务。");
          selected.review.decisionAcknowledged = true;
        }
        const prepared = await this.host.send(tab.id as number, {
          type: "prepare",
          conversation: selected.conversation,
        });
        if (actionEpoch !== this.actionEpoch) throw new Error("恢复已取消。");
        selected.pausedByUser = false;
        selected.phase =
          selected.resumePhase === "ready_to_deliver"
            ? "running"
            : (selected.resumePhase ?? "armed");
        if (actionEpoch !== this.actionEpoch) throw new Error("恢复已取消。");
        state.binding = selected;
        await this.host.save(state);
        if (actionEpoch !== this.actionEpoch) throw new Error("恢复已取消。");
        const result = await this.restore(state, prepared, { tabId: tab.id, url: tab.url });
        if (actionEpoch === this.actionEpoch && result.restored && "binding" in result)
          await this.host.send(tab.id as number, {
            type: "arm",
            binding: result.binding,
            restore: true,
          });
        return result;
      }
      if (value.type === "unbind") {
        const tab = await this.host.activeTab();
        const conversation = conversationUrl(tab.url ?? "");
        const selected =
          state.bindings?.[conversation ?? ""] ??
          (state.binding?.conversation === conversation ? state.binding : undefined);
        if (selected) {
          if (state.binding?.id === selected.id) state.binding = undefined;
          delete state.bindings?.[selected.conversation];
          await this.host.save(state);
          await this.host.send(selected.tabId, { type: "disarm" }).catch(() => {});
          if (
            selected.runId &&
            !["completed", "failed", "cancelled"].includes(selected.runStatus ?? "")
          ) {
            try {
              await client().call("runs.cancel", {
                projectId: selected.projectId,
                runId: selected.runId,
              });
            } catch {
              throw new Error(
                `已 Unbind；取消未确认，请在 Project 证据中检查 Run ${selected.runId}。`,
              );
            }
          }
        }
        return { unbound: true };
      }
      if (value.type === "projects") return client().call("projects.list", undefined);
      if (value.type === "codexConversations") {
        if (state.pairing || state.transport === "http" || !this.native?.listConversations)
          throw new Error("Existing Codex tasks require the Native Bridge.");
        if (
          (value.search !== undefined &&
            (typeof value.search !== "string" || value.search.length > 128)) ||
          (value.cursor !== undefined &&
            (typeof value.cursor !== "string" || value.cursor.length > 4096))
        )
          throw new Error("Invalid Codex task search.");
        return this.native.listConversations({
          search: value.search as string | undefined,
          cursor: value.cursor as string | undefined,
        });
      }
      if (["stop", "disable", "unpair"].includes(value.type)) {
        const binding = state.binding;
        if (binding && value.type !== "unpair") {
          const tab = await this.host.activeTab();
          if (tab.id !== binding.tabId || conversationUrl(tab.url ?? "") !== binding.conversation)
            throw new Error("请在已绑定的当前对话中操作。");
        }
        if (binding) {
          binding.pausedByUser =
            value.type === "disable" &&
            binding.bootstrapped === true &&
            !["dispatching", "delivering", "paused", "stopped"].includes(binding.phase);
          binding.resumePhase = binding.pausedByUser ? binding.phase : undefined;
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
          await client().revoke(state.binding?.projectId);
          await this.host.save({
            binding,
            transport: state.pairing ? "http" : state.transport,
            bindings: state.bindings,
          });
          this.readiness = undefined;
        }
        return { binding };
      }
      if (value.type === "bind") {
        const targetTab = await this.host.activeTab();
        const targetConversation = conversationUrl(targetTab.url ?? "");
        if (
          state.binding &&
          state.binding.conversation === targetConversation &&
          !["paused", "stopped"].includes(state.binding.phase)
        )
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
        if (value.nativeConversation !== undefined) {
          if (
            !isNativeConversation(value.nativeConversation) ||
            state.pairing ||
            state.transport === "http" ||
            !this.native?.selectConversation ||
            !this.native.checkConversation ||
            !targetConversation
          )
            throw new Error("Select a valid existing Codex task using the Native Bridge.");
          const selection = await this.native.selectConversation(value.nativeConversation);
          if (
            !object(selection) ||
            !isNativeConversation(selection.conversation) ||
            !object(selection.project) ||
            selection.conversation.id !== value.nativeConversation.id ||
            !isProjectId(selection.project.id) ||
            selection.project.root !== selection.conversation.root
          )
            throw new Error("Codex task selection was not confirmed.");
          value.projectId = selection.project.id;
          value.nativeConversation = selection.conversation;
          await this.native.checkConversation(selection.conversation, selection.project.id);
          const current = await this.host.activeTab();
          if (
            actionEpoch !== this.actionEpoch ||
            current.id !== targetTab.id ||
            conversationUrl(current.url ?? "") !== targetConversation
          )
            throw new Error(PAGE_CONNECTION_CHANGED);
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
        const prepared = await this.host.send(tab.id, { type: "prepare", conversation });
        if (actionEpoch !== this.actionEpoch) throw new Error("绑定已取消。");
        if (
          !object(prepared) ||
          prepared.conversation !== conversation ||
          typeof prepared.epoch !== "string"
        )
          throw new Error("请刷新 ChatGPT 页面后重试。");
        if (prepared.buildId !== BUILD_ID)
          throw new Error("页面与扩展构建版本不一致；请刷新当前对话。没有发送任务。");
        if (state.binding && state.binding.conversation !== targetConversation)
          await this.host.send(state.binding.tabId, { type: "disarm" }).catch(() => {});
        if (!state.pairing) await this.native?.authorize(value.projectId);
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
          !view.project.root.startsWith("/") ||
          (isNativeConversation(value.nativeConversation) &&
            value.nativeConversation.root !== view.project.root)
        )
          throw new Error("Project 返回身份或路径无效。");
        this.readiness = { projectId: value.projectId, at: Date.now(), view };
        const currentTab = await this.host.activeTab();
        if (currentTab.id !== tab.id || conversationUrl(currentTab.url ?? "") !== conversation)
          throw new Error(PAGE_CONNECTION_CHANGED);
        if (actionEpoch !== this.actionEpoch) throw new Error("绑定已取消。");
        const binding: Binding = {
          id: crypto.randomUUID(),
          tabId: tab.id,
          epoch: prepared.epoch,
          conversation,
          projectId: value.projectId,
          projectName: view.project.name,
          projectRoot: view.project.root,
          ...(isNativeConversation(value.nativeConversation)
            ? { nativeConversation: value.nativeConversation }
            : {}),
          nextRunId: crypto.randomUUID(),
          count: 0,
          maxRuns: Number(value.maxRuns),
          phase: "armed",
          message: "等待新的显式 handoff。",
          ...(!state.pairing && this.native
            ? { installationId: await this.native.identity() }
            : {}),
          attached: true,
        };
        if (actionEpoch !== this.actionEpoch) throw new Error("绑定已取消。");
        state.binding = binding;
        await this.host.save(state);
        if (actionEpoch !== this.actionEpoch) throw new Error("绑定已取消。");
        try {
          const response = await this.host.send(tab.id, {
            type: "arm",
            binding,
            text: bindingMessage(binding, view),
          });
          if (!object(response) || response.ok !== true)
            throw new Error(
              object(response) && typeof response.error === "string"
                ? response.error
                : "输入框必须为空且 ChatGPT 已完成生成；绑定消息未确认发送。",
            );
        } catch (error) {
          const latest = (await this.host.read()).binding;
          if (actionEpoch !== this.actionEpoch || latest?.id !== binding.id) throw error;
          binding.phase = "paused";
          binding.message = `绑定消息发送未确认：${error instanceof Error ? error.message : "检查当前会话后重新绑定。"}`;
          await this.host.save(state);
          throw error;
        }
        if (actionEpoch !== this.actionEpoch || (await this.host.read()).binding?.id !== binding.id)
          throw new Error("绑定已取消；检查当前对话，不会重发。");
        binding.bootstrapped = true;
        this.receiver = {
          bindingId: binding.id,
          epoch: binding.epoch,
          status: "confirmed",
          buildId: BUILD_ID,
        };
        await this.host.save(state);
        return { binding };
      }
      throw new Error("未知扩展操作。");
    }
    const before = JSON.stringify(state);
    const binding = state.binding;
    if (
      !binding ||
      sender.tabId !== binding.tabId ||
      conversationUrl(sender.url ?? "") !== binding.conversation ||
      value.epoch !== binding.epoch ||
      value.bindingId !== binding.id ||
      binding.attached === false
    )
      throw new Error("当前页面没有绑定权限。");
    if (!state.pairing && this.native && binding.installationId !== (await this.native.identity()))
      throw new Error("本机授权已变化；请重新绑定。");
    const tab = await this.host.tab(binding.tabId);
    if (conversationUrl(tab.url ?? "") !== binding.conversation)
      throw new Error("会话已切换；不会派发或回传。");
    if (actionEpoch !== this.actionEpoch) throw new Error("页面操作已暂停或解绑。");
    if (["paused", "stopped"].includes(binding.phase)) return { binding };
    if (value.type === "error") {
      binding.resumePhase = binding.phase === "running" ? "running" : undefined;
      binding.phase = "paused";
      binding.message =
        typeof value.message === "string"
          ? value.message.slice(0, 512)
          : "页面操作无法确认，请本地检查。";
    } else if (value.type === "dispatch") {
      if (binding.phase !== "armed" || binding.count >= binding.maxRuns)
        throw new Error("当前绑定不能继续派发。");
      if (typeof value.source !== "string") throw new Error("缺少显式 handoff。");
      // Record a bounded receipt even when schema validation rejects the framed input.
      checkpoint(
        binding,
        "detected",
        typeof value.assistantId === "string" ? value.assistantId : undefined,
        binding.nextRunId,
      );
      let handoff: ReturnType<typeof parseHandoff>;
      try {
        handoff = parseHandoff(value.source, binding.projectId, binding.nextRunId);
      } catch (error) {
        binding.phase = "paused";
        binding.message = `交接单校验未通过，没有派发：${error instanceof Error ? error.message : "协议无效。"}`;
        await this.host.save(state);
        throw error;
      }
      binding.admission = {
        handoffId: handoff.id,
        fingerprint: await handoffFingerprint(handoff),
        confirmed: false,
      };
      if (actionEpoch !== this.actionEpoch) throw new Error("派发已取消。");
      checkpoint(binding, "validated", handoff.id, handoff.runId);
      binding.phase = "dispatching";
      binding.runId = handoff.runId;
      binding.runStatus = "dispatching";
      binding.agentStatus = "unknown";
      binding.review = undefined;
      binding.count++;
      binding.message = "正在派发原生执行器。";
      // Persist the intent before crossing the network; ambiguous responses are never replayed.
      await this.host.save(state);
      if (actionEpoch !== this.actionEpoch) throw new Error("派发已取消。");
      try {
        const run = await client().call("runs.dispatch", {
          projectId: binding.projectId,
          handoff,
          ...(binding.nativeConversation
            ? { nativeConversationId: binding.nativeConversation.id }
            : {}),
        });
        this.observeRun(binding, run);
        binding.admission.confirmed = true;
        checkpoint(binding, "accepted", handoff.id);
        binding.phase = "running";
        binding.message = "原生执行中；可随时停止。";
      } catch (error) {
        binding.phase = "paused";
        binding.message = `派发未确认，不会重试：${error instanceof Error ? error.message : "请检查本机 run。"}`;
        // Read-only reconciliation is safe after a lost reply; dispatch itself is never retried.
        try {
          await this.reconcileAdmission(binding, client());
          if (actionEpoch !== this.actionEpoch) return { binding: undefined };
        } catch {
          binding.message = "本机接收尚未确认；已停止派发，请检查该 Run 的归档证据。没有重发任务。";
        }
      }
    } else if (value.type === "poll" && binding.phase === "running" && binding.runId) {
      const locator = { projectId: binding.projectId, runId: binding.runId };
      const run = await client().call("runs.get", locator);
      this.observeRun(binding, run);
      if (!["queued", "running"].includes(binding.runStatus ?? "")) {
        if (["completed", "failed", "cancelled"].includes(binding.runStatus ?? ""))
          checkpoint(binding, "completed");
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
          binding.review = {
            id: crypto.randomUUID(),
            runId: data.result.runId,
            resultId: data.result.id,
            handoffId: data.result.handoffId,
            at: new Date().toISOString(),
            phase: "pending",
          };
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
      if (actionEpoch !== this.actionEpoch) throw new Error("回传已取消。");
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
      checkpoint(binding, "delivered", String(value.deliveryId));
      // The final allowed execution still needs its review. The dispatch guard alone
      // enforces the budget; keeping this observer armed adds no polling or execution.
      binding.phase = "armed";
      binding.message =
        binding.count >= binding.maxRuns
          ? "已回传，自动执行次数用尽。"
          : "已回传，等待 GPT Review 或新的 repair handoff。";
    } else if (value.type === "review") {
      const target = binding.review;
      if (binding.phase === "armed" && binding.count === 0 && !binding.runId && !target) {
        // The initial Project snapshot can contain historical results. A planner's
        // unsolicited review is not authority to associate them with this binding.
        // Ignore it without saving a verdict, disabling an idle binding or doing I/O.
        return { binding: { ...binding, delivery: undefined }, reviewIgnored: true };
      }
      if (
        binding.phase !== "armed" ||
        !target ||
        target.runId !== binding.runId ||
        binding.lastResult?.runId !== target.runId ||
        binding.lastResult.delivery !== "confirmed" ||
        typeof value.source !== "string"
      )
        throw new Error("Review 只能关联当前对话已确认收到的执行结果。");
      if (target.phase === "pending") target.at = new Date().toISOString();
      const review = parseReview(value.source, binding.projectId, target);
      if (target.phase === "recorded") {
        // Do not label a conflicting later answer as saved. An identical duplicate
        // is acknowledged from canonical evidence without replaying the write.
        const saved = await client().call("reviews.get", {
          projectId: binding.projectId,
          runId: target.runId,
        });
        if (
          !isProjectReview(saved) ||
          serializeProjectEnvelope(saved) !== serializeProjectEnvelope(review)
        )
          throw new Error("该结果已有审查，新的内容与保存记录不一致；不会覆盖或重发。");
        return { binding };
      }
      if (target.phase !== "pending")
        throw new Error("审查提交未确认，请检查 Project 记录；不会重发。");
      target.phase = "submitting";
      await this.host.save(state);
      if (
        actionEpoch !== this.actionEpoch ||
        conversationUrl((await this.host.tab(binding.tabId)).url ?? "") !== binding.conversation
      )
        throw new Error("会话已切换；审查未提交。");
      const saved = await client().call("reviews.submit", {
        projectId: binding.projectId,
        runId: target.runId,
        review,
      });
      if (
        !isProjectReview(saved) ||
        saved.id !== target.id ||
        saved.projectId !== binding.projectId ||
        saved.runId !== target.runId ||
        saved.resultId !== target.resultId ||
        (saved.handoffId !== undefined && saved.handoffId !== target.handoffId)
      )
        throw new Error("审查保存响应身份不匹配；请检查 Project 记录。");
      target.phase = "recorded";
      target.needsDecision = saved.verdict === "needs_input" || saved.nextAction === "wait";
      checkpoint(binding, "reviewed", saved.id);
      binding.message = "审查已保存到 Project。";
      if (saved.verdict === "needs_input" || saved.nextAction === "wait") {
        binding.phase = "stopped";
        binding.message = "审查需要你的决定；自动桥接已停止。";
      }
    }
    const latest = (await this.host.read()).binding;
    if (
      actionEpoch !== this.actionEpoch ||
      latest?.id !== binding.id ||
      latest.epoch !== binding.epoch
    )
      return { binding: latest ? { ...latest, delivery: undefined } : undefined };
    if (JSON.stringify(state) !== before) await this.host.save(state);
    // Pending result bodies are available only through an explicit one-time claim.
    return { binding: { ...binding, delivery: undefined } };
  }
  private observeRun(binding: Binding, value: unknown) {
    if (!object(value)) throw new Error("Run 响应无效。");
    const { execution, ...run } = value;
    if (!isDaemonRunView(run) || run.projectId !== binding.projectId || run.runId !== binding.runId)
      throw new Error("Run 身份不匹配。");
    binding.runStatus = run.status;
    if (object(execution) && ["execute", "verify", "review"].includes(String(execution.stage)))
      binding.stage = execution.stage as Binding["stage"];
    if (object(execution) && typeof execution.agentStatus === "string")
      binding.agentStatus = execution.agentStatus.slice(0, 128);
  }
  private async reconcileAdmission(
    binding: Binding,
    client: ReturnType<BridgeController["client"]>,
  ) {
    const receipt = binding.admission;
    if (!receipt || !binding.runId || binding.pausedByUser || binding.phase === "stopped")
      throw new Error("任务接收证据不可用。");
    const locator = { projectId: binding.projectId, runId: binding.runId };
    const archived = await client.call("handoffs.get", locator);
    if (
      !isProjectHandoff(archived) ||
      archived.projectId !== binding.projectId ||
      archived.runId !== binding.runId ||
      archived.id !== receipt.handoffId ||
      (await handoffFingerprint(archived)) !== receipt.fingerprint
    )
      throw new Error("归档交接单与本次派发不一致；不会执行或重发。");
    const run = await client.call("runs.get", locator);
    // Admission is proved by both the immutable handoff and matching coordinator run.
    this.observeRun(binding, run);
    receipt.confirmed = true;
    checkpoint(binding, "accepted", receipt.handoffId);
    binding.phase = "running";
    binding.message = "已从本机归档确认任务已接收，继续跟踪原 Run。没有重复派发。";
  }
  private async status(state: SessionState, selectedId: unknown, inspect = true) {
    const tab = await this.host.activeTab();
    const conversation = conversationUrl(tab.url ?? "");
    let currentBound =
      !!state.binding &&
      tab.id === state.binding.tabId &&
      conversation === state.binding.conversation;
    const paired =
      (!!state.pairing && state.pairing.expiresAt > Date.now()) ||
      (!state.pairing && state.transport !== "http" && !!this.native);
    // Worker eviction loses only this cache, not the document binding or local grant.
    // Rehydrate once on the first requested snapshot; later idle snapshots stay read-only
    // and cached. A missing cache is not evidence that the native bridge disconnected.
    if (paired && !this.connectivity) inspect = true;
    let connectivity =
      paired && this.connectivity
        ? this.connectivity
        : { status: "disconnected", message: "未配对或授权已过期。" };
    let selected: ProjectView | undefined;
    let readinessAt: number | undefined;
    if (paired) {
      try {
        const client = this.client(state);
        if (inspect) {
          if (
            currentBound &&
            state.binding?.installationId &&
            !state.pairing &&
            this.native &&
            (await this.native.identity()) !== state.binding.installationId
          )
            throw new Error("Local authorization changed. Reconnect and explicitly bind again.");
          await client.call("projects.list", undefined);
          this.connectivity = { status: "connected", message: "本机 Daemon 已连接且授权有效。" };
          connectivity = this.connectivity;
        }
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
          if (
            inspect &&
            (this.readiness?.projectId !== projectId || Date.now() - this.readiness.at > 30000)
          ) {
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
            if (
              currentBound &&
              state.binding?.projectId === projectId &&
              (view.project.root !== state.binding.projectRoot || view.authorized === false)
            )
              throw new Error(
                "Project authorization expired or location changed. Bind explicitly again.",
              );
            this.readiness = { projectId, at: Date.now(), view };
          }
          if (this.readiness?.projectId === projectId) {
            selected = this.readiness.view;
            readinessAt = this.readiness.at;
          }
        }
        if (
          inspect &&
          currentBound &&
          state.binding?.runId &&
          !["completed", "failed", "cancelled"].includes(state.binding.runStatus ?? "")
        ) {
          const before = JSON.stringify(state.binding);
          const run = await client.call("runs.get", {
            projectId: state.binding.projectId,
            runId: state.binding.runId,
          });
          this.observeRun(state.binding, run);
          const latest = (await this.host.read()).binding;
          if (
            JSON.stringify(state.binding) !== before &&
            latest?.id === state.binding.id &&
            latest.phase === state.binding.phase &&
            latest.epoch === state.binding.epoch
          )
            await this.host.save(state);
        }
      } catch (error) {
        connectivity = {
          status: "unavailable",
          message: error instanceof Error ? error.message : "本机请求失败。",
        };
        this.connectivity = connectivity;
      }
    }
    let binding = currentBound ? state.binding : undefined;
    if (inspect && binding && tab.id !== undefined) {
      try {
        let page: unknown;
        try {
          page = await this.host.send(tab.id, { type: "probe" });
        } catch {
          /* Recover a known binding below. */
        }
        const mayRestore =
          binding.installationId &&
          binding.bootstrapped &&
          !binding.pausedByUser &&
          binding.phase !== "stopped" &&
          binding.phase !== "delivering" &&
          (binding.phase !== "paused" ||
            binding.admission?.confirmed === false ||
            binding.resumePhase === "running" ||
            (["pending", "submitting"].includes(binding.review?.phase ?? "") &&
              binding.lastResult?.delivery === "confirmed"));
        if (
          mayRestore &&
          selected?.readiness.ready &&
          connectivity.status === "connected" &&
          (!object(page) ||
            page.bindingId !== binding.id ||
            binding.phase === "paused" ||
            binding.attached === false)
        ) {
          // Restore only an already-authorized current conversation. prepare reads identity;
          // arm(restore) attaches observers without sending another bootstrap or dispatch.
          const prepared = await this.host.send(tab.id, { type: "prepare", conversation });
          const restored = await this.restore(state, prepared, { url: tab.url, tabId: tab.id });
          if (restored.restored && "binding" in restored) {
            await this.host.send(tab.id, { type: "arm", binding: restored.binding, restore: true });
            binding = state.binding;
            page = await this.host.send(tab.id, { type: "probe" });
          }
        }
        if (!binding) throw new Error("绑定已取消。");
        const matches =
          object(page) &&
          page.conversation === conversation &&
          page.epoch === binding.epoch &&
          page.bindingId === binding.id;
        this.receiver = {
          bindingId: binding.id,
          epoch: binding.epoch,
          status: !matches
            ? "unavailable"
            : object(page) && page.buildId === BUILD_ID
              ? "confirmed"
              : "different_build",
          ...(object(page) && typeof page.buildId === "string" ? { buildId: page.buildId } : {}),
        };
      } catch {
        if (binding)
          this.receiver = { bindingId: binding.id, epoch: binding.epoch, status: "unavailable" };
      }
    }
    // A slow readiness/receiver check must not label a newly selected tab as ready.
    const latestTab = await this.host.activeTab();
    if (latestTab.id !== tab.id || conversationUrl(latestTab.url ?? "") !== conversation) {
      currentBound = false;
      binding = undefined;
    }
    const receiver =
      this.receiver?.bindingId === binding?.id && this.receiver?.epoch === binding?.epoch
        ? this.receiver
        : undefined;
    const reason: BridgeReadiness["reason"] = !binding
      ? "unbound"
      : ["paused", "stopped"].includes(binding.phase)
        ? "paused"
        : connectivity.status !== "connected"
          ? "connecting"
          : !binding.bootstrapped
            ? "bootstrap"
            : !selected?.readiness.ready || selected.project.root !== binding.projectRoot
              ? "project"
              : binding.attached !== true || receiver?.status !== "confirmed"
                ? "page"
                : "ready";
    const readiness: BridgeReadiness = {
      ready: reason === "ready",
      reason,
      receiver: receiver?.status ?? "unknown",
      buildId: BUILD_ID,
      ...(receiver?.buildId ? { pageBuildId: receiver.buildId } : {}),
    };
    return {
      readiness,
      transport: state.pairing || state.transport === "http" ? "http" : "native",
      paired,
      expiresAt: state.pairing?.expiresAt,
      connectivity,
      conversation,
      tabId: tab.id,
      currentBound,
      enabled: currentBound && !["paused", "stopped"].includes(state.binding?.phase ?? "stopped"),
      binding: state.binding ? { ...state.binding, delivery: undefined } : undefined,
      selected: selected ? { project: selected.project, readiness: selected.readiness } : undefined,
      readinessAt,
    };
  }
  private client(state: SessionState) {
    if (state.pairing) return new LocalClient(parsePairing(state.pairing), this.request);
    if (this.native && state.transport !== "http") return this.native;
    throw new Error("请先导入本机 daemon 配对文件。");
  }
  private async restore(state: SessionState, value: unknown, sender: Sender) {
    const actionEpoch = this.actionEpoch;
    const conversation = conversationUrl(sender.url ?? "");
    if (
      !conversation ||
      sender.tabId === undefined ||
      !object(value) ||
      typeof value.epoch !== "string"
    )
      throw new Error("页面恢复身份无效。");
    const binding =
      state.bindings?.[conversation] ??
      (state.binding?.conversation === conversation ? state.binding : undefined);
    if (!binding?.installationId || !this.native || state.pairing || state.transport === "http")
      return { restored: false };
    if (binding.tabId !== sender.tabId) {
      const owner = await this.host.tab(binding.tabId).catch(() => ({}));
      if ("url" in owner && conversationUrl(owner.url ?? "") === conversation)
        throw new Error("该对话已在另一个标签页启用；请先关闭原标签页。");
    }
    const current = await this.host.tab(sender.tabId);
    if (conversationUrl(current.url ?? "") !== conversation) throw new Error("恢复时会话已变化。");
    if (actionEpoch !== this.actionEpoch) return { restored: false };
    const reconcilable =
      !!binding.admission &&
      !!binding.runId &&
      (binding.phase === "dispatching" ||
        (binding.phase === "paused" &&
          (!binding.admission.confirmed || binding.resumePhase === "running")));
    const reconcileReview =
      ["pending", "submitting"].includes(binding.review?.phase ?? "") &&
      binding.lastResult?.delivery === "confirmed";
    // Older local receipts did not distinguish a human-decision stop from Cancel.
    // Recover that display/control metadata from the immutable Project review only.
    if (
      binding.phase === "stopped" &&
      binding.review?.phase === "recorded" &&
      binding.review.needsDecision === undefined &&
      binding.lastResult?.delivery === "confirmed"
    ) {
      const target = binding.review;
      const saved = await this.native.call("reviews.get", {
        projectId: binding.projectId,
        runId: target.runId,
      });
      if (
        isProjectReview(saved) &&
        saved.id === target.id &&
        saved.projectId === binding.projectId &&
        saved.runId === target.runId &&
        saved.resultId === target.resultId &&
        saved.handoffId === target.handoffId
      )
        target.needsDecision = saved.verdict === "needs_input" || saved.nextAction === "wait";
    }
    if (
      binding.pausedByUser ||
      (binding.phase === "paused" && !reconcilable && !reconcileReview) ||
      binding.phase === "stopped"
    ) {
      binding.tabId = sender.tabId;
      binding.epoch = value.epoch;
      // A background page may reload an old paused conversation. Updating that
      // routing record must not evict the binding currently executing in another tab.
      state.bindings = { ...state.bindings, [conversation]: binding };
      if (!state.binding || state.binding.id === binding.id) state.binding = binding;
      await this.host.save(state);
      return { restored: false };
    }
    try {
      if (value.buildId !== BUILD_ID)
        throw new Error("页面与扩展构建版本不一致；请刷新当前对话。没有发送任务。");
      if (
        !binding.bootstrapped ||
        binding.phase === "delivering" ||
        (binding.phase === "dispatching" && !reconcilable)
      )
        throw new Error("上次发送未确认；请检查当前对话和 Project 证据，不会自动重发。");
      if ((await this.native.identity()) !== binding.installationId)
        throw new Error("本机授权已变化，请显式重新绑定。");
      if (
        binding.nativeConversation &&
        (!isNativeConversation(binding.nativeConversation) ||
          binding.nativeConversation.root !== binding.projectRoot)
      )
        throw new Error("保存的 Codex 对话与项目不匹配，请重新绑定。");
      const view = await this.native.call("projects.get", { projectId: binding.projectId });
      if (
        !object(view) ||
        view.authorized !== true ||
        !object(view.project) ||
        view.project.id !== binding.projectId ||
        view.project.root !== binding.projectRoot ||
        !object(view.readiness) ||
        view.readiness.ready !== true
      )
        throw new Error("Project 身份、路径或 Codex readiness 已变化。");
      if (actionEpoch !== this.actionEpoch) return { restored: false };
      this.readiness = {
        projectId: binding.projectId,
        at: Date.now(),
        view: view as unknown as ProjectView,
      };
      if (reconcilable) await this.reconcileAdmission(binding, this.native);
      const legacyReview = !binding.review;
      if (
        !binding.review &&
        binding.runId &&
        binding.lastResult?.runId === binding.runId &&
        binding.lastResult.delivery === "confirmed"
      ) {
        // Upgrade routing from an older extension using exact persisted result identity;
        // no old assistant messages are read, submitted or replayed.
        const data = await this.native.call("results.get", {
          projectId: binding.projectId,
          runId: binding.runId,
        });
        if (
          !object(data) ||
          !isProjectExecutionResult(data.result) ||
          data.result.projectId !== binding.projectId ||
          data.result.runId !== binding.runId
        )
          throw new Error("执行结果缺失或身份不匹配；请检查本机证据。");
        binding.review = {
          id: crypto.randomUUID(),
          runId: data.result.runId,
          resultId: data.result.id,
          handoffId: data.result.handoffId,
          at: new Date().toISOString(),
          phase: "pending",
        };
      }
      if (binding.review && binding.lastResult?.delivery === "confirmed") {
        // Read-only reconciliation: after a lost reply never resubmit the review body.
        const target = binding.review;
        const saved = await this.native.call("reviews.get", {
          projectId: binding.projectId,
          runId: target.runId,
        });
        if (
          saved !== null &&
          (!isProjectReview(saved) ||
            saved.projectId !== binding.projectId ||
            saved.runId !== target.runId ||
            saved.resultId !== target.resultId ||
            (saved.handoffId !== undefined && saved.handoffId !== target.handoffId) ||
            (!legacyReview && saved.id !== target.id))
        )
          throw new Error("审查保存响应身份不匹配；请检查 Project 记录。");
        if (saved) {
          if (legacyReview && isProjectReview(saved)) {
            target.id = saved.id;
            target.at = saved.provenance.at;
          }
          target.phase = "recorded";
          target.needsDecision =
            isProjectReview(saved) &&
            (saved.verdict === "needs_input" || saved.nextAction === "wait");
          checkpoint(binding, "reviewed", target.id);
          if (
            !target.decisionAcknowledged &&
            isProjectReview(saved) &&
            (saved.verdict === "needs_input" || saved.nextAction === "wait")
          ) {
            binding.phase = "stopped";
            binding.message = "审查需要你的决定；自动桥接已停止。";
          } else if (reconcileReview && binding.phase === "paused") {
            binding.phase = "armed";
            binding.message = "已从 Project 确认审查已保存，没有重复提交。";
          }
        } else if (target.phase !== "pending")
          throw new Error("审查提交未确认，请检查 Project 记录；不会重发。");
        else if (reconcileReview && binding.phase === "paused") {
          // No review write was attempted. Reattach only to future assistant turns;
          // never collect or replay the previously rejected review from page history.
          binding.phase = "armed";
          binding.message = "结果已确认回传，等待新的合规审查。没有重发或执行历史内容。";
        }
      }
      if (binding.phase === "ready_to_deliver" && !binding.delivery) binding.phase = "running";
      if (conversationUrl((await this.host.tab(sender.tabId)).url ?? "") !== conversation)
        throw new Error("恢复时会话已变化。");
      if (state.binding && state.binding.id !== binding.id)
        await this.host.send(state.binding.tabId, { type: "disarm" }).catch(() => {});
      if (actionEpoch !== this.actionEpoch) return { restored: false };
      binding.tabId = sender.tabId;
      binding.epoch = value.epoch;
      binding.attached = true;
      binding.resumePhase = undefined;
      this.receiver = {
        bindingId: binding.id,
        epoch: binding.epoch,
        status: "confirmed",
        buildId: BUILD_ID,
      };
      state.binding = binding;
      await this.host.save(state);
      return { restored: binding.phase !== "stopped", binding };
    } catch (error) {
      if (actionEpoch !== this.actionEpoch) return { restored: false };
      binding.phase = "paused";
      binding.attached = false;
      binding.message = error instanceof Error ? error.message : "恢复失败，请检查 Diagnostics。";
      state.binding = binding;
      await this.host.save(state);
      return { restored: false };
    }
  }
  async detached(tabId: number) {
    const state = await this.host.read();
    if (state.binding?.tabId !== tabId) return;
    const binding = state.binding;
    binding.attached = false;
    if (
      !binding.installationId ||
      !binding.bootstrapped ||
      binding.phase === "delivering" ||
      (binding.phase === "dispatching" && !binding.admission)
    ) {
      binding.phase = "paused";
      binding.delivery = undefined;
      if (binding.lastResult?.delivery === "pending") binding.lastResult.delivery = "stopped";
      binding.message = "页面切换，发送状态不确定；请检查当前对话，未自动重发。";
    }
    await this.host.save(state);
    await this.host.send(tabId, { type: "disarm" }).catch(() => {});
  }
}
