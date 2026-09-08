import { CodexAdapter } from "@veyraoss/codex";
import { parseConfig, type VeyraConfig } from "@veyraoss/config";
import { loadProjectBindings, openProject, ProjectError } from "@veyraoss/project";
import type { ProjectDescriptor, ProjectHandoff, ProjectRoleBinding } from "@veyraoss/protocol";
import type { ProcessRunner } from "@veyraoss/runtime";
import { DaemonError, type ExecutionSetup } from "@veyraoss/daemon";
import type { WorkflowDefinition } from "@veyraoss/workflow";
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
  verification?: { config: VeyraConfig; workflow: WorkflowDefinition },
): ExecutionSetup {
  try {
    requireNativeCodex(binding);
  } catch (error) {
    if (error instanceof CliError) throw new DaemonError(error.code, error.message);
    throw error;
  }
  const config = nativeConfig(project, binding);
  if (verification?.config.runtime.workspace?.mode === "worktree")
    throw new DaemonError(
      "unsupported_native_workspace",
      "Project-native sessions execute in the bound Project root. Use an explicit optional workflow for worktree execution.",
    );
  if (verification) config.approval = verification.config.approval;
  const setup: ExecutionSetup = {
    config,
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
  let previous = "execute";
  for (const requested of handoff.requestedVerification ?? []) {
    const step = verification?.workflow.steps[requested.id];
    if (step?.type !== "command" || !step.run?.length || requested.id === "execute")
      throw new DaemonError(
        "verification_unconfigured",
        "Configure each requested check as a command step in the Project's local veyra.yaml workflow; 'execute' is reserved for the native executor.",
      );
    const prior = setup.workflow.steps[previous];
    if (prior) prior.next = requested.id;
    setup.workflow.steps[requested.id] = {
      type: "command",
      run: [...step.run],
      ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
    };
    previous = requested.id;
  }
  return setup;
}
