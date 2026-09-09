import { watchPopup } from "./popup-refresh.js";
import { object, parseInvitation, type PairingInvitation } from "./contracts.js";
const status = document.querySelector<HTMLElement>("#status") as HTMLElement;
const project = document.querySelector<HTMLSelectElement>("#project") as HTMLSelectElement;
const limit = document.querySelector<HTMLSelectElement>("#limit") as HTMLSelectElement;
let invitation: PairingInvitation | undefined;
let busy = false;
let paused = false;
async function call(type: string, params: Record<string, unknown> = {}) {
  const response: unknown = await chrome.runtime.sendMessage({ type, ...params });
  if (!object(response) || response.ok !== true)
    throw new Error(
      object(response) && typeof response.error === "string" ? response.error : "扩展后台不可用。",
    );
  return response.data;
}
async function refresh() {
  const data = await call("projects");
  if (!Array.isArray(data)) throw new Error("项目列表无效。");
  const previous = project.value;
  project.replaceChildren(new Option("明确选择一个本地 Project", ""));
  for (const entry of data) {
    if (
      !object(entry) ||
      !object(entry.project) ||
      typeof entry.project.id !== "string" ||
      typeof entry.project.name !== "string" ||
      typeof entry.project.root !== "string"
    )
      continue;
    const option = new Option(
      `${entry.project.name} — ${entry.project.root}${entry.status === "available" ? "" : "（路径失效）"}`,
      entry.project.id,
    );
    option.disabled = entry.status !== "available";
    project.append(option);
  }
  project.value = [...project.options].some((option) => option.value === previous && previous)
    ? previous
    : project.options.length === 2
      ? (project.options[1]?.value ?? "")
      : "";
  await showStatus("inspect");
}
function act(action: () => Promise<unknown>, quiet = false) {
  if (busy) return;
  busy = true;
  if (!quiet) field("error", "");
  for (const button of document.querySelectorAll("button"))
    if (!["disable", "unbind"].includes(button.id)) button.disabled = true;
  void action()
    .catch((error: unknown) => {
      field("error", error instanceof Error ? error.message : "操作失败。");
    })
    .finally(() => {
      busy = false;
      for (const button of document.querySelectorAll("button")) button.disabled = false;
      (document.querySelector("#pair") as HTMLButtonElement).disabled = !invitation;
    });
}
document.querySelector<HTMLInputElement>("#pairing")?.addEventListener("change", (event) =>
  act(async () => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    invitation = undefined;
    try {
      if (!file || file.size > 4096) throw new Error("请选择 daemon 生成的短期 JSON 配对文件。");
      invitation = parseInvitation(JSON.parse(await file.text()));
      const preview = document.querySelector("#pairing-scope") as HTMLElement;
      preview.textContent = `即将授权 ${invitation.url}\n仅以下 Project UUID：\n${invitation.projectIds.join("\n")}\n邀请到期：${new Date(invitation.expiresAt).toLocaleString()}\n确认后授权最长 8 小时，可随时撤销。`;
      status.textContent = "请核对本机地址和 Project 范围，然后确认配对。";
    } finally {
      input.value = "";
    }
  }),
);
document.querySelector("#pair")?.addEventListener("click", () =>
  act(async () => {
    if (!invitation) throw new Error("请先选择配对文件。");
    const selected = invitation;
    invitation = undefined; // A lost response must not cause an automatic exchange retry.
    await call("pair", { pairing: selected });
    (document.querySelector("#pairing-scope") as HTMLElement).textContent =
      "本地授权已建立。配对文件已消费。";
    await refresh();
  }),
);
document.querySelector("#detect")?.addEventListener("click", () => act(refresh));
project.addEventListener("change", () => act(() => showStatus("inspect")));
document.querySelector("#bind")?.addEventListener("click", () =>
  act(async () => {
    await call("bind", { projectId: project.value, maxRuns: Number(limit.value) });
    await showStatus();
  }),
);
for (const [selector, type] of [
  ["#stop", "stop"],
  ["#unpair", "unpair"],
  ["#use-native", "native"],
]) {
  document.querySelector(selector as string)?.addEventListener("click", () =>
    act(async () => {
      await call(type === "disable" && paused ? "resume" : (type as string));
      if (type === "native") await refresh();
      else await showStatus();
    }),
  );
}
let safetyBusy = false;
for (const [selector, action] of [
  ["#disable", "disable"],
  ["#unbind", "unbind"],
]) {
  document.querySelector(selector as string)?.addEventListener("click", () => {
    if (safetyBusy) return;
    safetyBusy = true;
    field(
      "status",
      action === "unbind" ? "正在解除绑定；运行证据保留在 Project。" : "正在更新暂停状态…",
    );
    void call(action === "disable" && paused ? "resume" : (action as string))
      .then(() => showStatus("snapshot"))
      .catch((error: unknown) =>
        field(
          "error",
          error instanceof Error ? error.message : "操作未确认，请检查 Project 证据。",
        ),
      )
      .finally(() => {
        safetyBusy = false;
      });
  });
}
function field(id: string, text: string) {
  const element = document.querySelector(`#${id}`);
  if (element) element.textContent = text;
}
async function showStatus(type = "status") {
  const data = await call(type === "inspect" && !project.value ? "status" : type, {
    projectId: project.value,
  });
  if (!object(data)) throw new Error("状态响应无效。");
  const binding = object(data.binding) ? data.binding : undefined;
  const selected = object(data.selected) ? data.selected : undefined;
  const readiness = selected && object(selected.readiness) ? selected.readiness : undefined;
  const last = binding && object(binding.lastResult) ? binding.lastResult : undefined;
  const connectivity = object(data.connectivity) ? data.connectivity : undefined;
  const working =
    data.enabled &&
    binding &&
    ["dispatching", "running", "ready_to_deliver", "delivering"].includes(String(binding.phase));
  field(
    "enabled",
    working
      ? "Working"
      : connectivity?.status === "connected" && (!data.currentBound || data.enabled)
        ? "Ready"
        : "Needs attention",
  );
  paused = data.currentBound === true && binding?.pausedByUser === true;
  field("disable", paused ? "Resume" : "Pause");
  const bindButton = document.querySelector<HTMLButtonElement>("#bind");
  if (bindButton) bindButton.hidden = data.currentBound === true;
  if (data.currentBound && typeof binding?.projectId === "string")
    project.value = binding.projectId;
  project.disabled = data.currentBound === true;
  field(
    "conversation",
    data.currentBound
      ? "Current — 已明确绑定"
      : data.conversation
        ? "Current — 未绑定"
        : "请打开已保存的 chatgpt.com 对话",
  );
  field(
    "bound-project",
    data.currentBound && binding
      ? `${binding.projectName}\n${binding.projectRoot}`
      : "当前对话未绑定任何 Project",
  );
  field(
    "previous-binding",
    !data.currentBound && binding
      ? `另一个页面/之前的绑定：${binding.projectName}\n${binding.projectRoot}（不会向当前对话派发或回传）`
      : "",
  );
  field("project-detail", binding ? `${binding.projectId}\n${binding.projectRoot}` : "未绑定");
  field(
    "daemon",
    `${data.transport} — ${connectivity?.status ?? "disconnected"} — ${connectivity?.message ?? ""}`,
  );
  field(
    "native",
    readiness
      ? `${object(selected?.project) ? selected.project.name : "Project"}\nCodex — ${readiness.ready ? "Ready" : "Not Ready"}\n${readiness.message}\n检查于 ${new Date(Number(data.readinessAt)).toLocaleTimeString()}`
      : "Codex — 未检查；请选择 Project",
  );
  field(
    "run",
    binding?.runId
      ? last?.delivery === "confirmed"
        ? "Result returned"
        : binding.phase === "ready_to_deliver"
          ? "Result ready for review"
          : binding.phase === "dispatching"
            ? "Plan sent to Codex"
            : binding.phase === "running"
              ? "Codex working"
              : String(binding.runStatus ?? "Needs attention")
      : "尚无 Run",
  );
  field("run-detail", binding?.runId ? `${binding.runId}\n${binding.runStatus}` : "尚无 Run");
  field("agent", `Codex — ${binding?.agentStatus ?? "idle"}`);
  field(
    "last-result",
    last
      ? `${last.status} — ${last.summary}\nRun: ${last.runId}\n回传：${last.delivery}`
      : "尚无 Result",
  );
  field(
    "grant",
    data.transport === "native"
      ? "本机持久授权；每个 Project 需显式 Bind。可在本机 ve setup --revoke 撤销。"
      : data.paired
        ? `本地授权到期：${new Date(Number(data.expiresAt)).toLocaleString()}`
        : "未授权 / 已过期 / 已撤销",
  );
  status.textContent =
    data.currentBound && binding
      ? `${binding.message}\n本次执行：${binding.count}/${binding.maxRuns}`
      : connectivity?.status === "connected"
        ? "选择 Project → Bind → 正常聊天。"
        : "请先完成 ve setup，并在该项目运行 ve init。";
}
act(async () => {
  await showStatus("snapshot");
  await refresh();
});
watchPopup(() => {
  if (!busy && !invitation) act(() => showStatus("snapshot"), true);
});
