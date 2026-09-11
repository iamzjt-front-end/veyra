import {
  isNativeConversation,
  isProjectDescriptor,
  type NativeConversation,
  type DaemonMethod,
  type DaemonOperations,
} from "@veyraoss/protocol";
import { object } from "./contracts.js";
import { validateReply } from "./client.js";
export const NATIVE_HOST = "com.veyraoss.bridge";
class NativeDisconnect extends Error {}
const readMethods = new Set<DaemonMethod>([
  "projects.list",
  "projects.get",
  "runs.get",
  "handoffs.get",
  "results.get",
  "reviews.get",
]);
const reconnectDelay = () => new Promise<void>((resolve) => setTimeout(resolve, 200));
export interface NativeTransport {
  identity(): Promise<string>;
  call<M extends DaemonMethod>(method: M, params: DaemonOperations[M]["input"]): Promise<unknown>;
  authorize(projectId: string): Promise<void>;
  revoke(projectId?: string): Promise<void>;
  openControl?(projectId: string, runId?: string): Promise<unknown>;
  listConversations?(query: { cursor?: string; search?: string }): Promise<unknown>;
  selectConversation?(selected: NativeConversation): Promise<unknown>;
  checkConversation?(selected: NativeConversation, projectId: string): Promise<void>;
}
/** A short-lived native port; no idle keepalive and no replay of uncertain writes. */
export class NativeClient implements NativeTransport {
  private port?: chrome.runtime.Port;
  private connecting?: Promise<string>;
  private installationId?: string;
  private idle?: ReturnType<typeof setTimeout>;
  private pending = new Map<
    string,
    {
      resolve: (value: unknown) => void;
      reject: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  constructor(private readonly connect = () => chrome.runtime.connectNative(NATIVE_HOST)) {}
  async listConversations(query: { cursor?: string; search?: string }) {
    await this.identity();
    const result = await this.request("codex.conversations.list", query);
    if (
      !object(result) ||
      !Array.isArray(result.conversations) ||
      result.conversations.length > 30 ||
      !result.conversations.every(isNativeConversation) ||
      (result.cursor !== null && (typeof result.cursor !== "string" || result.cursor.length > 4096))
    )
      throw new Error("Invalid Codex task listing.");
    return result;
  }
  async selectConversation(selected: NativeConversation) {
    await this.identity();
    const result = await this.request("codex.conversations.select", selected);
    if (
      !object(result) ||
      !isProjectDescriptor(result.project) ||
      !isNativeConversation(result.conversation) ||
      result.conversation.id !== selected.id ||
      result.conversation.root !== result.project.root
    )
      throw new Error("Codex task selection was not confirmed.");
    return result;
  }
  async checkConversation(selected: NativeConversation, projectId: string) {
    await this.identity();
    const result = await this.request("codex.conversations.check", {
      conversation: selected,
      projectId,
    });
    if (
      !object(result) ||
      result.ready !== true ||
      !isNativeConversation(result.conversation) ||
      result.conversation.id !== selected.id ||
      result.conversation.root !== selected.root
    )
      throw new Error("Codex task readiness was not confirmed.");
  }
  identity(): Promise<string> {
    if (this.port && this.installationId) return Promise.resolve(this.installationId);
    this.connecting ??= this.openWithRecovery().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async openWithRecovery() {
    try {
      return await this.open();
    } catch (error) {
      // Hello has no execution/grant authority. Recover one transient port loss only;
      // protocol, timeout and authorization failures remain explicit failures.
      if (!(error instanceof NativeDisconnect)) throw error;
      await reconnectDelay();
      return this.open();
    }
  }
  private async open() {
    const port = this.connect();
    this.port = port;
    port.onMessage.addListener((value) => {
      if (this.port !== port) return;
      if (
        !object(value) ||
        typeof value.id !== "string" ||
        value.version !== 1 ||
        new TextEncoder().encode(JSON.stringify(value)).length > 256 * 1024
      ) {
        this.close("Native response invalid.");
        return;
      }
      const request = this.pending.get(value.id);
      if (!request) {
        this.close("Native response identity mismatch.");
        return;
      }
      this.pending.delete(value.id);
      clearTimeout(request.timer);
      if (value.ok === true) request.resolve(value.data);
      else
        request.reject(new Error(typeof value.error === "string" ? value.error : "本机连接失败。"));
      this.scheduleClose();
    });
    port.onDisconnect.addListener(() => {
      const message = chrome.runtime.lastError?.message;
      if (this.port === port) this.close(message ?? "本机连接已断开；不确定操作不会重试。", true);
    });
    const hello = await this.request("hello");
    if (this.port !== port) throw new NativeDisconnect("本机连接已断开。");
    if (
      !object(hello) ||
      hello.version !== 1 ||
      typeof hello.installationId !== "string" ||
      !/^[a-f0-9-]{36}$/.test(hello.installationId)
    ) {
      this.close("Invalid native handshake.");
      throw new Error("请运行一次 ve setup，再打开 Veyra。");
    }
    this.installationId = hello.installationId;
    return hello.installationId;
  }
  private scheduleClose() {
    clearTimeout(this.idle);
    if (!this.pending.size) this.idle = setTimeout(() => this.close(), 5000);
  }
  private close(message = "本机连接已休眠。", disconnected = false) {
    clearTimeout(this.idle);
    const port = this.port;
    this.port = undefined;
    this.installationId = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(disconnected ? new NativeDisconnect(message) : new Error(message));
    }
    this.pending.clear();
    port?.disconnect();
  }
  private request(method: string, params?: unknown): Promise<unknown> {
    clearTimeout(this.idle);
    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => this.close("本机请求未确认，请检查 Diagnostics；不会自动重发。"),
        40000,
      );
      this.pending.set(id, { resolve, reject, timer });
      try {
        const message = {
          version: 1,
          id,
          method,
          ...(params === undefined ? {} : { params }),
          ...(this.installationId ? { installationId: this.installationId } : {}),
        };
        if (new TextEncoder().encode(JSON.stringify(message)).length > 256 * 1024)
          throw new Error("Native request exceeds limit.");
        if (!this.port) throw new Error("请运行一次 ve setup，再打开 Veyra。");
        this.port.postMessage(message);
      } catch (error) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(error);
        this.scheduleClose();
      }
    });
  }
  async call<M extends DaemonMethod>(method: M, params: DaemonOperations[M]["input"]) {
    const identity = await this.identity();
    try {
      return validateReply(method, await this.request(method, params));
    } catch (error) {
      // A lost read can be retried once with the same installation. Dispatch, cancel,
      // approval, registration and grant mutations never enter this recovery path.
      if (!(error instanceof NativeDisconnect) || !readMethods.has(method)) throw error;
      await reconnectDelay();
      if ((await this.identity()) !== identity)
        throw new Error("Local authorization changed. Reconnect and explicitly bind again.");
      return validateReply(method, await this.request(method, params));
    }
  }
  async authorize(projectId: string) {
    await this.identity();
    await this.request("projects.authorize", { projectId });
  }
  async openControl(projectId: string, runId?: string) {
    await this.identity();
    return this.request("control.open", { projectId, ...(runId ? { runId } : {}) });
  }
  async revoke(projectId?: string) {
    if (!projectId) throw new Error("请选择要撤销授权的 Project。");
    await this.identity();
    await this.request("projects.revoke", { projectId });
  }
}
