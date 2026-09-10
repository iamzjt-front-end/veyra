import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  DEFAULT_LOCALE,
  translate,
  type Locale,
  type LocaleStore,
  type Parameters,
} from "./index.js";
const Context = createContext({
  locale: DEFAULT_LOCALE,
  setLocale: (_locale: Locale) => {},
  saveFailed: false,
  t: (source: string, parameters?: Parameters) => translate(DEFAULT_LOCALE, source, parameters),
});
export function I18nProvider({ store, children }: { store: LocaleStore; children?: ReactNode }) {
  const value = useSyncExternalStore(store.subscribe, store.snapshot, store.snapshot);
  useEffect(() => {
    document.documentElement.lang = value.locale;
  }, [value.locale]);
  const context = useMemo(
    () => ({
      ...value,
      setLocale: store.set,
      t: (source: string, parameters?: Parameters) => translate(value.locale, source, parameters),
    }),
    [store, value],
  );
  return <Context.Provider value={context}>{children}</Context.Provider>;
}
export const useI18n = () => useContext(Context);
