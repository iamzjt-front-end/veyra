import { parseHTML } from "linkedom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sendToConversation } from "../src/page.js";

const conversation = "https://chatgpt.com/c/62bf60b0-5646-4195-9f47-a4ea70140859";
const marker = "delivery-8e7dc509-d7f1-4d0a-958c-8c98ff011e64";
const text = `Veyra 自动结果 ${marker}\n\n中文 + English\nVEYRA_RESULT_BEGIN\n${JSON.stringify({ summary: "中文 English", files: Array.from({ length: 200 }, (_, n) => ({ n, path: `src/file ${n}.ts` })) }, null, 2)}\nVEYRA_RESULT_END`;
function fixture(insert: (f: ReturnType<typeof setup>, text: string) => void) {
  const f = setup();
  Object.assign(f.document, {
    execCommand: (_name: string, _ui: boolean, value: string) => {
      insert(f, value);
      return true;
    },
    getSelection: () => ({ removeAllRanges() {}, addRange() {} }),
  });
  return f;
}
function setup() {
  const { document: doc, window } = parseHTML(
    '<html><body><main></main><div id="prompt-textarea" contenteditable="true"></div><button data-testid="send-button">Send</button></body></html>',
  );
  vi.stubGlobal("MutationObserver", window.MutationObserver);
  const document = doc as unknown as Document;
  const editor = document.querySelector("#prompt-textarea") as HTMLElement;
  const button = document.querySelector("button") as HTMLButtonElement;
  let url = conversation;
  let bound = true;
  const click = vi.fn(() => {});
  button.addEventListener("click", click);
  const echo = (value = text) => {
    const node = document.createElement("div");
    node.dataset.messageAuthorRole = "user";
    node.dataset.messageId = crypto.randomUUID();
    node.textContent = value;
    document.querySelector("main")?.append(node);
    return node;
  };
  return {
    document,
    editor,
    button,
    click,
    echo,
    send: () =>
      sendToConversation(
        document,
        () => url,
        conversation,
        text,
        marker,
        () => bound,
      ),
    navigate: () => {
      url = conversation.replace("62bf", "12bf");
    },
    unbind: () => {
      bound = false;
    },
    event: () => {
      const event = new window.Event("input", { bubbles: true });
      Object.defineProperty(event, "isTrusted", { value: true });
      editor.dispatchEvent(event as unknown as Event);
    },
  };
}
beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
const settle = async () => {
  await vi.advanceTimersByTimeAsync(11000);
};
describe("marker and echoed-message send confirmation", () => {
  it.each(["p", "div"])(
    "accepts %s paragraphs, NBSP, repeated newlines, large JSON and bilingual blocks",
    async (tag) => {
      const f = fixture(({ document, editor }, value) => {
        editor.replaceChildren(
          ...value.split("\n").map((line) => {
            const p = document.createElement(tag);
            p.textContent = line.replace(/ /g, "\u00a0");
            return p;
          }),
        );
      });
      f.button.addEventListener("click", () => {
        f.editor.replaceChildren();
        f.echo();
      });
      const result = f.send();
      await settle();
      expect(await result).toBe("sent");
      expect(f.click).toHaveBeenCalledTimes(1);
      expect(vi.getTimerCount()).toBe(0);
    },
  );
  it("preserves the line break between a native initial text node and following DIVs", async () => {
    const f = fixture(({ document, editor }, value) => {
      const [first, ...lines] = value.split("\n");
      editor.textContent = first ?? "";
      for (const line of lines) {
        const div = document.createElement("div");
        div.textContent = line;
        editor.append(div);
      }
    });
    f.button.addEventListener("click", () => {
      f.echo();
      f.editor.textContent = "";
    });
    const result = f.send();
    await settle();
    expect(await result).toBe("sent");
    expect(f.click).toHaveBeenCalledTimes(1);
  });
  it("recognizes a new echo plus GPT reply after the composer was replaced, without another click", async () => {
    const f = fixture((f) => {
      f.editor.textContent = text;
      f.editor.replaceWith(f.editor.cloneNode(false));
      f.echo();
      const reply = f.document.createElement("div");
      reply.dataset.messageAuthorRole = "assistant";
      reply.textContent = "已收到";
      f.document.querySelector("main")?.append(reply);
      const stop = f.document.createElement("button");
      stop.dataset.testid = "stop-button";
      f.document.body.append(stop);
    });
    const result = f.send();
    await settle();
    expect(await result).toBe("sent");
    expect(f.click).not.toHaveBeenCalled();
  });
  it.each([
    ["missing marker", (value: string) => value.replace(marker, "gone")],
    ["missing END", (value: string) => value.replace("VEYRA_RESULT_END", "")],
    ["mixed draft", (value: string) => `user draft ${value}`],
    ["duplicate payload", (value: string) => `${value}\n${value}`],
    ["changed JSON", (value: string) => value.replace("file 0.ts", "evil.ts")],
  ])("rejects %s before clicking", async (_name, mutate) => {
    const f = fixture(({ editor }, value) => {
      editor.textContent = mutate(value);
    });
    const result = f.send().catch((error: Error) => error.message);
    await settle();
    expect(await result).toContain("不会自动重发");
    expect(f.click).not.toHaveBeenCalled();
  });
  it.each(["draft", "attachment", "streaming"])(
    "defers without insertion for existing %s",
    async (kind) => {
      const insert = vi.fn();
      const f = fixture(insert);
      if (kind === "draft") f.editor.textContent = "user draft";
      else {
        const node = f.document.createElement("div");
        node.dataset.testid = kind === "attachment" ? "composer-attachment" : "stop-button";
        f.document.body.append(node);
      }
      expect(await f.send()).toBe("deferred");
      expect(insert).not.toHaveBeenCalled();
    },
  );
  it.each(["input", "navigation", "binding", "attachment", "streaming"])(
    "rejects mid-send %s even if the marker is retained",
    async (kind) => {
      const f = fixture(({ editor, button }, value) => {
        editor.textContent = value;
        button.disabled = true;
      });
      const result = f.send().catch((error: Error) => error.message);
      await vi.advanceTimersByTimeAsync(0);
      if (kind === "input") f.event();
      if (kind === "navigation") f.navigate();
      if (kind === "binding") f.unbind();
      if (kind === "attachment" || kind === "streaming") {
        const node = f.document.createElement("div");
        node.dataset.testid = kind === "attachment" ? "composer-attachment" : "stop-button";
        f.document.body.append(node);
      }
      f.button.disabled = false;
      await settle();
      expect(await result).toContain("不会自动重发");
      expect(f.click).not.toHaveBeenCalled();
    },
  );
  it("does not use an old message, click alone, or an assistant echo as delivery proof", async () => {
    const f = fixture(({ editor }, value) => {
      editor.textContent = value;
    });
    f.echo(); // pre-existing identical marker is not this delivery
    f.button.addEventListener("click", () => {
      f.echo().dataset.messageAuthorRole = "assistant";
      f.editor.textContent = "";
    });
    const result = f.send().catch((error: Error) => error.message);
    await settle();
    expect(await result).toContain("不会自动重发");
    expect(f.click).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
