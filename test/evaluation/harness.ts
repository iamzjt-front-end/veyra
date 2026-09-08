import { createHash } from "node:crypto";
import { cp, lstat, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentAdapter, UsageMetadata, VeyraEvent } from "@veyraoss/protocol";
import {
  adaptersFor,
  configuredAdapters,
  secretValues,
  type AgentFactory,
} from "../../apps/cli/src/providers.js";
import { parseConfig, type VeyraConfig } from "../../packages/config/src/index.js";
import { LocalRunStore, VeyraEngine } from "../../packages/core/src/index.js";
import { runProcess } from "../../packages/runtime/src/index.js";
import { ShellVerifier } from "../../packages/verifier/src/index.js";
import { parseWorkflow, type WorkflowDefinition } from "../../packages/workflow/src/index.js";

const fixtures = fileURLToPath(new URL("../fixtures/evaluation/v1/", import.meta.url));
const repository = fileURLToPath(new URL("../../", import.meta.url));
export const taskIds = ["greeting", "sum", "immutable-sort"] as const;
export type TaskId = (typeof taskIds)[number];
export type Variant = "single" | "orchestrated";

export function evaluationWorkflow(variant: Variant): WorkflowDefinition {
  return parseWorkflow({
    version: 1,
    name: `evaluation-${variant}-v1`,
    start: variant === "single" ? "execute" : "plan",
    policy: { retry: { max: 1 }, stepTimeoutMs: 60_000, maxSteps: 20 },
    steps: {
      ...(variant === "orchestrated"
        ? {
            plan: { type: "agent", agent: "planner", next: "execute" },
            review: {
              type: "agent",
              agent: "reviewer",
              instructions:
                "Review the task and actual command evidence. Return explicit pass or fail. Do not edit files or claim missing checks passed.",
              on: { pass: "done", fail: "fix" },
            },
            fix: { type: "agent", agent: "executor", retry: { max: 1 }, next: "verify" },
          }
        : {}),
      execute: {
        type: "agent",
        agent: "executor",
        retry: { max: variant === "single" ? 1 : 0 },
        next: "verify",
      },
      verify: {
        type: "command",
        run: ["node --test"],
        on: {
          success: variant === "single" ? "done" : "review",
          failure: variant === "single" ? "execute" : "fix",
        },
      },
      done: { type: "end" },
    },
  });
}

/** Missing usage stays unknown, including started calls that never returned a result. */
export function summarizeUsage(usages: readonly (UsageMetadata | undefined)[], started: number) {
  let knownTokens = 0;
  let knownTokenCalls = 0;
  let knownCostCalls = 0;
  const costs = new Map<string, number>();
  for (const usage of usages) {
    const tokens =
      usage?.totalTokens ??
      (usage?.inputTokens !== undefined && usage.outputTokens !== undefined
        ? usage.inputTokens + usage.outputTokens
        : undefined);
    if (tokens !== undefined) {
      knownTokens += tokens;
      knownTokenCalls++;
    }
    if (usage?.cost) {
      costs.set(usage.cost.currency, (costs.get(usage.cost.currency) ?? 0) + usage.cost.amount);
      knownCostCalls++;
    }
  }
  return {
    knownTokens,
    unknownTokenCalls: Math.max(0, started - knownTokenCalls),
    knownCosts: [...costs]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([currency, amount]) => ({ currency, amount })),
    unknownCostCalls: Math.max(0, started - knownCostCalls),
  };
}

/** Hash only regular files; a symlink is a grading violation, never followed. */
async function filesAt(directory: string, omitState = false): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  async function walk(relative = "") {
    for (const item of await readdir(join(directory, relative), { withFileTypes: true })) {
      if (omitState && relative === "" && [".veyra", ".git"].includes(item.name)) continue;
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (item.isDirectory()) await walk(name);
      else if (item.isFile()) {
        if (omitState && name === "src/solution.js") continue;
        if ((await lstat(join(directory, name))).size > 1024 * 1024 || entries.length >= 1000)
          throw new Error("fixture_file_limit");
        entries.push([
          name,
          createHash("sha256")
            .update(await readFile(join(directory, name)))
            .digest("hex"),
        ]);
      } else throw new Error("non_regular_fixture_file");
    }
  }
  await walk();
  return Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
}

function scriptedFactory(task: TaskId, cwd: string): AgentFactory {
  let executions = 0;
  return (id): AgentAdapter => ({
    id,
    provider: "scripted-fixture",
    describe: () => ({
      schemaVersion: 1,
      id,
      provider: "scripted-fixture",
      adapterVersion: "1.0.0",
      roles: [id],
      capabilities: [],
    }),
    async run(_input, controls) {
      controls?.signal?.throwIfAborted();
      if (id === "executor") {
        executions++;
        // Three known calibration outcomes: immediate success, one repair, exhausted repairs.
        if (task === "greeting" || (task === "sum" && executions > 1))
          await writeFile(
            join(cwd, "src/solution.js"),
            await readFile(new URL(`./references/${task}.txt`, import.meta.url)),
          );
      }
      return {
        status: "success",
        summary: "Scripted harness calibration; not a live model result.",
        ...(id === "reviewer" ? { outcome: "pass" } : {}),
      };
    },
  });
}

