import { conversationUrl } from "./contracts.js";

const assistantSelector = '[data-message-author-role="assistant"]';
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
  const turn = message.closest("article") ?? message.parentElement;
  // A finished assistant turn needs its normal completion toolbar. Unknown DOM fails closed.
  if (!turn?.querySelector('[data-testid="copy-turn-action-button"]')) return;
  const sources: string[] = [];
  for (const pre of message.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;
    const explicit =
      code.classList.contains("language-veyra-handoff") ||
      code.getAttribute("data-language") === "veyra-handoff" ||
      [...pre.querySelectorAll("div, span")].some(
        (label) => label.children.length === 0 && label.textContent?.trim() === "veyra-handoff",
      );
    if (explicit) sources.push(code.textContent ?? "");
  }
  if (sources.length > 1) throw new Error("同一 GPT 输出含多个 handoff，已暂停，避免误派发。");
  return sources[0] === undefined ? undefined : { id, source: sources[0] };
}
function composer(document: Document): HTMLElement | undefined {
  const candidates = document.querySelectorAll<HTMLElement>(
    '#prompt-textarea[contenteditable="true"], textarea#prompt-textarea',
  );
  return candidates.length === 1 ? candidates[0] : undefined;
}
function editorText(element: HTMLElement): string {
  const text =
    element.tagName === "TEXTAREA"
      ? (element as HTMLTextAreaElement).value
      : (element.innerText ?? element.textContent ?? "");
  // Chromium may preserve indentation in contenteditable with non-breaking spaces.
  return text.replace(/\u00a0/g, " ").replace(/\r\n/g, "\n");
}
export function canCompose(document: Document): boolean {
  const editor = composer(document);
  return (
    !!editor &&
    !generating(document) &&
    !editorText(editor).trim() &&
    editor.getAttribute("aria-disabled") !== "true" &&
    !document.querySelector(
      '[data-testid="composer-attachment"], [data-testid="file-thumbnail"], [data-testid="composer-file"]',
    )
  );
}
export async function sendToConversation(
  document: Document,
  currentUrl: () => string,
  conversation: string,
  text: string,
  marker: string,
  stillBound: () => boolean,
): Promise<"sent" | "deferred"> {
  const valid = () => stillBound() && conversationUrl(currentUrl()) === conversation;
  if (!valid() || !canCompose(document)) return "deferred";
  const editor = composer(document);
  if (!editor || new TextEncoder().encode(text).length > 192 * 1024)
    throw new Error("回传文本或输入框不符合限制。");
  editor.focus();
  if (!valid() || editorText(editor).trim()) return "deferred";
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
      throw new Error("ChatGPT 输入框拒绝插入，请检查后重试绑定。");
  }
  const until = Date.now() + 3000;
  let send: HTMLButtonElement | null = null;
  while (Date.now() < until) {
    if (!valid() || editorText(editor) !== text.replace(/\u00a0/g, " ").replace(/\r\n/g, "\n"))
      throw new Error("会话或输入内容发生变化，已停止发送。");
    send = document.querySelector<HTMLButtonElement>('[data-testid="send-button"]');
    if (send && !send.disabled && send.getAttribute("aria-disabled") !== "true") break;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  if (!send || send.disabled || send.getAttribute("aria-disabled") === "true" || !valid())
    throw new Error("发送按钮不可用；文本保留在输入框，不会重复发送。");
  send.click();
  // A click alone is not delivery proof. Only acknowledge the echoed message in this conversation.
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline && valid()) {
    const users = document.querySelectorAll('[data-message-author-role="user"]');
    const last = users[users.length - 1]?.textContent ?? "";
    if (last.includes(marker) && !editorText(editor).trim()) return "sent";
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("结果发送未确认；请检查当前会话，不会自动重发。");
}
