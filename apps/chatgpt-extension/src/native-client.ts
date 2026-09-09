import type { DaemonMethod, DaemonOperations } from "@veyraoss/protocol";
import { object } from "./contracts.js";
import { validateReply } from "./client.js";
export const NATIVE_HOST = "com.veyraoss.bridge";
export interface NativeTransport {
  identity(): Promise<string>;
  call<M extends DaemonMethod>(method: M, params: DaemonOperations[M]["input"]): Promise<unknown>;
  authorize(projectId: string): Promise<void>;
  revoke(projectId?: string): Promise<void>;
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
  identity(): Promise<string> {
    if (this.port && this.installationId) return Promise.resolve(this.installationId);
    this.connecting ??= this.open().finally(() => {
      this.connecting = undefined;
    });
    return this.connecting;
  }
  private async open() {
    const port = this.connect();
    this.port = port;
    port.onMessage.addListener((value) => {
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
      if (this.port === port) this.close(message ?? "本机连接已断开；不确定操作不会重试。");
    });
    const hello = await this.request("hello");
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
  private close(message = "本机连接已休眠。") {
    clearTimeout(this.idle);
    const port = this.port;
    this.port = undefined;
    this.installationId = undefined;
    for (const item of this.pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(message));
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
    await this.identity();
    return validateReply(method, await this.request(method, params));
  }
  async authorize(projectId: string) {
    await this.identity();
    await this.request("projects.authorize", { projectId });
  }
  async revoke(projectId?: string) {
    if (!projectId) throw new Error("请选择要撤销授权的 Project。");
    await this.identity();
    await this.request("projects.revoke", { projectId });
  }
}
