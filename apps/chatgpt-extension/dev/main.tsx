import { I18nProvider, LocaleStore, isLocale } from "@veyraoss/ui";
import { createRoot } from "react-dom/client";
import { PanelFixture } from "./panel-fixture.js";
import "@veyraoss/ui/styles.css";
import "../src/panel.css";
import "../src/launcher.css";
document.documentElement.dataset.theme =
  new URLSearchParams(location.search).get("theme") === "dark" ? "dark" : "light";
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
    <PanelFixture name={location.pathname.split("/").at(-1) || "unbound"} />
  </I18nProvider>,
);
