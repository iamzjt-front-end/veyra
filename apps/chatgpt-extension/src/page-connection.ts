import { conversationUrl, object } from "./contracts.js";

export const PAGE_CONNECTION_UNAVAILABLE =
  "The ChatGPT page connection is unavailable. Refresh this conversation, then bind again. This attempt did not send a task.";
export const PAGE_CONNECTION_CHANGED =
  "The selected conversation changed while connecting. Return to it and bind again. This attempt did not send a task.";
const missingReceiver = (error: unknown) =>
  error instanceof Error &&
  error.message === "Could not establish connection. Receiving end does not exist.";

/** Only explicit Bind/Resume preparation can attach a missing receiver. No write is retried. */
export async function sendToPage(tabId: number, message: unknown): Promise<unknown> {
  if (!object(message) || message.type !== "prepare")
    return chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  const conversation = message.conversation;
  if (typeof conversation !== "string" || conversationUrl(conversation) !== conversation)
    throw new Error(PAGE_CONNECTION_UNAVAILABLE);
  const current = async () => {
    const tab = await chrome.tabs.get(tabId);
    const active = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
    if (
      active?.id !== tabId ||
      conversationUrl(active.url ?? "") !== conversation ||
      conversationUrl(tab.url ?? "") !== conversation ||
      (tab.pendingUrl && conversationUrl(tab.pendingUrl) !== conversation)
    )
      throw new Error(PAGE_CONNECTION_CHANGED);
  };
  await current();
  let response: unknown;
  try {
    response = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  } catch (error) {
    if (!missingReceiver(error)) throw new Error(PAGE_CONNECTION_UNAVAILABLE, { cause: error });
    try {
      await current();
      // Read URL/Chrome document identity only, never conversation text. The isolated ticket
      // also stops a same-document SPA navigation from installing on a different conversation.
      const results = await chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: "ISOLATED",
        func: (expected: string) => {
          if (`${location.origin}${location.pathname}` !== expected) return;
          (window as Window & { __veyraPageTarget?: string }).__veyraPageTarget = expected;
          return location.href;
        },
        args: [conversation],
      });
      const probe = results[0];
      if (
        results.length !== 1 ||
        probe?.frameId !== 0 ||
        !probe.documentId ||
        typeof probe.result !== "string" ||
        conversationUrl(probe.result) !== conversation
      )
        throw new Error(PAGE_CONNECTION_CHANGED);
      await current();
      await chrome.scripting.executeScript({
        target: { tabId, documentIds: [probe.documentId] },
        files: ["content.js"],
        world: "ISOLATED",
      });
      await current();
      // One read-only handshake with the same document, never a bootstrap/dispatch replay.
      response = await chrome.tabs.sendMessage(tabId, message, { documentId: probe.documentId });
    } catch (error) {
      if (error instanceof Error && error.message === PAGE_CONNECTION_CHANGED) throw error;
      throw new Error(PAGE_CONNECTION_UNAVAILABLE, { cause: error });
    }
  }
  await current();
  if (
    !object(response) ||
    response.conversation !== conversation ||
    typeof response.epoch !== "string" ||
    !response.epoch
  )
    throw new Error(PAGE_CONNECTION_UNAVAILABLE);
  return response;
}
