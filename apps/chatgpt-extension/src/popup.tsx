import { I18nProvider } from "@veyraoss/ui";
import { startExtensionUI } from "./ui-locale.js";
import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { object } from "./contracts.js";
import { surfaceCall } from "./panel-store.js";
import { supportsPanel } from "./surfaces.js";
import { LauncherView, type LauncherState } from "./launcher-view.js";
import { watchPopup } from "./popup-refresh.js";
import "@veyraoss/ui/styles.css";
import "./launcher.css";
function Launcher() {
  const [state, setState] = useState<LauncherState>({ status: "Needs attention", allowed: false });
  const [tabId, setTabId] = useState<number>();
  useEffect(() => {
    let alive = true;
    const refresh = async (inspect = false) => {
      try {
        const tab = (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
        const data = await surfaceCall(inspect ? "status" : "snapshot");
        if (!alive || !object(data)) return;
        const binding = data.currentBound && object(data.binding) ? data.binding : undefined;
        setTabId(tab?.id);
        const working =
          data.enabled &&
          binding &&
          ["running", "dispatching", "ready_to_deliver", "delivering"].includes(
            String(binding.phase),
          );
        setState({
          allowed: supportsPanel(tab?.url),
          status: working
            ? "Working"
            : object(data.readiness) && data.readiness.ready === true
              ? "Ready"
              : !data.currentBound &&
                  object(data.connectivity) &&
                  data.connectivity.status === "connected"
                ? "Awaiting binding"
                : "Needs attention",
          project: typeof binding?.projectName === "string" ? binding.projectName : undefined,
        });
      } catch {
        if (alive) setState((current) => ({ ...current, status: "Needs attention" }));
      }
    };
    void refresh(true);
    const stop = watchPopup(() => {
      void refresh();
    });
    return () => {
      alive = false;
      stop();
    };
  }, []);
  return (
    <LauncherView
      state={state}
      open={() => {
        if (tabId === undefined || !state.allowed) return;
        // Keep the open call directly in the trusted click handler to preserve Chrome's user gesture.
        void chrome.sidePanel.open({ tabId }).then(
          () => window.close(),
          () => setState((current) => ({ ...current, error: true })),
        );
      }}
      diagnostics={() => {
        void chrome.tabs.create({ url: chrome.runtime.getURL("diagnostics.html") });
      }}
    />
  );
}
startExtensionUI((locale) => {
  createRoot(document.getElementById("root") as HTMLElement).render(
    <I18nProvider store={locale}>
      <Launcher />
    </I18nProvider>,
  );
});
