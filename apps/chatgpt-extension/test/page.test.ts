import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { assistantIds, canCompose, latestHandoff, sendToConversation } from "../src/page.js";
import { conversationUrl, EXTENSION_ORIGIN, parseHandoff, parsePairing } from "../src/contracts.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import type { ProjectId } from "@veyraoss/protocol";

const projectId = "62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId;
const runId = "8e7dc509-d7f1-4d0a-958c-8c98ff011e64";
const handoff = { ...fixtureProjectState(projectId).handoff, runId };
const conversation = `https://chatgpt.com/c/${runId}`;
const page = (html: string) =>
  parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
const turn = (id: string, language = "veyra-handoff", role = "assistant") =>
  `<article><div data-message-author-role="${role}" data-message-id="${id}"><pre><code class="language-${language}">${JSON.stringify(handoff)}</code></pre></div><button data-testid="copy-turn-action-button"></button></article>`;

describe("explicit current-conversation DOM boundary", () => {
  it("accepts only a complete assistant fence, excludes old/user/unmarked messages and streaming", () => {
    const document = page(turn("old"));
    const ignored = assistantIds(document);
    expect(latestHandoff(document, ignored)).toBeUndefined();
    document.body.insertAdjacentHTML("beforeend", turn("new", "json"));
    expect(latestHandoff(document, ignored)).toBeUndefined();
    document.body.insertAdjacentHTML("beforeend", turn("user", "veyra-handoff", "user"));
    expect(latestHandoff(document, ignored)).toBeUndefined();
    document.body.insertAdjacentHTML("beforeend", turn("fresh"));
    expect(latestHandoff(document, ignored)?.source).toBe(JSON.stringify(handoff));
    document.body.insertAdjacentHTML("beforeend", '<button data-testid="stop-button"></button>');
    expect(latestHandoff(document, ignored)).toBeUndefined();
    document.querySelector('[data-testid="stop-button"]')?.remove();
    document.querySelector("article:last-child button")?.remove();
    expect(latestHandoff(document, ignored)).toBeUndefined();
  });
  it("rejects multiple explicit blocks and never evaluates their content", () => {
    const document = page(turn("new"));
    document
      .querySelector("pre")
      ?.insertAdjacentHTML("afterend", '<pre><code class="language-veyra-handoff">{}</code></pre>');
    expect(() => latestHandoff(document, new Set())).toThrow("多个");
    expect(() => parseHandoff("globalThis.stolen = true", projectId, runId)).toThrow();
  });
  it("validates schema, identity, size and planner/reviewer provenance", () => {
    expect(parseHandoff(JSON.stringify(handoff), projectId, runId)).toEqual(handoff);
    for (const value of [
      { ...handoff, commands: ["evil"] },
      { ...handoff, runId: "wrong" },
      { ...handoff, projectId: runId },
      { ...handoff, provenance: { ...handoff.provenance, role: "human" } },
    ])
      expect(() => parseHandoff(JSON.stringify(value), projectId, runId)).toThrow();
    expect(() => parseHandoff(" ".repeat(65537), projectId, runId)).toThrow("64 KiB");
  });
  it("does not overwrite draft text, attachments, changed conversations or a revoked binding", async () => {
    const document = page('<div id="prompt-textarea" contenteditable="true">User draft</div>');
    expect(canCompose(document)).toBe(false);
    expect(
      await sendToConversation(
        document,
        () => conversation,
        conversation,
        "result",
        "id",
        () => true,
      ),
    ).toBe("deferred");
    expect(document.querySelector("#prompt-textarea")?.textContent).toBe("User draft");
    const editor = document.querySelector("#prompt-textarea") as HTMLElement;
    editor.textContent = "";
    expect(
      await sendToConversation(
        document,
        () => `${conversation}wrong`,
        conversation,
        "result",
        "id",
        () => true,
      ),
    ).toBe("deferred");
    expect(
      await sendToConversation(
        document,
        () => conversation,
        conversation,
        "result",
        "id",
        () => false,
      ),
    ).toBe("deferred");
    document.body.insertAdjacentHTML("beforeend", '<div data-testid="composer-attachment"></div>');
    expect(canCompose(document)).toBe(false);
  });
  it("limits URL and pairing inputs to supported conversations and exact loopback/extension identity", () => {
    expect(conversationUrl(conversation)).toBe(conversation);
    for (const url of [
      "https://chatgpt.com/",
      "https://chatgpt.com/share/abc",
      `https://evil.test/c/${runId}`,
      `https://chatgpt.com.evil.test/c/${runId}`,
    ])
      expect(conversationUrl(url)).toBeUndefined();
    const value = {
      version: 1,
      url: "http://127.0.0.1:3181",
      origin: EXTENSION_ORIGIN,
      token: "a".repeat(64),
      expiresAt: Date.now() + 100000,
    };
    expect(parsePairing(value)).toEqual(value);
    for (const replacement of [
      { url: "https://public.test:3181" },
      { url: "http://localhost:3181" },
      { origin: "https://chatgpt.com" },
      { expiresAt: 0 },
      { token: "short" },
    ])
      expect(() => parsePairing({ ...value, ...replacement })).toThrow();
  });
});
