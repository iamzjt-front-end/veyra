import {
  assistantId,
  assistantIds,
  conversationTurn,
  turnText,
  generationSelector,
  hasGenerationSignal,
} from "./page.js";
import { extractHandoffBlock, extractMachineBlock } from "./contracts.js";
import type { PageObservation } from "./observation.js";

const assistant = '[data-message-author-role="assistant"]';
const composer =
  '#prompt-textarea, [data-testid="composer-attachment"], [data-testid="file-thumbnail"], [data-testid="composer-file"]';
const completion = '[data-testid="copy-turn-action-button"]';
const streaming = generationSelector;

/** A historical reply's styling is not a generation signal for the current turn.
 * Stop controls still block globally; unknown wrappers fail closed. No text is read. */
function generatingTurn(flags: Set<Element>, turn: Element): boolean {
  for (const element of flags) if (!element.isConnected) flags.delete(element);
  return hasGenerationSignal(flags, turn);
}

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
  onHandoff: (turn: { id: string; source: string; review?: string }) => void,
  onComposer: () => void,
  onError: (error: unknown) => void,
  active: () => boolean = () => true,
  restored = false,
  onObservation: (state: PageObservation) => void = () => {},
): (() => void) & { expectReply(): void; snapshot(): PageObservation } {
  const ignored = new Set<string>();
  const flags = new Set<Element>();
  // One metadata-only snapshot; generation signals are maintained from mutations,
  // never by rescanning the document for every token or on an idle interval.
  for (const element of document.querySelectorAll(`${assistant}, ${streaming}`)) {
    if (element.matches(assistant)) {
      const id = assistantId(element);
      if (id) ignored.add(id);
    }
    if (element.matches(streaming)) flags.add(element);
  }
  // Restored React history may mount after our first identity snapshot. It is not
  // a new planner/reviewer turn. Only a fresh user send or our own result delivery
  // opens the boundary; no historical message body is read to establish it.
  let accepting = !restored;
  let newest: Element | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  let observation: PageObservation = { phase: restored ? "waiting_for_send" : "waiting_for_reply" };
  const publish = (phase: PageObservation["phase"], id?: string) => {
    if (observation.phase === phase && observation.assistantId === id) return;
    observation = { phase, ...(id ? { assistantId: id } : {}) };
    onObservation({ ...observation });
  };
  const consider = (element: Element) => {
    const id = assistantId(element);
    if (!id) {
      if (accepting) publish("unsupported");
      return;
    }
    if (ignored.has(id)) return;
    if (!accepting) {
      ignored.add(id);
      return;
    }
    if (
      !newest?.isConnected ||
      element === newest ||
      (newest.compareDocumentPosition(element) & 4) !== 0
    ) {
      // Retain only the newest unconsumed turn. If it is superseded, later edits or
      // DOM reattachment of that older reply must never turn into a fresh task.
      const previousId = newest && assistantId(newest);
      if (previousId && previousId !== id) ignored.add(previousId);
      newest = element;
    }
  };
  const schedule = () => {
    clearTimeout(timer);
    timer = undefined;
    if (!newest?.isConnected) return;
    const turn = conversationTurn(newest);
    const id = assistantId(newest);
    if (!turn) {
      publish("unsupported", id);
      return;
    }
    if (generatingTurn(flags, turn)) {
      publish("streaming", id);
      return;
    }
    if (!turn.querySelector(completion)) {
      publish("waiting_for_completion", id);
      return;
    }
    // One bounded quiet-period debounce after the completion toolbar appears. Streaming
    // text never gets read; a mutation burst only resets this one pending check.
    timer = setTimeout(() => {
      timer = undefined;
      if (stopped || !active() || !newest?.isConnected) return;
      const current = newest;
      const id = assistantId(current);
      const turn = conversationTurn(current);
      if (!id || ignored.has(id) || !turn?.querySelector(completion) || generatingTurn(flags, turn))
        return;
      try {
        const text = turnText(current);
        const source = extractHandoffBlock(text);
        const review = extractMachineBlock(text, "REVIEW");
        // The toolbar and body can commit separately. Plain text is not a consumed
        // task: keep this new turn eligible for a later mutation, with no idle timer.
        if (source === undefined && review === undefined) {
          publish("no_protocol", id);
          return;
        }
        ignored.add(id);
        newest = undefined;
        publish("protocol_ready", id);
        onHandoff({ id, source: source ?? "", ...(review ? { review } : {}) });
      } catch (error) {
        publish("invalid", id);
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
      if (target.matches(streaming)) flags.add(target);
      else flags.delete(target);
      const owner = target.closest(assistant);
      // Inspect flags only in newly inserted subtrees of this live turn or its UI.
      if (!owner || !ignored.has(assistantId(owner) ?? "")) {
        for (const node of record.addedNodes) {
          if (node.nodeType !== 1) continue;
          const element = node as Element;
          if (element.matches(streaming)) flags.add(element);
          for (const flag of element.querySelectorAll(streaming)) flags.add(flag);
        }
      }
      if (target.matches(streaming) || wasStreaming(record)) {
        changed = true;
        composerChanged = true;
      }
      if (target.closest(composer)) {
        composerChanged = true;
        continue;
      }
      if (owner) {
        consider(owner);
        if (owner === newest) changed = true;
        // No queries inside old history or every token of a streaming answer.
        continue;
      }
      if (newest && conversationTurn(newest)?.contains(target)) changed = true;
      // React can turn the existing Stop control into Send/Voice without removing it.
      // Its old streaming attribute is the completion event; there may be no later DOM change.
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
  const expectReply = () => {
    clearTimeout(timer);
    timer = undefined;
    for (const id of assistantIds(document)) ignored.add(id);
    newest = undefined;
    accepting = true;
    publish("waiting_for_reply");
  };
  const submit = (event: Event) => {
    if (!event.isTrusted || !active()) return;
    const target = event.target as Element | null;
    const form = document.querySelector("#prompt-textarea")?.closest("form");
    if (
      (event.type === "submit" && target === form) ||
      (event.type === "click" &&
        (target?.closest('[data-testid="send-button"]') ||
          (form && target?.closest('button[type="submit"]')?.closest("form") === form))) ||
      (event.type === "keydown" &&
        "key" in event &&
        (event as KeyboardEvent).key === "Enter" &&
        !(event as KeyboardEvent).shiftKey &&
        !(event as KeyboardEvent).isComposing &&
        target?.closest("#prompt-textarea"))
    )
      expectReply();
  };
  document.addEventListener("click", submit, true);
  document.addEventListener("keydown", submit, true);
  document.addEventListener("submit", submit, true);
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    observer.disconnect();
    document.removeEventListener("input", input, true);
    document.removeEventListener("click", submit, true);
    document.removeEventListener("keydown", submit, true);
    document.removeEventListener("submit", submit, true);
  };
  return Object.assign(stop, { expectReply, snapshot: () => ({ ...observation }) });
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
