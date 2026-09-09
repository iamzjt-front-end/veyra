import { lstat, readFile, writeFile, appendFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  initializeProject,
  openProject,
  ProjectError,
  ProjectRegistry,
  loadProjectBindings,
  saveProjectBindings,
} from "@veyraoss/project";
import { detectCodex } from "./native-installation.js";
async function exists(path: string) {
  try {
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1)
      throw new Error("Refusing a linked/non-regular project config.");
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
export async function initializeNativeProject(
  root: string,
  options: { registryRoot?: string; env?: NodeJS.ProcessEnv } = {},
) {
  let project: Awaited<ReturnType<typeof openProject>> | undefined;
  try {
    project = await openProject(root);
  } catch (error) {
    if (!(error instanceof ProjectError) || error.code !== "project_missing") throw error;
  }
  // A nested invocation opens the existing Project; never write a second config beside its source.
  root = project?.root ?? root;
  const configExists = await exists(join(root, "veyra.yaml"));
  const workflowExists = await exists(join(root, ".veyra/workflow.yaml"));
  const ignored = await exists(join(root, ".gitignore"));
  project ??= await initializeProject(root);
  const registry = new ProjectRegistry(options.registryRoot ? { root: options.registryRoot } : {});
  const bindings = await loadProjectBindings(project);
  const bound = !bindings?.roles.executor;
  if (bound) {
    const executable = await detectCodex(options.env);
    await saveProjectBindings(
      project,
      {
        ...bindings?.roles,
        executor: { provider: "codex", mode: "native", ...(executable ? { executable } : {}) },
      },
      bindings?.revision ?? 0,
    );
  }
  const checks: string[] = [];
  if (!configExists && !workflowExists) {
    let manager = "npm";
    let scripts: Record<string, unknown> = {};
    if (await exists(join(root, "package.json"))) {
      const info = await lstat(join(root, "package.json"));
      if (info.size > 1024 * 1024) throw new Error("package.json exceeds inspection limit.");
      const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
      if (pkg.scripts && typeof pkg.scripts === "object" && !Array.isArray(pkg.scripts))
        scripts = pkg.scripts;
      if (typeof pkg.packageManager === "string" && /^(pnpm|yarn|bun)@/.test(pkg.packageManager))
        manager = pkg.packageManager.split("@")[0];
      else if (await exists(join(root, "pnpm-lock.yaml"))) manager = "pnpm";
      else if (await exists(join(root, "yarn.lock"))) manager = "yarn";
    }
    checks.push(
      ...["lint", "check", "test", "build"].filter((name) => typeof scripts[name] === "string"),
    );
    const steps: Record<string, unknown> = {
      execute: { type: "agent", agent: "executor", next: checks[0] ?? "done" },
    };
    for (const [index, id] of checks.entries())
      steps[id] = {
        type: "command",
        run: [`${manager} run ${id}`],
        next: checks[index + 1] ?? "done",
      };
    steps.done = { type: "end" };
    await writeFile(
      join(root, ".veyra/workflow.yaml"),
      stringify({ name: "project-native", version: 1, start: "execute", steps }),
      { flag: "wx", mode: 0o600 },
    );
    await writeFile(
      join(root, "veyra.yaml"),
      stringify({
        version: 1,
        project: { name: project.name },
        agents: { executor: { provider: "codex" } },
        workflow: { use: ".veyra/workflow.yaml" },
        runtime: { stateDir: ".veyra", maxFixIterations: 0 },
      }),
      { flag: "wx", mode: 0o600 },
    );
  }
  const source = ignored ? await readFile(join(root, ".gitignore"), "utf8") : "";
  const entries = [
    ".veyra/state.json",
    ".veyra/state/",
    ".veyra/runs/",
    ".veyra/handoffs/",
    ".veyra/artifacts/",
    ".veyra/worktrees/",
  ];
  const missing = entries.filter((entry) => !source.split(/\r?\n/).includes(entry));
  if (missing.length)
    await appendFile(
      join(root, ".gitignore"),
      `${source && !source.endsWith("\n") ? "\n" : ""}# Veyra local engineering evidence\n${missing.join("\n")}\n`,
    );
  await registry.register(project.root);
  return { project, bound, checks, createdConfig: !configExists && !workflowExists };
}
