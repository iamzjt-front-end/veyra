import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { parseHTML } from "linkedom";
import { BridgeController, type SessionState, type ExtensionHost } from "../src/controller.js";
import { durableBindings } from "../src/persistence.js";
import { NativeClient, type NativeTransport } from "../src/native-client.js";
import { EXTENSION_ORIGIN, type Binding, frameHandoff, handoffTemplate } from "../src/contracts.js";
import { collapseMachine } from "../src/collapse.js";
import type { ProjectId } from "@veyraoss/protocol";
const popup = { url: `${EXTENSION_ORIGIN}/popup.html` };
function fixture() {
  const projectId = randomUUID() as ProjectId;
  let identity = randomUUID();
  let state: SessionState = {};
  let url = `https://chatgpt.com/c/${randomUUID()}`;
  let tabId = 1;
  let root = "/project";
  const native: NativeTransport = {
    identity: vi.fn(async () => identity),
    authorize: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    call: vi.fn(async (method, params) => {
      if (method === "projects.get")
        return {
          authorized: true,
          project: { id: projectId, name: "Project", root },
          readiness: { ready: true, message: "ready", checks: [] },
          sharedState: null,
        };
      if (method === "projects.list") return [];
      return {
        version: 1,
        projectId,
        runId:
          params && "handoff" in params
            ? params.handoff.runId
            : params && "runId" in params
              ? params.runId
              : randomUUID(),
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
    activeTab: async () => ({ id: tabId, url }),
    tab: async (id) => {
      if (id !== tabId) throw new Error("closed");
      return { id, url };
    },
    send: vi.fn(async (_id, msg) =>
      (msg as { type: string }).type === "prepare"
        ? { epoch: "epoch", conversation: url }
        : { ok: true },
    ),
  };
  let controller = new BridgeController(host, vi.fn(), native);
  return {
    native,
    host,
    controller: () => controller,
    state: () => state,
    url: () => url,
    projectId,
    bind: () => controller.handle({ type: "bind", projectId, maxRuns: 3 }, popup),
    hello: () => controller.handle({ type: "hello", epoch: "new-epoch" }, { url, tabId }),
    mutate: (change: (b: Binding) => void) => {
      assert.ok(state.binding);
      change(state.binding);
      state.bindings = durableBindings(state);
    },
    restart: () => {
      state = { bindings: durableBindings(state) };
      controller = new BridgeController(host, vi.fn(), native);
    },
    restartWorker: () => {
      // chrome.storage.session survives worker eviction; the document stays armed.
      controller = new BridgeController(host, vi.fn(), native);
    },
    navigate: (next = `https://chatgpt.com/c/${randomUUID()}`) => {
      url = next;
    },
    rotate: () => {
      identity = randomUUID();
    },
    move: () => {
      root = "/moved";
    },
    newTab: () => {
      tabId = 2;
    },
  };
}
it("keeps an explicitly paused binding paused when page preparation fails", async () => {
  const f = fixture();
  await f.bind();
  await f.controller().handle({ type: "disable" }, popup);
  const before = structuredClone(f.state());
  vi.mocked(f.host.send).mockRejectedValueOnce(new Error("Page receiver unavailable"));
  await expect(f.controller().handle({ type: "resume" }, popup)).rejects.toThrow("Page receiver");
  expect(f.state()).toEqual(before);
  expect(f.state().binding?.pausedByUser).toBe(true);
});
it("does not bind or send bootstrap after the selected conversation changes during readiness", async () => {
  const f = fixture();
  const call = f.native.call;
  f.native.call = vi.fn(async (method, params) => {
    const result = await call(method, params);
    if (method === "projects.get") f.navigate();
    return result;
  });
  await expect(f.bind()).rejects.toThrow("conversation changed");
  expect(f.state().binding).toBeUndefined();
  expect(vi.mocked(f.host.send).mock.calls).toHaveLength(1);
  expect(vi.mocked(f.host.send).mock.calls[0]?.[1]).toMatchObject({ type: "prepare" });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("recovers a cold worker snapshot without manual reconnect, rebinding or periodic checks", async () => {
  const f = fixture();
  await f.bind();
  await f.controller().handle({ type: "status" }, popup);
  const original = structuredClone(f.state());
  const sends = vi.mocked(f.host.send).mock.calls.length;
  f.restartWorker();
  vi.mocked(f.native.call).mockClear();
  expect(await f.controller().handle({ type: "snapshot" }, popup)).toMatchObject({
    currentBound: true,
    enabled: true,
    connectivity: { status: "connected" },
    selected: { readiness: { ready: true } },
    binding: { id: original.binding?.id, phase: "armed" },
  });
  expect(vi.mocked(f.native.call).mock.calls.map(([method]) => method)).toEqual([
    "projects.list",
    "projects.get",
  ]);
  vi.mocked(f.native.call).mockClear();
  for (let i = 0; i < 100; i++) await f.controller().handle({ type: "snapshot" }, popup);
  expect(f.native.call).not.toHaveBeenCalled();
  expect(f.state()).toEqual(original);
  expect(f.host.send).toHaveBeenCalledTimes(sends);
  expect(f.native.authorize).toHaveBeenCalledTimes(1);
});
it.each(["rotate", "move", "revoke"] as const)(
  "cold snapshots do not hide %s authorization changes or renew grants",
  async (change) => {
    const f = fixture();
    await f.bind();
    const original = structuredClone(f.state());
    f.restartWorker();
    if (change === "revoke") {
      const call = f.native.call;
      f.native.call = vi.fn(async (method, params) => {
        const value = await call(method, params);
        return method === "projects.get" ? { ...(value as object), authorized: false } : value;
      });
    } else f[change]();
    expect(await f.controller().handle({ type: "snapshot" }, popup)).toMatchObject({
      currentBound: true,
      connectivity: { status: "unavailable" },
      selected: undefined,
    });
    expect(f.state()).toEqual(original);
    expect(f.native.authorize).toHaveBeenCalledTimes(1);
    expect(vi.mocked(f.native.call).mock.calls.some(([method]) => method === "runs.dispatch")).toBe(
      false,
    );
  },
);
it("binds explicitly once, survives document/worker/browser restarts without resending bootstrap", async () => {
  const f = fixture();
  await f.bind();
  expect(f.native.authorize).toHaveBeenCalledWith(f.projectId);
  expect(f.state().binding?.bootstrapped).toBe(true);
  const sends = vi.mocked(f.host.send).mock.calls.length;
  await f.controller().detached(1);
  f.restart();
  expect(await f.hello()).toMatchObject({
    restored: true,
    binding: { epoch: "new-epoch", phase: "armed", projectId: f.projectId },
  });
  expect(f.host.send).toHaveBeenCalledTimes(sends + 1); // only detach/disarm, never another binding message
  f.newTab();
  f.restart();
  expect(await f.hello()).toMatchObject({ restored: true });
  f.navigate();
  expect(await f.hello()).toEqual({ restored: false });
});
it("keeps separate explicit conversation bindings and restores only the selected conversation", async () => {
  const f = fixture();
  await f.bind();
  const first = f.url();
  const id = f.state().binding?.id;
  f.navigate();
  expect(await f.hello()).toEqual({ restored: false });
  await f.bind();
  expect(Object.keys(f.state().bindings ?? {})).toHaveLength(2);
  expect(f.state().binding?.id).not.toBe(id);
  f.navigate(first);
  f.restart();
  expect(await f.hello()).toMatchObject({ restored: true, binding: { id } });
});
it.each(["paused", "stopped"] as const)(
  "a %s conversation refreshing in another tab cannot take over the active binding",
  async (phase) => {
    const f = fixture();
    await f.bind();
    const pausedUrl = f.url();
    await f.controller().handle({ type: "disable" }, popup);
    f.mutate((b) => {
      b.phase = phase;
      b.pausedByUser = phase === "stopped";
    });
    f.navigate();
    f.newTab();
    await f.bind();
    const active = structuredClone(f.state().binding);
    assert.ok(active);
    const tab = f.host.tab;
    f.host.tab = async (id) => (id === 1 ? { id, url: pausedUrl } : tab(id));
    const sends = vi.mocked(f.host.send).mock.calls.length;

    expect(
      await f
        .controller()
        .handle({ type: "hello", epoch: "paused-page-reloaded" }, { tabId: 1, url: pausedUrl }),
    ).toEqual({ restored: false });
    expect(f.state().binding).toEqual(active);
    expect(f.state().bindings?.[pausedUrl]?.phase).toBe(phase);
    expect(f.host.send).toHaveBeenCalledTimes(sends);
    await expect(
      f.controller().handle(
        {
          type: "dispatch",
          epoch: active.epoch,
          bindingId: active.id,
          source: frameHandoff(handoffTemplate(active)),
        },
        { tabId: 2, url: f.url() },
      ),
    ).resolves.toMatchObject({ binding: { id: active.id, phase: "running" } });
    expect(
      vi.mocked(f.native.call).mock.calls.filter(([method]) => method === "runs.dispatch"),
    ).toHaveLength(1);
  },
);
it.each(["dispatching", "delivering"] as const)(
  "does not replay %s across a restart",
  async (phase) => {
    const f = fixture();
    await f.bind();
    f.mutate((b) => {
      b.phase = phase;
      b.runId = randomUUID();
    });
    f.restart();
    expect(await f.hello()).toEqual({ restored: false });
    expect(f.state().binding?.phase).toBe("paused");
    expect(vi.mocked(f.native.call).mock.calls.some(([method]) => method === "runs.dispatch")).toBe(
      false,
    );
    await expect(f.controller().handle({ type: "resume" }, popup)).rejects.toThrow("不确定");
  },
);
it("fails closed when installation identity or Project root changes", async () => {
  for (const change of ["rotate", "move"] as const) {
    const f = fixture();
    await f.bind();
    f.restart();
    f[change]();
    expect(await f.hello()).toEqual({ restored: false });
    expect(f.state().binding?.phase).toBe("paused");
  }
});
it("persists pause, restores active run observation, unbinds immediately and scopes cancellation", async () => {
  const f = fixture();
  await f.bind();
  const b = f.state().binding;
  assert.ok(b);
  await f.controller().handle(
    {
      type: "dispatch",
      epoch: b.epoch,
      bindingId: b.id,
      source: frameHandoff(handoffTemplate(b)),
    },
    { url: f.url(), tabId: 1 },
  );
  await f.controller().handle({ type: "disable" }, popup);
  f.restart();
  expect(await f.hello()).toEqual({ restored: false });
  await f.controller().handle({ type: "resume" }, popup);
  expect(f.state().binding?.phase).toBe("running");
  await f.controller().handle({ type: "unbind" }, popup);
  expect(f.state().binding).toBeUndefined();
  expect(f.state().bindings).toEqual({});
  expect(vi.mocked(f.native.call).mock.calls.some(([method]) => method === "runs.cancel")).toBe(
    true,
  );
  f.restart();
  expect(await f.hello()).toEqual({ restored: false });
});
it("Unbind removes routing while dispatch is pending and a late reply cannot resurrect it", async () => {
  const f = fixture();
  await f.bind();
  const b = f.state().binding;
  assert.ok(b);
  const original = f.native.call;
  let release = () => {};
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered = () => {};
  const dispatched = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.native.call = vi.fn(async (method, params) => {
    if (method === "runs.dispatch") {
      entered();
      await wait;
    }
    return original(method, params);
  });
  const dispatch = f.controller().handle(
    {
      type: "dispatch",
      epoch: b.epoch,
      bindingId: b.id,
      source: frameHandoff(handoffTemplate(b)),
    },
    { url: f.url(), tabId: 1 },
  );
  await dispatched;
  await f.controller().handle({ type: "unbind" }, popup);
  expect(f.state().binding).toBeUndefined();
  release();
  await dispatch;
  expect(f.state().binding).toBeUndefined();
  expect(f.state().bindings).toEqual({});
});
it.each(["bind", "resume", "restore"] as const)(
  "Unbind during pending %s cannot restore a removed conversation binding",
  async (operation) => {
    const f = fixture();
    let release = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = () => {};
    const pending = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = async () => {
      entered();
      await waiting;
    };
    if (operation === "bind") {
      const original = f.native.identity;
      f.native.identity = async () => {
        await gate();
        return original();
      };
    } else {
      await f.bind();
      if (operation === "resume") {
        await f.controller().handle({ type: "disable" }, popup);
      } else {
        const conversation = f.url();
        f.navigate();
        await f.bind();
        f.navigate(conversation);
      }
      const original = f.host.send;
      f.host.send = async (id, message) => {
        if ((message as { type: string }).type === (operation === "resume" ? "prepare" : "disarm"))
          await gate();
        return original(id, message);
      };
    }
    const work =
      operation === "bind"
        ? f.bind()
        : operation === "resume"
          ? f.controller().handle({ type: "resume" }, popup)
          : f.hello();
    // Attach before releasing the delayed request, including expected cancellation errors.
    const outcome = work.catch(() => ({ restored: false }));
    await pending;
    const unbind = f.controller().handle({ type: "unbind" }, popup);
    // Unbind itself sends disarm; remove the gate only after it has deleted the route.
    await vi.waitFor(() => expect(f.state().bindings?.[f.url()]).toBeUndefined());
    release();
    await unbind;
    await outcome;
    expect(f.state().bindings?.[f.url()]).toBeUndefined();
    expect(f.state().binding?.conversation).not.toBe(f.url());
  },
);
it("stores routing/intent only and reconstructs an unclaimed result from Project state", async () => {
  const f = fixture();
  await f.bind();
  f.mutate((b) => {
    b.phase = "ready_to_deliver";
    b.delivery = { id: randomUUID(), text: "raw result body NEVER persist" };
    b.lastResult = {
      runId: randomUUID(),
      status: "failed",
      summary: "full execution summary",
      delivery: "pending",
    };
  });
  expect(JSON.stringify(durableBindings(f.state()))).not.toMatch(
    /raw result body|full execution summary/,
  );
  f.restart();
  expect(await f.hello()).toMatchObject({ restored: true, binding: { phase: "running" } });
});
it("uses a short native port and has no timers after idle; does not replay uncertain dispatch", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("chrome", { runtime: {} });
  const listeners: ((value: unknown) => void)[] = [];
  const post = vi.fn((msg: { id: string; method: string }) => {
    if (msg.method === "hello")
      queueMicrotask(() =>
        listeners.forEach((fn) => {
          fn({
            version: 1,
            id: msg.id,
            ok: true,
            data: { version: 1, installationId: "8852fd50-44a4-4aad-bd98-596e9482528c" },
          });
        }),
      );
  });
  const disconnect = vi.fn();
  const connect = vi.fn(
    () =>
      ({
        postMessage: post,
        disconnect,
        onMessage: { addListener: (fn: (value: unknown) => void) => listeners.push(fn) },
        onDisconnect: { addListener: vi.fn() },
      }) as unknown as chrome.runtime.Port,
  );
  const client = new NativeClient(connect);
  const ready = client.identity();
  await vi.advanceTimersByTimeAsync(0);
  await ready;
  await vi.advanceTimersByTimeAsync(60000);
  expect(disconnect).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(connect).toHaveBeenCalledTimes(1);
  listeners.length = 0;
  const again = client.identity();
  await vi.advanceTimersByTimeAsync(0);
  await again;
  const call = client.call("projects.list", undefined);
  const rejected = expect(call).rejects.toThrow("未确认");
  await vi.advanceTimersByTimeAsync(40001);
  await rejected;
  expect(post.mock.calls.filter(([msg]) => msg.method === "projects.list")).toHaveLength(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("folds machine messages reversibly without deleting or changing their text", () => {
  const { document } = parseHTML(
    '<html><body><div id="message">VEYRA_RESULT_BEGIN\n{"status":"completed"}\nVEYRA_RESULT_END</div></body></html>',
  );
  const node = document.querySelector("#message");
  assert.ok(node);
  const text = node.textContent;
  collapseMachine(node as unknown as Element, "Result returned");
  expect(node.textContent).toBe(text);
  expect((node as unknown as HTMLElement).style.display).toBe("none");
  const button = document.querySelector("button");
  assert.ok(button);
  button.click();
  expect((node as unknown as HTMLElement).style.display).not.toBe("none");
  expect(node.textContent).toBe(text);
  collapseMachine(node as unknown as Element, "Result returned");
  expect(document.querySelectorAll("button")).toHaveLength(1);
});
