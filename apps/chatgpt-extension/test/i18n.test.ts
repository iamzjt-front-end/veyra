import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import { machinePresentation } from "../src/collapse.js";
import { extensionLocale } from "../src/ui-locale.js";
import { diagnosticText, stateLabel } from "../src/diagnostic-copy.js";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider, LocaleStore } from "@veyraoss/ui";
import { PanelView, type PanelActions } from "../src/panel-view.js";
import { panelFixture } from "../dev/fixtures.js";
import { PAGE_CONNECTION_CHANGED, PAGE_CONNECTION_UNAVAILABLE } from "../src/page-connection.js";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
it("changes only owned machine labels, preserves framed evidence and never scans the conversation", () => {
  const { document } = parseHTML(
    '<html><body><div id="result">VEYRA_RESULT_BEGIN\n{"projectId":"中文-English","status":"completed"}\nVEYRA_RESULT_END</div></body></html>',
  );
  const node = document.querySelector("#result");
  assert.ok(node);
  const text = node.textContent,
    original = node.innerHTML;
  const view = machinePresentation();
  view.fold(node as unknown as Element, "Result returned");
  const button = document.querySelector("button");
  assert.ok(button);
  expect(button.textContent).toContain("结果已回传");
  const scan = vi.spyOn(document, "querySelectorAll");
  view.language("en");
  expect(button.textContent).toBe("Result returned · View raw payload");
  expect(button.getAttribute("aria-expanded")).toBe("false");
  button.click();
  view.language("zh-CN");
  expect(button.getAttribute("aria-expanded")).toBe("true");
  expect(button.textContent).toContain("隐藏原始协议");
  expect(node.textContent).toBe(text);
  expect(node.innerHTML).toBe(original);
  expect(scan).not.toHaveBeenCalled();
});
it("persists and synchronizes trusted extension UI preferences without binding calls or polling", async () => {
  vi.useFakeTimers();
  const { window, document } = parseHTML("<html><body></body></html>");
  vi.stubGlobal("window", window);
  vi.stubGlobal("document", document);
  let saved: unknown;
  const listeners = new Set<
    (changes: Record<string, { newValue: unknown }>, area: string) => void
  >();
  const sendMessage = vi.fn();
  const set = vi.fn(async (value: { locale: string }) => {
    saved = value.locale;
    for (const listener of listeners) listener({ locale: { newValue: saved } }, "local");
  });
  vi.stubGlobal("chrome", {
    runtime: { id: "meibodpmcjcjdpfaaejdpiclijnpcclh", sendMessage },
    storage: {
      local: { get: async () => ({ locale: saved }), set, setAccessLevel: vi.fn() },
      session: { get: vi.fn(), set: vi.fn(), setAccessLevel: vi.fn() },
      onChanged: {
        addListener: (fn: typeof listeners extends Set<infer T> ? T : never) => listeners.add(fn),
        removeListener: (fn: typeof listeners extends Set<infer T> ? T : never) =>
          listeners.delete(fn),
      },
    },
  });
  const store = await extensionLocale();
  expect(document.documentElement.lang).toBe("zh-CN");
  store.set("en");
  await store.settled();
  expect(document.documentElement.lang).toBe("en");
  const reopened = await extensionLocale();
  expect(reopened.snapshot().locale).toBe("en");
  for (const fn of listeners) fn({ locale: { newValue: "zh-CN" } }, "session");
  expect(store.snapshot().locale).toBe("en");
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
  expect(sendMessage).not.toHaveBeenCalled();
  expect(set).toHaveBeenCalledExactlyOnceWith({ locale: "en" });
  window.dispatchEvent(new window.Event("pagehide"));
  expect(listeners.size).toBe(0);
});
it("translates known diagnostics and state labels without rewriting unknown evidence", () => {
  for (const literal of ["constructor", "__proto__", "toString"]) {
    expect(stateLabel("zh-CN", literal)).toBe(literal);
    expect(diagnosticText("zh-CN", literal)).toBe(literal);
  }
  expect(stateLabel("zh-CN", "running")).toBe("运行中");
  expect(stateLabel("en", "running")).toBe("Running");
  expect(diagnosticText("en", "等待新的显式 handoff。")).toBe(
    "Waiting for a new explicit handoff.",
  );
  expect(diagnosticText("zh-CN", "src/test.ts:16 actual=failed")).toBe(
    "src/test.ts:16 actual=failed",
  );
});
it.each([PAGE_CONNECTION_UNAVAILABLE, PAGE_CONNECTION_CHANGED])(
  "shows the page connection remedy directly in Chinese and English: %s",
  (error) => {
    const state = { ...panelFixture("unbound"), connected: true, error };
    const actions: PanelActions = {
      select() {},
      bind() {},
      pause() {},
      unbind() {},
      cancel() {},
      reconnect() {},
      diagnostics() {},
      theme() {},
    };
    for (const locale of ["zh-CN", "en"] as const) {
      const html = renderToStaticMarkup(
        createElement(
          I18nProvider,
          { store: new LocaleStore(undefined, locale) },
          createElement(PanelView, { state, actions }),
        ),
      );
      expect(html).toContain(
        locale === "zh-CN" ? "本次没有发送任务" : "This attempt did not send a task",
      );
      expect(html).not.toContain("Receiving end does not exist");
      expect(html).not.toContain("An action could not be confirmed");
      expect(diagnosticText(locale, error)).toEqual(
        locale === "en" ? error : expect.stringContaining("本次没有发送任务"),
      );
    }
  },
);
