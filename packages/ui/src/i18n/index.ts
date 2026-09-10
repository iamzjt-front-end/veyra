import { chinese } from "./messages.js";
export { chinese } from "./messages.js";
export type Locale = "zh-CN" | "en";
export const DEFAULT_LOCALE: Locale = "zh-CN";
export const isLocale = (value: unknown): value is Locale => value === "zh-CN" || value === "en";
export type Parameters = Readonly<Record<string, string | number>>;
/** Translate only known interface copy; never rewrite project content, code or protocol fields. */
export function translate(locale: Locale, source: string, parameters: Parameters = {}): string {
  const text =
    locale === "zh-CN" && Object.hasOwn(chinese, source) ? (chinese[source] ?? source) : source;
  return text.replace(/\{([a-zA-Z]+)\}/g, (match, key: string) =>
    Object.hasOwn(parameters, key) ? String(parameters[key]) : match,
  );
}
export interface LocalePersistence {
  load: () => Promise<unknown>;
  save: (locale: Locale) => Promise<void>;
}
/** An explicitly owned UI preference store. No polling and no execution/Project authority. */
export class LocaleStore {
  private value: { locale: Locale; saveFailed: boolean };
  private listeners = new Set<() => void>();
  private revision = 0;
  private writes = Promise.resolve();
  constructor(
    private readonly persistence?: LocalePersistence,
    initial: Locale = DEFAULT_LOCALE,
  ) {
    this.value = { locale: initial, saveFailed: false };
  }
  snapshot = () => this.value;
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private update(locale: Locale, saveFailed = false) {
    if (this.value.locale === locale && this.value.saveFailed === saveFailed) return;
    this.value = { locale, saveFailed };
    for (const listener of this.listeners) listener();
  }
  async initialize() {
    const revision = this.revision;
    try {
      const value = await this.persistence?.load();
      if (revision === this.revision && isLocale(value)) this.update(value);
    } catch {
      // A missing preference keeps the explicit Chinese default; it never changes run readiness.
    }
  }
  accept = (value: unknown) => {
    if (!isLocale(value)) return;
    this.revision++;
    this.update(value);
  };
  set = (locale: Locale) => {
    if (!isLocale(locale) || (locale === this.value.locale && !this.value.saveFailed)) return;
    const revision = ++this.revision;
    this.update(locale);
    this.writes = this.writes.then(async () => {
      try {
        await this.persistence?.save(locale);
      } catch {
        if (revision === this.revision) this.update(locale, true);
      }
    });
  };
  settled = () => this.writes;
}
