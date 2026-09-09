import { turnText } from "./page.js";
/** Cosmetic only: preserve React-owned nodes and allow immediate evidence expansion. */
export function collapseMachine(element: Element, label: string) {
  if (!element.isConnected || element.getAttribute("data-veyra-folded") === "true") return;
  const button = element.ownerDocument.createElement("button");
  button.type = "button";
  button.textContent = `${label} · Show details`;
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
    button.textContent = `${label} · ${expanded ? "Show" : "Hide"} details`;
  });
}
export function collapseHandoff(document: Document, id: string, source: string) {
  const owner = document.querySelector(`[data-message-id="${CSS.escape(id)}"]`);
  if (!owner) return;
  for (const block of owner.querySelectorAll("pre")) {
    if (turnText(block).trim() === source.trim()) {
      collapseMachine(block, "Plan sent to Codex");
      return;
    }
  }
  if (turnText(owner).trim() === source.trim()) collapseMachine(owner, "Plan sent to Codex");
}
