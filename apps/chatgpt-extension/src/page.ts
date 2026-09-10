import { conversationUrl, extractHandoffBlock } from "./contracts.js";

const assistantSelector = '[data-message-author-role="assistant"]';
/** Completion belongs to this explicit turn, never an adjacent turn or the whole page. */
export function conversationTurn(message: Element): Element | null {
  // Current ChatGPT uses SECTION; its toolbar is outside the message's direct parent.
  // Older layouts use ARTICLE. Neither CSS classes nor translated button labels route work.
  return message.closest('[data-testid^="conversation-turn-"]') ?? message.closest("article");
}
export function assistantId(message: Element): string | undefined {
  return (
    message.getAttribute("data-message-id") ??
    message.closest("[data-message-id]")?.getAttribute("data-message-id") ??
    undefined
  );
}
export function assistantIds(document: Document): Set<string> {
  return new Set(
    [...document.querySelectorAll(assistantSelector)].flatMap(
      (element) => assistantId(element) ?? [],
    ),
  );
}
export function generating(document: Document): boolean {
  return !!document.querySelector(
    '[data-testid="stop-button"], [data-testid="stop-generation-button"], .result-streaming, [data-is-streaming="true"]',
  );
}
export function latestHandoff(
  document: Document,
  ignored: ReadonlySet<string>,
): { id: string; source: string } | undefined {
  if (generating(document)) return;
  const messages = document.querySelectorAll(assistantSelector);
  const message = messages[messages.length - 1];
  if (!message) return;
  const id = assistantId(message);
  if (!id || ignored.has(id)) return;
  const turn = conversationTurn(message);
  // A finished assistant turn needs its normal completion toolbar. Unknown DOM fails closed.
  if (!turn?.querySelector('[data-testid="copy-turn-action-button"]')) return;
  // Inspect only this new completed assistant turn; forward only its delimited engineering data.
  const text = turnText(message);
  const source = extractHandoffBlock(text);
  return source === undefined ? undefined : { id, source };
}
export function turnText(message: Element): string {
  let text = "";
  const visit = (node: Node, depth: number) => {
    if (depth > 80 || text.length > 192 * 1024)
      throw new Error("新的 GPT 输出超出桥接读取上限，已暂停。");
    if (node.nodeType === 3) text += node.textContent ?? "";
    else if (node.nodeType === 1) {
      const element = node as Element;
      if (["SCRIPT", "STYLE", "BUTTON"].includes(element.tagName)) return;
      // Chromium may leave the first line as a text node and wrap subsequent lines
      // in DIVs. A block starts a line as well as ending one.
      if (["P", "DIV", "PRE", "LI"].includes(element.tagName) && text && !text.endsWith("\n"))
        text += "\n";
      for (const child of element.childNodes) visit(child, depth + 1);
      if (["P", "DIV", "PRE", "BR", "LI"].includes(element.tagName)) text += "\n";
    }
  };
  visit(message, 0);
  if (text.length > 192 * 1024) throw new Error("新的 GPT 输出超出桥接读取上限，已暂停。");
  return text;
}
function composer(document: Document): HTMLElement | undefined {
  const candidates = document.querySelectorAll<HTMLElement>(
    '#prompt-textarea[contenteditable="true"], textarea#prompt-textarea',
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
function editorText(element: HTMLElement): string {
  // DOM traversal does not force layout, unlike innerText on a large live ChatGPT page.
  return element.tagName === "TEXTAREA"
    ? (element as HTMLTextAreaElement).value
    : turnText(element);
}
const attachmentSelector =
  '[data-testid="composer-attachment"], [data-testid="file-thumbnail"], [data-testid="composer-file"]';
function composerAvailable(document: Document, editor: HTMLElement): boolean {
  return (
    !generating(document) &&
    editor.getAttribute("aria-disabled") !== "true" &&
    !document.querySelector(attachmentSelector)
  );
}
export function canCompose(document: Document): boolean {
  const editor = composer(document);
  return !!editor && !editorText(editor).trim() && composerAvailable(document, editor);
}

// Preserve every non-whitespace character and word separator. Paragraph/BR/NBSP rendering
// may change whitespace runs; this is supplementary integrity checking, not delivery proof.
const normalized = (text: string) => text.replace(/[ \t\r\n\u00a0]+/g, " ").trim();
const occurrences = (text: string, marker: string) => text.split(marker).length - 1;
const boundaries = (text: string) =>
  [
    ...text.matchAll(
      /(?:^|\n)[ \t\r\u00a0]*(VEYRA_(?:HANDOFF|RESULT|REVIEW)_(?:BEGIN|END))[ \t\r\u00a0]*(?=\n|$)/g,
    ),
  ]
    .map((match) => match[1])
    .join(",");

export async function sendToConversation(
  document: Document,
  currentUrl: () => string,
  conversation: string,
  text: string,
  marker: string,
  stillBound: () => boolean,
  onDelivered?: (message: Element) => void,
): Promise<"sent" | "deferred"> {
  const valid = () => stillBound() && conversationUrl(currentUrl()) === conversation;
  if (!valid() || !canCompose(document)) return "deferred";
  const editor = composer(document);
  if (
    !editor ||
    new TextEncoder().encode(text).length > 192 * 1024 ||
    !/^[a-zA-Z0-9-]{16,128}$/.test(marker) ||
    occurrences(text, marker) !== 1 ||
    !boundaries(text)
  )
    throw new Error("回传文本、唯一 marker 或 BEGIN/END 边界不符合限制。");
  editor.focus();
  if (!valid() || !canCompose(document)) return "deferred";

  const expected = normalized(text);
  const frames = boundaries(text);
  const intact = (value: string) =>
    occurrences(value, marker) === 1 &&
    boundaries(value) === frames &&
    normalized(value) === expected;
  const userSelector = '[data-message-author-role="user"]';
  // Snapshot identities only. Never retain or scan old conversation text.
  const previous = new Set(document.querySelectorAll(userSelector));
  const previousIds = new Set([...previous].flatMap((node) => assistantId(node) ?? []));
  const echoes = new Set<Element>();
  let inserting = true;
  let interrupted = false;
  let clicked = false;
  let settled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let check = () => {};
  const intervention = (event: Event) => {
    // execCommand's own synchronous input event is trusted too. A human event cannot
    // interleave with that synchronous insertion; later trusted edits must fail closed.
    if (event.type === "keydown") {
      const key = (event as KeyboardEvent).key;
      if (key.length !== 1 && !["Enter", "Backspace", "Delete"].includes(key)) return;
    }
    const target = event.target as Element | null;
    if (!inserting && event.isTrusted && target?.closest?.("#prompt-textarea")) {
      interrupted = true;
      check();
    }
  };
  const events = ["beforeinput", "input", "paste", "cut", "drop", "compositionstart", "keydown"];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target =
        record.target.nodeType === 1 ? (record.target as Element) : record.target.parentElement;
      const user = target?.closest(userSelector);
      if (user) echoes.add(user);
      for (const node of record.addedNodes) {
        if (node.nodeType !== 1) continue;
        const element = node as Element;
        if (element.matches(userSelector)) echoes.add(element);
        // Insertion inside the composer cannot be a conversation echo.
        if (!element.closest("#prompt-textarea"))
          for (const child of element.querySelectorAll(userSelector)) echoes.add(child);
      }
    }
    if (!inserting) check();
  });
  for (const event of events) document.addEventListener(event, intervention, true);
  observer.observe(document.body, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: [
      "disabled",
      "aria-disabled",
      "data-message-author-role",
      "data-testid",
      "data-is-streaming",
      "class",
    ],
  });
  try {
    return await new Promise<"sent">((resolve, reject) => {
      const finish = (error?: string) => {
        if (settled) return;
        settled = true;
        if (error)
          reject(
            new Error(`${error} 请检查当前 conversation；不会自动重发，Project/run 证据保留。`),
          );
        else resolve("sent");
      };
      check = () => {
        if (settled || inserting) return;
        try {
          if (!valid()) return finish("会话或绑定已变化，发送未确认。");
          if (interrupted) return finish("检测到发送期间的用户输入，已停止发送确认。");
          let matched = 0;
          let delivered: Element | undefined;
          for (const echo of echoes) {
            if (
              !echo.isConnected ||
              !echo.matches(userSelector) ||
              previous.has(echo) ||
              previousIds.has(assistantId(echo) ?? "")
            )
              continue;
            const value = turnText(echo);
            if (!value.includes(marker)) continue;
            if (!intact(value))
              return finish("对应 user message 的 marker 或内容不完整，发送未确认。");
            matched++;
            delivered = echo;
          }
          if (matched > 1) return finish("出现重复 marker 消息，发送未确认。");
          // The page may already have submitted, replaced the composer and started a reply.
          // A fresh, intact user echo is the proof. Never click again in that case.
          if (matched === 1) {
            finish();
            try {
              if (delivered) onDelivered?.(delivered);
            } catch {
              /* Rendering never changes delivery proof. */
            }
            return;
          }
          if (clicked) return;
          const current = composer(document);
          if (!current || !composerAvailable(document, current))
            return finish("输入框、附件或 GPT 生成状态发生变化，已停止发送。");
          if (!intact(editorText(current)))
            return finish("输入内容的 marker、边界或正文发生变化，已停止发送。");
          const sends = document.querySelectorAll<HTMLButtonElement>('[data-testid="send-button"]');
          const send = sends.length === 1 ? sends[0] : undefined;
          if (!send || send.disabled || send.getAttribute("aria-disabled") === "true") return;
          clicked = true;
          clearTimeout(timer);
          timer = setTimeout(() => finish("对应 user message 未出现，发送未确认。"), 10000);
          send.click();
        } catch {
          finish("页面内容无法安全确认，已停止发送。");
        }
      };
      timer = setTimeout(() => finish("发送按钮不可用，文本可能保留在输入框。"), 3000);
      if (editor.tagName === "TEXTAREA") {
        const setter = Object.getOwnPropertyDescriptor(
          document.defaultView?.HTMLTextAreaElement.prototype ?? {},
          "value",
        )?.set;
        if (!setter) throw new Error("不支持当前输入框。");
        setter.call(editor, text);
        editor.dispatchEvent(
          new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }),
        );
      } else {
        const selection = document.getSelection();
        const range = document.createRange();
        range.selectNodeContents(editor);
        selection?.removeAllRanges();
        selection?.addRange(range);
        if (!document.execCommand("insertText", false, text))
          throw new Error("ChatGPT 输入框拒绝插入；请检查当前会话，不会自动重发。");
      }
      inserting = false;
      // Drain insertion/React mutations first, including a user echo produced synchronously.
      // Subsequent checks are mutation/input driven, with one bounded timeout, not DOM polling.
      queueMicrotask(check);
    });
  } finally {
    clearTimeout(timer);
    observer.disconnect();
    for (const event of events) document.removeEventListener(event, intervention, true);
  }
}
