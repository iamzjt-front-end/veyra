import { describe, expect, it } from "vitest";
import { isWorkspaceInfo } from "../src/index.js";

describe("workspace snapshot contract", () => {
  const shared = { mode: "shared", cwd: "/fixture", root: "/fixture" };
  const worktree = {
    mode: "worktree",
    cwd: "/state/worktrees/run",
    root: "/state/worktrees/run",
    source: "/fixture",
    gitDir: "/fixture/.git/worktrees/run",
    commit: "a".repeat(40),
    dirtyPolicy: "reject",
  };
  it("accepts shared and detached worktree snapshots", () => {
    expect(isWorkspaceInfo(shared)).toBe(true);
    expect(isWorkspaceInfo(worktree)).toBe(true);
    expect(isWorkspaceInfo({ ...worktree, commit: "b".repeat(64), dirtyPolicy: "use-head" })).toBe(
      true,
    );
  });
  it.each(
    [
      null,
      [],
      { ...shared, cwd: "" },
      { ...shared, cwd: "bad\0path" },
      { ...shared, secret: "unexpected" },
      { ...worktree, commit: "HEAD" },
      { ...worktree, dirtyPolicy: "discard" },
      { ...worktree, source: undefined },
    ].map((value) => [value]),
  )("rejects malformed snapshots %j", (value) => {
    expect(isWorkspaceInfo(value)).toBe(false);
  });
});
