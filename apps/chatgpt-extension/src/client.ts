import { isDaemonResponse, type DaemonMethod, type DaemonOperations } from "@veyraoss/protocol";
import { object, type Pairing } from "./contracts.js";

export class LocalClient {
  constructor(
    private readonly pairing: Pairing,
    private readonly request: typeof fetch = (...args) => globalThis.fetch(...args),
  ) {}
  async call<M extends DaemonMethod>(
    method: M,
    params: DaemonOperations[M]["input"],
  ): Promise<unknown> {
    if (this.pairing.expiresAt <= Date.now()) throw new Error("Daemon 配对已过期，请重新配对。");
    const response = await this.request(`${this.pairing.url}/rpc`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.pairing.token}`,
      },
      body: JSON.stringify({ version: 1, method, ...(params === undefined ? {} : { params }) }),
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      signal: AbortSignal.timeout(12000),
    });
    if (!response.body) throw new Error("Daemon 返回空响应。");
    const reader = response.body.getReader();
    let bytes = 0;
    const chunks: Uint8Array[] = [];
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        bytes += part.value.length;
        if (bytes > 256 * 1024) throw new Error("Daemon 响应超出上限。");
        chunks.push(part.value);
      }
    } finally {
      await reader.cancel();
    }
    const all = new Uint8Array(bytes);
    let offset = 0;
    for (const chunk of chunks) {
      all.set(chunk, offset);
      offset += chunk.length;
    }
    const data: unknown = JSON.parse(new TextDecoder().decode(all));
    if (!response.ok || !object(data) || data.ok !== true)
      throw new Error(
        object(data) && object(data.error) && typeof data.error.message === "string"
          ? data.error.message.slice(0, 512)
          : "本机 daemon 请求失败。",
      );
    if (
      !["projects.get", "results.get"].includes(method) &&
      !isDaemonResponse({ version: 1, ok: true, result: data.data }, method)
    )
      throw new Error("Daemon 返回不符合协议的结果。");
    return data.data;
  }
}
