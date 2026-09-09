import { createRoot } from "react-dom/client";
import { PanelFixture } from "./panel-fixture.js";
import "@veyraoss/ui/styles.css";
import "../src/panel.css";
import "../src/launcher.css";
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
createRoot(document.getElementById("root") as HTMLElement).render(
  <PanelFixture name={location.pathname.split("/").at(-1) || "unbound"} />,
);
