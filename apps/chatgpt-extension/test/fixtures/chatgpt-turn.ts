// Sanitized layout observed in the selected real ChatGPT conversation on 2026-09-10.
// The completion toolbar is a different branch from the assistant message's parent.
// No real conversation identifiers, history, handoff body or credentials are stored here.
export const sectionTurnMarkup = `<div>
  <div><div><div data-message-author-role="assistant"></div></div></div>
  <div data-conversation-screenshot-content><div><div role="group" aria-label="回复操作"></div></div></div>
</div>`;

export function sectionTurn(document: Document, id: string, source: string): Element {
  const turn = document.createElement("section");
  turn.setAttribute("data-testid", `conversation-turn-${id}`);
  turn.setAttribute("data-turn", "assistant");
  turn.innerHTML = sectionTurnMarkup;
  const message = turn.querySelector('[data-message-author-role="assistant"]');
  const actions = turn.querySelector('[role="group"]');
  if (!message || !actions) throw new Error("Invalid section fixture");
  message.setAttribute("data-message-id", id);
  message.textContent = source;
  const copy = document.createElement("button");
  copy.setAttribute("data-testid", "copy-turn-action-button");
  copy.setAttribute("aria-label", "复制回复");
  actions.append(copy);
  return turn;
}
