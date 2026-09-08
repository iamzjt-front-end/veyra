import { randomUUID } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { stringify } from "yaml";
import { CliError } from "./arguments.js";

export async function initialize(
  configPath: string,
  options: { force?: boolean; workflow?: string; model?: string },
) {
  const root = dirname(configPath);
  const ignorePath = join(root, ".gitignore");
  const configExists = await regularOrMissing(configPath);
  if (configExists && !options.force)
    throw new CliError(
      "config_exists",
      `${configPath} already exists. Keep it or explicitly use ve init --force to replace it.`,
    );
  const ignored = (await regularOrMissing(ignorePath)) ? await readFile(ignorePath, "utf8") : "";
  const model = options.model ?? "gpt-5.6-sol";
  if (!model.trim() || !(options.workflow ?? "dev").trim())
    throw new CliError("invalid_init_option", "Model and workflow must be non-empty.");
  const config = {
    version: 1,
    project: { name: basename(root) || "project" },
    agents: {
      planner: { provider: "openai", model },
      executor: { provider: "codex" },
      reviewer: { provider: "openai", model },
    },
    workflow: { use: options.workflow ?? "dev" },
    runtime: { maxFixIterations: 3, stateDir: ".veyra" },
  };
  if (options.force) await writeAtomic(configPath, stringify(config), 0o600);
  else await writeFile(configPath, stringify(config), { flag: "wx", mode: 0o600 });
  const block = "# Veyra local run state\n.veyra/state/\n.veyra/runs/\n.veyra/worktrees/\n";
  if (!ignored.endsWith(block))
    await writeAtomic(
      ignorePath,
      `${ignored}${ignored && !ignored.endsWith("\n") ? "\n" : ""}${block}`,
      0o644,
    );
  return { configPath, ignorePath, model, workflow: config.workflow.use };
}

async function writeAtomic(path: string, text: string, mode: number) {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: "wx", mode });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function regularOrMissing(path: string): Promise<boolean> {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink())
      throw new CliError(
        "unsafe_init_path",
        `Refusing to replace a non-regular file or symlink: ${path}`,
      );
    return true;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}
