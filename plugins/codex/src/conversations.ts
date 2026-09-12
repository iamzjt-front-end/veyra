import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { isSessionId, type NativeConversation } from "@veyraoss/protocol";
import { record, withAppServer, type AppServerOptions } from "./app-server.js";

export function conversationMetadata(value: unknown): NativeConversation {
  if (
    !record(value) ||
    !isSessionId(value.id) ||
    typeof value.cwd !== "string" ||
    !isAbsolute(value.cwd) ||
    value.cwd.length > 4096 ||
    [...value.cwd].some((c) => c.charCodeAt(0) < 32) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 512
  )
    throw new Error("Codex task has no valid title or local project directory.");
  // Deliberately discard preview, turns, paths to transcripts and provider configuration.
  return { id: value.id, title: value.name, root: value.cwd };
}
export async function listCodexConversations(
  options: AppServerOptions,
  query: { cursor?: string; search?: string } = {},
) {
  return withAppServer(options, async (rpc) => {
    const response = await rpc.call("thread/list", {
      limit: 30,
      sortKey: "updated_at",
      useStateDbOnly: true,
      archived: false,
      ...(query.cursor ? { cursor: query.cursor } : {}),
      ...(query.search ? { searchTerm: query.search } : {}),
    });
    if (
      !record(response) ||
      !Array.isArray(response.data) ||
      response.data.length > 30 ||
      (response.nextCursor != null &&
        (typeof response.nextCursor !== "string" || response.nextCursor.length > 4096))
    )
      throw new Error("Invalid Codex task listing.");
    const conversations: NativeConversation[] = [];
    for (const item of response.data) {
      try {
        conversations.push(conversationMetadata(item));
      } catch {
        /* Unnamed/nonlocal tasks cannot be selected. */
      }
    }
    return { conversations, cursor: (response.nextCursor as string | null) ?? null };
  });
}
export async function readCodexConversation(options: AppServerOptions, id: string) {
  if (!isSessionId(id)) throw new Error("Invalid Codex task ID.");
  return withAppServer(options, async (rpc) => {
    const response = await rpc.call("thread/read", { threadId: id, includeTurns: false });
    const selected = conversationMetadata(record(response) ? response.thread : undefined);
    if (selected.id !== id) throw new Error("Codex task identity changed.");
    return selected;
  });
}
/** Acquire and release the native writer, without appending a turn. Status notLoaded is not a lock check. */
export async function checkCodexConversation(
  options: AppServerOptions,
  selected: NativeConversation,
) {
  return withAppServer(options, async (rpc) => {
    const metadata = await rpc.call("thread/read", { threadId: selected.id, includeTurns: false });
    await requireConversationRoot(record(metadata) ? metadata.thread : undefined, selected);
    if (rpc.shared) requireIdleConversation(record(metadata) ? metadata.thread : undefined, true);
    const response = await rpc.call("thread/resume", { threadId: selected.id, excludeTurns: true });
    await requireConversationRoot(record(response) ? response.thread : undefined, selected);
    if (rpc.shared) requireIdleConversation(record(response) ? response.thread : undefined);
    return { ready: true as const };
  });
}
/** An idle shared server is different from an unloaded task in a separate stdio process. */
export function requireIdleConversation(value: unknown, allowUnloaded = false) {
  const status = record(value) && record(value.status) ? value.status.type : undefined;
  if (status === "idle" || (allowUnloaded && status === "notLoaded")) return;
  throw new Error(
    status === "active"
      ? "The selected Codex task is running. Wait for it to finish; Veyra did not send another task."
      : "The selected Codex task has no confirmed idle status. Veyra did not dispatch.",
  );
}
export async function requireConversationRoot(value: unknown, selected: NativeConversation) {
  const actual = conversationMetadata(value);
  if (
    actual.id !== selected.id ||
    (await realpath(actual.root)) !== (await realpath(selected.root))
  )
    throw new Error("The selected Codex task moved to another Project. Bind explicitly again.");
  return actual;
}
