import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { EventSink, UsageMetadata } from "@veyra/protocol";
import {
  adaptersFor,
  type AgentFactory,
  createAgent,
  redact,
  secretValues,
} from "../../apps/cli/src/providers.js";
import { parseConfig } from "../../packages/config/src/index.js";
import { LocalRunStore, VeyraEngine } from "../../packages/core/src/index.js";
import { runProcess } from "../../packages/runtime/src/index.js";
import { loadWorkflow } from "../../packages/workflow/src/index.js";
import { CodexAdapter, type CodexDoctorResult } from "../../plugins/codex/src/index.js";
import { createFixtureWorkspace } from "../helpers/workspace.js";

export const smokeGreeting = "Hello from the verified Veyra closed loop";
interface SmokeDependencies {
  createAgent?: AgentFactory;
  checkCodex?: (cwd: string) => Promise<CodexDoctorResult>;
  emit?: EventSink;
  signal?: AbortSignal;
}
export interface SmokeReport {
  status: "passed" | "failed" | "blocked";
  message: string;
  fixturePath?: string;
  disposableWorkspaceRemoved?: boolean;
  model?: string;
  codexVersion?: string;
  runId?: string;
  calls?: { agent: string; provider: string; usage?: UsageMetadata }[];
}

/** Opt-in test tooling, never called by production or normal CI with real providers. */
export async function runClosedLoopSmoke(
  env: NodeJS.ProcessEnv = process.env,
  dependencies: SmokeDependencies = {},
): Promise<SmokeReport> {
  if (env.VEYRA_LIVE_SMOKE !== "1")
    return {
      status: "blocked",
      message: "Set VEYRA_LIVE_SMOKE=1 to explicitly enable real provider use.",
    };
  if (!env.OPENAI_API_KEY?.trim())
    return {
      status: "blocked",
      message:
        "Set OPENAI_API_KEY in the environment before running the live closed-loop smoke test.",
    };
  const model = env.VEYRA_SMOKE_MODEL?.trim() || "gpt-5.6-sol";
  const secrets = secretValues(env);
  const workspace = await createFixtureWorkspace();
  const path = workspace.path;
  const report: SmokeReport = {
    status: "failed",
    message: "Smoke did not finish.",
    fixturePath: path,
    model,
  };
  const signal = dependencies.signal ?? AbortSignal.timeout(10 * 60_000);
  const command = async (executable: string, args: string[]) => {
    const result = await runProcess({ executable, args, cwd: path, timeoutMs: 30_000, signal });
    assert.equal(result.exitCode, 0, `Fixture command failed: ${executable} ${args.join(" ")}`);
    assert.equal(result.terminationReason, undefined, "Fixture command was interrupted.");
    return result;
  };
  try {
    const readiness = await (
      dependencies.checkCodex ?? ((cwd) => new CodexAdapter().doctor({ cwd, signal }))
    )(path);
    if (!readiness.ready) {
      report.status = "blocked";
      report.message = readiness.message;
      return report;
    }
    report.codexVersion = readiness.version;
    const testPath = join(path, "test/message.test.js");
    await writeFile(
      testPath,
      (await readFile(testPath, "utf8")).replace("Hello from the Veyra fixture", smokeGreeting),
    );
    const packagePath = join(path, "package.json");
    const manifest = JSON.parse(await readFile(packagePath, "utf8"));
    manifest.scripts.build = "node build.js";
    await writeFile(packagePath, JSON.stringify(manifest, null, 2));
    await writeFile(
      join(path, "build.js"),
      "import {mkdir,copyFile} from 'node:fs/promises'; await mkdir('dist',{recursive:true}); await copyFile('src/message.js','dist/message.js');\n",
    );
    await writeFile(join(path, ".gitignore"), ".veyra/state/\n.veyra/runs/\ndist/\n");
    await writeFile(
      join(path, "AGENTS.md"),
      "# Disposable smoke fixture\nOnly edit src/message.js. Preserve tests, package.json, build.js, configuration, workflow, and this file. Do not install dependencies, access the network, commit, push, publish, or deploy. Run local checks as needed.\n",
    );
    const config = parseConfig({
      version: 1,
      project: { name: "veyra-live-smoke" },
      workflow: { use: "workflow.yaml" },
      agents: {
        planner: {
          provider: "openai",
          model,
          options: { role: "planner", maxOutputTokens: 2048, timeoutMs: 60_000 },
        },
        executor: { provider: "codex", options: { timeoutMs: 180_000 } },
        reviewer: {
          provider: "openai",
          model,
          options: { role: "reviewer", maxOutputTokens: 2048, timeoutMs: 60_000 },
        },
      },
      runtime: { maxFixIterations: 1, stateDir: ".veyra" },
    });
    const workflow = await loadWorkflow("dev");
    workflow.steps.fix = { ...workflow.steps.fix, type: "agent", retry: { max: 1 } };
    await writeFile(join(path, "veyra.yaml"), JSON.stringify(config, null, 2));
    await writeFile(join(path, "workflow.yaml"), JSON.stringify(workflow, null, 2));
    const protectedPaths = [
      "AGENTS.md",
      ".gitignore",
      "package.json",
      "build.js",
      "test/message.test.js",
      "veyra.yaml",
      "workflow.yaml",
    ];
    const protectedFiles = await Promise.all(
      protectedPaths.map(async (file) => [file, await readFile(join(path, file), "utf8")] as const),
    );
    await command("git", ["init", "--quiet"]);
    await command("git", ["add", "."]);
    const before = await runProcess({
      executable: process.execPath,
      args: ["--test"],
      cwd: path,
      timeoutMs: 30_000,
      signal,
    });
    assert.equal(before.exitCode, 1, "Fixture must start with the expected failing test.");
    const store = new LocalRunStore({ stateDir: join(path, ".veyra"), redactValues: secrets });
    const engine = new VeyraEngine({ store, emit: dependencies.emit });
    const result = await engine.run({
      goal: `Change only src/message.js so message() returns exactly "${smokeGreeting}". It currently returns "Hello from the Veyra fixture". The existing Node test expects the new greeting. Planner: give a tiny deterministic plan. Executor: implement it without altering tests or configuration. Reviewer: evaluate the deterministic check, test and build evidence against this goal; do not treat executor claims alone as proof.`,
      config,
      workflow,
      agents: adaptersFor(config, workflow, dependencies.createAgent ?? createAgent),
      cwd: path,
      signal,
    });
    report.runId = result.runId;
    const events = await store.readEvents(result.runId);
    report.calls = events
      .filter((event) => event.type === "agent.completed")
      .map((event) => ({
        agent: event.agentId,
        provider: event.provider ?? "unknown",
        ...(event.result.usage ? { usage: event.result.usage } : {}),
      }));
    const last = events.at(-1);
    assert.equal(
      result.status,
      "completed",
      last?.type === "run.failed" ? last.message : "The live run did not complete.",
    );
    assert.ok(
      events.some(
        (event) =>
          event.type === "agent.completed" &&
          event.role === "planner" &&
          event.result.status === "success",
      ),
      "Missing successful planner result.",
    );
    const review = [...events]
      .reverse()
      .find((event) => event.type === "agent.completed" && event.role === "reviewer");
    assert.ok(
      review?.type === "agent.completed" && review.result.outcome === "pass",
      "Reviewer did not pass.",
    );
    const verification = [...events]
      .reverse()
      .find((event) => event.type === "verification.completed");
    assert.ok(
      verification?.type === "verification.completed" &&
        verification.success &&
        verification.results.length === 3,
      "Check/test/build evidence is incomplete.",
    );
    for (const [file, original] of protectedFiles)
      assert.equal(
        await readFile(join(path, file), "utf8"),
        original,
        `Protected fixture file changed: ${file}`,
      );
    await command(process.execPath, ["--test"]);
    assert.ok(
      (await readFile(join(path, "dist/message.js"), "utf8")).includes(smokeGreeting),
      "Expected greeting is missing from the build output.",
    );
    assert.equal(
      (await command("git", ["diff", "--name-only"])).stdout.trim(),
      "src/message.js",
      "Unexpected tracked changes.",
    );
    assert.equal(
      (await command("git", ["ls-files", "--others", "--exclude-standard"])).stdout,
      "",
      "Unexpected untracked files.",
    );
    report.status = "passed";
    report.message =
      "Planner, executor, deterministic verification and reviewer passed; only src/message.js changed.";
  } catch (error) {
    report.status = "failed";
    report.message = String(
      redact(error instanceof Error ? error.message : "Smoke failed.", secrets),
    ).slice(0, 1500);
  } finally {
    if (env.VEYRA_SMOKE_KEEP === "1") report.disposableWorkspaceRemoved = false;
    else {
      await workspace.cleanup();
      report.disposableWorkspaceRemoved = true;
    }
  }
  return report;
}
