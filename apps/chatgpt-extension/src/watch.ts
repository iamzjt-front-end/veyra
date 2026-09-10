import { assistantId, assistantIds, conversationTurn, generating, turnText } from "./page.js";
import { extractHandoffBlock } from "./contracts.js";

const assistant = '[data-message-author-role="assistant"]';
const composer =
  '#prompt-textarea, [data-testid="composer-attachment"], [data-testid="file-thumbnail"], [data-testid="composer-file"]';
const completion = '[data-testid="copy-turn-action-button"]';
const streaming =
  '[data-testid="stop-button"], [data-testid="stop-generation-button"], .result-streaming, [data-is-streaming="true"]';

function wasStreaming(record: MutationRecord): boolean {
  if (record.type !== "attributes") return false;
  switch (record.attributeName) {
    case "data-testid":
      return ["stop-button", "stop-generation-button"].includes(record.oldValue ?? "");
    case "data-is-streaming":
      return record.oldValue === "true";
    case "class":
      return (record.oldValue ?? "").split(/\s+/).includes("result-streaming");
    default:
      return false;
  }
}

/** One identity snapshot on explicit binding; thereafter inspect only changed/new subtrees. */
export function watchConversation(
  document: Document,
  onHandoff: (turn: { id: string; source: string }) => void,
  onComposer: () => void,
  onError: (error: unknown) => void,
  active: () => boolean = () => true,
): () => void {
  const ignored = assistantIds(document);
  let newest: Element | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const consider = (element: Element) => {
    const id = assistantId(element);
    if (!id || ignored.has(id)) return;
    if (
      !newest?.isConnected ||
      element === newest ||
      (newest.compareDocumentPosition(element) & 4) !== 0
    )
      newest = element;
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!newest?.isConnected) return;
    const turn = conversationTurn(newest);
    if (!turn?.querySelector(completion) || generating(document)) return;
    // One bounded quiet-period debounce after the completion toolbar appears. Streaming
    // text never gets read; a mutation burst only resets this one pending check.
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || !active() || !newest?.isConnected || generating(document)) return;
      const current = newest;
      const id = assistantId(current);
      const turn = conversationTurn(current);
      if (!id || ignored.has(id) || !turn?.querySelector(completion)) return;
      try {
        const source = extractHandoffBlock(turnText(current));
        ignored.add(id);
        newest = undefined;
        if (source !== undefined) onHandoff({ id, source });
      } catch (error) {
        onError(error);
      }
    }, 400);
  };
  const observer = new MutationObserver((records) => {
    if (stopped || !active()) return;
    let changed = false;
    let composerChanged = false;
    for (const record of records) {
      const target =
        record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
      if (!target) continue;
      if (target.closest(composer)) {
        composerChanged = true;
        continue;
      }
      const owner = target.closest(assistant);
      if (owner) {
        consider(owner);
        if (owner === newest) changed = true;
        // No queries inside old history or every token of a streaming answer.
        continue;
      }
      if (newest && conversationTurn(newest)?.contains(target)) changed = true;
      // React can turn the existing Stop control into Send/Voice without removing it.
      // Its old streaming attribute is the completion event; there may be no later DOM change.
      if (target.matches(streaming) || wasStreaming(record)) {
        changed = true;
        composerChanged = true;
      }
      for (const node of [...record.addedNodes, ...record.removedNodes]) {
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        if (element.matches(composer)) composerChanged = true;
        if (element.matches(streaming) || element.querySelector(streaming)) {
          changed = true;
          composerChanged = true;
        }
        if (!element.isConnected) continue;
        if (element.matches(assistant)) {
          consider(element);
          changed = true;
        } else
          for (const child of element.querySelectorAll(assistant)) {
            consider(child);
            changed = true;
          }
        if (element.matches(completion) || element.querySelector(completion)) changed = true;
      }
    }
    if (changed) schedule();
    if (composerChanged) onComposer();
  });
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeOldValue: true,
    attributeFilter: [
      "data-message-id",
      "data-message-author-role",
      "data-testid",
      "data-is-streaming",
      "class",
      "aria-disabled",
    ],
  });
  const input = (event: Event) => {
    if (active() && (event.target as Element | null)?.closest?.(composer)) onComposer();
  };
  document.addEventListener("input", input, true);
  return () => {
    stopped = true;
    clearTimeout(timer);
    observer.disconnect();
    document.removeEventListener("input", input, true);
  };
}

/** Only active runs schedule reads: 1, 2, 4, 8, 15 seconds, reset on a status change. */
export class RunBackoff {
  private timer?: ReturnType<typeof setTimeout>;
  private delay = 1000;
  private last?: string;
  private generation = 0;
  constructor(private readonly poll: () => Promise<string | undefined>) {}
  start() {
    this.stop();
    const generation = this.generation;
    const schedule = () => {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        void this.poll().then((status) => {
          if (generation !== this.generation || status === undefined) return;
          this.delay =
            this.last === undefined || this.last === status
              ? Math.min(this.delay * 2, 15000)
              : 1000;
          this.last = status;
          schedule();
        });
      }, this.delay);
    };
    schedule();
  }
  stop() {
    this.generation++;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.delay = 1000;
    this.last = undefined;
  }
}
