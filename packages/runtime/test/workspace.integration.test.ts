import { randomUUID } from "node:crypto";
import { mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { git, initializeGit } from "../../../test/helpers/git.js";
import { LocalWorkspaceManager, runProcess } from "../src/index.js";

describe("local workspace lifecycle", () => {
  it("preserves the shared directory and rejects overlapping runs across state directories", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const first = await new LocalWorkspaceManager(join(path, "state-one")).prepare(
        randomUUID(),
        path,
      );
      try {
        expect(first.info).toMatchObject({ mode: "shared", cwd: path });
        await expect(
          new LocalWorkspaceManager(join(path, "state-two")).prepare(
            randomUUID(),
            await realpath(path),
          ),
        ).rejects.toMatchObject({ code: "workspace_busy" });
      } finally {
        await first.release();
      }
      const next = await new LocalWorkspaceManager(join(path, "state-two")).prepare(
        randomUUID(),
        path,
      );
      await next.release();
    });
  });

  it("shares Git leases across subdirectory aliases and independent processes", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeGit(path);
      await mkdir(join(path, "nested"));
      const manager = new LocalWorkspaceManager(join(path, ".veyra"));
      const active = await manager.prepare(randomUUID(), path);
      try {
        await expect(manager.prepare(randomUUID(), join(path, "nested"))).rejects.toMatchObject({
          code: "workspace_busy",
        });
        const script = `import { LocalWorkspaceManager } from ${JSON.stringify(new URL("../src/index.ts", import.meta.url).href)}; import { randomUUID } from 'node:crypto'; try { const lease = await new LocalWorkspaceManager(process.argv[1]).prepare(randomUUID(), process.argv[2]); await lease.release(); console.log('unexpected success'); } catch (e) { console.log(e.code); }`;
        const child = await runProcess({
          executable: process.execPath,
          args: [
            "--import",
            "tsx",
            "--input-type=module",
            "-e",
            script,
            join(path, "other"),
            join(path, "nested"),
          ],
          timeoutMs: 30_000,
        });
        expect(child.exitCode, child.stderr).toBe(0);
        expect(child.stdout.trim()).toBe("workspace_busy");
      } finally {
        await active.release();
      }
    });
  });

  it("creates independent detached worktrees and maps a committed subdirectory", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await mkdir(join(path, "nested"));
      await writeFile(join(path, "nested", "file.txt"), "baseline");
      const commit = await initializeGit(path);
      const manager = new LocalWorkspaceManager(join(path, ".veyra"));
      const ids = [randomUUID(), randomUUID()];
      const first = await manager.prepare(ids[0] as string, join(path, "nested"), {
        mode: "worktree",
      });
      const second = await manager.prepare(ids[1] as string, path, { mode: "worktree" });
      try {
        expect(first.info).toMatchObject({ mode: "worktree", commit, dirtyPolicy: "reject" });
        expect(first.info.cwd).toBe(join(first.info.root, "nested"));
        expect(await git(first.info.root, "rev-parse", "--abbrev-ref", "HEAD")).toBe("HEAD");
        await writeFile(join(first.info.cwd, "file.txt"), "first run");
        expect(await readFile(join(second.info.root, "nested", "file.txt"), "utf8")).toBe(
          "baseline",
        );
        expect(await readFile(join(path, "nested", "file.txt"), "utf8")).toBe("baseline");
      } finally {
        await first.release();
        await second.release();
      }
      await expect(manager.remove(ids[0] as string, first.info)).rejects.toMatchObject({
        code: "dirty_workspace",
      });
      await manager.remove(ids[1] as string, second.info);
      await expect(readFile(join(second.info.root, "package.json"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      expect(await readFile(join(first.info.cwd, "file.txt"), "utf8")).toBe("first run");
    });
  });

  it.each(["tracked", "staged", "untracked"])(
    "rejects a %s dirty source unless use-head is explicit",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        await initializeGit(path);
        const file = kind === "untracked" ? "new.txt" : "package.json";
        await writeFile(join(path, file), "user changes");
        if (kind === "staged") await git(path, "add", file);
        const manager = new LocalWorkspaceManager(join(path, ".veyra"));
        await expect(
          manager.prepare(randomUUID(), path, { mode: "worktree" }),
        ).rejects.toMatchObject({ code: "dirty_workspace" });
        const id = randomUUID();
        const workspace = await manager.prepare(id, path, {
          mode: "worktree",
          dirtyPolicy: "use-head",
        });
        await workspace.release();
        expect(await readFile(join(path, file), "utf8")).toBe("user changes");
        if (kind === "untracked")
          await expect(readFile(join(workspace.info.root, file))).rejects.toMatchObject({
            code: "ENOENT",
          });
        else
          expect(await readFile(join(workspace.info.root, file), "utf8")).not.toBe("user changes");
        await manager.remove(id, workspace.info);
      });
    },
  );

  it("ignores generated run state but does not ignore arbitrary files when stateDir is the repository", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeGit(path);
      await mkdir(join(path, "runs"));
      await writeFile(join(path, "runs", "generated.json"), "{}");
      const manager = new LocalWorkspaceManager(path);
      const id = randomUUID();
      const workspace = await manager.prepare(id, path, { mode: "worktree" });
      await workspace.release();
      await manager.remove(id, workspace.info);
      await writeFile(join(path, "user.txt"), "user work");
      await expect(manager.prepare(randomUUID(), path, { mode: "worktree" })).rejects.toMatchObject(
        { code: "dirty_workspace" },
      );
    });
  });

  it.each(["ignored", "untracked", "committed"])(
    "preserves %s work during cleanup",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        await writeFile(join(path, ".gitignore"), "cache/\n");
        await initializeGit(path);
        const manager = new LocalWorkspaceManager(join(path, ".veyra"));
        const id = randomUUID();
        const workspace = await manager.prepare(id, path, { mode: "worktree" });
        await workspace.release();
        const file =
          kind === "ignored"
            ? join(workspace.info.root, "cache", "data")
            : join(workspace.info.root, "result.txt");
        if (kind === "ignored") await mkdir(join(workspace.info.root, "cache"));
        await writeFile(file, "retain this");
        if (kind === "committed") {
          await git(workspace.info.root, "add", "result.txt");
          await git(workspace.info.root, "commit", "-m", "Agent change");
        }
        await expect(manager.remove(id, workspace.info)).rejects.toMatchObject({
          code: kind === "committed" ? "workspace_has_commits" : "dirty_workspace",
        });
        expect(await readFile(file, "utf8")).toBe("retain this");
      });
    },
  );

  it("refuses cleanup while a worktree is active, and never removes shared directories", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeGit(path);
      const manager = new LocalWorkspaceManager(join(path, ".veyra"));
      const id = randomUUID();
      const workspace = await manager.prepare(id, path, { mode: "worktree" });
      try {
        await expect(manager.remove(id, workspace.info)).rejects.toMatchObject({
          code: "workspace_busy",
        });
      } finally {
        await workspace.release();
      }
      await manager.remove(id, workspace.info);
      const shared = await manager.prepare(randomUUID(), path);
      await shared.release();
      await expect(manager.remove(randomUUID(), shared.info)).rejects.toMatchObject({
        code: "shared_workspace",
      });
    });
  });

  it("validates saved ownership and refuses a replaced worktree path", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeGit(path);
      const manager = new LocalWorkspaceManager(join(path, ".veyra"));
      const id = randomUUID();
      const workspace = await manager.prepare(id, path, { mode: "worktree" });
      await workspace.release();
      if (workspace.info.mode !== "worktree") throw new Error("Expected worktree");
      await expect(
        manager.resume(id, { ...workspace.info, commit: "a".repeat(40) }),
      ).rejects.toMatchObject({ code: "invalid_workspace_owner" });
      await rm(join(workspace.info.gitDir, "veyra-workspace.json"));
      await symlink(
        join(path, "package.json"),
        join(workspace.info.gitDir, "veyra-workspace.json"),
      );
      await expect(manager.remove(id, workspace.info)).rejects.toMatchObject({
        code: "invalid_workspace_owner",
      });
      await rm(workspace.info.root, { recursive: true });
      await symlink(path, workspace.info.root, "dir");
      await expect(manager.resume(id, workspace.info)).rejects.toMatchObject({
        code: "workspace_changed",
      });
    });
  });

  it.each(["--assume-unchanged", "--skip-worktree"])(
    "preserves files hidden from status by %s",
    async (flag) => {
      await withFixtureWorkspace(async ({ path }) => {
        await initializeGit(path);
        const manager = new LocalWorkspaceManager(join(path, ".veyra"));
        const id = randomUUID();
        const workspace = await manager.prepare(id, path, { mode: "worktree" });
        await workspace.release();
        await git(workspace.info.root, "update-index", flag, "package.json");
        await writeFile(join(workspace.info.root, "package.json"), "hidden user change");
        expect(await git(workspace.info.root, "status", "--porcelain")).toBe("");
        await expect(manager.remove(id, workspace.info)).rejects.toMatchObject({
          code: "dirty_workspace",
        });
        expect(await readFile(join(workspace.info.root, "package.json"), "utf8")).toBe(
          "hidden user change",
        );
      });
    },
  );

  it("refuses a symlinked worktree container before creating files", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      await initializeGit(path);
      await mkdir(join(path, ".veyra"));
      await symlink(path, join(path, ".veyra", "worktrees"), "dir");
      const manager = new LocalWorkspaceManager(join(path, ".veyra"));
      await expect(manager.prepare(randomUUID(), path, { mode: "worktree" })).rejects.toMatchObject(
        { code: "invalid_workspace_path" },
      );
      const next = await manager.prepare(randomUUID(), path);
      await next.release();
    });
  });

  it("rejects non-Git and unborn repositories without leaving a workspace lease", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const manager = new LocalWorkspaceManager(join(path, ".veyra"));
      await expect(manager.prepare(randomUUID(), path, { mode: "worktree" })).rejects.toMatchObject(
        { code: "git_workspace_required" },
      );
      const shared = await manager.prepare(randomUUID(), path);
      await shared.release();
      await git(path, "init");
      await expect(
        manager.prepare(randomUUID(), path, { mode: "worktree", dirtyPolicy: "use-head" }),
      ).rejects.toMatchObject({ code: "workspace_git_failed" });
      const after = await manager.prepare(randomUUID(), path);
      await after.release();
    });
  });
});
