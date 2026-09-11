import { useState } from "react";
import { useI18n } from "@veyraoss/ui";
import { PanelView } from "../src/panel-view.js";
import { LauncherView } from "../src/launcher-view.js";
import { panelFixture } from "./fixtures.js";
export function PanelFixture({ name }: { name: string }) {
  const { locale } = useI18n();
  const [state, setState] = useState(() => panelFixture(name));
  const conversation = {
    id: "01a07a2c-85ca-79e1-99e2-28f5b690498d",
    title: "确认旧代码已删除",
    root: "/Users/example/Projects/etf-quant-monitor",
  };
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
        discoverConversations: () =>
          setState({ ...state, codexChoices: [conversation], codexCursor: null }),
        chooseConversation: (nativeConversation) =>
          setState({ ...state, nativeConversation, projectId: "", selected: undefined }),
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
