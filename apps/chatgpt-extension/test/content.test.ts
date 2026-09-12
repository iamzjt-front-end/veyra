import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import { frameHandoff, handoffTemplate, type Binding } from "../src/contracts.js";
import type { ProjectId } from "@veyraoss/protocol";
import { sectionTurn } from "./fixtures/chatgpt-turn.js";

afterEach(() => {
  // Linkedom's window proxy delegates custom globals to this test realm; real browser
  // documents have separate isolated worlds. Dispose that explicit per-document lease.
  const scope = window as Window & { __veyraContent?: { dispose(): void } };
  scope.__veyraContent?.dispose();
  delete scope.__veyraContent;
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.resetModules();
});
it.each(["article", "section"])(
  "wakes for a new %s and an emptied composer, including input while a defer response is pending",
  async (layout) => {
    vi.useFakeTimers();
    const { document: doc, window } = parseHTML(
      '<html><body><main></main><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button"></button></body></html>',
    );
    const document = doc as unknown as Document;
    const conversation = "https://chatgpt.com/c/dc6aee38-ef73-470c-ae9f-d70d57c1c412";
    const editor = document.querySelector("#prompt-textarea") as HTMLElement;
    let listener: (
      message: unknown,
      sender: { id: string },
      reply: (value: unknown) => void,
    ) => boolean = () => false;
    let epoch = "";
    const id = "8e7dc509-d7f1-4d0a-958c-8c98ff011e64";
    let binding: Binding = {
      id,
      epoch,
      conversation,
      tabId: 1,
      projectId: "62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId,
      projectName: "fixture",
      projectRoot: "/fixture",
      phase: "armed",
      count: 0,
      maxRuns: 2,
      nextRunId: id,
      message: "fixture",
    };
    const marker = "delivery-62bf60b0-5646-4195-9f47-a4ea70140859";
    const resultText = `Veyra ${marker}\nVEYRA_RESULT_BEGIN\n{"status":"completed"}\nVEYRA_RESULT_END`;
    let release: (() => void) | undefined;
    let claims = 0;
    const call = vi.fn(async (message: { type: string }) => {
      if (message.type === "review" && binding.count === 0)
        return { ok: true, data: { binding, reviewIgnored: true } };
      if (message.type === "dispatch") binding = { ...binding, phase: "running", count: 1 };
      if (message.type === "poll") binding = { ...binding, phase: "ready_to_deliver" };
      if (message.type === "claim") {
        claims++;
        if (claims === 1) editor.textContent = "user draft"; // appeared during network round trip
        return { ok: true, data: { delivery: { id: marker, text: resultText } } };
      }
      if (message.type === "defer")
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      if (message.type === "ack") binding = { ...binding, phase: "armed" };
      if (message.type === "error") throw new Error("Unexpected bridge failure");
      return { ok: true, data: { binding } };
    });
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", window);
    vi.stubGlobal("location", { href: conversation });
    vi.stubGlobal("MutationObserver", window.MutationObserver);
    vi.stubGlobal("chrome", {
      runtime: {
        id: "extension",
        sendMessage: call,
        onMessage: {
          addListener: (value: typeof listener) => {
            listener = value;
          },
        },
      },
    });
    Object.assign(document, {
      getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
      execCommand: (_cmd: string, _ui: boolean, text: string) => {
        editor.textContent = text;
        return true;
      },
    });
    document.querySelector("button")?.addEventListener("click", () => {
      const node = document.createElement("div");
      node.dataset.messageAuthorRole = "user";
      node.textContent = editor.textContent;
      node.dataset.messageId = crypto.randomUUID();
      document.querySelector("main")?.append(node);
      editor.textContent = "";
    });
    await import("../src/content.js");
    // Re-injection in the same isolated document must not add listeners or send another hello.
    const installedListener = listener;
    vi.resetModules();
    await import("../src/content.js");
    expect(listener).toBe(installedListener);
    listener({ type: "prepare" }, { id: "extension" }, (value) => {
      epoch = (value as { epoch: string }).epoch;
    });
    binding.epoch = epoch;
    const armed = vi.fn();
    listener(
      { type: "arm", binding, text: `Veyra binding ${id}\n${frameHandoff({ ready: true })}` },
      { id: "extension" },
      armed,
    );
    await vi.advanceTimersByTimeAsync(1000);
    expect(armed).toHaveBeenCalledWith(expect.objectContaining({ ok: true }));
    expect(call.mock.calls.filter(([message]) => message.type === "hello")).toHaveLength(1);
    call.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(call).not.toHaveBeenCalled();
    const source = frameHandoff(handoffTemplate(binding));
    // A planner can review a historical result included in the initial Project snapshot.
    // No current result was delivered: ignore the whole reply, including a mixed handoff.
    const historicalReview = sectionTurn(
      document,
      "historical-review",
      'VEYRA_REVIEW_BEGIN\n{"verdict":"PASS","summary":"Old result","findings":[],"nextAction":"complete"}\nVEYRA_REVIEW_END\n' +
        source,
    );
    document.querySelector("main")?.append(historicalReview);
    await vi.advanceTimersByTimeAsync(1000);
    const actions = () =>
      call.mock.calls.map(([message]) => message.type).filter((type) => type !== "observe");
    expect(actions()).toEqual(["review"]);
    expect(historicalReview.textContent).toContain("VEYRA_REVIEW_BEGIN");
    expect(historicalReview.querySelector('[data-veyra-folded="true"]')).toBeNull();
    call.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(call).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const turn =
      layout === "section"
        ? sectionTurn(document, "fresh", source)
        : document.createElement("article");
    if (layout === "article") {
      turn.innerHTML =
        '<div data-message-author-role="assistant" data-message-id="fresh"></div><button data-testid="copy-turn-action-button"></button>';
      (turn.firstElementChild as Element).textContent = source;
    }
    const toolbar = turn.querySelector('[data-testid="copy-turn-action-button"]');
    if (!toolbar) throw new Error("Missing completion toolbar");
    toolbar.remove();
    document.querySelector("main")?.append(turn);
    await vi.advanceTimersByTimeAsync(0);
    // Coordinator reconnection during a long reply must retain the existing watcher.
    // Restarting it would snapshot this unfinished message as old history forever.
    const restored = vi.fn();
    listener({ type: "arm", binding, restore: true }, { id: "extension" }, restored);
    expect(restored).toHaveBeenCalledWith(
      expect.objectContaining({
        ok: true,
        observation: { phase: "waiting_for_completion", assistantId: "fresh" },
      }),
    );
    turn.append(toolbar);
    await vi.advanceTimersByTimeAsync(1500);
    expect(actions()).toEqual(["dispatch", "poll", "claim", "defer"]);
    // The old 1.5s interval would mask this lost-wakeup race. No periodic retry exists now.
    editor.textContent = "";
    editor.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    await vi.advanceTimersByTimeAsync(0);
    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(actions()).toEqual(["dispatch", "poll", "claim", "defer", "claim", "ack"]);
    expect(document.querySelectorAll('[data-message-author-role="user"]')).toHaveLength(2);
    const count = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(call).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    // The reviewer response is a separate completed assistant turn in this same document.
    const review =
      'VEYRA_REVIEW_BEGIN\n{"verdict":"PASS","summary":"Evidence collected","findings":[],"nextAction":"complete"}\nVEYRA_REVIEW_END';
    document.querySelector("main")?.append(sectionTurn(document, "review-new", review));
    await vi.advanceTimersByTimeAsync(1000);
    expect(call.mock.calls.at(-1)?.[0]).toMatchObject({ type: "review", source: review });
    expect(call.mock.calls.filter(([message]) => message.type === "review")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(call.mock.calls.filter(([message]) => message.type === "dispatch")).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
    listener({ type: "disarm" }, { id: "extension" }, () => {});
  },
);
