import { translate, type Locale } from "@veyraoss/ui/i18n";
const states: Record<string, string> = {
  connected: "Connected",
  disconnected: "Disconnected",
  ready: "Ready",
  running: "Running",
  queued: "Queued",
  completed: "Completed",
  failed: "Failed",
  paused: "Paused",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
  idle: "Idle",
  stopped: "Stopped",
  dispatching: "Dispatching",
  delivering: "Delivering",
  ready_to_deliver: "Result ready for review",
  confirmed: "Confirmed",
  unknown: "Unknown",
  unavailable: "Unavailable",
  different_build: "Different build",
  pending: "Pending",
  uncertain: "Uncertain",
  native: "Native bridge",
  http: "HTTP fallback",
};
export const stateLabel = (locale: Locale, value: unknown) => {
  const source = String(value ?? "unavailable");
  return translate(locale, Object.hasOwn(states, source) ? (states[source] ?? source) : source);
};
/** Translate built-in diagnostic prose; unknown technical evidence stays verbatim. */
export function diagnosticText(locale: Locale, source: unknown) {
  const text = typeof source === "string" ? source : "";
  const legacy: Record<string, string> = {
    "尚未检测 Daemon。": "Local connection has not been checked.",
    "等待新的显式 handoff。": "Waiting for a new explicit handoff.",
    "正在派发原生执行器。": "Dispatching the native executor.",
    "原生执行中；可随时停止。": "Native execution is in progress; you can cancel at any time.",
    "等待当前会话输入框空闲后自动回传。":
      "Waiting for the current conversation composer to be empty before returning the result.",
    "正在向当前会话回传；未确认时不会重复发送。":
      "Returning the result to this conversation; uncertain delivery is never retried.",
    "本机 Daemon 已连接且授权有效。": "Local coordinator connected and authorized.",
    "未配对或授权已过期。": "Local authorization is missing or expired.",
    "本机连接已休眠。": "The local connection is idle.",
    "Disabled：自动派发和回传已停止。": "Automatic dispatch and handback are paused.",
    "Run 需要本地审批或恢复；扩展不能代替审批。":
      "This run needs local approval or recovery. The extension cannot approve it.",
    "页面切换，发送状态不确定；请检查当前对话，未自动重发。":
      "The page changed during delivery. Check the conversation; nothing was resent.",
    "回传已停止，但取消请求未确认；请在本机检查该 run。":
      "Handback stopped, but cancellation was not confirmed. Inspect the run locally.",
    "Disabled：已停止自动桥接，已派发的 run 继续执行；需要时点击 Cancel Run。":
      "Automatic bridging is paused. The dispatched run continues; use Cancel Run to stop it.",
    "已回传，自动执行次数用尽。": "Result returned; the automatic execution limit was reached.",
    "已回传，等待 GPT Review 或新的 repair handoff。":
      "Result returned; waiting for ChatGPT review or a repair handoff.",
    "扩展后台不可用。": "Extension background is unavailable.",
    "操作未确认，请检查 Project 证据。": "Action not confirmed. Check Project evidence.",
    "操作失败。": "Action failed.",
  };
  return translate(locale, Object.hasOwn(legacy, text) ? (legacy[text] ?? text) : text);
}
