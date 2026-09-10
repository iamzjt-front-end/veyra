import { parseHTML } from "linkedom";
import { describe, expect, it } from "vitest";
import { assistantIds, canCompose, latestHandoff, sendToConversation } from "../src/page.js";
import {
  conversationUrl,
  EXTENSION_ORIGIN,
  extractHandoffBlock,
  frameHandoff,
  parseHandoff,
  parseInvitation,
  parsePairing,
} from "../src/contracts.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import type { ProjectId } from "@veyraoss/protocol";
import { sectionTurn } from "./fixtures/chatgpt-turn.js";

const projectId = "62bf60b0-5646-4195-9f47-a4ea70140859" as ProjectId;
const runId = "8e7dc509-d7f1-4d0a-958c-8c98ff011e64";
const handoff = { ...fixtureProjectState(projectId).handoff, runId };
const conversation = `https://chatgpt.com/c/${runId}`;
const page = (html: string) =>
  parseHTML(`<html><body>${html}</body></html>`).document as unknown as Document;
const turn = (id: string, source = frameHandoff(handoff), role = "assistant") =>
  `<article><div data-message-author-role="${role}" data-message-id="${id}"><pre><code>${source}</code></pre></div><button data-testid="copy-turn-action-button"></button></article>`;

describe("explicit current-conversation DOM boundary", () => {
  it("recognizes the observed ChatGPT section with its sibling completion toolbar", () => {
    const document = page("");
    document.body.append(sectionTurn(document, "fresh", frameHandoff(handoff)));
    expect(latestHandoff(document, new Set())).toEqual({
      id: "fresh",
      source: frameHandoff(handoff),
    });
    expect(latestHandoff(document, new Set(["fresh"]))).toBeUndefined();
  });
  it("cannot borrow completion from an adjacent section or outside the current turn", () => {
    const document = page("");
    const old = sectionTurn(document, "old", frameHandoff(handoff));
    const fresh = sectionTurn(document, "fresh", frameHandoff(handoff));
    const toolbar = fresh.querySelector('[role="group"]');
    if (!toolbar) throw new Error("Missing fixture toolbar");
    document.body.append(old, fresh, toolbar);
    expect(latestHandoff(document, new Set(["old"]))).toBeUndefined();
    fresh.append(toolbar);
    expect(latestHandoff(document, new Set(["old"]))?.id).toBe("fresh");
  });
  it("fails closed for an unidentified wrapper instead of treating a shared parent as a turn", () => {
    const document = page("");
    const unknown = sectionTurn(document, "fresh", frameHandoff(handoff));
    unknown.removeAttribute("data-testid");
    document.body.append(unknown);
    expect(latestHandoff(document, new Set())).toBeUndefined();
  });
  it("accepts only new completed assistant markers, excluding old/user/unmarked turns and streaming", () => {
    const document = page(turn("old"));
    const ignored = assistantIds(document);
    expect(latestHandoff(document, ignored)).toBeUndefined();
    document.body.insertAdjacentHTML("beforeend", turn("plain", JSON.stringify(handoff)));
    expect(latestHandoff(document, ignored)).toBeUndefined();
    document.body.insertAdjacentHTML("beforeend", turn("user", frameHandoff(handoff), "user"));
    expect(latestHandoff(document, ignored)).toBeUndefined();
    document.body.insertAdjacentHTML("beforeend", turn("fresh"));
    expect(latestHandoff(document, ignored)?.source).toBe(frameHandoff(handoff));
    document.body.insertAdjacentHTML("beforeend", '<button data-testid="stop-button"></button>');
    expect(latestHandoff(document, ignored)).toBeUndefined();
    document.querySelector('[data-testid="stop-button"]')?.remove();
    document.querySelector("article:last-child button")?.remove();
    expect(latestHandoff(document, ignored)).toBeUndefined();
  });
  it("extracts only the delimited data, not surrounding prose, and supports plain rendered text", () => {
    const text = `Unrelated prose must stay here\n${frameHandoff(handoff)}\nMore commentary`;
    expect(extractHandoffBlock(text)).toBe(frameHandoff(handoff));
    const document = page(turn("new"));
    const message = document.querySelector('[data-message-author-role="assistant"]');
    if (!message) throw new Error("Missing fixture message");
    message.textContent = text;
    expect(latestHandoff(document, new Set())?.source).toBe(frameHandoff(handoff));
    expect(() => parseHandoff(text, projectId, runId)).toThrow("边界");
    const legacy = page(turn("legacy", JSON.stringify(handoff)));
    legacy.querySelector("code")?.classList.add("language-veyra-handoff");
    expect(latestHandoff(legacy, new Set())).toBeUndefined();
  });
  it.each([
    "VEYRA_HANDOFF_BEGIN\n{}",
    "{}\nVEYRA_HANDOFF_END",
    "VEYRA_HANDOFF_END\n{}\nVEYRA_HANDOFF_BEGIN",
    "VEYRA_HANDOFF_BEGIN {} VEYRA_HANDOFF_END",
    `${frameHandoff({})}\n${frameHandoff({})}`,
    `VEYRA_HANDOFF_BEGIN\n${frameHandoff({})}\nVEYRA_HANDOFF_END`,
  ])("refuses ambiguous, incomplete or misplaced boundaries: %s", (text) => {
    expect(() => latestHandoff(page(turn("new", text)), new Set())).toThrow();
  });
  it("validates schema, identity, JSON, size and planner/reviewer provenance without evaluation", () => {
    expect(parseHandoff(frameHandoff(handoff), projectId, runId)).toEqual(handoff);
    for (const value of [
      { ...handoff, commands: ["evil"] },
      { ...handoff, runId: "wrong" },
      { ...handoff, projectId: runId },
      { ...handoff, provenance: { ...handoff.provenance, role: "human" } },
    ])
      expect(() => parseHandoff(frameHandoff(value), projectId, runId)).toThrow();
    expect(() =>
      parseHandoff(`VEYRA_HANDOFF_BEGIN\n{bad JSON}\nVEYRA_HANDOFF_END`, projectId, runId),
    ).toThrow("JSON");
    expect(() => parseHandoff(frameHandoff("x".repeat(65537)), projectId, runId)).toThrow("64 KiB");
    expect(() => parseHandoff("globalThis.stolen = true", projectId, runId)).toThrow();
    expect(extractHandoffBlock("Please implement this task now")).toBeUndefined();
  });
  it("does not overwrite drafts or attachments or send after navigation or disabled binding", async () => {
    const document = page('<div id="prompt-textarea" contenteditable="true">User draft</div>');
    const send = (url = conversation, bound = true) =>
      sendToConversation(
        document,
        () => url,
        conversation,
        "result",
        "id",
        () => bound,
      );
    expect(canCompose(document)).toBe(false);
    expect(await send()).toBe("deferred");
    expect(document.querySelector("#prompt-textarea")?.textContent).toBe("User draft");
    (document.querySelector("#prompt-textarea") as HTMLElement).textContent = "";
    expect(await send(`${conversation}wrong`)).toBe("deferred");
    expect(await send(conversation, false)).toBe("deferred");
    document.body.insertAdjacentHTML("beforeend", '<div data-testid="composer-attachment"></div>');
    expect(canCompose(document)).toBe(false);
  });
  it("validates loopback invitation and grant separately without allowing credentials from the page", () => {
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
      projectIds: [projectId],
    };
    expect(parsePairing(value)).toEqual(value);
    const { token, ...base } = value;
    expect(parseInvitation({ ...base, code: token })).toMatchObject({ code: token });
    expect(() => parseInvitation(value)).toThrow();
    for (const replacement of [
      { url: "https://public.test:3181" },
      { url: "http://localhost:3181" },
      { url: "http://127.0.0.1:99999" },
      { origin: "https://chatgpt.com" },
      { expiresAt: 0 },
      { expiresAt: Infinity },
      { token: "short" },
      { projectIds: [] },
      { projectIds: ["guessed-project"] },
      { cookie: "secret" },
    ])
      expect(() => parsePairing({ ...value, ...replacement })).toThrow();
  });
});
