import { resolve } from "node:path";
import { CodexAdapter } from "@veyraoss/codex";
import { loadConfig } from "@veyraoss/config";
import { loadProjectBindings } from "@veyraoss/project";
import { loadWorkflow } from "@veyraoss/workflow";
import type { ProjectDescriptor } from "@veyraoss/protocol";
import type { ProcessRunner } from "@veyraoss/runtime";

export async function nativeProjectReadiness(
  project: ProjectDescriptor,
  env: NodeJS.ProcessEnv,
  runner?: ProcessRunner,
) {
  const binding = (await loadProjectBindings(project))?.roles.executor;
  const checks: { id: string }[] = [];
  try {
    const config = await loadConfig(resolve(project.root, "veyra.yaml"));
    const workflow = await loadWorkflow(config.workflow.use, project.root);
    for (const [id, step] of Object.entries(workflow.steps))
      if (id !== "execute" && step.type === "command" && step.run?.length) checks.push({ id });
  } catch {
    /* Verification stays optional until the planner selects an existing check. */
  }
  if (binding?.provider !== "codex" || binding.mode !== "native")
    return {
      ready: false,
      message: "Bind this Project locally with ve project bind <id> --executor codex/native.",
      checks,
    };
  const native = await new CodexAdapter(
    { executable: binding.executable, model: binding.model },
    { env, runProcess: runner },
  ).doctor({ cwd: project.root, timeoutMs: 5000 });
  return { ready: native.ready, message: native.message, checks };
}
