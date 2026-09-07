import { dirname, resolve } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { loadConfig } from "@veyra/config";
import { LocalRunStore, type RunResult, VeyraEngine } from "@veyra/core";
import type { VeyraEvent } from "@veyra/protocol";
import { type ProcessRunner, runProcess } from "@veyra/runtime";
import { loadWorkflow } from "@veyra/workflow";
import { argumentsFor, CliError, help } from "./arguments.js";
import { inspectEnvironment } from "./doctor.js";
import { initialize } from "./init.js";
import { listWorkflows, validateWorkflow } from "./workflows.js";
import { adaptersFor, type AgentFactory, createAgent, redact, secretValues } from "./providers.js";

export interface CliServices {
  cwd?: string;
  /** Environment for readiness and redaction; production adapters retain their native auth. */
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
      write({ version: "0.1.0-dev", executable: "ve" }, "ve 0.1.0-dev");
      return 0;
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
      );
      write(
        result,
        [
          "Veyra Doctor",
          `Node:     ${result.node.version}`,
          `pnpm:     ${result.pnpm.version}`,
          `Platform: ${result.platform}`,
          `CWD:      ${result.cwd}`,
          `Directory: read=${result.workingDirectory.readable} write=${result.workingDirectory.writable}`,
          `Config:   ${result.config.status}${result.config.message ? ` — ${result.config.message}` : ""}`,
          ...result.providers.map(
            (provider) =>
              `${provider.required ? "Required" : "Optional"} ${provider.agent} (${provider.provider}${provider.version ? ` ${provider.version}` : ""}): ${provider.ready ? "ready" : "not ready"} — ${provider.message}`,
          ),
        ].join("\n"),
      );
      return result.ready ? 0 : 1;
    }
    const config = await loadConfig(configPath);
    secrets = secretValues(env, config);
    config.runtime.stateDir = resolve(root, config.runtime.stateDir);
    const store = new LocalRunStore({ stateDir: config.runtime.stateDir, redactValues: secrets });
    const emit = (event: VeyraEvent) => {
      if (json) {
        write(event, "");
        return;
      }
      let line = event.type;
      if ("stepId" in event && event.stepId) line += ` ${event.stepId}`;
      if (event.type === "agent.completed")
        line += `: ${event.result.status} — ${event.result.summary.slice(0, 240)}`;
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
      write(event, line);
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
          agents: adaptersFor(config, workflow, services.createAgent ?? createAgent),
          goal: positionals.join(" "),
          cwd: root,
          signal: services.signal,
        }),
      );
    }
    const selectedId = values["run-id"] ?? positionals[0];
    const active = selectedId ? await store.loadRun(selectedId) : await store.getActiveRun();
    const latest = active ?? (await store.listRuns())[0];
    if (!latest)
      throw new CliError("no_run", 'No saved run was found. Start one with ve run "your goal".');
    const run = "input" in latest ? latest : await store.loadRun(latest.runId);
    const request = { config, runId: run.state.runId, cwd: root };
    if (command === "status") {
      const approval = await engine.getPendingApproval(request);
      write(
        { ...run.state, goal: run.input.goal, cwd: run.input.cwd, approval },
        [
          `Run: ${run.state.runId}`,
          `Status: ${run.state.status}`,
          `Step: ${run.state.currentStep ?? "—"}`,
          `Retries: ${JSON.stringify(run.state.retryCounts)}`,
          `Created: ${run.state.createdAt}`,
          `Updated: ${run.state.updatedAt}`,
          `CWD: ${run.input.cwd}`,
          ...(approval ? [`Approval: ${approval.approvalId} — ${approval.message}`] : []),
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
        { runId: run.state.runId, review: review ?? null, verification: verification ?? null },
        [
          `Run: ${run.state.runId}`,
          review?.type === "agent.completed"
            ? `Review: ${review.result.outcome ?? review.result.status} — ${review.result.summary}\nArtifacts: ${JSON.stringify(review.result.artifacts ?? [])}`
            : "No reviewer result is saved yet.",
          verification?.type === "verification.completed"
            ? `Verification: ${verification.success ? "passed" : "failed"}\n${verification.results.map((result) => `${result.success ? "PASS" : "FAIL"} ${result.command} (exit ${result.exitCode ?? "unavailable"})`).join("\n")}`
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
        decision: values.approve ? "approved" : "rejected",
        ...(values.comment !== undefined ? { comment: values.comment } : {}),
      });
      if (resolved.status !== "paused") return finish(resolved);
    }
    return finish(
      await engine.resume({
        ...request,
        agents: adaptersFor(config, run.input.workflow, services.createAgent ?? createAgent),
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
