import { resolve } from "node:path";
import { realpath } from "node:fs/promises";
import { readCodexConversation } from "@veyraoss/codex";
import { loadConfig } from "@veyraoss/config";
import { loadProjectBindings } from "@veyraoss/project";
import { startDaemon, type DaemonOptions } from "@veyraoss/daemon";
import { loadWorkflow } from "@veyraoss/workflow";
import type { ProcessRunner } from "@veyraoss/runtime";
import { nativeExecution } from "./native-executor.js";
import { nativeProjectReadiness } from "./native-project-readiness.js";
import { nativeCodexEnvironment, readInstallation } from "./native-installation.js";
import { adaptersFor, configuredAdapters, secretValues, type AgentFactory } from "./providers.js";

/** Shared trusted composition for foreground diagnostics and the lazy native launcher. */
export function startCoordinator(
  options: DaemonOptions & {
    runProcess?: ProcessRunner;
    createAgent?: AgentFactory;
    allowPlugins?: string[];
    nativeInstallationPath?: string;
  },
) {
  const baseEnv = options.env ?? process.env;
  return startDaemon({
    ...options,
    ...(options.http
      ? {
          http: {
            ...options.http,
            inspectProject: (project) =>
              nativeProjectReadiness(project, baseEnv, options.runProcess),
          },
        }
      : {}),
    resolveExecution: async (project, handoff, nativeConversationId) => {
      // Reload trusted local routing at admission; a sleeping coordinator must not use an old socket.
      const env = options.nativeInstallationPath
        ? nativeCodexEnvironment(await readInstallation(options.nativeInstallationPath), baseEnv)
        : baseEnv;
      const binding = (await loadProjectBindings(project))?.roles.executor;
      if (binding) {
        const conversation = nativeConversationId
          ? await readCodexConversation(
              {
                executable: binding.executable ?? "codex",
                cwd: project.root,
                env,
                runner: options.runProcess,
              },
              nativeConversationId,
            )
          : undefined;
        if (conversation && (await realpath(conversation.root)) !== (await realpath(project.root)))
          throw new Error("The selected Codex task belongs to another Project.");
        const config = handoff.requestedVerification?.length
          ? await loadConfig(resolve(project.root, "veyra.yaml"))
          : undefined;
        return nativeExecution(
          project,
          binding,
          handoff,
          { env, runProcess: options.runProcess },
          config
            ? { config, workflow: await loadWorkflow(config.workflow.use, project.root) }
            : undefined,
          conversation,
        );
      }
      if (nativeConversationId)
        throw new Error("Selected Codex task requires a native Project executor binding.");
      const config = await loadConfig(resolve(project.root, "veyra.yaml"));
      const workflow = await loadWorkflow(config.workflow.use, project.root);
      const agents = options.createAgent
        ? adaptersFor(config, workflow, options.createAgent)
        : await configuredAdapters(config, workflow, project.root, options.allowPlugins, {
            env,
            runProcess: options.runProcess,
          });
      return { config, workflow, agents, redactValues: secretValues(env, config) };
    },
  });
}
