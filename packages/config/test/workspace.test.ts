import { describe, expect, it } from "vitest";
import { parseConfig } from "../src/index.js";

const input = (workspace: unknown) => ({
  version: 1,
  agents: {},
  workflow: { use: "dev" },
  runtime: { workspace },
});
describe("workspace policy", () => {
  it("defaults isolated workspaces to rejecting dirty sources and preserves explicit policies", () => {
    expect(parseConfig(input({ mode: "worktree" })).runtime.workspace).toEqual({
      mode: "worktree",
      dirtyPolicy: "reject",
    });
    expect(
      parseConfig(input({ mode: "worktree", dirtyPolicy: "use-head" })).runtime.workspace,
    ).toEqual({ mode: "worktree", dirtyPolicy: "use-head" });
    expect(parseConfig(input({ mode: "shared" })).runtime.workspace).toEqual({ mode: "shared" });
  });
  it.each(
    [
      null,
      [],
      {},
      "worktree",
      { mode: "copy" },
      { mode: "worktree", dirtyPolicy: "discard" },
      { mode: "shared", dirtyPolicy: "reject" },
      { mode: "worktree", cleanup: "always" },
    ].map((value) => [value]),
  )("rejects unsupported workspace configuration %j", (value) => {
    expect(() => parseConfig(input(value))).toThrow(/runtime.workspace/);
  });
});
