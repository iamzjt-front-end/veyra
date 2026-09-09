import { isDaemonResponse, type DaemonMethod, type DaemonOperations } from "@veyraoss/protocol";
import { object, parsePairing, type Pairing, type PairingInvitation } from "./contracts.js";

export async function exchangePairing(invitation: PairingInvitation, request: typeof fetch) {
  const grant = parsePairing(
    await localRequest(invitation.url, "/pair", { version: 1, code: invitation.code }, request),
  );
  if (
    grant.url !== invitation.url ||
    grant.origin !== invitation.origin ||
    [...grant.projectIds].sort().join() !== [...invitation.projectIds].sort().join()
  )
    throw new Error("Daemon 返回的授权范围与用户确认的邀请不一致。");
  return grant;
}

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
    if (params && "projectId" in params && !this.pairing.projectIds.includes(params.projectId))
      throw new Error("Project 不在本地授权范围内。");
    const data = await localRequest(
      this.pairing.url,
      "/rpc",
      { version: 1, method, ...(params === undefined ? {} : { params }) },
      this.request,
      this.pairing.token,
    );
    return validateReply(method, data);
  }
  async revoke(_projectId?: string) {
    const data = await localRequest(
      this.pairing.url,
      "/grant/revoke",
      { version: 1 },
      this.request,
      this.pairing.token,
    );
    if (!object(data) || data.revoked !== true) throw new Error("本地授权撤销未确认。");
  }
}

async function localRequest(
  url: string,
  path: "/rpc" | "/pair" | "/grant/revoke",
  body: unknown,
  request: typeof fetch,
  token?: string,
): Promise<unknown> {
  const response = await request(`${url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
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
  return data.data;
}

export function validateReply(method: DaemonMethod, data: unknown): unknown {
  const checked =
    method === "runs.get" && object(data)
      ? (({ execution: _execution, ...run }) => run)(data)
      : data;
  if (
    !["projects.get", "results.get"].includes(method) &&
    !isDaemonResponse({ version: 1, ok: true, result: checked }, method)
  )
    throw new Error("Daemon 返回不符合协议的结果。");
  return data;
}
