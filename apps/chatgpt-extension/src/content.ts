import { conversationUrl, object, parseHandoff, type Binding } from "./contracts.js";
import { assistantIds, canCompose, latestHandoff, sendToConversation } from "./page.js";

const epoch = crypto.randomUUID();
let binding: Binding | undefined;
let ignored = new Set<string>();
let candidate: { id: string; source: string } | undefined;
let busy = false;
const send = async (type: string, fields: Record<string, unknown> = {}) => {
  const response: unknown = await chrome.runtime.sendMessage({
    type,
    epoch,
    bindingId: binding?.id,
    ...fields,
  });
  if (!object(response) || response.ok !== true)
    throw new Error(
      object(response) && typeof response.error === "string" ? response.error : "扩展后台不可用。",
    );
  return response.data;
};
const bound = (id: string) =>
  binding?.id === id && conversationUrl(location.href) === binding.conversation;
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !object(message)) return false;
  if (message.type === "prepare") {
    reply({ epoch, conversation: conversationUrl(location.href) });
    return false;
  }
  if (message.type === "disarm") {
    binding = undefined;
    reply({ ok: true });
    return false;
  }
  if (
    message.type !== "arm" ||
    !object(message.binding) ||
    message.binding.epoch !== epoch ||
    typeof message.text !== "string"
  )
    return false;
  binding = message.binding as unknown as Binding;
  ignored = assistantIds(document);
  candidate = undefined;
  const selected = binding;
  busy = true;
  void sendToConversation(
    document,
    () => location.href,
    selected.conversation,
    message.text,
    selected.id,
    () => bound(selected.id),
  )
    .then((result) => {
      if (result !== "sent") binding = undefined;
      reply({ ok: result === "sent" });
    })
    .catch((error: unknown) => {
      binding = undefined;
      reply({ ok: false, error: error instanceof Error ? error.message : "页面发送失败。" });
    })
    .finally(() => {
      busy = false;
    });
  return true;
});
async function tick() {
  if (busy || !binding) return;
  if (!bound(binding.id)) {
    binding = undefined;
    return;
  }
  busy = true;
  try {
    const response = await send("poll");
    if (!object(response) || !object(response.binding)) throw new Error("绑定状态无效。");
    const current = response.binding as unknown as Binding;
    if (!binding || current.id !== binding.id || !bound(current.id)) return;
    binding = current;
    if (current.phase === "armed") {
      const next = latestHandoff(document, ignored);
      if (next && candidate?.id === next.id && candidate.source === next.source) {
        parseHandoff(next.source, current.projectId, current.nextRunId);
        ignored.add(next.id);
        candidate = undefined;
        await send("dispatch", { source: next.source });
      } else candidate = next;
    } else if (current.phase === "ready_to_deliver" && canCompose(document)) {
      const claimed = await send("claim");
      if (
        !object(claimed) ||
        !object(claimed.delivery) ||
        typeof claimed.delivery.text !== "string" ||
        typeof claimed.delivery.id !== "string"
      )
        throw new Error("回传内容不可用。");
      const result = await sendToConversation(
        document,
        () => location.href,
        current.conversation,
        claimed.delivery.text,
        claimed.delivery.id,
        () => bound(current.id),
      );
      await send(result === "sent" ? "ack" : "defer", { deliveryId: claimed.delivery.id });
    }
  } catch (error) {
    await send("error", {
      message: error instanceof Error ? error.message : "页面桥接失败。",
    }).catch(() => {});
    binding = undefined;
  } finally {
    busy = false;
  }
}
setInterval(() => {
  void tick();
}, 1500);
