import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { NativeTransport } from "../src/native-client.js";
import { BridgeController, type ExtensionHost, type SessionState } from "../src/controller.js";
import { EXTENSION_ORIGIN, frameHandoff, handoffTemplate } from "../src/contracts.js";
import type { ProjectId } from "@veyraoss/protocol";

const projectId = "62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId;
const conversation = `https://chatgpt.com/c/${randomUUID()}`;
const popup = { url: `${EXTENSION_ORIGIN}/popup.html` };
function fixture(native?: NativeTransport) {
  let state: SessionState = {
    pairing: {
      version: 1,
      url: "http://127.0.0.1:3181",
      origin: EXTENSION_ORIGIN,
      token: "f".repeat(64),
      expiresAt: Date.now() + 100000,
      projectIds: [projectId],
    },
  };
  let url = conversation;
  let status = "completed";
  const host: ExtensionHost = {
    read: async () => structuredClone(state),
    save: async (next) => {
      state = structuredClone(next);
    },
    activeTab: async () => ({ id: 10, url }),
    tab: async () => ({ id: 10, url }),
    send: vi.fn(async (_id, data) =>
      (data as { type: string }).type === "prepare"
        ? { epoch: "epoch", conversation: url }
        : { ok: true },
    ),
  };
  const calls: string[] = [];
  const request = vi.fn<typeof fetch>(async (target, options) => {
    expect(String(target)).toBe("http://127.0.0.1:3181/rpc");
    expect(options?.credentials).toBe("omit");
    expect(options?.redirect).toBe("error");
    const body = JSON.parse(String(options?.body));
    calls.push(body.method);
    const now = new Date().toISOString();
    let data: unknown;
    if (body.method === "projects.get")
      data = {
        project: { id: projectId, name: "Fixture", root: "/disposable/fixture" },
        readiness: { ready: true, message: "Native ready", checks: [] },
        sharedState: null,
      };
    else if (body.method === "results.get")
      data = {
        result: {
          version: 1,
          kind: "result",
          id: randomUUID(),
          projectId,
          runId: body.params.runId,
          handoffId: body.params.runId,
          status: "failed",
          summary: "Actual test failed",
          changedFiles: ["answer.txt"],
          evidence: [],
          artifacts: [],
          provenance: {
            role: "executor",
            surface: "fixture",
            actor: "fixture",
            at: now,
            contentTrust: "untrusted",
          },
        },
        verificationEvidence: [{ success: false, results: [{ exitCode: 1 }] }],
      };
    else if (body.method === "projects.list") data = [];
    else
      data = {
        version: 1,
        projectId,
        runId: body.params.runId ?? body.params.handoff.runId,
        status: body.method === "runs.dispatch" ? "queued" : status,
        createdAt: now,
        updatedAt: now,
      };
    return new Response(JSON.stringify({ ok: true, data }), { status: 200 });
  });
  const controller = new BridgeController(host, request, native);
  const bind = async (maxRuns = 2) =>
    controller.handle({ type: "bind", projectId, maxRuns }, popup);
  const message = (
    type: string,
    extra: Record<string, unknown> = {},
    sender = { url, tabId: 10 },
  ) => controller.handle({ type, epoch: "epoch", bindingId: state.binding?.id, ...extra }, sender);
  const dispatch = () => {
    if (!state.binding) throw new Error("Missing binding");
    return message("dispatch", { source: frameHandoff(handoffTemplate(state.binding)) });
  };
  return {
    controller,
    host,
    request,
    calls,
    bind,
    message,
    dispatch,
    state: () => state,
    navigate: () => {
      url = `https://chatgpt.com/c/${randomUUID()}`;
    },
    status: (value: string) => {
      status = value;
    },
  };
}

