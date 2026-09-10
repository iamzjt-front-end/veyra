import { afterEach, expect, it, vi } from "vitest";
import { sendToPage } from "../src/page-connection.js";

const conversation = "https://chatgpt.com/c/8e7dc509-d7f1-4d0a-958c-8c98ff011e64";
const another = "https://chatgpt.com/c/62bf60b0-5646-4195-9f47-a4ea70140859";
const missing = "Could not establish connection. Receiving end does not exist.";
const message = { type: "prepare", conversation, locale: "zh-CN" };
const response = { epoch: "document-epoch", conversation };
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const tab = { id: 1, url: conversation };
  const active = { ...tab };
  const sendMessage = vi.fn().mockResolvedValue(response);
  const executeScript = vi
    .fn()
    .mockResolvedValue([{ frameId: 0, documentId: "original-document", result: conversation }]);
  vi.stubGlobal("chrome", {
    tabs: {
      get: vi.fn(async () => ({ ...tab })),
      query: vi.fn(async () => [{ ...active }]),
      sendMessage,
    },
    scripting: { executeScript },
  });
  return { tab, active, sendMessage, executeScript };
}
it("uses an existing main-frame receiver without injection or periodic work", async () => {
  const f = fixture();
  await expect(sendToPage(1, message)).resolves.toEqual(response);
  expect(f.sendMessage).toHaveBeenCalledExactlyOnceWith(1, message, { frameId: 0 });
  expect(f.executeScript).not.toHaveBeenCalled();
});
it("attaches only to the confirmed main document and repeats only its read-only prepare", async () => {
  const f = fixture();
  f.sendMessage.mockRejectedValueOnce(new Error(missing));
  await expect(sendToPage(1, message)).resolves.toEqual(response);
  expect(f.executeScript).toHaveBeenCalledTimes(2);
  expect(f.executeScript.mock.calls[0]?.[0]).toMatchObject({
    target: { tabId: 1, frameIds: [0] },
    world: "ISOLATED",
  });
  expect(f.executeScript.mock.calls[1]?.[0]).toEqual({
    target: { tabId: 1, documentIds: ["original-document"] },
    files: ["content.js"],
    world: "ISOLATED",
  });
  expect(f.sendMessage.mock.calls[1]).toEqual([1, message, { documentId: "original-document" }]);
});
it.each(["arm", "restore", "disarm", "locale"])(
  "never injects or replays %s messages",
  async (type) => {
    const f = fixture();
    f.sendMessage.mockRejectedValue(new Error(missing));
    await expect(sendToPage(1, { ...message, type })).rejects.toThrow(missing);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
    expect(f.executeScript).not.toHaveBeenCalled();
  },
);
it("does not treat a lost response or malformed reply as an absent receiver", async () => {
  const f = fixture();
  f.sendMessage.mockRejectedValueOnce(
    new Error("The message port closed before a response was received."),
  );
  await expect(sendToPage(1, message)).rejects.toThrow();
  f.sendMessage.mockResolvedValueOnce({ conversation: another, epoch: "foreign" });
  await expect(sendToPage(1, message)).rejects.toThrow();
  expect(f.sendMessage).toHaveBeenCalledTimes(2);
  expect(f.executeScript).not.toHaveBeenCalled();
});
it.each(["background-tab", "different-conversation", "unsupported-url"])(
  "refuses %s before attachment",
  async (mode) => {
    const f = fixture();
    if (mode === "background-tab") f.active.id = 2;
    else f.tab.url = f.active.url = mode === "unsupported-url" ? "https://example.com/" : another;
    await expect(sendToPage(1, message)).rejects.toThrow();
    expect(f.sendMessage).not.toHaveBeenCalled();
    expect(f.executeScript).not.toHaveBeenCalled();
  },
);
it("rejects navigation during the main-document probe without attaching the bridge", async () => {
  const f = fixture();
  f.sendMessage.mockRejectedValueOnce(new Error(missing));
  f.executeScript.mockImplementationOnce(async () => {
    f.tab.url = f.active.url = another;
    return [{ frameId: 0, documentId: "original-document", result: conversation }];
  });
  await expect(sendToPage(1, message)).rejects.toThrow();
  expect(f.executeScript).toHaveBeenCalledTimes(1);
  expect(f.sendMessage).toHaveBeenCalledTimes(1);
});
it.each(["foreign-url", "subframe", "no-document-id"])(
  "rejects a %s probe result",
  async (mode) => {
    const f = fixture();
    f.sendMessage.mockRejectedValueOnce(new Error(missing));
    f.executeScript.mockResolvedValueOnce([
      {
        frameId: mode === "subframe" ? 2 : 0,
        documentId: mode === "no-document-id" ? undefined : "original-document",
        result: mode === "foreign-url" ? another : conversation,
      },
    ]);
    await expect(sendToPage(1, message)).rejects.toThrow();
    expect(f.executeScript).toHaveBeenCalledTimes(1);
    expect(f.sendMessage).toHaveBeenCalledTimes(1);
  },
);
it.each(["permission-denied", "document-replaced", "still-missing"])(
  "stops after one recovery attempt on %s",
  async (mode) => {
    const f = fixture();
    f.sendMessage.mockRejectedValue(new Error(missing));
    if (mode === "permission-denied")
      f.executeScript.mockRejectedValueOnce(new Error("Cannot access contents of the page."));
    if (mode === "document-replaced")
      f.executeScript
        .mockResolvedValueOnce([
          { frameId: 0, documentId: "original-document", result: conversation },
        ])
        .mockRejectedValueOnce(new Error("No document with id original-document"));
    await expect(sendToPage(1, message)).rejects.toThrow(/page connection/);
    expect(f.sendMessage).toHaveBeenCalledTimes(mode === "still-missing" ? 2 : 1);
    expect(f.executeScript.mock.calls.length).toBeLessThanOrEqual(2);
  },
);
