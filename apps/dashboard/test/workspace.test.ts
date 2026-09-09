import { randomUUID } from "node:crypto";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it, vi } from "vitest";
import { WorkspaceView } from "../src/views.js";
import { WorkspaceStore } from "../src/store.js";
import type { ControlClient } from "../src/client.js";
const empty = { projects: [], runs: [], issues: [], hasMore: false };
it("shows a quiet empty workspace without fabricated runs or progress", () => {
  const markup = renderToStaticMarkup(
    createElement(WorkspaceView, {
      data: empty,
      route: "/overview",
      navigate: () => {},
      reconnect: () => {},
      cancel: () => {},
      logout: () => {},
      theme: () => {},
    }),
  );
  expect(markup).toContain("Room for your next idea");
  expect(markup).toContain("No runs yet");
  expect(markup).not.toMatch(/ChatGPT approved|42 tests|undefined|null|API_KEY|daemon/);
});
it("coalesces in-flight updates, ignores stale route evidence, and has zero idle timers", async () => {
  vi.useFakeTimers();
  try {
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const workspace = vi.fn(async () => {
      await ready;
      return empty;
    });
    const project = vi.fn(async () => {
      throw new Error("Project missing");
    });
    const store = new WorkspaceStore({ workspace, project } as unknown as ControlClient);
    const listener = vi.fn();
    store.subscribe(listener);
    const pending = store.refresh();
    for (let i = 0; i < 100; i++) void store.refresh();
    store.route(`/projects/${randomUUID()}`);
    release();
    await pending;
    await vi.runAllTimersAsync();
    expect(workspace.mock.calls.length).toBeLessThanOrEqual(2);
    expect(store.snapshot().error).toBe("Project missing");
    const renders = listener.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(listener).toHaveBeenCalledTimes(renders);
    expect(vi.getTimerCount()).toBe(0);
    store.close();
    await store.refresh();
    expect(workspace).toHaveBeenCalledTimes(2);
  } finally {
    vi.useRealTimers();
  }
});
