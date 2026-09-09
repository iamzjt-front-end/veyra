import { createRoot } from "react-dom/client";
import { useState } from "react";
import { PanelView } from "../src/panel-view.js";
import { panelFixture } from "./fixtures.js";
import "@veyraoss/ui/styles.css";
import "../src/panel.css";
const name = location.pathname.split("/").at(-1) || "unbound";
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
function Fixture() {
  const [state, setState] = useState(() => panelFixture(name));
  return (
    <PanelView
      state={state}
      actions={{
        select: (projectId) => setState({ ...state, projectId }),
        bind: () => setState(panelFixture("idle")),
        pause: () => setState(panelFixture("paused")),
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
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