export interface EvaluationOptions {
  mode: "scripted" | "live";
  trials?: number;
  config?: VeyraConfig;
  allowPlugins?: string[];
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** Test-only injection. Live evaluations always use configured real adapters. */
  scriptedAgents?: (task: TaskId, variant: Variant, cwd: string) => AgentFactory;
}

export interface EvaluationRow {
  task: TaskId;
  variant: Variant;
  trial: number;
  order: number;
  status: string;
  passed: boolean;
  gradingPassed: boolean;
  protectedFilesUnchanged: boolean;
  durationMs: number;
  agentCalls: number;
  executorCalls: number;
  executorRepairs: number;
  retryEvents: number;
  metricsComplete: boolean;
  usage: ReturnType<typeof summarizeUsage>;
  providers: { agent: string; provider: string; model?: string; adapterVersion?: string }[];
  failureCode?: string;
}

/** Development tooling only. Never publishes or writes into the source fixtures. */
export async function runEvaluation(options: EvaluationOptions) {
  const env = options.env ?? process.env;
  // Verifier/grader children execute participant code, so they do not receive credentials.
  const commandEnv = {
    ...Object.fromEntries(Object.keys({ ...process.env, ...env }).map((key) => [key, undefined])),
    PATH: process.env.PATH,
  };
  if (options.mode !== "scripted" && options.mode !== "live")
    throw new Error("invalid_evaluation_mode");
  if (
    options.mode === "live" &&
    (env.VEYRA_LIVE_EVAL !== "1" || !options.config || options.scriptedAgents)
  )
    throw new Error(
      "Live evaluation requires VEYRA_LIVE_EVAL=1 and an explicit provider config, with no scripted overrides.",
    );
  options.signal?.throwIfAborted();
  const trials = options.trials ?? 1;
  if (!Number.isSafeInteger(trials) || trials < 1 || trials > 10)
    throw new Error("trials must be an integer from 1 through 10");
  const base =
    options.mode === "live"
      ? parseConfig(options.config)
      : parseConfig({
          version: 1,
          workflow: { use: "evaluation" },
          agents: Object.fromEntries(
            ["planner", "executor", "reviewer"].map((id) => [id, { provider: "scripted-fixture" }]),
          ),
        });
  for (const id of ["planner", "executor", "reviewer"])
    if (!base.agents[id]) throw new Error(`Evaluation config requires '${id}'.`);
  const temporary = await mkdtemp(join(tmpdir(), "veyra-evaluation-"));
  const rows: EvaluationRow[] = [];
  const secrets = secretValues(env);
  try {
    const fixtureRevision = createHash("sha256")
      .update(JSON.stringify(await filesAt(fixtures)))
      .digest("hex");
    for (let trial = 1; trial <= trials; trial++) {
      for (const [taskIndex, task] of taskIds.entries()) {
        const taskPath = join(fixtures, task);
        const definition = JSON.parse(await readFile(join(taskPath, "task.json"), "utf8"));
        if (
          definition.version !== 1 ||
          definition.id !== task ||
          typeof definition.goal !== "string"
        )
          throw new Error("invalid_fixture_metadata");
        const variants: Variant[] =
          (trial + taskIndex) % 2 ? ["single", "orchestrated"] : ["orchestrated", "single"];
        for (const variant of variants) {
          options.signal?.throwIfAborted();
          const cwd = join(temporary, `${trial}-${task}-${variant}`);
          await cp(taskPath, cwd, { recursive: true });
          const git = await runProcess({
            executable: "git",
            args: ["init", "--quiet"],
            cwd,
            timeoutMs: 5000,
          });
          if (git.exitCode !== 0) throw new Error("fixture_git_init_failed");
          const signal = AbortSignal.any([
            AbortSignal.timeout(600_000),
            ...(options.signal ? [options.signal] : []),
          ]);
          const workflow = evaluationWorkflow(variant);
          // Every sample owns a fresh shared temporary workspace; never use caller state/worktrees.
          const config = parseConfig({
            ...base,
            workflow: { use: "./workflow.yaml" },
            runtime: { maxFixIterations: 1, stateDir: ".veyra" },
          });
          await writeFile(join(cwd, "veyra.yaml"), JSON.stringify(config));
          await writeFile(join(cwd, "workflow.yaml"), JSON.stringify(workflow));
          const protectedBefore = await filesAt(cwd, true);
          delete protectedBefore["src/solution.js"];
          const store = new LocalRunStore({ stateDir: join(cwd, ".veyra"), redactValues: secrets });
          let status = "setup_failed";
          let failureCode: string | undefined;
          let events: VeyraEvent[] = [];
          let metricsComplete = false;
          const start = performance.now();
          try {
            const agents =
              options.mode === "scripted"
                ? adaptersFor(
                    config,
                    workflow,
                    (options.scriptedAgents ?? ((id, _variant, path) => scriptedFactory(id, path)))(
                      task,
                      variant,
                      cwd,
                    ),
                  )
                : await configuredAdapters(config, workflow, cwd, options.allowPlugins, { env });
            const result = await new VeyraEngine({
              store,
              verifier: new ShellVerifier({
                runProcess: (request) => runProcess({ ...request, env: commandEnv }),
                redactValues: secrets,
              }),
            }).run({
              goal: `${definition.goal} Only edit src/solution.js. Preserve tests and all other files. Use node --test for evidence.`,
              config,
              workflow,
              agents,
              cwd,
              signal,
            });
            status = result.status;
            failureCode = result.error?.code;
            events = await store.readEvents(result.runId);
            metricsComplete = true;
          } catch (error) {
            status = "error";
            failureCode =
              error instanceof Error &&
              "code" in error &&
              typeof error.code === "string" &&
              /^[a-z_]+$/.test(error.code)
                ? error.code
                : "evaluation_error";
          }
          let protectedFilesUnchanged = false;
          let gradingPassed = false;
          try {
            const after = await filesAt(cwd, true);
            delete after["src/solution.js"];
            protectedFilesUnchanged = JSON.stringify(after) === JSON.stringify(protectedBefore);
            const solution = join(cwd, "src/solution.js");
            const info = await lstat(solution);
            if (
              protectedFilesUnchanged &&
              info.isFile() &&
              info.size <= 128 * 1024 &&
              !signal.aborted
            ) {
              // Grade against pristine acceptance files in another directory, not agent-editable tests.
              const grader = `${cwd}-grade`;
              await cp(taskPath, grader, { recursive: true });
              await writeFile(join(grader, "src/solution.js"), await readFile(solution));
              const grade = await runProcess({
                executable: process.execPath,
                args: ["--test"],
                cwd: grader,
                timeoutMs: 30_000,
                signal,
                env: commandEnv,
              });
              gradingPassed = grade.exitCode === 0 && !grade.signal && !grade.terminationReason;
            }
          } catch {
            /* Any unsafe/missing fixture file or failed grader leaves the sample failed. */
          }
          const started = events.filter((event) => event.type === "agent.started");
          const completed = events.filter((event) => event.type === "agent.completed");
          const executorCalls = started.filter((event) => event.agentId === "executor").length;
          const identities = events
            .filter((event) => event.type === "agent.selected")
            .map((event) => ({
              agent: event.agentId,
              provider: event.provider ?? "unknown",
              ...(event.descriptor?.model ? { model: event.descriptor.model } : {}),
              ...(event.descriptor?.adapterVersion
                ? { adapterVersion: event.descriptor.adapterVersion }
                : {}),
            }));
          rows.push({
            task,
            variant,
            trial,
            order: rows.length + 1,
            status,
            passed: status === "completed" && gradingPassed && protectedFilesUnchanged,
            gradingPassed,
            protectedFilesUnchanged,
            durationMs: performance.now() - start,
            agentCalls: started.length,
            executorCalls,
            executorRepairs: Math.max(0, executorCalls - 1),
            retryEvents: events.filter((event) => event.type === "step.retrying").length,
            metricsComplete,
            usage: summarizeUsage(
              completed.map((event) => event.result.usage),
              started.length,
            ),
            providers: [
              ...new Map(
                identities.map((identity) => [JSON.stringify(identity), identity]),
              ).values(),
            ],
            ...(failureCode ? { failureCode } : {}),
          });
        }
      }
    }
    const commit = await runProcess({
      executable: "git",
      args: ["rev-parse", "HEAD"],
      cwd: repository,
    });
    const dirty = await runProcess({
      executable: "git",
      args: ["status", "--porcelain"],
      cwd: repository,
    });
    return {
      schemaVersion: 1,
      suite: "local-code-v1",
      fixtureRevision,
      mode: options.mode,
      trials,
      configurationHash: createHash("sha256").update(JSON.stringify(base)).digest("hex"),
      harnessRevision: createHash("sha256")
        .update(await readFile(new URL("./harness.ts", import.meta.url)))
        .digest("hex"),
      generatedAt: new Date().toISOString(),
      source: {
        commit: commit.exitCode === 0 ? commit.stdout.trim() : null,
        dirty: dirty.exitCode === 0 ? Boolean(dirty.stdout) : null,
        node: process.version,
        platform: process.platform,
        arch: process.arch,
      },
      rows,
      summary: (["single", "orchestrated"] as const).map((variant) => {
        const samples = rows.filter((row) => row.variant === variant);
        const passed = samples.filter((row) => row.passed).length;
        return {
          variant,
          samples: samples.length,
          passed,
          completionRate: passed / samples.length,
          meanDurationMs: samples.reduce((sum, row) => sum + row.durationMs, 0) / samples.length,
          executorRepairs: samples.reduce((sum, row) => sum + row.executorRepairs, 0),
        };
      }),
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
