import { createRoot } from "react-dom/client";
import { PanelFixture } from "../../chatgpt-extension/dev/panel-fixture.js";
import { WorkspaceFixture } from "./workspace-fixture.js";
import { Brand, Icon } from "@veyraoss/ui";
import "@veyraoss/ui/styles.css";
import "../../chatgpt-extension/src/panel.css";
import "../../chatgpt-extension/src/launcher.css";
import "../src/styles.css";
import "./fixture.css";
const groups = {
  "Side Panel": [
    "unbound",
    "idle",
    "running",
    "verification",
    "completed",
    "failed",
    "paused",
    "cancelled",
    "no-projects",
    "project-missing",
    "codex-unavailable",
    "waiting-codex",
    "disconnected",
  ],
  "Control Center": [
    "overview",
    "projects",
    "project",
    "runs",
    "run",
    "failed",
    "settings",
    "empty",
    "missing",
    "disconnected",
    "large-projects",
    "large-runs",
  ],
};
function Gallery() {
  return (
    <main className="v-fixture-gallery">
      <Brand />
      <h1>A quieter way to build.</h1>
      <p>Veyra · Interactive UI fixtures</p>
      <div className="v-fixture-note">
        Fixed sample data for visual review. These views do not connect to your Projects, ChatGPT or
        Codex.
      </div>
      {Object.entries(groups).map(([label, states]) => (
        <section key={label}>
          <h2>{label}</h2>
          <div>
            {states.map((state) => (
              <a
                key={state}
                href={`/${label === "Side Panel" ? "side-panel" : "control-center"}/${state}`}
              >
                {state.replaceAll("-", " ")}
                <Icon name="arrow" />
              </a>
            ))}
          </div>
        </section>
      ))}
      <a href="/popup">
        Popup launcher <Icon name="arrow" />
      </a>
      <p>
        Append <code>?theme=dark</code> for a dark preview. Production UI follows the system font;{" "}
        <code>?fixed=1</code> pins fixture fonts for screenshot regression.
      </p>
    </main>
  );
}
const name = location.pathname.split("/").at(-1) || "overview";
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") ?? "light";
if (new URLSearchParams(location.search).has("fixed")) {
  await import("./fixed-fonts.css");
  document.documentElement.dataset.fixtureFont = "fixed";
}
createRoot(document.getElementById("root") as HTMLElement).render(
  location.pathname.startsWith("/side-panel/") || location.pathname === "/popup" ? (
    <PanelFixture name={name} />
  ) : location.pathname.startsWith("/control-center/") ? (
    <WorkspaceFixture name={name} />
  ) : (
    <Gallery />
  ),
);
