import { resolve } from "node:path";
import { loadConfig } from "@veyraoss/config";
import { loadProjectBindings } from "@veyraoss/project";
import { startDaemon, type DaemonOptions } from "@veyraoss/daemon";
import { loadWorkflow } from "@veyraoss/workflow";
import type { ProcessRunner } from "@veyraoss/runtime";
import { nativeExecution } from "./native-executor.js";
import { nativeProjectReadiness } from "./native-project-readiness.js";
import { adaptersFor, configuredAdapters, secretValues, type AgentFactory } from "./providers.js";

/** Shared trusted composition for foreground diagnostics and the lazy native launcher. */
export function startCoordinator(
  options: DaemonOptions & {
    runProcess?: ProcessRunner;
    createAgent?: AgentFactory;
    allowPlugins?: string[];
  },
) {
  const env = options.env ?? process.env;
  return startDaemon({
    ...options,
    ...(options.http
      ? {
          http: {
            ...options.http,
            inspectProject: (project) => nativeProjectReadiness(project, env, options.runProcess),
          },
        }
      : {}),
    resolveExecution: async (project, handoff) => {
      const binding = (await loadProjectBindings(project))?.roles.executor;
      if (binding) {
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
        );
      }
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
