import { CLI_VERSION } from "./version.js";
import { stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { loadConfig } from "@veyraoss/config";
import { startDaemon, stopDaemon, daemonStatus, daemonProjects } from "@veyraoss/daemon";
import {
  initializeProject,
  openProject,
  ProjectError,
  ProjectRegistry,
  type ProjectId,
} from "@veyraoss/project";
import { eventView, LocalRunStore, type RunResult, VeyraEngine } from "@veyraoss/core";
import type { AgentPermissions, VeyraEvent } from "@veyraoss/protocol";
import { type ProcessRunner, runProcess } from "@veyraoss/runtime";
import { loadWorkflow } from "@veyraoss/workflow";
import { argumentsFor, CliError, help } from "./arguments.js";
import { inspectEnvironment } from "./doctor.js";
import { initialize } from "./init.js";
import { listWorkflows, validateWorkflow } from "./workflows.js";
import {
  adaptersFor,
  configuredAdapters,
  type AgentFactory,
  createAgent,
  redact,
  secretValues,
} from "./providers.js";

export interface CliServices {
  cwd?: string;
  /** Environment for API auth, readiness and redaction; native CLIs retain their own auth. */
  env?: NodeJS.ProcessEnv;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
  createAgent?: AgentFactory;
  runProcess?: ProcessRunner;
  signal?: AbortSignal;
}

/** Testable CLI surface. Fakes enter through injected services, never through production flags. */
export async function runCli(argv: string[], services: CliServices = {}): Promise<number> {
  const env = services.env ?? process.env;
  const cwd = resolve(services.cwd ?? process.cwd());
  const stdout = services.stdout ?? ((text) => process.stdout.write(text));
  const stderr = services.stderr ?? ((text) => process.stderr.write(text));
  let secrets = secretValues(env);
  let json = argv.includes("--json");
  const write = (value: unknown, human: string) => {
    stdout(
      `${json ? JSON.stringify(redact(value, secrets)) : stripVTControlCharacters(String(redact(human, secrets)))}\n`,
    );
  };
  try {
    const { command, values, positionals } = argumentsFor(argv);
    json = values.json ?? false;
    if (command === "help") {
      write({ command: "help", text: help }, help);
      return 0;
    }
    if (command === "version") {
      write({ version: CLI_VERSION, executable: "ve" }, `ve ${CLI_VERSION}`);
      return 0;
    }
    if (command === "daemon") {
      const options = values.registry ? { registryRoot: resolve(cwd, values.registry) } : {};
      if (positionals[0] === "start") {
        const daemon = await startDaemon({ ...options, signal: services.signal, env });
        write(
          { type: "daemon.started", ...daemon.metadata },
          `Veyra daemon running (PID ${daemon.metadata.owner.pid}).\nRegistry: ${daemon.metadata.registryRoot}\nForeground service; Ctrl-C or ve daemon stop to shut down.`,
        );
        await daemon.closed;
        return 0;
      }
      if (positionals[0] === "stop") {
        await stopDaemon(options);
        write({ type: "daemon.stopped" }, "Veyra daemon stopped.");
        return 0;
      }
      if (positionals[0] === "projects") {
        const projects = await daemonProjects(options);
        write(
          { projects },
          projects
            .map(
              ({ project, status }) =>
                `${project.id} ${project.name} — ${project.root} (${status})`,
            )
            .join("\n") || "No registered Projects.",
        );
        return 0;
      }
      const result = await daemonStatus(options);
      write(
        result,
        result.status === "running"
          ? `Veyra daemon running (PID ${result.metadata.owner.pid}).`
          : result.status === "stopped"
            ? "Veyra daemon stopped."
            : result.message,
      );
      return result.status === "running" ? 0 : 1;
    }
    if (command === "projects" || command === "project") {
      const registry = new ProjectRegistry(
        values.registry ? { root: resolve(cwd, values.registry) } : {},
      );
      if (command === "projects") {
        const projects = await registry.list();
        write(
          { projects },
          projects
            .map(
              ({ project, status, reason }) =>
                `${project.id} ${project.name} — ${project.root} (${status}${reason ? `: ${reason}` : ""})`,
            )
            .join("\n") || "No registered Projects. Use ve project add <path>.",
        );
        return 0;
      }
      const reference = positionals[1] as string;
      if (positionals[0] === "add") {
        const path = resolve(cwd, reference);
        try {
          await openProject(path);
        } catch (error) {
          if (!(error instanceof ProjectError) || error.code !== "project_missing") throw error;
          try {
            await initializeProject(path);
          } catch (error) {
            if (!(error instanceof ProjectError) || error.code !== "project_exists") throw error;
          }
        }
        const result = await registry.register(path);
        write(
          result,
          `Registered ${result.project.id}: ${result.project.name}\n${result.project.root}`,
        );
        return 0;
      }
      if (positionals[0] === "remove") {
        const removed = await registry.unregister(reference as ProjectId);
        if (!removed) throw new CliError("project_not_found", "Project is not registered.");
        write(
          { projectId: reference, removed },
          `Unregistered ${reference}; project files are preserved.`,
        );
        return 0;
      }
      const result = await registry.get(reference as ProjectId);
      if (!result) throw new CliError("project_not_found", "Project is not registered.");
      write(
        result,
        `${result.project.id} ${result.project.name}\n${result.project.root}\n${result.status}${result.reason ? `: ${result.reason}` : ""}`,
      );
      return result.status === "available" ? 0 : 1;
    }
    const configPath = resolve(cwd, values.config ?? "veyra.yaml");
    const root = dirname(configPath);
    if (command === "workflow") {
      if (positionals[0] === "list") {
        const result = await listWorkflows();
        write(
          result,
          result.workflows
            .map(
              (workflow) =>
                `${workflow.reference}: ${workflow.name} — agents: ${workflow.requiredAgents.join(", ") || "none"}`,
            )
            .join("\n"),
        );
        return 0;
      }
      const config = values.config !== undefined ? await loadConfig(configPath) : undefined;
      if (config) secrets = secretValues(env, config);
      const result = await validateWorkflow(
        positionals[1] as string,
        config ? root : cwd,
        config,
        services.createAgent !== undefined && services.createAgent !== createAgent,
      );
      write(
        result,
        [
          `${result.valid ? "Valid" : "Invalid"} workflow: ${result.workflow.name} (version ${result.workflow.version}, ${result.workflow.stepCount} steps)`,
          `Required agents: ${result.workflow.requiredAgents.join(", ") || "none"}`,
          ...(result.configurationChecked
            ? []
            : [
                "Agent configuration not checked; pass --config <file> to check bindings and installed provider support.",
              ]),
          ...result.diagnostics.map((item) => item.message),
          ...result.warnings.map((item) => item.message),
        ].join("\n"),
      );
      return result.valid ? 0 : 2;
    }
    if (command === "init") {
      const result = await initialize(configPath, values);
      write(
        { type: "initialized", ...result },
        `Created ${result.configPath}\nLocal state is ignored in ${result.ignorePath}\nSet OPENAI_API_KEY, run codex login, then ve doctor.\nReview the workflow's verification commands, then run: ve run "your goal"`,
      );
      return 0;
    }
    if (command === "doctor") {
      const result = await inspectEnvironment(
        configPath,
        root,
        env,
        services.runProcess ?? runProcess,
        values.workflow,
        Boolean(values.config || values.workflow),
        values["allow-plugin"],
        services.signal,
      );
      write(
        result,
        [
          "Veyra Doctor",
          `Node:     ${result.node.version}`,
          `pnpm:     ${result.pnpm.version}`,
          ...(result.pnpm.message ? [result.pnpm.message] : []),
          `Platform: ${result.platform}`,
          `CWD:      ${result.cwd}`,
          `Directory: read=${result.workingDirectory.readable} write=${result.workingDirectory.writable}`,
          `Config:   ${result.config.status}${result.config.message ? ` — ${result.config.message}` : ""}`,
          ...result.providers.map(
            (provider) =>
              `${provider.required ? "Required" : provider.routingCandidate ? "Routing candidate" : "Optional"} ${provider.agent} (${provider.provider}${provider.version ? ` ${provider.version}` : ""}): ${provider.ready ? "ready" : "not ready"} — ${provider.message}${provider.descriptor?.permissions ? `\n  ${permissionText(provider.descriptor.permissions)}` : ""}`,
          ),
          ...result.routing.map(
            (route) =>
              `Routing ${route.stepId}: ${route.ready ? `eligible ${route.decision?.selected}` : "blocked"} — ${route.message ?? route.decision?.attempts.map((attempt) => `${attempt.binding}: ${attempt.reason}`).join("; ")}`,
          ),
        ].join("\n"),
      );
      return result.ready ? 0 : 1;
    }
    const config = await loadConfig(configPath);
    secrets = secretValues(env, config);
    config.runtime.stateDir = resolve(root, config.runtime.stateDir);
    const store = new LocalRunStore({ stateDir: config.runtime.stateDir, redactValues: secrets });
    if (command === "prune") {
      const result = await store.pruneRuns({
        ...(values["older-than-days"] !== undefined
          ? { olderThanDays: Number(values["older-than-days"]) }
          : {}),
        ...(values["keep-last"] !== undefined ? { keepLast: Number(values["keep-last"]) } : {}),
        apply: values.apply ?? false,
      });
      write(
        { type: "retention", ...result },
        [
          `${result.dryRun ? "Preview" : "Cleanup"}: ${result.candidates.length} eligible runs; ${result.removed.length} removed.`,
          ...result.candidates.map(
            (run) => `${run.runId} — ${run.sizeBytes} bytes, updated ${run.updatedAt}`,
          ),
          `${result.skipped.length} runs preserved by policy or ownership.`,
          ...(result.dryRun
            ? [
                "Review this list, then pass --apply to delete eligible history and managed artifacts. Workspaces are preserved.",
              ]
            : []),
        ].join("\n"),
      );
      return 0;
    }
    const emit = (event: VeyraEvent) => {
      if (json) {
        write(eventView(event), "");
        return;
      }
      let line: string = event.type;
      if ("stepId" in event && event.stepId) line += ` ${event.stepId}`;
      if (event.type === "run.started" && event.workspace)
        line += `\nCWD: ${event.workspace.cwd}\nWorkspace: ${event.workspace.mode}${event.workspace.mode === "worktree" ? ` (HEAD ${event.workspace.commit})` : ""}`;
      else if (event.type === "agent.routed")
        line += `: ${event.decision.attempts.map((attempt) => `${attempt.binding} ${attempt.decision} (${attempt.reason})`).join("; ")}`;
      else if (event.type === "agent.selected")
        line += `: ${event.binding} → ${event.agentId} (${event.provider}, role ${event.role})${event.descriptor?.permissions ? `\n${permissionText(event.descriptor.permissions)}` : ""}`;
      else if (event.type === "agent.completed")
        line += `: ${event.result.status} — ${event.result.summary.slice(0, 240)}`;
      else if (event.type === "verification.started")
        line += `: ${event.commandSource ?? "legacy/unspecified"} shell commands (host permissions)`;
      else if (event.type === "verification.completed")
        line += `: ${event.success ? "passed" : "failed"}`;
      else if (event.type === "parallel.child.completed")
        line += ` (${event.parentStepId}): ${event.result.status}`;
      else if (event.type === "parallel.completed")
        line += `: ${event.success ? "passed" : "failed"} (${event.results.length} children)`;
      else if (event.type === "router.selected") line += `: ${event.route} → ${event.target}`;
      else if (event.type === "subworkflow.started")
        line += `: ${event.workflowName} → ${event.childStepId}`;
      else if (event.type === "subworkflow.completed")
        line += `: ${event.success ? "passed" : "failed"}`;
      else if (event.type === "subworkflow.paused") line += `: paused at ${event.childStepId}`;
      else if (event.type === "consensus.completed")
        line += `: ${event.outcome} (${event.mode}${event.reason ? `, ${event.reason}` : ""})`;
      else if (event.type === "consensus.paused") line += `: waiting for ${event.phase}`;
      else if (event.type === "approval.required")
        line += `: ${event.message}\nApproval ID: ${event.approvalId}`;
      else if (event.type === "step.retrying")
        line += `: repair ${event.retryCount}/${event.maxRetries}${event.delayMs ? ` after ${event.delayMs}ms` : ""}`;
      else if (event.type === "budget.checked")
        line += `: ${event.allowed ? "allowed" : "denied"} (${event.phase})${event.reason ? ` — ${event.reason}` : ""}`;
      else if (event.type === "run.failed" || event.type === "step.failed")
        line += `: ${event.message}`;
      if (event.payload)
        line = `${line.slice(0, 4096)}\nStored payload: ${event.payload.path} (${event.payload.sizeBytes} bytes)`;
      write(eventView(event), line);
    };
    const engine = new VeyraEngine({ store, emit });
    const finish = (result: RunResult) => {
      write(
        { type: "result", ...result },
        `Run ${result.runId}: ${result.status}${result.lastStep ? ` (${result.lastStep})` : ""}${result.status === "paused" ? "\nInspect ve status, then use ve resume with an explicit --approve/--reject when a human gate is pending." : ""}`,
      );
      return result.status === "completed" ? 0 : result.status === "paused" ? 3 : 1;
    };
    if (command === "run") {
      const workflow = await loadWorkflow(values.workflow ?? config.workflow.use, root);
      return finish(
        await engine.run({
          config,
          workflow,
          agents: services.createAgent
            ? adaptersFor(config, workflow, services.createAgent)
            : await configuredAdapters(config, workflow, root, values["allow-plugin"], {
                env,
                runProcess: services.runProcess,
              }),
          goal: positionals.join(" "),
          cwd: root,
          signal: services.signal,
        }),
      );
    }
    if (command === "workspace") {
      const result = await engine.removeWorkspace({
        config,
        cwd: root,
        runId: positionals[1] as string,
        recoverInterrupted: values["recover-interrupted"],
      });
      write(result, `Removed worktree for run ${result.runId}: ${result.cwd}`);
      return 0;
    }
    const selectedId = values["run-id"] ?? positionals[0];
    const active = selectedId ? await store.loadRun(selectedId) : await store.getActiveRun();
    const latest = active ?? (await store.listRuns())[0];
    if (!latest)
      throw new CliError("no_run", 'No saved run was found. Start one with ve run "your goal".');
    const run = "input" in latest ? latest : await store.loadRun(latest.runId);
    const request = { config, runId: run.state.runId, cwd: root };
    if (command === "status") {
      const inspection = await engine.inspectRun(request);
      const approval = await engine.getPendingApproval(request);
      const workspace = run.input.workspace ?? {
        mode: "shared" as const,
        cwd: run.input.cwd,
        root: run.input.cwd,
      };
      let workspaceAvailable = false;
      try {
        workspaceAvailable = (await stat(workspace.cwd)).isDirectory();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      write(
        {
          ...run.state,
          ...inspection,
          goal: run.input.goal,
          cwd: run.input.cwd,
          workspace,
          workspaceAvailable,
          approval,
        },
        [
          `Run: ${run.state.runId}`,
          `Status: ${inspection.status}${inspection.status !== run.state.status ? ` (saved: ${run.state.status})` : ""}`,
          ...(run.state.status === "running"
            ? [
                `Owner: ${run.state.owner ? `${run.state.owner.host} PID ${run.state.owner.pid}` : "unrecorded"} (${inspection.ownerStatus})`,
                `Recovery: ${inspection.recovery.allowed ? "available with --recover-interrupted" : "refused"} — ${inspection.recovery.reason}`,
              ]
            : []),
          `Step: ${run.state.currentStep ?? "—"}`,
          ...(run.state.error
            ? [`Error: ${run.state.error.code} — ${run.state.error.message}`]
            : []),
          `Retries: ${JSON.stringify(run.state.retryCounts)}`,
          `Created: ${run.state.createdAt}`,
          `Updated: ${run.state.updatedAt}`,
          `CWD: ${run.input.cwd}`,
          `Workspace: ${workspace.mode} (${workspaceAvailable ? "available" : "missing or removed"})`,
          ...(workspace.mode === "worktree"
            ? [
                `Worktree: ${workspace.root}`,
                `Source: ${workspace.source}`,
                `Base commit: ${workspace.commit}`,
                `Dirty policy: ${workspace.dirtyPolicy}`,
              ]
            : []),
          ...(approval ? [`Approval: ${approval.approvalId} — ${approval.message}`] : []),
          ...(approval?.context?.operation
            ? [`Operation: ${JSON.stringify(approval.context.operation)}`]
            : []),
        ].join("\n"),
      );
      return 0;
    }
    if (command === "review") {
      const events = await store.readEvents(run.state.runId);
      const review = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "agent.completed" &&
            (event.role === "reviewer" ||
              event.result.outcome === "pass" ||
              event.result.outcome === "fail"),
        );
      const verification = [...events]
        .reverse()
        .find((event) => event.type === "verification.completed");
      write(
        {
          runId: run.state.runId,
          review: review ? eventView(review) : null,
          verification: verification ? eventView(verification) : null,
        },
        [
          `Run: ${run.state.runId}`,
          review?.type === "agent.completed"
            ? `Review: ${review.result.outcome ?? review.result.status} — ${review.result.summary.slice(0, 240)}\nArtifacts: ${JSON.stringify(review.payload ? [review.payload] : (review.result.artifacts ?? []))}`
            : "No reviewer result is saved yet.",
          verification?.type === "verification.completed"
            ? `Verification: ${verification.success ? "passed" : "failed"}\n${verification.results.map((result) => `${result.success ? "PASS" : "FAIL"} ${result.command} (exit ${result.exitCode ?? "unavailable"})`).join("\n")}${verification.payload ? `\nStored payload: ${verification.payload.path}` : ""}`
            : "No verification result is saved yet.",
        ].join("\n"),
      );
      return 0;
    }
    if (values.approve || values.reject) {
      const pending = await engine.getPendingApproval(request);
      if (!pending)
        throw new CliError(
          "no_pending_approval",
          "This run has no pending human approval; use ve resume without a decision flag.",
        );
      const resolved = await engine.resolveApproval({
        ...request,
        approvalId: values["approval-id"] ?? pending.approvalId,
        recoverInterrupted: values["recover-interrupted"],
        decision: values.approve ? "approved" : "rejected",
        ...(values.comment !== undefined ? { comment: values.comment } : {}),
      });
      if (resolved.status !== "paused") return finish(resolved);
    }
    return finish(
      await engine.resume({
        ...request,
        agents: services.createAgent
          ? adaptersFor(config, run.input.workflow, services.createAgent)
          : await configuredAdapters(config, run.input.workflow, root, values["allow-plugin"], {
              env,
              runProcess: services.runProcess,
            }),
        signal: services.signal,
        recoverInterrupted: values["recover-interrupted"],
      }),
    );
  } catch (error) {
    const code =
      error instanceof Error && "code" in error && typeof error.code === "string"
        ? error.code
        : "cli_error";
    const message = error instanceof Error ? error.message : "The command could not complete.";
    if (json) write({ type: "error", code, message }, "");
    else stderr(`${stripVTControlCharacters(String(redact(message, secrets)))}\n`);
    return error instanceof CliError ? error.exitCode : 2;
  }
}

function permissionText(permissions: AgentPermissions): string {
  return `Permissions: ${permissions.mode} (${permissions.source})${permissions.sandbox ? `; sandbox flag: ${permissions.sandbox}` : ""}${permissions.toolAllowRules !== undefined ? `; explicit allow rules: ${permissions.toolAllowRules}` : ""}; additional native policy not inspected`;
}
