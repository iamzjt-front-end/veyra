import { isExtensionSurface, supportsPanel } from "./surfaces.js";
import { object } from "./contracts.js";
import { NativeClient } from "./native-client.js";
import { durableBindings } from "./persistence.js";
import { BridgeController, type SessionState } from "./controller.js";

let saving: Promise<void> = Promise.resolve();
const host = {
  read: async (): Promise<SessionState> => {
    await saving;
    const session = ((await chrome.storage.session.get("state")).state as SessionState) ?? {};
    const bindings =
      ((await chrome.storage.local.get("bindings")).bindings as SessionState["bindings"]) ?? {};
    return { ...session, bindings };
  },
  save: (state: SessionState) => {
    const captured = structuredClone(state);
    const write = saving.then(async () => {
      // Durable intent goes first: a crash after dispatch/claim cannot replay a write.
      await chrome.storage.local.set({ bindings: durableBindings(captured) });
      await chrome.storage.session.set({ state: captured });
    });
    saving = write.catch(() => {});
    return write;
  },
  activeTab: async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? {},
  tab: (id: number) => chrome.tabs.get(id),
  send: (id: number, message: unknown) => chrome.tabs.sendMessage(id, message),
};
const controller = new BridgeController(host, undefined, new NativeClient());
// Default session storage is not exposed to content scripts. Make that boundary explicit.
const ready = Promise.all([
  chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
]);
let serial: Promise<unknown> = ready;
const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
  const result = serial.then(action);
  serial = result.catch(() => {});
  return result;
};
chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || (sender.frameId !== undefined && sender.frameId !== 0))
    return false;
  const action = () => controller.handle(message, { url: sender.url, tabId: sender.tab?.id });
  const urgent =
    isExtensionSurface(sender.url) &&
    object(message) &&
    ["disable", "unbind"].includes(String(message.type));
  // Local detach must not wait behind a slow native request. Controller epochs prevent resurrection.
  void (urgent ? ready.then(action) : enqueue(action)).then(
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
  if (change.status === "complete")
    void enqueue(() => host.send(id, { type: "restore" }).catch(() => {}));
});

// Default is disabled; enable only tabs on the supported ChatGPT origin.
void chrome.sidePanel.setOptions({ enabled: false });
const updatePanel = (id: number, url?: string) =>
  chrome.sidePanel
    .setOptions({ tabId: id, path: "sidepanel.html", enabled: supportsPanel(url) })
    .catch(() => {});
chrome.tabs.onUpdated.addListener((id, change, tab) => {
  if (change.url || change.status === "complete") void updatePanel(id, tab.url);
});
chrome.runtime.onInstalled.addListener(() => {
  void chrome.tabs.query({ url: "https://chatgpt.com/*" }).then((tabs) => {
    for (const tab of tabs) if (tab.id !== undefined) void updatePanel(tab.id, tab.url);
  });
});
chrome.tabs.onActivated.addListener(({ tabId }) => {
  void chrome.tabs
    .get(tabId)
    .then((tab) => updatePanel(tabId, tab.url))
    .catch(() => {});
});
