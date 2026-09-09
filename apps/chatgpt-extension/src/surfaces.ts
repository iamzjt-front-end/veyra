import { EXTENSION_ORIGIN } from "./contracts.js";
/** Only extension-owned pages get UI authority; page/content messages retain their epoch checks. */
export function isExtensionSurface(value?: string): boolean {
  try {
    const url = new URL(value ?? "");
    return (
      `${url.protocol}//${url.host}` === EXTENSION_ORIGIN &&
      ["/popup.html", "/sidepanel.html", "/diagnostics.html"].includes(url.pathname) &&
      !url.search
    );
  } catch {
    return false;
  }
}
export function supportsPanel(value?: string): boolean {
  try {
    return new URL(value ?? "").origin === "https://chatgpt.com";
  } catch {
    return false;
  }
}
