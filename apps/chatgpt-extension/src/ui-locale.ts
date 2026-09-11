import { LocaleStore, translate } from "@veyraoss/ui/i18n";
import { extensionStorage, STORAGE_UNAVAILABLE } from "./storage.js";
/** Locale is a trusted extension UI preference, separate from binding/auth and Project state. */
export async function extensionLocale() {
  const storage = await extensionStorage();
  const preferences = await storage.local.get(["locale", "theme"]);
  if (preferences.theme === "light" || preferences.theme === "dark")
    document.documentElement.dataset.theme = preferences.theme;
  const store = new LocaleStore({
    load: async () => preferences.locale,
    save: async (locale) => {
      await storage.local.set({ locale });
    },
  });
  await store.initialize();
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes.locale) store.accept(changes.locale.newValue);
  };
  storage.onChanged.addListener(changed);
  const apply = () => {
    document.documentElement.lang = store.snapshot().locale;
  };
  const unsubscribe = store.subscribe(apply);
  apply();
  window.addEventListener(
    "pagehide",
    () => {
      unsubscribe();
      storage.onChanged.removeListener(changed);
    },
    { once: true },
  );
  return store;
}

/** A failed startup must leave a visible, non-operating surface instead of a blank
 * panel or an uncaught storage exception. Recovery requires a fresh user action. */
export function startExtensionUI(mount: (locale: LocaleStore) => void) {
  void extensionLocale()
    .then(mount)
    .catch((error: unknown) => {
      const locale = document.documentElement.lang === "en" ? "en" : "zh-CN";
      const alert = document.createElement("section");
      alert.setAttribute("role", "alert");
      alert.dataset.veyraStartupError = "true";
      const message = document.createElement("p");
      message.textContent = translate(
        locale,
        error instanceof Error ? error.message : STORAGE_UNAVAILABLE,
      );
      const retry = document.createElement("button");
      retry.textContent = translate(locale, "Reopen Veyra");
      retry.addEventListener("click", () => location.reload());
      alert.append(message, retry);
      document.body.replaceChildren(alert);
    });
}
