import { parseHTML } from "linkedom";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { RunBackoff, watchConversation } from "../src/watch.js";
import { watchPopup } from "../src/popup-refresh.js";
import { sectionTurn } from "./fixtures/chatgpt-turn.js";

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each(["HANDOFF", "REVIEW"])(
  "keeps a new completed turn eligible when its %s block renders after initial prose",
  async (kind) => {
    const { document: doc, window } = parseHTML("<html><body><main></main></body></html>");
    vi.stubGlobal("MutationObserver", window.MutationObserver);
    const document = doc as unknown as Document;
    const source = `VEYRA_${kind}_BEGIN\n{"summary":"中文 English"}\nVEYRA_${kind}_END`;
    const candidate = vi.fn();
    const error = vi.fn();
    const stop = watchConversation(document, candidate, vi.fn(), error);
    const turn = sectionTurn(document, "staged", "Preparing the structured response…");
    document.querySelector("main")?.append(turn);
    await vi.advanceTimersByTimeAsync(1000);
    expect(candidate).not.toHaveBeenCalled();
    // A completed-looking toolbar can precede React's final body commit. The same
    // message identity must not be permanently consumed just for having plain text.
    const reads = vi.spyOn(document, "querySelectorAll");
    await vi.advanceTimersByTimeAsync(60000);
    expect(reads).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const message = turn.querySelector('[data-message-author-role="assistant"]');
    if (!message) throw new Error("Missing fixture assistant");
    message.textContent = source;
    for (let n = 0; n < 1000; n++) message.setAttribute("class", `render-${n}`);
    await vi.advanceTimersByTimeAsync(500);
    expect(candidate).toHaveBeenCalledExactlyOnceWith({
      id: "staged",
      source: kind === "HANDOFF" ? source : "",
      ...(kind === "REVIEW" ? { review: source } : {}),
    });
    message.textContent = `${source}\nLater presentation update`;
    await vi.advanceTimersByTimeAsync(60000);
    expect(candidate).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  },
);
it("retires a plain completed turn when a newer assistant starts and never replays it", async () => {
  const { document: doc, window } = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("MutationObserver", window.MutationObserver);
  const document = doc as unknown as Document;
  const source = 'VEYRA_HANDOFF_BEGIN\n{"goal":"task"}\nVEYRA_HANDOFF_END';
  const candidate = vi.fn();
  const error = vi.fn();
  let stop = watchConversation(document, candidate, vi.fn(), error);
  const previous = sectionTurn(document, "previous", "Ordinary response");
  document.querySelector("main")?.append(previous);
  await vi.advanceTimersByTimeAsync(500);
  const newest = sectionTurn(document, "newest", "Ordinary response");
  document.querySelector("main")?.append(newest);
  await vi.advanceTimersByTimeAsync(500);
  newest.remove();
  const message = previous.querySelector('[data-message-author-role="assistant"]');
  if (!message) throw new Error("Missing fixture assistant");
  message.textContent = source;
  await vi.advanceTimersByTimeAsync(500);
  expect(candidate).not.toHaveBeenCalled();
  stop();
  stop = watchConversation(document, candidate, vi.fn(), error);
  message.textContent = `${source}\n`;
  await vi.advanceTimersByTimeAsync(60000);
  expect(candidate).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  stop();
});
it("waits for the current section toolbar, then dispatches once without scanning old turns", async () => {
  const { document: doc, window } = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("MutationObserver", window.MutationObserver);
  const document = doc as unknown as Document;
  const main = document.querySelector("main");
  if (!main) throw new Error("Missing fixture main");
  const source = 'VEYRA_HANDOFF_BEGIN\n{"goal":"中文 English"}\nVEYRA_HANDOFF_END';
  const old = sectionTurn(document, "old", source);
  main.append(old);
  const handoff = vi.fn();
  const error = vi.fn();
  let active = true;
  const stop = watchConversation(document, handoff, vi.fn(), error, () => active);
  const fresh = sectionTurn(document, "fresh", source);
  const toolbar = fresh.querySelector('[role="group"]');
  if (!toolbar) throw new Error("Missing fixture toolbar");
  toolbar.remove();
  main.append(fresh);
  document.body.append(toolbar);
  // Neither an old complete turn nor a toolbar outside the new section proves completion.
  old.setAttribute("class", "changed");
  await vi.advanceTimersByTimeAsync(1000);
  expect(handoff).not.toHaveBeenCalled();
  const streaming = document.createElement("button");
  streaming.setAttribute("data-testid", "stop-button");
  document.body.append(streaming);
  fresh.append(toolbar);
  await vi.advanceTimersByTimeAsync(1000);
  expect(handoff).not.toHaveBeenCalled();
  streaming.setAttribute("data-testid", "send-button");
  for (let n = 0; n < 1000; n++) toolbar.setAttribute("class", `complete-${n}`);
  await vi.advanceTimersByTimeAsync(500);
  expect(handoff).toHaveBeenCalledExactlyOnceWith({ id: "fresh", source });
  toolbar.setAttribute("class", "rerender");
  await vi.advanceTimersByTimeAsync(60000);
  expect(handoff).toHaveBeenCalledTimes(1);
  expect(vi.getTimerCount()).toBe(0);
  const cancelled = sectionTurn(document, "cancelled", source);
  main.append(cancelled);
  await vi.advanceTimersByTimeAsync(200);
  active = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(handoff).toHaveBeenCalledTimes(1);
  expect(error).not.toHaveBeenCalled();
  stop();
  expect(vi.getTimerCount()).toBe(0);
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
it("captures only a new completed review, deduplicates mutation bursts and never replays history after refresh", async () => {
  const { document: doc, window } = parseHTML("<html><body><main></main></body></html>");
  vi.stubGlobal("MutationObserver", window.MutationObserver);
  const document = doc as unknown as Document;
  const main = document.querySelector("main");
  if (!main) throw new Error("Missing main");
  const review =
    'VEYRA_REVIEW_BEGIN\n{"verdict":"PASS","summary":"只读验收 English","findings":[],"nextAction":"complete"}\nVEYRA_REVIEW_END';
  for (let n = 0; n < 3000; n++)
    main.append(sectionTurn(document, `old-${n}`, n === 2999 ? review : "old"));
  const turn = vi.fn(),
    error = vi.fn();
  let active = true;
  let stop = watchConversation(document, turn, vi.fn(), error, () => active);
  const scans = vi.spyOn(document, "querySelectorAll");
  await vi.advanceTimersByTimeAsync(60000);
  expect(scans).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  const fresh = sectionTurn(document, "review-new", review);
  const toolbar = fresh.querySelector('[role="group"]');
  if (!toolbar) throw new Error("Missing toolbar");
  toolbar.remove();
  main.append(fresh);
  for (let n = 0; n < 1000; n++) fresh.setAttribute("class", `stream-${n}`);
  await vi.advanceTimersByTimeAsync(1000);
  expect(turn).not.toHaveBeenCalled();
  fresh.append(toolbar);
  for (let n = 0; n < 1000; n++) toolbar.setAttribute("class", `complete-${n}`);
  await vi.advanceTimersByTimeAsync(500);
  expect(turn).toHaveBeenCalledExactlyOnceWith({ id: "review-new", source: "", review });
  await vi.advanceTimersByTimeAsync(60000);
  expect(scans).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  stop();
  turn.mockClear();
  stop = watchConversation(document, turn, vi.fn(), error, () => active);
  fresh.setAttribute("class", "after-refresh");
  await vi.advanceTimersByTimeAsync(1000);
  expect(turn).not.toHaveBeenCalled();
  main.append(sectionTurn(document, "navigation-race", review));
  await vi.advanceTimersByTimeAsync(200);
  active = false;
  await vi.advanceTimersByTimeAsync(500);
  expect(turn).not.toHaveBeenCalled();
  expect(error).not.toHaveBeenCalled();
  stop();
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  ["data-testid", "stop-button", "composer-speech-button"],
  ["data-testid", "stop-generation-button", "send-button"],
  ["data-is-streaming", "true", "false"],
  ["class", "button result-streaming", "button complete"],
])(
  "detects completion when React reuses the streaming control: %s",
  async (attribute, before, after) => {
    const { document: doc, window } = parseHTML(
      `<html><body><main></main><button id="control" ${attribute}="${before}"></button></body></html>`,
    );
    vi.stubGlobal("MutationObserver", window.MutationObserver);
    const document = doc as unknown as Document;
    const handoff = vi.fn();
    const error = vi.fn();
    const stop = watchConversation(document, handoff, vi.fn(), error);
    const article = document.createElement("article");
    article.innerHTML =
      '<div data-message-author-role="assistant" data-message-id="new"><p>VEYRA_HANDOFF_BEGIN</p><p>{"goal":"只读验收 English"}</p><p>VEYRA_HANDOFF_END</p></div><button data-testid="copy-turn-action-button"></button>';
    document.querySelector("main")?.append(article);
    await vi.advanceTimersByTimeAsync(1000);
    expect(handoff).not.toHaveBeenCalled();
    document.getElementById("control")?.setAttribute(attribute, after);
    await vi.advanceTimersByTimeAsync(500);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(error).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60000);
    expect(handoff).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    stop();
  },
);
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
  const visibility = Object.assign(new EventTarget(), { hidden: false });
  vi.stubGlobal("document", visibility);
  const refresh = vi.fn();
  const close = watchPopup(refresh);
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
  for (let n = 0; n < 1000; n++) storage.emit({}, "session");
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(1);
  visibility.hidden = true;
  visibility.dispatchEvent(new Event("visibilitychange"));
  for (let n = 0; n < 1000; n++) storage.emit({}, "session");
  await vi.advanceTimersByTimeAsync(60000);
  expect(refresh).toHaveBeenCalledTimes(1);
  visibility.hidden = false;
  visibility.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(100);
  expect(refresh).toHaveBeenCalledTimes(2);
  storage.emit({}, "session");
  close();
  await vi.advanceTimersByTimeAsync(60000);
  updated.emit();
  activated.emit();
  storage.emit({}, "session");
  expect(refresh).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
  expect(storage.listeners.size + activated.listeners.size + updated.listeners.size).toBe(0);
});
