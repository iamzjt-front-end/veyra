import { LocaleStore } from "@veyraoss/ui/i18n";
/** Locale is a trusted extension UI preference, separate from binding/auth and Project state. */
export async function extensionLocale() {
  const store = new LocaleStore({
    load: async () => (await chrome.storage.local.get("locale")).locale,
    save: async (locale) => {
      await chrome.storage.local.set({ locale });
    },
  });
  await store.initialize();
  const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
    if (area === "local" && changes.locale) store.accept(changes.locale.newValue);
  };
  chrome.storage.onChanged.addListener(changed);
  const apply = () => {
    document.documentElement.lang = store.snapshot().locale;
  };
  const unsubscribe = store.subscribe(apply);
  apply();
  window.addEventListener(
    "pagehide",
    () => {
      unsubscribe();
      chrome.storage.onChanged.removeListener(changed);
    },
    { once: true },
  );
  return store;
}
