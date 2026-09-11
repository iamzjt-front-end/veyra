import { afterEach, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ handle: vi.fn(), detached: vi.fn() }));
vi.mock("../src/controller.js", () => ({
  BridgeController: class {
    handle = calls.handle;
    detached = calls.detached;
  },
}));
const extensionId = "meibodpmcjcjdpfaaejdpiclijnpcclh";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.resetModules();
  vi.clearAllMocks();
});
function event() {
  return { addListener: vi.fn(), removeListener: vi.fn() };
}
function fixture() {
  vi.useFakeTimers();
  calls.handle.mockResolvedValue({ status: "safe" });
  const area = () => ({
    get: vi.fn(async () => ({})),
    set: vi.fn(async () => {}),
    setAccessLevel: vi.fn(async () => {}),
  });
  const storage = { local: area(), session: area(), onChanged: event() };
  const browser = {
    runtime: { id: extensionId as string | undefined, onMessage: event(), onInstalled: event() },
    storage: undefined as typeof storage | undefined,
    tabs: {
      onRemoved: event(),
      onUpdated: event(),
      onActivated: event(),
      query: vi.fn(async () => []),
    },
    sidePanel: { setOptions: vi.fn(async () => {}) },
  };
  vi.stubGlobal("chrome", browser);
  const message = () => {
    const reply = vi.fn();
    const listener = browser.runtime.onMessage.addListener.mock.calls[0]?.[0];
    expect(listener).toBeTypeOf("function");
    expect(
      listener(
        { type: "snapshot" },
        { id: extensionId, url: `chrome-extension://${extensionId}/sidepanel.html` },
        reply,
      ),
    ).toBe(true);
    return reply;
  };
  return { browser, storage, message };
}

it("registers messages during delayed storage startup, then runs once after access restrictions", async () => {
  const f = fixture();
  await expect(import("../src/background.js")).resolves.toBeDefined();
  const reply = f.message();
  await vi.advanceTimersByTimeAsync(100);
  expect(calls.handle).not.toHaveBeenCalled();
  f.browser.storage = f.storage;
  await vi.advanceTimersByTimeAsync(1000);
  expect(reply).toHaveBeenCalledExactlyOnceWith({ ok: true, data: { status: "safe" } });
  expect(calls.handle).toHaveBeenCalledTimes(1);
  for (const area of [f.storage.local, f.storage.session]) {
    expect(area.setAccessLevel).toHaveBeenCalledExactlyOnceWith({
      accessLevel: "TRUSTED_CONTEXTS",
    });
    expect(area.setAccessLevel.mock.invocationCallOrder[0]).toBeLessThan(
      calls.handle.mock.invocationCallOrder[0] ?? 0,
    );
    expect(area.set).not.toHaveBeenCalled();
  }
  expect(f.storage.onChanged.addListener).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
  expect(calls.handle).toHaveBeenCalledTimes(1);
});

it("fails closed within a bounded startup window and never lets the next queued request bypass it", async () => {
  const f = fixture();
  await expect(import("../src/background.js")).resolves.toBeDefined();
  const first = f.message();
  await vi.advanceTimersByTimeAsync(3000);
  expect(first).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("storage") });
  const second = f.message();
  await vi.advanceTimersByTimeAsync(60000);
  expect(second).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("storage") });
  expect(calls.handle).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not proceed or retry when the trusted-storage access restriction fails", async () => {
  const f = fixture();
  f.browser.storage = f.storage;
  f.storage.local.setAccessLevel.mockRejectedValue(new Error("Access restriction refused"));
  await import("../src/background.js");
  const first = f.message();
  await vi.advanceTimersByTimeAsync(0);
  expect(first).toHaveBeenCalledWith({ ok: false, error: "Access restriction refused" });
  const second = f.message();
  await vi.advanceTimersByTimeAsync(0);
  expect(second).toHaveBeenCalledWith({ ok: false, error: "Access restriction refused" });
  expect(calls.handle).not.toHaveBeenCalled();
  expect(f.storage.local.setAccessLevel).toHaveBeenCalledTimes(1);
  expect(f.storage.local.get).not.toHaveBeenCalled();
});

it("does not resume a startup wait in an invalidated extension context", async () => {
  const f = fixture();
  await expect(import("../src/background.js")).resolves.toBeDefined();
  const reply = f.message();
  f.browser.runtime.id = undefined;
  f.browser.storage = f.storage;
  await vi.advanceTimersByTimeAsync(3000);
  expect(reply).toHaveBeenCalledWith({ ok: false, error: expect.stringContaining("context") });
  expect(calls.handle).not.toHaveBeenCalled();
  expect(f.storage.local.get).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
