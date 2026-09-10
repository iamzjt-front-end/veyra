import { conversationUrl } from "./contracts.js";

interface Lifetime {
  alive(): boolean;
  dispose(): void;
}
/** This lease lives only in the extension's isolated world for this document. */
export function installContentOnce(start: (restore: boolean) => () => void): void {
  const scope = window as Window & {
    __veyraPageTarget?: string;
    __veyraContent?: Lifetime;
  };
  const expected = scope.__veyraPageTarget;
  delete scope.__veyraPageTarget;
  if (expected !== undefined && conversationUrl(location.href) !== expected) return;
  const runtime = chrome.runtime;
  const id = runtime.id;
  if (!id) return;
  if (scope.__veyraContent?.alive()) return;
  scope.__veyraContent?.dispose();
  const dispose = start(expected === undefined);
  scope.__veyraContent = {
    alive: () => {
      try {
        return runtime.id === id;
      } catch {
        return false;
      }
    },
    dispose,
  };
}