describe("session-local extension coordination", () => {
  it("renders popup change notifications from snapshots without daemon reads or state write feedback", async () => {
    const f = fixture();
    await f.bind();
    await f.dispatch();
    await f.controller.handle({ type: "status" }, popup);
    f.calls.length = 0;
    const saved = vi.spyOn(f.host, "save");
    for (let n = 0; n < 100; n++)
      expect(await f.controller.handle({ type: "snapshot" }, popup)).toMatchObject({
        currentBound: true,
        selected: { readiness: { ready: true } },
      });
    expect(f.calls).toEqual([]);
    expect(saved).not.toHaveBeenCalled();
  });

  it("shows current Project path, daemon/native/run status and never presents another conversation as bound", async () => {
    const f = fixture();
    await f.bind();
    await f.dispatch();
    const current = await f.controller.handle({ type: "status" }, popup);
    expect(current).toMatchObject({
      currentBound: true,
      enabled: true,
      connectivity: { status: "connected" },
      selected: { readiness: { ready: true } },
      binding: {
        projectName: "Fixture",
        projectRoot: "/disposable/fixture",
        runStatus: "completed",
      },
    });
    expect(JSON.stringify(current)).not.toContain("f".repeat(64));
    f.navigate();
    expect(await f.controller.handle({ type: "status" }, popup)).toMatchObject({
      currentBound: false,
      enabled: false,
    });
    f.request.mockRejectedValueOnce(new Error("Daemon unavailable"));
    expect(await f.controller.handle({ type: "status" }, popup)).toMatchObject({
      connectivity: { status: "unavailable" },
    });
  });
  it("requires markers even at the worker boundary and disables bridging without pretending to cancel", async () => {
    const f = fixture();
    await f.bind();
    const binding = f.state().binding;
    if (!binding) throw new Error("Missing binding");
    await expect(
      f.message("dispatch", { source: JSON.stringify(handoffTemplate(binding)) }),
    ).rejects.toThrow("边界");
    await f.dispatch();
    await f.controller.handle({ type: "disable" }, popup);
    expect(f.state().binding).toMatchObject({ phase: "stopped" });
    expect(f.calls).not.toContain("runs.cancel");
    expect(f.state().binding?.message).toContain("继续执行");
  });
  it("pairs only through the popup, revokes before dropping the grant and preserves it on uncertain revocation", async () => {
    const f = fixture();
    const grant = f.state().pairing;
    if (!grant) throw new Error("Missing grant");
    f.request.mockImplementationOnce(async (url) => {
      expect(String(url).endsWith("/pair")).toBe(true);
      return new Response(JSON.stringify({ ok: true, data: grant }));
    });
    const { token, ...base } = grant;
    await f.controller.handle({ type: "pair", pairing: { ...base, code: token } }, popup);
    f.request.mockRejectedValueOnce(new Error("Connection uncertain"));
    await expect(f.controller.handle({ type: "unpair" }, popup)).rejects.toThrow("uncertain");
    expect(f.state().pairing).toEqual(grant);
    f.request.mockImplementationOnce(async (url, options) => {
      expect(String(url).endsWith("/grant/revoke")).toBe(true);
      expect(options?.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      return new Response(JSON.stringify({ ok: true, data: { revoked: true } }));
    });
    await f.controller.handle({ type: "unpair" }, popup);
    expect(f.state().pairing).toBeUndefined();
  });
  it("retains a disconnected HTTP fallback after revocation instead of implicitly using native authorization", async () => {
    const native = {
      identity: vi.fn(async () => randomUUID()),
      call: vi.fn(),
      authorize: vi.fn(),
      revoke: vi.fn(),
    };
    const f = fixture(native);
    await f.bind();
    f.request.mockImplementationOnce(
      async () => new Response(JSON.stringify({ ok: true, data: { revoked: true } })),
    );
    // Prevent a run cancellation request; this binding has not dispatched.
    await f.controller.handle({ type: "unpair" }, popup);
    expect(await f.controller.handle({ type: "status" }, popup)).toMatchObject({
      transport: "http",
      paired: false,
      enabled: false,
    });
    expect(native.call).not.toHaveBeenCalled();
  });
  it("requires explicit popup binding and rejects another tab, epoch, Project or stale lease", async () => {
    const f = fixture();
    await expect(f.message("dispatch", { source: "{}" })).rejects.toThrow("绑定权限");
    await f.bind();
    await expect(f.message("poll", {}, { url: conversation, tabId: 11 })).rejects.toThrow(
      "绑定权限",
    );
    await expect(f.message("poll", { epoch: "another-document" })).rejects.toThrow("绑定权限");
    const binding = f.state().binding;
    if (!binding) throw new Error("Missing binding");
    for (const change of [{ projectId: randomUUID() }, { runId: randomUUID() }])
      await expect(
        f.message("dispatch", {
          source: frameHandoff({ ...handoffTemplate(binding), ...change }),
        }),
      ).rejects.toThrow("不匹配");
    expect(f.calls).not.toContain("runs.dispatch");
    expect(JSON.stringify((f.host.send as ReturnType<typeof vi.fn>).mock.calls)).not.toContain(
      "f".repeat(64),
    );
  });
  it("deduplicates dispatch, hands back actual failure, requires delivery acknowledgement and bounds repairs", async () => {
    const f = fixture();
    await f.bind(2);
    for (let iteration = 0; iteration < 2; iteration++) {
      await f.dispatch();
      await expect(f.dispatch()).rejects.toThrow("不能继续");
      await f.message("poll");
      expect(f.state().binding?.phase).toBe("ready_to_deliver");
      const claim = (await f.message("claim")) as { delivery: { id: string; text: string } };
      expect(claim.delivery.text).toContain('"exitCode":1');
      expect(claim.delivery.text).toContain('"status":"failed"');
      expect(claim.delivery.text).toContain("VEYRA_RESULT_BEGIN\n");
      expect(claim.delivery.text).toContain("\nVEYRA_RESULT_END");
      expect(claim.delivery.text).toContain("请作为 Reviewer");
      expect(claim.delivery.text).toContain("VEYRA_REVIEW_BEGIN");
      expect(claim.delivery.text).toContain("不是用户的新任务");
      expect(claim.delivery.text).not.toContain("f".repeat(64));
      expect(await f.message("claim")).not.toHaveProperty("delivery");
      await f.message("ack", { deliveryId: "wrong" });
      expect(f.state().binding?.phase).toBe("delivering");
      await f.message("ack", { deliveryId: claim.delivery.id });
    }
    expect(f.state().binding?.phase).toBe("stopped");
    expect(f.state().binding?.lastResult).toMatchObject({
      status: "failed",
      delivery: "confirmed",
    });
    expect(f.state().binding?.runId).toBeTruthy();
    expect(f.calls.filter((method) => method === "runs.dispatch")).toHaveLength(2);
    await f.dispatch();
    expect(f.calls.filter((method) => method === "runs.dispatch")).toHaveLength(2);
  });
  it("preserves a result while the composer is busy and does not deliver after navigation or restart", async () => {
    const f = fixture();
    await f.bind();
    await f.dispatch();
    await f.message("poll");
    for (let n = 0; n < 3; n++) await f.message("poll");
    expect(f.state().binding?.phase).toBe("ready_to_deliver");
    const claim = (await f.message("claim")) as { delivery: { id: string } };
    await f.message("defer", { deliveryId: claim.delivery.id });
    expect(f.state().binding?.phase).toBe("ready_to_deliver");
    f.navigate();
    await expect(f.message("claim")).rejects.toThrow("绑定权限");
    await f.controller.detached(10);
    expect(f.state().binding?.phase).toBe("paused");
    expect(f.state().binding?.delivery).toBeUndefined();
    const fresh = new BridgeController(f.host, f.request);
    await expect(
      fresh.handle(
        { type: "poll", epoch: "new-epoch", bindingId: f.state().binding?.id },
        { url: conversation, tabId: 10 },
      ),
    ).rejects.toThrow();
  });
  it("does not replay ambiguous dispatch and never approves human gates", async () => {
    const f = fixture();
    await f.bind();
    f.request.mockRejectedValueOnce(new Error("Connection lost after dispatch"));
    await f.dispatch();
    expect(f.state().binding?.phase).toBe("paused");
    await f.message("poll");
    expect(f.request).toHaveBeenCalledTimes(2);
    const gate = fixture();
    await gate.bind();
    await gate.dispatch();
    gate.status("paused");
    await gate.message("poll");
    expect(gate.state().binding?.message).toContain("审批");
    expect(gate.calls).not.toContain("results.get");
  });
  it("stops local dispatch and return before sending scoped cancellation", async () => {
    const f = fixture();
    await f.bind();
    await f.dispatch();
    await f.controller.handle({ type: "stop" }, popup);
    expect(f.state().binding?.phase).toBe("stopped");
    expect(f.calls.at(-1)).toBe("runs.cancel");
    await f.message("poll");
    expect(f.calls.at(-1)).toBe("runs.cancel");
  });
  it("does not replace a disabled binding while its native run is still active", async () => {
    const f = fixture();
    await f.bind();
    await f.dispatch();
    f.status("running");
    await f.controller.handle({ type: "disable" }, popup);
    await expect(f.bind()).rejects.toThrow("尚未结束");
    f.status("cancelled");
    await f.controller.handle({ type: "stop" }, popup);
    await f.bind();
    expect(f.state().binding?.phase).toBe("armed");
  });
  it("requires supported saved conversations, bounded settings and native readiness before enabling", async () => {
    const f = fixture();
    await expect(f.bind(6)).rejects.toThrow("1–5");
    f.host.activeTab = async () => ({ id: 10, url: "https://chatgpt.com/" });
    await expect(f.bind()).rejects.toThrow("已有");
    const missing = fixture();
    missing.request.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          data: { readiness: { ready: false, message: "Native login required" } },
        }),
      ),
    );
    await expect(missing.bind()).rejects.toThrow("Native login required");
    expect(missing.state().binding).toBeUndefined();
  });
});

it("rejects a stale Side Panel bind after the active conversation changes", async () => {
  const f = fixture();
  f.navigate();
  await expect(
    f.controller.handle(
      {
        type: "bind",
        projectId,
        maxRuns: 3,
        expectedConversation: conversation,
        expectedTabId: 10,
      },
      { url: `${EXTENSION_ORIGIN}/sidepanel.html` },
    ),
  ).rejects.toThrow("Conversation changed");
  expect(f.request).not.toHaveBeenCalled();
  expect(f.host.send).not.toHaveBeenCalled();
});
