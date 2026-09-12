import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import type { ProjectId } from "@veyraoss/protocol";
import { BridgeController, type ExtensionHost, type SessionState } from "../src/controller.js";
import { durableBindings } from "../src/persistence.js";
import { EXTENSION_ORIGIN, frameHandoff, handoffTemplate, object } from "../src/contracts.js";
import type { NativeTransport } from "../src/native-client.js";

const surface = { url: `${EXTENSION_ORIGIN}/sidepanel.html` };
function fixture() {
  const projectId = randomUUID() as ProjectId;
  const identity = randomUUID();
  const url = `https://chatgpt.com/c/${randomUUID()}`;
  let state: SessionState = {};
  let archived: unknown;
  let receive = true;
  let reply = false;
  let page = true;
  let pageBuild = "development";
  let activeUrl = url;
  const native: NativeTransport = {
    identity: vi.fn(async () => identity),
    authorize: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    call: vi.fn(async (method, params) => {
      if (method === "projects.list") return [];
      if (method === "projects.get")
        return {
          authorized: true,
          project: { id: projectId, name: "Proof", root: "/proof" },
          readiness: { ready: true, message: "Native login ready", checks: [] },
          sharedState: null,
        };
      if (method === "runs.dispatch") {
        if (receive && object(params)) archived = structuredClone(params.handoff);
        if (!reply) throw new Error("response lost");
      }
      if (method === "handoffs.get") return archived;
      if (!archived) throw new Error("run not found");
      return {
        version: 1,
        projectId,
        runId: object(archived) ? archived.runId : undefined,
        status: "running",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
    }),
  };
  const host: ExtensionHost = {
    read: async () => structuredClone(state),
    save: async (next) => {
      state = structuredClone({ ...next, bindings: durableBindings(next) });
    },
    activeTab: async () => ({ id: 1, url: activeUrl }),
    tab: async () => ({ id: 1, url: activeUrl }),
    send: vi.fn(async (_id, value) => {
      if (!page) throw new Error("page unavailable");
      return object(value) && ["prepare", "probe"].includes(String(value.type))
        ? {
            epoch: "epoch",
            conversation: url,
            buildId: pageBuild,
            bindingId: state.binding?.id,
            observation: { phase: "waiting_for_send" },
          }
        : { ok: true, observation: { phase: "waiting_for_reply" } };
    }),
  };
  let controller = new BridgeController(host, vi.fn(), native);
  return {
    native,
    host,
    state: () => state,
    bind: () => controller.handle({ type: "bind", projectId, maxRuns: 3 }, surface),
    dispatch: () => {
      const b = state.binding;
      if (!b) throw new Error("Missing fixture binding");
      return controller.handle(
        {
          type: "dispatch",
          epoch: b.epoch,
          bindingId: b.id,
          source: frameHandoff(handoffTemplate(b)),
          assistantId: "new-turn",
        },
        { url, tabId: 1 },
      );
    },
    status: () => controller.handle({ type: "status" }, surface),
    snapshot: () => controller.handle({ type: "snapshot" }, surface),
    restore: () =>
      controller.handle(
        { type: "hello", epoch: "epoch", buildId: "development" },
        { url, tabId: 1 },
      ),
    restart: () => {
      state = { bindings: durableBindings(state) };
      controller = new BridgeController(host, vi.fn(), native);
    },
    unreceived: () => {
      receive = false;
    },
    acknowledged: () => {
      reply = true;
    },
    pageMissing: () => {
      page = false;
    },
    pageBuild: (build: string) => {
      pageBuild = build;
    },
    navigate: () => {
      activeUrl = `https://chatgpt.com/c/${randomUUID()}`;
    },
    pollError: () =>
      controller.handle(
        { type: "error", epoch: "epoch", bindingId: state.binding?.id, error: "read interrupted" },
        { url, tabId: 1 },
      ),
    unbind: () => controller.handle({ type: "unbind" }, surface),
    tamper: () => {
      if (object(archived) && object(archived.context)) archived.context.goal = "Different task";
    },
    pause: () => controller.handle({ type: "disable" }, surface),
  };
}

it("reconciles a lost dispatch reply against the archived handoff without executing twice", async () => {
  const f = fixture();
  await f.bind();
  await f.dispatch();
  expect(f.state().binding?.phase).toBe("running");
  expect(vi.mocked(f.native.call).mock.calls.filter(([m]) => m === "runs.dispatch")).toHaveLength(
    1,
  );
  expect(f.state().binding).toMatchObject({
    checkpoints: [
      expect.objectContaining({ stage: "detected" }),
      expect.objectContaining({ stage: "validated" }),
      expect.objectContaining({ stage: "accepted" }),
    ],
  });
});
it("restores accepted work after worker/browser loss using only read operations", async () => {
  const f = fixture();
  await f.bind();
  await f.dispatch();
  f.restart();
  vi.mocked(f.native.call).mockClear();
  expect(await f.restore()).toMatchObject({
    restored: true,
    binding: { phase: "running", count: 1 },
  });
  expect(
    vi
      .mocked(f.native.call)
      .mock.calls.every(([m]) => !["runs.dispatch", "reviews.submit"].includes(m)),
  ).toBe(true);
});
it.each(["unreceived", "tamper"] as const)(
  "never resumes an unconfirmed %s dispatch or replays it",
  async (mode) => {
    const f = fixture();
    await f.bind();
    if (mode === "unreceived") f.unreceived();
    else {
      const call = f.native.call;
      f.native.call = vi.fn(async (method, params) => {
        if (method === "handoffs.get") f.tamper();
        return call(method, params);
      });
    }
    await f.dispatch();
    expect(f.state().binding?.phase).toBe("paused");
    f.restart();
    expect(await f.restore()).toMatchObject({ restored: false });
    expect(f.state().binding?.phase).toBe("paused");
  },
);
it("does not call an unbound or receiver-missing conversation ready", async () => {
  const f = fixture();
  expect(await f.status()).toMatchObject({ readiness: { ready: false, reason: "unbound" } });
  await f.bind();
  expect(await f.status()).toMatchObject({ readiness: { ready: true, receiver: "confirmed" } });
  f.pageMissing();
  expect(await f.status()).toMatchObject({ readiness: { ready: false, receiver: "unavailable" } });
  expect(vi.mocked(f.native.call).mock.calls.some(([m]) => m === "runs.dispatch")).toBe(false);
});
it("reports unknown or unsupported observation without dispatching or persisting reply bodies", async () => {
  const f = fixture();
  await f.bind();
  const send = f.host.send;
  f.host.send = async (id, message) => {
    const result = await send(id, message);
    if (object(message) && message.type === "probe" && object(result))
      return { ...result, observation: undefined };
    return result;
  };
  expect(await f.status()).toMatchObject({ readiness: { ready: false, reason: "observation" } });
  expect(await f.snapshot()).toMatchObject({ readiness: { ready: false, reason: "observation" } });
  f.host.send = async (id, message) => {
    const result = await send(id, message);
    return object(result)
      ? {
          ...result,
          observation: { phase: "unsupported", assistantId: "reply-id", text: "DO NOT STORE" },
        }
      : result;
  };
  const status = await f.status();
  expect(status).toMatchObject({
    readiness: {
      ready: false,
      reason: "observation",
      observation: { phase: "unsupported", assistantId: "reply-id" },
    },
  });
  expect(JSON.stringify(status)).not.toContain("DO NOT STORE");
  expect(await f.snapshot()).toMatchObject({
    readiness: { observation: { phase: "unsupported" } },
  });
  expect(JSON.stringify(durableBindings(f.state()))).not.toContain("observation");
  expect(vi.mocked(f.native.call).mock.calls.some(([m]) => m === "runs.dispatch")).toBe(false);
});
it("recovers an interrupted run read without dispatch replay or renewing authorization", async () => {
  const f = fixture();
  await f.bind();
  await f.dispatch();
  await f.pollError();
  expect(f.state().binding?.phase).toBe("paused");
  expect(await f.status()).toMatchObject({
    readiness: { ready: true },
    binding: { phase: "running" },
  });
  expect(vi.mocked(f.native.call).mock.calls.filter(([m]) => m === "runs.dispatch")).toHaveLength(
    1,
  );
  expect(f.native.authorize).toHaveBeenCalledTimes(1);
});
it("requires the receiver to run the worker's exact build", async () => {
  const f = fixture();
  f.pageBuild("stale-build");
  await expect(f.bind()).rejects.toThrow("构建版本不一致");
  expect(f.native.authorize).not.toHaveBeenCalled();
  f.pageBuild("development");
  await f.bind();
  f.pageBuild("stale-build");
  expect(await f.status()).toMatchObject({
    readiness: { ready: false, receiver: "different_build" },
  });
});
it("does not report readiness if the conversation changes during receiver confirmation", async () => {
  const f = fixture();
  await f.bind();
  const send = f.host.send;
  f.host.send = async (id, value) => {
    const result = await send(id, value);
    f.navigate();
    return result;
  };
  expect(await f.status()).toMatchObject({ currentBound: false, readiness: { ready: false } });
});
it("keeps an explicit pause across reload instead of recovering it as a transport fault", async () => {
  const f = fixture();
  await f.bind();
  await f.dispatch();
  await f.pause();
  f.restart();
  expect(await f.restore()).toMatchObject({ restored: false });
  expect(vi.mocked(f.native.call).mock.calls.filter(([m]) => m === "runs.dispatch")).toHaveLength(
    1,
  );
});
it("does not resurrect an unbound conversation when archived admission arrives late", async () => {
  const f = fixture();
  await f.bind();
  const call = f.native.call;
  f.native.call = vi.fn(async (method, params) => {
    if (method === "handoffs.get") await f.unbind();
    return call(method, params);
  });
  await f.dispatch();
  expect(f.state().binding).toBeUndefined();
  expect(Object.keys(f.state().bindings ?? {})).toHaveLength(0);
});
