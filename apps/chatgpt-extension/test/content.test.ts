import { parseHTML } from "linkedom";
import { afterEach, expect, it, vi } from "vitest";
import { frameHandoff, handoffTemplate, type Binding } from "../src/contracts.js";
import type { ProjectId } from "@veyraoss/protocol";
import { sectionTurn } from "./fixtures/chatgpt-turn.js";

afterEach(() => {
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
      if (message.type === "dispatch") binding = { ...binding, phase: "running" };
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
    expect(armed).toHaveBeenCalledWith({ ok: true });
    expect(call.mock.calls.filter(([message]) => message.type === "hello")).toHaveLength(1);
    call.mockClear();
    await vi.advanceTimersByTimeAsync(60000);
    expect(call).not.toHaveBeenCalled();
    const source = frameHandoff(handoffTemplate(binding));
    const turn =
      layout === "section"
        ? sectionTurn(document, "fresh", source)
        : document.createElement("article");
    if (layout === "article") {
      turn.innerHTML =
        '<div data-message-author-role="assistant" data-message-id="fresh"></div><button data-testid="copy-turn-action-button"></button>';
      (turn.firstElementChild as Element).textContent = source;
    }
    document.querySelector("main")?.append(turn);
    await vi.advanceTimersByTimeAsync(1500);
    expect(call.mock.calls.map(([message]) => message.type)).toEqual([
      "dispatch",
      "poll",
      "claim",
      "defer",
    ]);
    // The old 1.5s interval would mask this lost-wakeup race. No periodic retry exists now.
    editor.textContent = "";
    editor.dispatchEvent(new window.Event("input", { bubbles: true }) as unknown as Event);
    await vi.advanceTimersByTimeAsync(0);
    release?.();
    await vi.advanceTimersByTimeAsync(1000);
    expect(call.mock.calls.map(([message]) => message.type)).toEqual([
      "dispatch",
      "poll",
      "claim",
      "defer",
      "claim",
      "ack",
    ]);
    expect(document.querySelectorAll('[data-message-author-role="user"]')).toHaveLength(2);
    const count = call.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60000);
    expect(call).toHaveBeenCalledTimes(count);
    expect(vi.getTimerCount()).toBe(0);
    listener({ type: "disarm" }, { id: "extension" }, () => {});
  },
);
