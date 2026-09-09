/** Popup refreshes cached state only on change. Closing it removes listeners and pending work. */
export function watchPopup(refresh: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let closed = false;
  const changed = () => {
    if (closed || timer !== undefined) return;
    timer = setTimeout(() => {
      timer = undefined;
      if (!closed) refresh();
    }, 100);
  };
  const storage = (_changes: unknown, area: string) => {
    if (area === "session") changed();
  };
  chrome.storage.onChanged.addListener(storage);
  chrome.tabs.onActivated.addListener(changed);
  chrome.tabs.onUpdated.addListener(changed);
  window.addEventListener("focus", changed);
  const close = () => {
    closed = true;
    clearTimeout(timer);
    chrome.storage.onChanged.removeListener(storage);
    chrome.tabs.onActivated.removeListener(changed);
    chrome.tabs.onUpdated.removeListener(changed);
    window.removeEventListener("focus", changed);
    window.removeEventListener("pagehide", close);
  };
  window.addEventListener("pagehide", close);
  return close;
}
