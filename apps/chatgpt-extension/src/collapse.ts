import { translate, DEFAULT_LOCALE, isLocale, type Locale } from "@veyraoss/ui/i18n";
import { turnText } from "./page.js";
/** Cosmetic only: preserve React-owned nodes and allow immediate evidence expansion. */
export function collapseMachine(
  element: Element,
  label: string,
  locale: () => Locale = () => DEFAULT_LOCALE,
  track?: (button: HTMLButtonElement, update: () => void) => void,
) {
  if (!element.isConnected || element.getAttribute("data-veyra-folded") === "true") return;
  const button = element.ownerDocument.createElement("button");
  button.type = "button";
  button.style.cssText =
    "display:flex;align-items:center;gap:8px;max-width:100%;padding:12px 14px;margin:12px 0;border:1px solid color-mix(in srgb,currentColor 14%,transparent);border-radius:10px;background:transparent;color:inherit;font:500 12px/1.5 -apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;text-align:left;cursor:pointer";

  const update = () => {
    button.textContent = `${translate(locale(), label)} · ${translate(locale(), button.getAttribute("aria-expanded") === "true" ? "Hide raw payload" : "View raw payload")}`;
  };
  update();
  button.setAttribute("aria-expanded", "false");
  button.setAttribute("data-veyra-status", "true");
  const original = (element as HTMLElement).style.display;
  element.setAttribute("data-veyra-folded", "true");
  (element as HTMLElement).style.display = "none";
  element.before(button);
  button.addEventListener("click", () => {
    const expanded = button.getAttribute("aria-expanded") === "true";
    (element as HTMLElement).style.display = expanded ? "none" : original;
    button.setAttribute("aria-expanded", String(!expanded));
    update();
  });
  track?.(button, update);
}
export function collapseHandoff(
  document: Document,
  id: string,
  source: string,
  fold = collapseMachine,
  label = "Plan sent to Codex",
) {
  const owner = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!owner) return;
  for (const block of owner.querySelectorAll("pre")) {
    if (turnText(block).trim() === source.trim()) {
      fold(block, label);
      return;
    }
  }
  if (turnText(owner).trim() === source.trim()) fold(owner, label);
}

/** Track only controls created in this document; language changes never scan conversation text. */
export function machinePresentation() {
  let locale: Locale = DEFAULT_LOCALE;
  const controls = new Map<HTMLButtonElement, () => void>();
  const prune = () => {
    for (const button of controls.keys()) if (!button.isConnected) controls.delete(button);
  };
  const fold = (node: Element, label: string) =>
    collapseMachine(
      node,
      label,
      () => locale,
      (button, update) => {
        prune();
        if (controls.size < 512) controls.set(button, update);
      },
    );
  return {
    fold,
    handoff: (document: Document, id: string, source: string) =>
      collapseHandoff(document, id, source, fold),
    review: (document: Document, id: string, source: string) =>
      collapseHandoff(document, id, source, fold, "Review saved"),
    language: (value: unknown) => {
      if (!isLocale(value) || value === locale) return;
      locale = value;
      prune();
      for (const update of controls.values()) update();
    },
  };
}
