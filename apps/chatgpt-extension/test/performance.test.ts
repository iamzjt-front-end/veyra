import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunBackoff, watchConversation } from "../src/watch.js";
import { watchPopup } from "../src/popup-refresh.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it("does no DOM queries, text reads or timers during 60 seconds idle with 3000 old turns; coalesces streaming bursts", async () => {
  const { document: doc, window } = parseHTML(
    `<html><body><main>${Array.from({ length: 3000 }, (_, n) => `<article><div data-message-author-role="assistant" data-message-id="old-${n}">${"old history ".repeat(20)}</div><button data-testid="copy-turn-action-button"></button></article>`).join("")}</main></body></html>`,
  );
  vi.stubGlobal("MutationObserver", window.MutationObserver);
  const document = doc as unknown as Document;
  const reads = vi.spyOn(document, "querySelectorAll");
  const handoff = vi.fn();
  const error = vi.fn();
  const composer = vi.fn();
  const stop = watchConversation(document, handoff, composer, error);
  expect(reads).toHaveBeenCalledTimes(1);
  reads.mockClear();
  await vi.advanceTimersByTimeAsync(60000);
  expect(reads).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const article = document.createElement("article");
  const assistant = document.createElement("div");
  assistant.dataset.messageAuthorRole = "assistant";
  assistant.dataset.messageId = "new";
  article.append(assistant);
  document.querySelector("main")?.append(article);
  for (let n = 0; n < 1000; n++) assistant.textContent = `stream ${n}`;
  await vi.advanceTimersByTimeAsync(500);
  expect(handoff).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  assistant.textContent = 'VEYRA_HANDOFF_BEGIN\n{"goal":"中文 English"}\nVEYRA_HANDOFF_END';
  const copy = document.createElement("button");
  copy.dataset.testid = "copy-turn-action-button";
  article.append(copy);
  for (let n = 0; n < 1000; n++) assistant.setAttribute("class", `completed-${n}`);
  await vi.advanceTimersByTimeAsync(500);
  expect(handoff).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  expect(reads).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  await vi.advanceTimersByTimeAsync(60000);
  expect(handoff).toHaveBeenCalledTimes(1);
  stop();
  expect(vi.getTimerCount()).toBe(0);
});
it("backs off only active-run queries and leaves no timer when finished or disabled", async () => {
  const poll = vi.fn(async (): Promise<string | undefined> => "running");
  const runs = new RunBackoff(poll);
  await vi.advanceTimersByTimeAsync(60000);
  expect(poll).not.toHaveBeenCalled();
  runs.start();
  await vi.advanceTimersByTimeAsync(60000);
  expect(poll.mock.calls.length).toBeLessThanOrEqual(9);
  poll.mockResolvedValue(undefined);
  await vi.advanceTimersByTimeAsync(15000);
  expect(vi.getTimerCount()).toBe(0);
  const count = poll.mock.calls.length;
  await vi.advanceTimersByTimeAsync(60000);
  expect(poll).toHaveBeenCalledTimes(count);
  runs.start();
  runs.stop();
  expect(vi.getTimerCount()).toBe(0);
});
it("does not revive polling after Stop while a request is in flight", async () => {
  let done: (status: string) => void = () => {};
  const poll = vi.fn(
    () =>
      new Promise<string>((resolve) => {
        done = resolve;
      }),
  );
  const runs = new RunBackoff(poll);
  runs.start();
  await vi.advanceTimersByTimeAsync(1000);
  runs.stop();
  done("running");
  await vi.advanceTimersByTimeAsync(60000);
  expect(poll).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
});
it("popup refreshes on coalesced events only and removes all listeners/work when closed", async () => {
  const event = () => {
    const listeners = new Set<(...args: unknown[]) => void>();
    return {
      listeners,
      addListener: (fn: (...args: unknown[]) => void) => listeners.add(fn),
      removeListener: (fn: (...args: unknown[]) => void) => listeners.delete(fn),
      emit: (...args: unknown[]) => {
        for (const fn of listeners) fn(...args);
      },
    };
  };
  const storage = event(),
    activated = event(),
    updated = event();
  vi.stubGlobal("chrome", {
    storage: { onChanged: storage },
    tabs: { onActivated: activated, onUpdated: updated },
  });
  vi.stubGlobal("window", new EventTarget());
  const refresh = vi.fn();
  const close = watchPopup(refresh);
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  for (let n = 0; n < 1000; n++) storage.emit({}, "session");
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(1);
  storage.emit({}, "session");
  close();
  await vi.advanceTimersByTimeAsync(60000);
  updated.emit();
  activated.emit();
  storage.emit({}, "session");
  expect(refresh).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  expect(storage.listeners.size + activated.listeners.size + updated.listeners.size).toBe(0);
});
