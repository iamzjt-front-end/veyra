/** Popup refreshes cached state only on change. Closing it removes listeners and pending work. */
export function watchPopup(refresh: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const changed = () => {
    if (closed || document.hidden || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed && !document.hidden) refresh();
    }, 100);
  };
  const storage = (_changes: unknown, area: string) => {
    if (area === "session") changed();
  };
  chrome.storage.onChanged.addListener(storage);
  chrome.tabs.onActivated.addListener(changed);
  chrome.tabs.onUpdated.addListener(changed);
  window.addEventListener("focus", changed);
  const visibility = () => {
    if (document.hidden) {
      clearTimeout(timer);
      timer = undefined;
    } else changed();
  };
  document.addEventListener("visibilitychange", visibility);
  const close = () => {
    closed = true;
    clearTimeout(timer);
    chrome.storage.onChanged.removeListener(storage);
    chrome.tabs.onActivated.removeListener(changed);
    chrome.tabs.onUpdated.removeListener(changed);
    window.removeEventListener("focus", changed);
    window.removeEventListener("pagehide", close);
    document.removeEventListener("visibilitychange", visibility);
  };
  window.addEventListener("pagehide", close);
  return close;
}
