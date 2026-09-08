import { CodexAdapter } from "@veyraoss/codex";
import { parseConfig } from "@veyraoss/config";
import { loadProjectBindings, openProject, ProjectError } from "@veyraoss/project";
import type { ProjectDescriptor, ProjectHandoff, ProjectRoleBinding } from "@veyraoss/protocol";
import type { ProcessRunner } from "@veyraoss/runtime";
import type { ExecutionSetup } from "@veyraoss/daemon";
import { CliError } from "./arguments.js";

export async function projectExecutor(from: string) {
  try {
    const project = await openProject(from);
    const bindings = await loadProjectBindings(project);
    if (bindings?.roles.executor) return { project, bindings, executor: bindings.roles.executor };
  } catch (error) {
    if (!(error instanceof ProjectError) || error.code !== "project_missing") throw error;
  }
  return undefined;
}

export function requireNativeCodex(binding: ProjectRoleBinding) {
  if (binding.provider !== "codex" || binding.mode !== "native")
    throw new CliError(
      "unsupported_executor_binding",
      "This CLI currently supports Project executor codex/native. Select a supported binding or use an explicit optional workflow.",
    );
}

export function nativeConfig(project: ProjectDescriptor, binding: ProjectRoleBinding) {
  return parseConfig({
    version: 1,
    agents: {
      executor: { provider: binding.provider, ...(binding.model ? { model: binding.model } : {}) },
    },
    workflow: { use: "project-executor" },
    runtime: { stateDir: `${project.root}/.veyra`, maxFixIterations: 0 },
  });
}

/** Host composition selects the first native adapter; Core remains provider-neutral. */
export function nativeExecution(
  project: ProjectDescriptor,
  binding: ProjectRoleBinding,
  handoff: ProjectHandoff,
  dependencies: { runProcess?: ProcessRunner; env: NodeJS.ProcessEnv },
): ExecutionSetup {
  requireNativeCodex(binding);
  return {
    config: nativeConfig(project, binding),
    workflow: {
      version: 1,
      name: "project-executor",
      start: "execute",
      steps: {
        execute: { type: "agent", agent: "executor" },
      },
    },
    agents: {
      executor: new CodexAdapter(
        {
          executable: binding.executable,
          model: binding.model,
          session: {
            project,
            ...(binding.session?.runId === handoff.runId ? { resume: binding.session } : {}),
          },
        },
        dependencies,
      ),
    },
  };
}
