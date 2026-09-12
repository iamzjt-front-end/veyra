/** Current-document routing diagnostics only. Never contains prompts or reply bodies. */
export interface PageObservation {
  phase:
    | "waiting_for_send"
    | "waiting_for_reply"
    | "streaming"
    | "waiting_for_completion"
    | "no_protocol"
    | "protocol_ready"
    | "unsupported"
    | "invalid";
  assistantId?: string;
}

export const observationCopy: Record<
  PageObservation["phase"],
  { title: string; description: string }
> = {
  waiting_for_send: {
    title: "Waiting for your next message",
    description: "Binding restored. Earlier replies will not be replayed.",
  },
  waiting_for_reply: {
    title: "Waiting for ChatGPT",
    description: "Your task has not been sent to Codex yet.",
  },
  streaming: {
    title: "ChatGPT is responding",
    description: "Veyra will validate the completed reply before sending it to Codex.",
  },
  waiting_for_completion: {
    title: "Waiting for reply confirmation",
    description:
      "Veyra has not confirmed that this reply is complete. Nothing has been sent to Codex.",
  },
  no_protocol: {
    title: "Reply received",
    description: "This reply contains no executable handoff. No task was sent to Codex.",
  },
  protocol_ready: {
    title: "Checking the task",
    description: "Veyra detected a structured task and is checking it before dispatch.",
  },
  unsupported: {
    title: "Page layout needs attention",
    description: "The current reply could not be identified safely. No task was sent to Codex.",
  },
  invalid: {
    title: "Task format needs attention",
    description: "Veyra could not validate this reply. No task was sent to Codex.",
  },
};

export function parseObservation(value: unknown): PageObservation | undefined {
  if (!value || typeof value !== "object") return;
  const entry = value as Record<string, unknown>;
  if (
    ![
      "waiting_for_send",
      "waiting_for_reply",
      "streaming",
      "waiting_for_completion",
      "no_protocol",
      "protocol_ready",
      "unsupported",
      "invalid",
    ].includes(String(entry.phase)) ||
    (entry.assistantId !== undefined &&
      (typeof entry.assistantId !== "string" || !/^[\w-]{1,128}$/.test(entry.assistantId)))
  )
    return;
  return {
    phase: entry.phase as PageObservation["phase"],
    ...(typeof entry.assistantId === "string" ? { assistantId: entry.assistantId } : {}),
  };
}
