import { object, parseInvitation, type PairingInvitation } from "./contracts.js";
import { watchPopup } from "./popup-refresh.js";
import { translate, type Parameters as MessageParameters, LocaleStore } from "@veyraoss/ui/i18n";
import { extensionLocale } from "./ui-locale.js";
import { diagnosticText, stateLabel } from "./diagnostic-copy.js";
let language = new LocaleStore();
const t = (source: string, values?: MessageParameters) =>
  translate(language.snapshot().locale, source, values);
const diagnostic = (source: unknown) => diagnosticText(language.snapshot().locale, source);
const label = (source: unknown) => stateLabel(language.snapshot().locale, source);
const date = (value: number, timeOnly = false) =>
  !Number.isFinite(value)
    ? t("Not captured")
    : new Intl.DateTimeFormat(
        language.snapshot().locale,
        timeOnly ? { timeStyle: "medium" } : { dateStyle: "medium", timeStyle: "short" },
      ).format(value);
let lastData: Record<string, unknown> | undefined;
let lastProjects: unknown[] = [];
let lastError = "";
const status = document.querySelector<HTMLElement>("#status") as HTMLElement;
const project = document.querySelector<HTMLSelectElement>("#project") as HTMLSelectElement;
const limit = document.querySelector<HTMLSelectElement>("#limit") as HTMLSelectElement;
let invitation: PairingInvitation | undefined;
let pairingConsumed = false;
let busy = false;
let paused = false;
async function call(type: string, params: Record<string, unknown> = {}) {
  const response: unknown = await chrome.runtime.sendMessage({ type, ...params });
  if (!object(response) || response.ok !== true)
    throw new Error(
      object(response) && typeof response.error === "string"
        ? response.error
        : "Extension background is unavailable.",
    );
  return response.data;
}
async function refresh() {
  const data = await call("projects");
  if (!Array.isArray(data)) throw new Error("Invalid Project list.");
  lastProjects = data;
  renderProjects();
  await showStatus("inspect");
}
function renderProjects(preserveSelection = false) {
  const data = lastProjects;
  const previous = project.value;
  project.replaceChildren(new Option(t("Choose an explicit local Project"), ""));
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
      `${entry.project.name} — ${entry.project.root}${entry.status === "available" ? "" : t(" (location unavailable)")}`,
      entry.project.id,
    );
    option.disabled = entry.status !== "available";
    project.append(option);
  }
  project.value = [...project.options].some((option) => option.value === previous && previous)
    ? previous
    : !preserveSelection && project.options.length === 2
      ? (project.options[1]?.value ?? "")
      : "";
}
function act(action: () => Promise<unknown>, quiet = false) {
  if (busy) return;
  busy = true;
  if (!quiet) field("error", "");
  for (const button of document.querySelectorAll("button"))
    if (!["disable", "unbind"].includes(button.id)) button.disabled = true;
  void action()
    .catch((error: unknown) => {
      field("error", error instanceof Error ? error.message : "Action failed.");
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
    pairingConsumed = false;
    try {
      if (!file || file.size > 4096)
        throw new Error("Choose the short-lived JSON pairing file generated locally.");
      invitation = parseInvitation(JSON.parse(await file.text()));
      renderPairing();
    } finally {
      input.value = "";
    }
  }),
);
document.querySelector("#pair")?.addEventListener("click", () =>
  act(async () => {
    if (!invitation) throw new Error("Choose a pairing file first.");
    const selected = invitation;
    invitation = undefined; // A lost response must not cause an automatic exchange retry.
    await call("pair", { pairing: selected });
    pairingConsumed = true;
    renderPairing();
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
      action === "unbind"
        ? t("Unbinding; run evidence stays with the Project.")
        : t("Updating pause state…"),
    );
    void call(action === "disable" && paused ? "resume" : (action as string))
      .then(() => showStatus("snapshot"))
      .catch((error: unknown) =>
        field(
          "error",
          error instanceof Error ? error.message : "Action not confirmed. Check Project evidence.",
        ),
      )
      .finally(() => {
        safetyBusy = false;
      });
  });
}
function field(id: string, text: string) {
  const element = document.querySelector(`#${id}`);
  if (id === "error") lastError = text;
  if (element) element.textContent = id === "error" ? diagnostic(text) : text;
}
async function showStatus(type = "status") {
  const data = await call(type === "inspect" && !project.value ? "status" : type, {
    projectId: project.value,
  });
  if (!object(data)) throw new Error("Invalid status response.");
  lastData = data;
  renderStatus(data);
}
function renderStatus(data: Record<string, unknown>) {
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
      ? t("Working")
      : connectivity?.status === "connected" && (!data.currentBound || data.enabled)
        ? t("Ready")
        : t("Needs attention"),
  );
  paused = data.currentBound === true && binding?.pausedByUser === true;
  field("disable", paused ? t("Resume") : t("Pause"));
  const bindButton = document.querySelector<HTMLButtonElement>("#bind");
  if (bindButton) bindButton.hidden = data.currentBound === true;
  if (data.currentBound && typeof binding?.projectId === "string")
    project.value = binding.projectId;
  project.disabled = data.currentBound === true;
  field(
    "conversation",
    data.currentBound
      ? t("Current — explicitly bound")
      : data.conversation
        ? t("Current — unbound")
        : t("Open a saved chatgpt.com conversation"),
  );
  field(
    "bound-project",
    data.currentBound && binding
      ? `${binding.projectName}\n${binding.projectRoot}`
      : t("This conversation is not bound to a Project"),
  );
  field(
    "previous-binding",
    !data.currentBound && binding
      ? t(
          "Previous / other-page binding: {name}\n{path}\nNo dispatch or handback will target this conversation.",
          { name: String(binding.projectName), path: String(binding.projectRoot) },
        )
      : "",
  );
  field("project-detail", binding ? `${binding.projectId}\n${binding.projectRoot}` : t("Unbound"));
  field(
    "daemon",
    `${label(data.transport)} — ${label(connectivity?.status ?? "disconnected")} — ${diagnostic(connectivity?.message)}`,
  );
  field(
    "native",
    readiness
      ? `${object(selected?.project) ? selected.project.name : t("Project")}\nCodex — ${readiness.ready ? t("Ready") : t("Not ready")}\n${diagnostic(readiness.message)}\n${t("Checked at {time}", { time: date(Number(data.readinessAt), true) })}`
      : `Codex — ${t("Not checked; choose a Project")}`,
  );
  field(
    "run",
    binding?.runId
      ? last?.delivery === "confirmed"
        ? t("Result returned")
        : binding.phase === "ready_to_deliver"
          ? t("Result ready for review")
          : binding.phase === "dispatching"
            ? t("Plan sent to Codex")
            : binding.phase === "running"
              ? t("Codex working")
              : label(binding.runStatus ?? "Needs attention")
      : t("No run yet"),
  );
  field(
    "run-detail",
    binding?.runId ? `${binding.runId}\n${label(binding.runStatus)}` : t("No run yet"),
  );
  field("agent", `Codex — ${label(binding?.agentStatus ?? "idle")}`);
  field(
    "last-result",
    last
      ? `${label(last.status)} — ${last.summary}\n${t("Run")}: ${last.runId}\n${t("Delivery: {delivery}", { delivery: label(last.delivery) })}`
      : t("No result yet"),
  );
  field(
    "grant",
    data.transport === "native"
      ? t(
          "Persistent local authorization; each Project needs an explicit Bind. Revoke on this machine with ve setup --revoke.",
        )
      : data.paired
        ? t("Local authorization expires: {time}", { time: date(Number(data.expiresAt)) })
        : t("Unauthorized / expired / revoked"),
  );
  status.textContent =
    data.currentBound && binding
      ? `${diagnostic(binding.message)}\n${t("Executions: {count}/{limit}", { count: Number(binding.count), limit: Number(binding.maxRuns) })}`
      : connectivity?.status === "connected"
        ? t("Choose a Project → Bind → Just talk.")
        : t("Run ve setup first, then ve init inside the Project.");
}
void extensionLocale().then((store) => {
  language = store;
  const picker = document.querySelector<HTMLSelectElement>("#locale") as HTMLSelectElement;
  const renderLanguage = () => {
    for (const element of document.querySelectorAll<HTMLElement>("[data-i18n]"))
      element.textContent = t(element.dataset.i18n ?? "");
    picker.value = store.snapshot().locale;
    field(
      "locale-error",
      store.snapshot().saveFailed ? t("Language preference could not be saved. Try again.") : "",
    );
    renderProjects(true);
    if (lastData) renderStatus(lastData);
    renderPairing();
    document.title = `Veyra · ${t("Diagnostics")}`;
    field("error", lastError);
  };
  picker.addEventListener("change", () => {
    if (picker.value === "zh-CN" || picker.value === "en") store.set(picker.value);
  });
  const unsubscribe = store.subscribe(renderLanguage);
  renderLanguage();
  act(async () => {
    await showStatus("snapshot");
    await refresh();
  });
  const stop = watchPopup(() => {
    if (!busy && !invitation) act(() => showStatus("snapshot"), true);
  });
  window.addEventListener(
    "pagehide",
    () => {
      unsubscribe();
      stop();
    },
    { once: true },
  );
});

function renderPairing() {
  field(
    "pairing-scope",
    invitation
      ? t(
          "Authorize {url}\nOnly these Project IDs:\n{projects}\nInvitation expires: {expires}\nAccess lasts at most 8 hours and can be revoked.",
          {
            url: invitation.url,
            projects: invitation.projectIds.join("\n"),
            expires: date(invitation.expiresAt),
          },
        )
      : pairingConsumed
        ? t("Local authorization established. Pairing file consumed.")
        : "",
  );
  if (invitation)
    status.textContent = t("Check the local address and Project scope, then confirm pairing.");
}
