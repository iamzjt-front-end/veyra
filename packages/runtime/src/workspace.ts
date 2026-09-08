import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isWorkspaceInfo, type WorkspaceInfo } from "@veyra/protocol";
import { runProcess, type ProcessRunner } from "./process.js";
import {
  acquireWorkspaceLease,
  exists,
  WorkspaceError,
  type WorkspaceLease,
} from "./workspace-lease.js";

export interface WorkspacePolicy {
  mode: "shared" | "worktree";
  dirtyPolicy?: "reject" | "use-head";
}

export interface PreparedWorkspace extends WorkspaceLease {
  info: WorkspaceInfo;
}
interface GitWorkspace {
  root: string;
  gitDir: string;
  commonDir: string;
}

/** Owns Git and filesystem lifecycle; Core supplies the run identity and stores the snapshot. */
export class LocalWorkspaceManager {
  constructor(
    readonly stateDir: string,
    readonly runner: ProcessRunner = runProcess,
  ) {}

  async prepare(
    runId: string,
    cwd: string,
    policy: WorkspacePolicy = { mode: "shared" },
  ): Promise<PreparedWorkspace> {
    validateRunId(runId);
    if (
      !policy ||
      !["shared", "worktree"].includes(policy.mode) ||
      (policy.dirtyPolicy !== undefined &&
        (policy.mode !== "worktree" || !["reject", "use-head"].includes(policy.dirtyPolicy)))
    )
      throw new WorkspaceError(
        "invalid_workspace_policy",
        "Expected shared mode, or worktree mode with dirtyPolicy reject/use-head.",
      );
    const actual = await realpath(cwd);
    const git = await this.#discover(actual);
    const root = git?.root ?? actual;
    const sourceLease = await this.#lease(root, git, runId);
    try {
      if (policy.mode === "shared")
        return { info: { mode: "shared", cwd: resolve(cwd), root }, release: sourceLease.release };
      if (!git)
        throw new WorkspaceError(
          "git_workspace_required",
          "Worktree isolation requires a Git working tree with a committed HEAD.",
        );
      const dirtyPolicy = policy.dirtyPolicy ?? "reject";
      if (dirtyPolicy === "reject" && (await this.#dirty(git.root, false)))
        throw new WorkspaceError(
          "dirty_workspace",
          "The source working tree has changes. Commit/stash them, or explicitly set runtime.workspace.dirtyPolicy: use-head to use only committed HEAD.",
        );
      const commit = (await this.#git(git.root, ["rev-parse", "--verify", "HEAD^{commit}"])).trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))
        throw new WorkspaceError(
          "invalid_workspace_commit",
          "Git did not return a commit identity.",
        );
      const directory = await this.#directory();
      const worktrees = await ensureDirectory(join(directory, "worktrees"));
      const target = join(worktrees, runId);
      if (await exists(target))
        throw new WorkspaceError("workspace_exists", `Preserving existing workspace ${target}.`);
      try {
        await this.#git(git.root, ["worktree", "add", "--detach", "--", target, commit]);
        const isolated = await this.#discover(target);
        if (!isolated || isolated.root !== target || isolated.commonDir !== git.commonDir)
          throw new WorkspaceError(
            "invalid_worktree",
            "The new worktree has unexpected Git metadata.",
          );
        const workCwd = join(target, relative(git.root, actual));
        if ((await realpath(workCwd)) !== workCwd)
          throw new WorkspaceError(
            "invalid_worktree",
            "The execution directory resolves outside its expected worktree location.",
          );
        const info: WorkspaceInfo = {
          mode: "worktree",
          cwd: workCwd,
          root: target,
          source: git.root,
          gitDir: isolated.gitDir,
          commit,
          dirtyPolicy,
        };
        const lease = await this.#lease(target, isolated, runId);
        try {
          await writeFile(
            join(isolated.gitDir, "veyra-workspace.json"),
            JSON.stringify({ runId, info }),
            { flag: "wx", mode: 0o600 },
          );
        } catch (error) {
          await lease.release();
          throw error;
        }
        return { info, release: lease.release };
      } catch (error) {
        throw new WorkspaceError(
          "workspace_setup_failed",
          `Worktree setup failed at ${target}; any created files are preserved. ${error instanceof WorkspaceError ? error.message : "Inspect its Git registration and filesystem before cleanup."}`,
        );
      }
    } finally {
      if (policy.mode !== "shared") await sourceLease.release();
    }
  }

  async resume(
    runId: string,
    info: WorkspaceInfo,
    recoverInterrupted = false,
  ): Promise<PreparedWorkspace> {
    validateRunId(runId);
    if (!isWorkspaceInfo(info) || !isAbsolute(info.cwd) || !isAbsolute(info.root))
      throw new WorkspaceError("invalid_workspace", "Invalid saved workspace location.");
    const actual = await realpath(info.cwd);
    const git = await this.#discover(actual);
    if ((git?.root ?? actual) !== info.root)
      throw new WorkspaceError(
        "workspace_changed",
        "The saved execution directory now refers to a different workspace.",
      );
    const lease = await this.#lease(info.root, git, runId, recoverInterrupted);
    try {
      if (info.mode === "worktree") await this.#owned(runId, info, git);
      return { info: structuredClone(info), release: lease.release };
    } catch (error) {
      await lease.release();
      throw error;
    }
  }

  /** Only an unchanged, clean, Veyra-owned worktree is eligible; never uses --force. */
  async remove(runId: string, info: WorkspaceInfo, recoverInterrupted = false): Promise<void> {
    if (info.mode !== "worktree")
      throw new WorkspaceError(
        "shared_workspace",
        "Shared working directories are never removed by Veyra.",
      );
    const workspace = await this.resume(runId, info, recoverInterrupted);
    try {
      const source = await this.#discover(info.source);
      const target = await this.#discover(info.root);
      if (!source || source.root !== info.source || source.commonDir !== target?.commonDir)
        throw new WorkspaceError(
          "workspace_changed",
          "The source Git repository no longer matches this worktree.",
        );
      if ((await this.#git(info.root, ["rev-parse", "HEAD"])).trim() !== info.commit)
        throw new WorkspaceError(
          "workspace_has_commits",
          `Preserving ${info.root}: HEAD changed since this run started. Retain its commits and manage cleanup explicitly with Git.`,
        );
      if (await this.#dirty(info.root, true))
        throw new WorkspaceError(
          "dirty_workspace",
          `Preserving ${info.root}: tracked, untracked, or ignored files have changed. Save the work before cleanup.`,
        );
      await this.#git(source.root, ["worktree", "remove", "--", info.root]);
    } finally {
      await workspace.release();
    }
  }

  async #owned(
    runId: string,
    info: Extract<WorkspaceInfo, { mode: "worktree" }>,
    git: GitWorkspace | undefined,
  ) {
    if (
      info.root !== join(await this.#directory(), "worktrees", runId) ||
      !git ||
      git.gitDir !== info.gitDir ||
      !inside(info.root, info.cwd)
    )
      throw new WorkspaceError(
        "workspace_changed",
        "The worktree no longer matches its saved ownership and location.",
      );
    const file = join(git.gitDir, "veyra-workspace.json");
    const stat = await lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 256 * 1024)
      throw new WorkspaceError("invalid_workspace_owner", "Invalid worktree ownership record.");
    const owner = JSON.parse(await readFile(file, "utf8")) as { runId?: unknown; info?: unknown };
    if (
      !owner ||
      owner.runId !== runId ||
      !isWorkspaceInfo(owner.info) ||
      Object.keys(info).some(
        (key) => Reflect.get(owner.info as object, key) !== Reflect.get(info, key),
      )
    )
      throw new WorkspaceError(
        "invalid_workspace_owner",
        "The worktree ownership record does not match this run.",
      );
  }

  async #lease(root: string, git: GitWorkspace | undefined, runId: string, recover = false) {
    // Common Git metadata survives worktree removal; canonical root keys also coalesce subdirectories.
    const parent = git
      ? await ensureDirectory(
          join(
            await ensureDirectory(join(git.commonDir, "veyra-workspaces")),
            createHash("sha256").update(root).digest("hex"),
          ),
        )
      : await ensureDirectory(join(root, ".veyra"));
    return acquireWorkspaceLease(parent, root, runId, recover);
  }

  async #directory() {
    return ensureDirectory(resolve(this.stateDir));
  }

  async #discover(cwd: string): Promise<GitWorkspace | undefined> {
    // Shared directories need no Git installation when no repository metadata is present.
    let parent = cwd;
    while (!(await exists(join(parent, ".git")))) {
      if (dirname(parent) === parent) return undefined;
      parent = dirname(parent);
    }
    const root = await realpath(
      (await this.#git(cwd, ["rev-parse", "--show-toplevel"])).replace(/\r?\n$/, ""),
    );
    const gitDir = await realpath(
      (await this.#git(cwd, ["rev-parse", "--absolute-git-dir"])).replace(/\r?\n$/, ""),
    );
    const commonDir = await realpath(
      resolve(cwd, (await this.#git(cwd, ["rev-parse", "--git-common-dir"])).replace(/\r?\n$/, "")),
    );
    return { root, gitDir, commonDir };
  }

  async #dirty(root: string, cleanup: boolean): Promise<boolean> {
    // Git status can conceal edits to assume-unchanged/skip-worktree entries.
    // Preserve those trees instead of treating an incomplete status view as clean.
    const index = await this.#git(root, ["ls-files", "-v", "-z"]);
    if (index.split("\0").some((entry) => entry && !entry.startsWith("H "))) return true;
    const output = await this.#git(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      ...(cleanup ? ["--ignored"] : []),
    ]);
    const entries = output.split("\0");
    for (let index = 0; index < entries.length; index++) {
      const entry = entries[index];
      if (!entry) continue;
      // Rename records have a second path. Any tracked change is already dirty.
      if (!entry.startsWith("?? ") || cleanup) return true;
      const path = resolve(root, entry.slice(3));
      const state = await this.#directory();
      const generated = [
        join(root, ".veyra"),
        ...["runs", "state", "worktrees"].map((name) => join(state, name)),
      ];
      if (
        !generated.some(
          (directory) => inside(root, directory) && directory !== root && inside(directory, path),
        )
      )
        return true;
    }
    return false;
  }

  async #git(cwd: string, args: string[]): Promise<string> {
    // Repository override environment must not redirect management commands to a different checkout.
    const env: Record<string, undefined> = Object.fromEntries(
      Object.keys(process.env)
        .filter((key) => key.startsWith("GIT_"))
        .map((key) => [key, undefined]),
    );
    const result = await this.runner({
      executable: "git",
      args,
      cwd,
      env,
      timeoutMs: 30_000,
      maxOutputBytes: 1024 * 1024,
    });
    if (
      result.exitCode !== 0 ||
      result.terminationReason ||
      result.stdoutTruncated ||
      result.stderrTruncated
    )
      throw new WorkspaceError(
        "workspace_git_failed",
        `Git ${args[0]} failed in ${cwd} (exit ${result.exitCode ?? "none"}${result.terminationReason ? `, ${result.terminationReason}` : ""}${result.stdoutTruncated || result.stderrTruncated ? ", output limit" : ""}). No raw Git output is included; inspect the repository locally.`,
      );
    return result.stdout;
  }
}

async function ensureDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new WorkspaceError("invalid_workspace_path", `Expected a real directory at ${path}.`);
  return realpath(path);
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === "" || (suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix))
  );
}

function validateRunId(runId: string) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId))
    throw new WorkspaceError("invalid_run_id", "Workspace run ID must be a UUID v4.");
}
