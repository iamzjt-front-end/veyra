import { I18nProvider, LocaleStore, isLocale, LanguageSelect, useI18n } from "@veyraoss/ui";
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
    "review-approved",
    "review-changes",
    "review-human",
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
const stateNames: Record<string, string> = {
  unbound: "Unbound",
  idle: "Ready",
  running: "Working",
  verification: "Verification",
  completed: "Completed",
  failed: "Failed",
  "review-approved": "Approved",
  "review-changes": "Needs changes",
  "review-human": "Needs your decision",
  paused: "Paused",
  cancelled: "Cancelled",
  "no-projects": "No Projects",
  "project-missing": "Project location unavailable",
  "codex-unavailable": "Codex needs your attention",
  "waiting-codex": "Waiting for Codex",
  disconnected: "Disconnected",
  overview: "Overview",
  projects: "Projects",
  project: "Project",
  runs: "Run history",
  run: "Run details",
  settings: "Settings",
  empty: "No Projects",
  missing: "Project location unavailable",
  "large-projects": "3,000 Projects",
  "large-runs": "3,000 runs",
};
function Gallery() {
  const { t, locale } = useI18n();
  return (
    <main className="v-fixture-gallery">
      <Brand />
      <LanguageSelect />
      <h1>{t("A quieter way to build.")}</h1>
      <p>{t("Veyra · Interactive UI fixtures")}</p>
      <div className="v-fixture-note">
        {t(
          "Fixed sample data for visual review. These views do not connect to your Projects, ChatGPT or Codex.",
        )}
      </div>
      {Object.entries(groups).map(([label, states]) => (
        <section key={label}>
          <h2>{t(label)}</h2>
          <div>
            {states.map((state) => (
              <a
                key={state}
                href={`/${label === "Side Panel" ? "side-panel" : "control-center"}/${state}?lang=${locale}`}
              >
                {t(stateNames[state] ?? state)}
                <Icon name="arrow" />
              </a>
            ))}
          </div>
        </section>
      ))}
      <a href={`/popup?lang=${locale}`}>
        {t("Popup launcher")} <Icon name="arrow" />
      </a>
      <p>{t("Use theme=dark for a dark preview and fixed=1 for fixed screenshot fonts.")}</p>
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
const requestedLocale = new URLSearchParams(location.search).get("lang");
const language = new LocaleStore(
  {
    load: async () => localStorage.getItem("veyra-locale"),
    save: async (locale) => {
      localStorage.setItem("veyra-locale", locale);
    },
  },
  isLocale(requestedLocale) ? requestedLocale : undefined,
);
if (!isLocale(requestedLocale)) await language.initialize();
createRoot(document.getElementById("root") as HTMLElement).render(
  <I18nProvider store={language}>
    {location.pathname.startsWith("/side-panel/") || location.pathname === "/popup" ? (
      <PanelFixture name={name} />
    ) : location.pathname.startsWith("/control-center/") ? (
      <WorkspaceFixture name={name} />
    ) : (
      <Gallery />
    )}
  </I18nProvider>,
);
