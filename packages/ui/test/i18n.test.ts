import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, expect, it, vi } from "vitest";
import {
  chinese,
  LocaleStore,
  translate,
  I18nProvider,
  RunStatus,
  Stepper,
  runSteps,
} from "../src/index.js";

afterEach(() => vi.useRealTimers());
it("defaults to Chinese, keeps protocol states unchanged, and supports English rendering", () => {
  const run = { status: "completed" };
  const render = (language: "zh-CN" | "en") =>
    renderToStaticMarkup(
      createElement(
        I18nProvider,
        { store: new LocaleStore(undefined, language) },
        createElement(RunStatus, run),
      ),
    );
  expect(new LocaleStore().snapshot().locale).toBe("zh-CN");
  expect(render("zh-CN")).toContain("已完成");
  expect(render("en")).toContain("Completed");
  expect(run).toEqual({ status: "completed" });
  // Even when user content happens to equal a dictionary key, review prose remains evidence.
  const steps = runSteps({});
  steps[3] = { id: "review", label: "Review", state: "passed", detail: "Ready" };
  expect(renderToStaticMarkup(createElement(Stepper, { steps }))).toContain("Ready");
});
it("has matching interpolation parameters and never translates unknown engineering content", () => {
  const parameters = (text: string) =>
    [...text.matchAll(/\{([a-zA-Z]+)\}/g)].map((m) => m[1]).sort();
  for (const [source, text] of Object.entries(chinese)) {
    expect(text.trim(), source).not.toBe("");
    expect(parameters(text), source).toEqual(parameters(source));
    expect(translate("en", source)).toBe(source);
  }
  expect(translate("zh-CN", "{count} files", { count: 2 })).toBe("2 个文件");
  const evidence = 'src/中文/handler.ts const greeting = "你好 Hello"; VEYRA_RESULT_BEGIN';
  expect(translate("zh-CN", evidence)).toBe(evidence);
  expect(translate("zh-CN", "toString")).toBe("toString");
  expect(translate("zh-CN", "{value}", { value: "{count}" })).toBe("{count}");
});
it("persists language, survives reopening, and rejects late loads that would overwrite a choice", async () => {
  let saved: unknown;
  const persistence = {
    load: async () => saved,
    save: async (value: string) => {
      saved = value;
    },
  };
  const first = new LocaleStore(persistence);
  first.set("en");
  await first.settled();
  const reopened = new LocaleStore(persistence);
  await reopened.initialize();
  expect(reopened.snapshot().locale).toBe("en");
  let resolve: (value: unknown) => void = () => {};
  const delayed = new LocaleStore({
    load: () =>
      new Promise((done) => {
        resolve = done;
      }),
    save: persistence.save,
  });
  const loading = delayed.initialize();
  delayed.set("en");
  resolve("zh-CN");
  await loading;
  expect(delayed.snapshot().locale).toBe("en");
});
it("orders writes, reports save failure without affecting work, and retries only on user input", async () => {
  const writes: string[] = [];
  const store = new LocaleStore({
    load: async () => undefined,
    save: async (value) => {
      writes.push(value);
    },
  });
  store.set("en");
  store.set("zh-CN");
  store.set("en");
  await store.settled();
  expect(writes).toEqual(["en", "zh-CN", "en"]);
  const save = vi
    .fn()
    .mockRejectedValueOnce(new Error("Disk unavailable"))
    .mockResolvedValue(undefined);
  const failed = new LocaleStore({ load: async () => undefined, save });
  failed.set("en");
  await failed.settled();
  expect(failed.snapshot()).toEqual({ locale: "en", saveFailed: true });
  expect(save).toHaveBeenCalledTimes(1);
  failed.set("en");
  await failed.settled();
  expect(failed.snapshot().saveFailed).toBe(false);
  expect(save).toHaveBeenCalledTimes(2);
});
it("syncs external preferences without storage echo or idle timers", async () => {
  vi.useFakeTimers();
  const save = vi.fn();
  const store = new LocaleStore({ load: async () => "invalid", save });
  const changed = vi.fn();
  const stop = store.subscribe(changed);
  await store.initialize();
  store.accept("en");
  store.accept("en");
  store.accept({ locale: "zh-CN" });
  expect(changed).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(60000);
  expect(vi.getTimerCount()).toBe(0);
  expect(save).not.toHaveBeenCalled();
  stop();
  store.accept("zh-CN");
  expect(changed).toHaveBeenCalledTimes(1);
});
