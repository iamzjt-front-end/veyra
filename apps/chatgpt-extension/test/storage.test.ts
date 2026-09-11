import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import { extensionStorage, STORAGE_UNAVAILABLE } from "../src/storage.js";
import { startExtensionUI } from "../src/ui-locale.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function fixture(locale = "zh-CN") {
  vi.useFakeTimers();
  const { window, document } = parseHTML(`<html lang="${locale}"><body></body></html>`);
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  const reload = vi.fn();
  vi.stubGlobal("location", { reload });
  const area = () => ({ get: vi.fn(async () => ({})), set: vi.fn(), setAccessLevel: vi.fn() });
  const storage = {
    local: { ...area(), get: vi.fn(async () => ({ locale: "en", theme: "dark" })) },
    session: area(),
    onChanged: { addListener: vi.fn(), removeListener: vi.fn() },
  };
  const browser = { runtime: { id: "meibodpmcjcjdpfaaejdpiclijnpcclh" }, storage };
  vi.stubGlobal("chrome", browser);
  return { document, browser, storage, reload };
}

it("uses already available APIs without a timer or any state mutation", async () => {
  const f = fixture();
  expect(await extensionStorage()).toBe(f.storage);
  expect(f.storage.local.get).not.toHaveBeenCalled();
  expect(f.storage.local.set).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it("does not mount a popup/panel or read preferences until delayed storage is available", async () => {
  const f = fixture();
  let available = false;
  const access = vi.fn(() => (available ? f.storage : undefined));
  Object.defineProperty(f.browser, "storage", { get: access });
  const mount = vi.fn();
  startExtensionUI(mount);
  await vi.advanceTimersByTimeAsync(100);
  expect(mount).not.toHaveBeenCalled();
  expect(f.storage.local.get).not.toHaveBeenCalled();
  available = true;
  await vi.advanceTimersByTimeAsync(1000);
  expect(mount).toHaveBeenCalledTimes(1);
  expect(f.document.documentElement.lang).toBe("en");
  expect(f.document.documentElement.dataset.theme).toBe("dark");
  const attempts = access.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(access).toHaveBeenCalledTimes(attempts);
  expect(vi.getTimerCount()).toBe(0);
  expect(f.storage.local.set).not.toHaveBeenCalled();
});

it.each(["zh-CN", "en"])(
  "shows a %s recovery action after a bounded failure without mounting or automatic retry",
  async (locale) => {
    const f = fixture(locale);
    const access = vi.fn(() => undefined);
    Object.defineProperty(f.browser, "storage", { get: access });
    const mount = vi.fn();
    startExtensionUI(mount);
    await vi.advanceTimersByTimeAsync(3000);
    expect(mount).not.toHaveBeenCalled();
    expect(f.document.querySelector('[role="alert"]')?.textContent).toContain(
      locale === "en" ? "Extension storage is unavailable" : "扩展本地存储暂时不可用",
    );
    expect(access).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(60000);
    expect(access).toHaveBeenCalledTimes(7);
    expect(vi.getTimerCount()).toBe(0);
    expect(f.reload).not.toHaveBeenCalled();
    f.document.querySelector("button")?.click();
    expect(f.reload).toHaveBeenCalledTimes(1);
  },
);

it("does not mount after a storage read rejects and never retries that read or clears saved state", async () => {
  const f = fixture();
  f.storage.local.get.mockRejectedValue(new Error(STORAGE_UNAVAILABLE));
  const mount = vi.fn();
  startExtensionUI(mount);
  await vi.advanceTimersByTimeAsync(0);
  expect(mount).not.toHaveBeenCalled();
  expect(f.storage.local.get).toHaveBeenCalledTimes(1);
  expect(f.storage.local.set).not.toHaveBeenCalled();
  expect(f.document.querySelector('[role="alert"]')).not.toBeNull();
  expect(vi.getTimerCount()).toBe(0);
});
