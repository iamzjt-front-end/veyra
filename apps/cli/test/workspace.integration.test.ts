import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { initializeGit } from "../../../test/helpers/git.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { runCli } from "../src/application.js";

describe("workspace CLI", { timeout: 30_000 }, () => {
  it("shows persisted worktree metadata in run/status and removes a clean terminal workspace", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await writeFile(
        join(path, "veyra.yaml"),
        JSON.stringify({
          version: 1,
          agents: {},
          workflow: { use: "workflow.yaml" },
          runtime: { workspace: { mode: "worktree" } },
        }),
      );
      await writeFile(
        join(path, "workflow.yaml"),
        JSON.stringify({
          version: 1,
          name: "fixture",
          start: "done",
          steps: { done: { type: "end" } },
        }),
      );
      const commit = await initializeGit(path);
      const invoke = async (args: string[]) => {
        let output = "";
        const code = await runCli(args, {
          cwd: path,
          env: {},
          stdout: (text) => {
            output += text;
          },
          stderr: (text) => {
            output += text;
          },
        });
        return {
          code,
          output,
          records: () =>
            output
              .trim()
              .split("\n")
              .map((line) => JSON.parse(line)),
        };
      };
      const run = await invoke(["run", "Isolated baseline", "--json"]);
      expect(run.code, run.output).toBe(0);
      expect(run.records()[0]).toMatchObject({
        type: "run.started",
        workspace: { mode: "worktree", commit },
      });
      const id = run.records().at(-1).runId as string;
      const status = await invoke(["status", id, "--json"]);
      expect(status.records()[0]).toMatchObject({
        workspace: { mode: "worktree", commit },
        workspaceAvailable: true,
      });
      const plain = await invoke(["status", id]);
      expect(plain.output).toContain(`Base commit: ${commit}`);
      expect(plain.output).toContain("Worktree:");
      const removed = await invoke(["workspace", "remove", id, "--json"]);
      expect(removed.code, removed.output).toBe(0);
      expect(removed.records()[0]).toMatchObject({ runId: id, removed: true });
      expect((await invoke(["status", id, "--json"])).records()[0]).toMatchObject({
        status: "completed",
        workspaceAvailable: false,
      });
      expect(
        (await invoke(["workspace", "remove", id, "--force", "--json"])).records()[0],
      ).toMatchObject({ code: "invalid_option" });
    });
  });

  it("rejects missing or unexpected workspace arguments without loading configuration", async () => {
    for (const args of [
      ["workspace"],
      ["workspace", "delete", "id"],
      ["workspace", "remove"],
      ["workspace", "remove", "id", "extra"],
    ]) {
      let output = "";
      expect(
        await runCli([...args, "--json"], {
          env: {},
          stdout: (text) => {
            output += text;
          },
        }),
      ).toBe(2);
      expect(JSON.parse(output)).toMatchObject({ code: "invalid_workspace_command" });
    }
  });
});
