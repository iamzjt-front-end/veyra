import { DEFAULT_LOCALE, isLocale, type Locale } from "@veyraoss/ui/i18n";
import { isExtensionSurface, supportsPanel } from "./surfaces.js";
import { object } from "./contracts.js";
import { NativeClient } from "./native-client.js";
import { durableBindings } from "./persistence.js";
import { BridgeController, type SessionState } from "./controller.js";
import { sendToPage } from "./page-connection.js";
import { extensionStorage } from "./storage.js";

let locale: Locale = DEFAULT_LOCALE;
let saving: Promise<void> = Promise.resolve();
const host = {
  read: async (): Promise<SessionState> => {
    const storage = await ready;
    await saving;
    const session = ((await storage.session.get("state")).state as SessionState) ?? {};
    const bindings =
      ((await storage.local.get("bindings")).bindings as SessionState["bindings"]) ?? {};
    return { ...session, bindings };
  },
  save: (state: SessionState) => {
    const captured = structuredClone(state);
    const write = saving.then(async () => {
      const storage = await ready;
      // Durable intent goes first: a crash after dispatch/claim cannot replay a write.
      await storage.local.set({ bindings: durableBindings(captured) });
      await storage.session.set({ state: captured });
    });
    saving = write.catch(() => {});
    return write;
  },
  activeTab: async (): Promise<Partial<chrome.tabs.Tab>> =>
    (await chrome.tabs.query({ active: true, currentWindow: true }))[0] ?? {},
  tab: (id: number) => chrome.tabs.get(id),
  send: (id: number, message: unknown) =>
    sendToPage(id, object(message) ? { ...message, locale } : message),
};
const controller = new BridgeController(host, undefined, new NativeClient());
// Default session storage is not exposed to content scripts. Make that boundary explicit.
const ready = extensionStorage().then(async (storage) => {
  await Promise.all([
    storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
    storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" }),
  ]);
  const data = await storage.local.get("locale");
  if (isLocale(data.locale)) locale = data.locale;
  return storage;
});
// Register wake-up listeners synchronously. A startup failure is returned to callers,
// not an uncaught exception that leaves the worker without a receiving end.
void ready.catch(() => {});
let serial: Promise<unknown> = Promise.resolve();
const enqueue = <T>(action: () => Promise<T>): Promise<T> => {
  const result = serial.then(async () => {
    // A previous rejected request must not remove the initialization gate.
    await ready;
    return action();
  });
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
  void enqueue(() => controller.detached(id)).catch(() => {});
});
chrome.tabs.onUpdated.addListener((id, change) => {
  if (change.status === "loading" || change.url)
    void enqueue(() => controller.detached(id)).catch(() => {});
  if (change.status === "complete")
    void enqueue(() => host.send(id, { type: "restore" })).catch(() => {});
});

// Default is disabled; enable only tabs on the supported ChatGPT origin.
void chrome.sidePanel.setOptions({ enabled: false }).catch(() => {});
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

function onStorageChanged(changes: Record<string, chrome.storage.StorageChange>, area: string) {
  if (area !== "local" || !isLocale(changes.locale?.newValue)) return;
  locale = changes.locale.newValue;
  // A cosmetic event for the current supported tab only; no history reads or controller actions.
  void host
    .activeTab()
    .then((tab) => {
      if (tab.id !== undefined && supportsPanel(tab.url))
        return host.send(tab.id, { type: "locale" });
    })
    .catch(() => {});
}
// Normally register synchronously for cold-worker events; late API availability
// defers only this cosmetic locale listener, never the message/safety listeners.
if (globalThis.chrome?.storage?.onChanged) chrome.storage.onChanged.addListener(onStorageChanged);
else void ready.then((storage) => storage.onChanged.addListener(onStorageChanged)).catch(() => {});
