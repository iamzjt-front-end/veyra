import { isJsonValue } from "./json.js";

/** Immutable execution location, saved with a run before invoking any agent. */
export type WorkspaceInfo =
  | { mode: "shared"; cwd: string; root: string }
  | {
      mode: "worktree";
      cwd: string;
      root: string;
      source: string;
      gitDir: string;
      commit: string;
      dirtyPolicy: "reject" | "use-head";
    };

export function isWorkspaceInfo(value: unknown): value is WorkspaceInfo {
  if (!isJsonValue(value) || !value || typeof value !== "object" || Array.isArray(value))
    return false;
  const path = (item: unknown) =>
    typeof item === "string" && item.length > 0 && item.length <= 32768 && !item.includes("\0");
  if (!path(value.cwd) || !path(value.root)) return false;
  if (value.mode === "shared")
    return Object.keys(value).every((key) => ["mode", "cwd", "root"].includes(key));
  return (
    value.mode === "worktree" &&
    path(value.source) &&
    path(value.gitDir) &&
    typeof value.commit === "string" &&
    /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value.commit) &&
    ["reject", "use-head"].includes(value.dirtyPolicy as string) &&
    Object.keys(value).every((key) =>
      ["mode", "cwd", "root", "source", "gitDir", "commit", "dirtyPolicy"].includes(key),
    )
  );
}
