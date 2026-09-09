import { useEffect, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { PanelStore } from "./panel-store.js";
import { PanelView } from "./panel-view.js";
import { watchPopup } from "./popup-refresh.js";
import "@veyraoss/ui/styles.css";
import "./panel.css";

const store = new PanelStore();
function Panel() {
  const state = useSyncExternalStore(store.subscribe, store.snapshot);
  useEffect(() => {
    const stop = watchPopup(() => {
      void store.refresh();
    });
    void store.connect();
    return () => {
      stop();
      store.close();
    };
  }, []);
  return (
    <PanelView
      state={state}
      actions={{
        select: (id) => {
          void store.select(id);
        },
        bind: () => {
          void store.act("bind");
        },
        pause: () => {
          void store.act(state.binding?.pausedByUser ? "resume" : "disable");
        },
        unbind: () => {
          void store.act("unbind");
        },
        cancel: () => {
          void store.act("stop");
        },
        reconnect: () => {
          void store.connect();
        },
        diagnostics: () => {
          void chrome.tabs.create({ url: chrome.runtime.getURL("diagnostics.html") });
        },
        theme: () => {
          const dark =
            document.documentElement.dataset.theme === "dark" ||
            (!document.documentElement.dataset.theme &&
              matchMedia("(prefers-color-scheme: dark)").matches);
          document.documentElement.dataset.theme = dark ? "light" : "dark";
          void chrome.storage.local.set({ theme: dark ? "light" : "dark" });
        },
      }}
    />
  );
}
void chrome.storage.local.get("theme").then(({ theme }) => {
  if (typeof theme === "string" && ["light", "dark"].includes(theme))
    document.documentElement.dataset.theme = theme;
});
createRoot(document.getElementById("root") as HTMLElement).render(<Panel />);
