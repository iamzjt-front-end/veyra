import { CodexAdapter, CodexConversationAdapter } from "@veyraoss/codex";
import { parseConfig, type VeyraConfig } from "@veyraoss/config";
import { loadProjectBindings, openProject, ProjectError } from "@veyraoss/project";
import type {
  ProjectDescriptor,
  ProjectHandoff,
  ProjectRoleBinding,
  NativeConversation,
} from "@veyraoss/protocol";
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
  conversation?: NativeConversation,
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
    // Native reasoning/transport recovery can exceed two minutes. Keep the adapter's bounded default.
    timeoutMs: 15 * 60_000,
    workflow: {
      version: 1,
      name: "project-executor",
      start: "execute",
      steps: {
        execute: { type: "agent", agent: "executor" },
      },
    },
    agents: {
      executor: conversation
        ? new CodexConversationAdapter(
            conversation,
            project,
            binding.executable ?? "codex",
            dependencies,
          )
        : new CodexAdapter(
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
  const checks: { id: string; commands: string[] }[] = [];
  let previous = "execute";
  for (const requested of handoff.requestedVerification ?? []) {
    const step = verification?.workflow.steps[requested.id];
    if (step?.type !== "command" || !step.run?.length || requested.id === "execute")
      throw new DaemonError(
        "verification_unconfigured",
        "Configure each requested check as a command step in the Project's local veyra.yaml workflow; 'execute' is reserved for the native executor.",
      );
    const prior = setup.workflow.steps[previous];
    if (prior) {
      prior.next = requested.id;
      // Collect independent evidence after a settled failure, without revisiting any node.
      prior.on = { failure: requested.id };
    }
    setup.workflow.steps[requested.id] = {
      type: "command",
      run: [...step.run],
      timeoutMs: step.timeoutMs ?? 120000,
      // Core charges first entry from a failure edge against the target's recovery budget.
      // This acyclic sequence permits that entry only; it never retries execution or a check.
      retry: { max: 1 },
    };
    checks.push({ id: requested.id, commands: [...step.run] });
    previous = requested.id;
  }
  if (checks.length) {
    const execute = setup.workflow.steps.execute;
    if (execute)
      execute.instructions =
        "Veyra will independently run the following Project-configured checks after your execution. " +
        "Check IDs are not npm script names. If you run these checks as part of the task, use their exact configured commands instead of guessing alternatives. " +
        "Your summary and commandsRun are execution claims, not Verifier evidence. Preserve the task's read-only/repair and human-approval constraints. " +
        JSON.stringify(checks);
    if (verification?.workflow.policy) {
      const { approval, ...policy } = verification.workflow.policy;
      const before = approval?.before.filter((id) => Object.hasOwn(setup.workflow.steps, id));
      setup.workflow.policy = {
        ...policy,
        ...(before?.length ? { approval: { before } } : {}),
      };
    }
  }
  return setup;
}
