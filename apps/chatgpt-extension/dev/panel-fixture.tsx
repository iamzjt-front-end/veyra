import { useState } from "react";
import { useI18n } from "@veyraoss/ui";
import { PanelView } from "../src/panel-view.js";
import { LauncherView } from "../src/launcher-view.js";
import { panelFixture } from "./fixtures.js";
export function PanelFixture({ name }: { name: string }) {
  const { locale } = useI18n();
  const [state, setState] = useState(() => panelFixture(name));
  if (name === "popup")
    return (
      <LauncherView
        state={{ status: "Ready", project: "veyra-pro-proof", allowed: true }}
        open={() => {
          location.href = `/side-panel/unbound?lang=${locale}`;
        }}
        diagnostics={() => {}}
      />
    );
  return (
    <PanelView
      state={state}
      actions={{
        select: (projectId) => setState({ ...state, projectId }),
        bind: () => setState(panelFixture("idle")),
        pause: () => setState(panelFixture(state.binding?.pausedByUser ? "running" : "paused")),
        unbind: () => setState(panelFixture("unbound")),
        cancel: () => setState(panelFixture("cancelled")),
        reconnect: () => setState(panelFixture("unbound")),
        diagnostics: () => {},
        theme: () => {
          document.documentElement.dataset.theme =
            document.documentElement.dataset.theme === "dark" ? "light" : "dark";
        },
      }}
    />
  );
}
