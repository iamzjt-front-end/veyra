import { join } from "node:path";
import { runProcess } from "../../packages/runtime/src/process.js";

/** A repository entirely inside the caller's disposable fixture; never reads credentials. */
export async function git(cwd: string, ...args: string[]): Promise<string> {
  const result = await runProcess({
    executable: "git",
    cwd,
    args,
    timeoutMs: 30_000,
    env: {
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: join(cwd, ".git", "unused-global-config"),
      GIT_DIR: undefined,
      GIT_WORK_TREE: undefined,
      GIT_INDEX_FILE: undefined,
    },
  });
  if (result.exitCode !== 0) throw new Error(`Fixture Git failed: ${result.stderr}`);
  return result.stdout.replace(/\r?\n$/, "");
}

export async function initializeGit(cwd: string): Promise<string> {
  await git(cwd, "-c", "init.defaultBranch=main", "init");
  await git(cwd, "config", "user.name", "Veyra fixture");
  await git(cwd, "config", "user.email", "fixture@example.invalid");
  await git(cwd, "config", "commit.gpgSign", "false");
  await git(cwd, "config", "core.hooksPath", join(cwd, ".git", "unused-hooks"));
  await git(cwd, "config", "core.autocrlf", "false");
  await git(cwd, "add", "--all");
  await git(cwd, "commit", "-m", "Fixture baseline");
  return git(cwd, "rev-parse", "HEAD");
}
