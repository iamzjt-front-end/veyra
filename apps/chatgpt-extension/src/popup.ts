import { object } from "./contracts.js";
const status = document.querySelector<HTMLElement>("#status") as HTMLElement;
const project = document.querySelector<HTMLSelectElement>("#project") as HTMLSelectElement;
const limit = document.querySelector<HTMLSelectElement>("#limit") as HTMLSelectElement;
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
  project.replaceChildren();
  for (const entry of data) {
    if (
      !object(entry) ||
      !object(entry.project) ||
      typeof entry.project.id !== "string" ||
      typeof entry.project.name !== "string"
    )
      continue;
    const option = document.createElement("option");
    option.value = entry.project.id;
    option.textContent = `${entry.project.name} (${entry.project.id.slice(0, 8)})${entry.status === "available" ? "" : " — 路径失效"}`;
    option.disabled = entry.status !== "available";
    project.append(option);
  }
  status.textContent = "本机 daemon 已连接，请选择项目。";
}
function act(action: () => Promise<unknown>) {
  for (const button of document.querySelectorAll("button")) button.disabled = true;
  void action()
    .catch((error: unknown) => {
      status.textContent = error instanceof Error ? error.message : "操作失败。";
    })
    .finally(() => {
      for (const button of document.querySelectorAll("button")) button.disabled = false;
    });
}
document.querySelector<HTMLInputElement>("#pairing")?.addEventListener("change", (event) =>
  act(async () => {
    const input = event.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file || file.size > 4096) throw new Error("请选择 daemon 生成的小型 JSON 配对文件。");
    try {
      await call("pair", { pairing: JSON.parse(await file.text()) });
    } finally {
      input.value = "";
    }
    await refresh();
  }),
);
document.querySelector("#detect")?.addEventListener("click", () => act(refresh));
document.querySelector("#bind")?.addEventListener("click", () =>
  act(async () => {
    await call("bind", { projectId: project.value, maxRuns: Number(limit.value) });
    await showStatus();
  }),
);
document.querySelector("#stop")?.addEventListener("click", () =>
  act(async () => {
    await call("stop");
    await showStatus();
  }),
);
async function showStatus() {
  const data = await call("status");
  if (object(data) && object(data.binding))
    status.textContent = `${data.binding.message}\nProject: ${data.binding.projectId}\n执行次数: ${data.binding.count}/${data.binding.maxRuns}`;
  else if (object(data))
    status.textContent = data.paired
      ? "已配对，可检测 daemon 并选择项目。"
      : "请先导入 daemon 配对文件。";
}
void showStatus().catch(() => {});
