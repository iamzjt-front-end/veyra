import { BridgeController, type SessionState } from "./controller.js";

const host = {
  read: async () => ((await chrome.storage.session.get("state")).state as SessionState) ?? {},
  save: async (state: SessionState) => {
    await chrome.storage.session.set({ state });
  },
  activeTab: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? {},
  tab: (id: number) => chrome.tabs.get(id),
  send: (id: number, message: unknown) => chrome.tabs.sendMessage(id, message),
};
const controller = new BridgeController(host);
// Default session storage is not exposed to content scripts. Make that boundary explicit.
const ready = chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
let serial: Promise<unknown> = ready;
const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
  const result = serial.then(action);
  serial = result.catch(() => {});
  return result;
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0))
    return false;
  void enqueue(() => controller.handle(message, { url: sender.url, tabId: sender.tab?.id })).then(
    (data) => reply({ ok: true, data }),
    (error: unknown) =>
      reply({
        ok: false,
        error: error instanceof Error ? error.message.slice(0, 512) : "扩展操作失败。",
      }),
  );
  return true;
});
chrome.tabs.onRemoved.addListener((id) => {
  void enqueue(() => controller.detached(id));
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === "loading" || change.url) void enqueue(() => controller.detached(id));
});
