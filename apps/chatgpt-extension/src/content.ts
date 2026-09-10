import { machinePresentation } from "./collapse.js";
import { conversationUrl, object, parseHandoff, type Binding } from "./contracts.js";
import { canCompose, sendToConversation } from "./page.js";
import { RunBackoff, watchConversation } from "./watch.js";

const presentation = machinePresentation();
const epoch = crypto.randomUUID();
let binding: Binding | undefined;
let candidate: { id: string; source: string } | undefined;
let busy = false;
let composerChanged = false;
let unwatch: (() => void) | undefined;
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
function disarm() {
  binding = undefined;
  candidate = undefined;
  unwatch?.();
  unwatch = undefined;
  runs.stop();
}
async function fail(error: unknown, id: string) {
  if (binding?.id !== id) return;
  await send("error", { message: error instanceof Error ? error.message : "页面桥接失败。" }).catch(
    () => {},
  );
  disarm();
}
function accept(response: unknown, id: string) {
  if (!object(response) || !object(response.binding)) throw new Error("绑定状态无效。");
  const current = response.binding as unknown as Binding;
  if (!bound(id)) return false;
  if (current.id !== id) throw new Error("会话或绑定已经变化。");
  binding = current;
  if (["paused", "stopped"].includes(current.phase)) disarm();
  return true;
}
const runs = new RunBackoff(async () => {
  if (binding?.phase !== "running") return;
  const id = binding.id;
  try {
    if (!accept(await send("poll"), id)) return;
    if (binding?.phase === "running") return `${binding.runStatus}/${binding.agentStatus}`;
    void work();
  } catch (error) {
    await fail(error, id);
  }
});
chrome.runtime.onMessage.addListener((message: unknown, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !object(message)) return false;
  presentation.language(message.locale);
  if (message.type === "locale") {
    reply({ ok: true });
    return false;
  }
  if (message.type === "restore") {
    void restore();
    reply({ ok: true });
    return false;
  }
  if (message.type === "prepare") {
    reply({ epoch, conversation: conversationUrl(location.href) });
    return false;
  }
  if (message.type === "disarm") {
    disarm();
    reply({ ok: true });
    return false;
  }
  if (
    message.type !== "arm" ||
    !object(message.binding) ||
    message.binding.epoch !== epoch ||
    (typeof message.text !== "string" && message.restore !== true)
  )
    return false;
  activate(message, reply);
  return true;
});
function activate(message: Record<string, unknown>, reply: (value: unknown) => void) {
  disarm();
  binding = message.binding as unknown as Binding;
  const selected = binding;
  busy = true;
  unwatch = watchConversation(
    document,
    (turn) => {
      candidate = turn;
      void work();
    },
    () => {
      if (binding?.phase === "ready_to_deliver") {
        composerChanged = true;
        void work();
      }
    },
    (error) => {
      void fail(error, selected.id);
    },
    () => bound(selected.id),
  );
  void (
    message.restore === true
      ? Promise.resolve("sent" as const)
      : sendToConversation(
          document,
          () => location.href,
          selected.conversation,
          message.text as string,
          selected.id,
          () => bound(selected.id),
          (node) => presentation.fold(node, "Project bound"),
        )
  )
    .then((result) => {
      if (result !== "sent" && binding?.id === selected.id) disarm();
      reply({ ok: result === "sent" });
    })
    .catch((error: unknown) => {
      if (binding?.id === selected.id) disarm();
      reply({ ok: false, error: error instanceof Error ? error.message : "页面发送失败。" });
    })
    .finally(() => {
      busy = false;
      if (binding?.phase === "running") runs.start();
      void work();
    });
}
async function work() {
  if (busy || !binding) return;
  if (!bound(binding.id)) {
    disarm();
    return;
  }
  composerChanged = false;
  busy = true;
  const current = binding;
  try {
    if (current.phase === "armed" && candidate) {
      const next = candidate;
      candidate = undefined;
      parseHandoff(next.source, current.projectId, current.nextRunId);
      if (!accept(await send("dispatch", { source: next.source }), current.id)) return;
      if (binding?.phase === "running") {
        runs.start();
        try {
          presentation.handoff(document, next.id, next.source);
        } catch {
          /* Cosmetic only. */
        }
      }
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
        (node) => presentation.fold(node, "Result returned"),
      );
      accept(
        await send(result === "sent" ? "ack" : "defer", { deliveryId: claimed.delivery.id }),
        current.id,
      );
    }
  } catch (error) {
    await fail(error, current.id);
  } finally {
    busy = false;
  }
  // A completed assistant turn can arrive while the one-time delivery is being acknowledged.
  if (
    (binding?.phase === "armed" && candidate) ||
    (binding?.phase === "ready_to_deliver" && composerChanged)
  )
    void work();
}
window.addEventListener("pagehide", disarm);
window.addEventListener("popstate", () => {
  if (binding && !bound(binding.id)) disarm();
  void restore();
});

async function restore() {
  if (binding || busy || !conversationUrl(location.href)) return;
  try {
    const response = await send("hello");
    if (
      !binding &&
      object(response) &&
      response.restored === true &&
      object(response.binding) &&
      response.binding.epoch === epoch &&
      response.binding.conversation === conversationUrl(location.href)
    )
      activate({ binding: response.binding, restore: true }, () => {});
  } catch {
    /* Setup/explicit Bind may not have happened. Idle remains event-only. */
  }
}
void restore();
