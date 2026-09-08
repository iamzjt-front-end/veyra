import { mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runProcess } from "../../packages/runtime/src/index.js";
import { runEvaluation, summarizeUsage, taskIds } from "./harness.js";

describe("versioned evaluation harness", () => {
  it("measures actual success, a repair and exhausted repairs for both variants", async () => {
    const report = await runEvaluation({ mode: "scripted", env: {} });
    expect(report.rows).toHaveLength(6);
    expect(report.fixtureRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(report.harnessRevision).toMatch(/^[a-f0-9]{64}$/);
    expect(report.configurationHash).toMatch(/^[a-f0-9]{64}$/);
    for (const variant of ["single", "orchestrated"]) {
      const rows = report.rows.filter((row) => row.variant === variant);
      expect(rows.map((row) => row.task)).toEqual(taskIds);
      expect(rows.map((row) => row.passed)).toEqual([true, true, false]);
      expect(rows.map((row) => row.executorCalls)).toEqual([1, 2, 2]);
      expect(rows.map((row) => row.executorRepairs)).toEqual([0, 1, 1]);
      expect(rows.every((row) => row.durationMs > 0 && row.protectedFilesUnchanged)).toBe(true);
      expect(rows.every((row) => row.usage.unknownCostCalls === row.agentCalls)).toBe(true);
      expect(report.summary.find((item) => item.variant === variant)).toMatchObject({
        samples: 3,
        passed: 2,
        completionRate: 2 / 3,
        executorRepairs: 2,
      });
    }
    expect(report.rows.slice(0, 4).map((row) => row.variant)).toEqual([
      "single",
      "orchestrated",
      "orchestrated",
      "single",
    ]);
    expect(JSON.stringify(report)).not.toContain("Only edit src/solution.js");
  }, 30_000);

  it.each(["tamper", "symlink", "throw"] as const)(
    "rejects %s and removes each disposable workspace",
    async (behavior) => {
      const paths = new Set<string>();
      const report = await runEvaluation({
        mode: "scripted",
        env: { OPENAI_API_KEY: "fixture-evaluation-secret" },
        scriptedAgents: (_task, _variant, cwd) => {
          paths.add(cwd);
          let changed = false;
          return (id) => ({
            id,
            provider: "fixture",
            async run() {
              if (id === "executor" && !changed) {
                changed = true;
                if (behavior === "throw") throw new Error("fixture-evaluation-secret");
                if (behavior === "tamper") await writeFile(join(cwd, "test/solution.test.js"), "");
                if (behavior === "symlink") {
                  await unlink(join(cwd, "src/solution.js"));
                  await symlink("../package.json", join(cwd, "src/solution.js"));
                }
              }
              return {
                status: "success",
                summary: "Claimed success must not replace grading.",
                ...(id === "reviewer" ? { outcome: "pass" } : {}),
              };
            },
          });
        },
      });
      expect(report.rows.every((row) => !row.passed)).toBe(true);
      if (behavior !== "throw")
        expect(report.rows.every((row) => !row.protectedFilesUnchanged)).toBe(true);
      expect(JSON.stringify(report)).not.toContain("fixture-evaluation-secret");
      for (const path of paths)
        await expect(readdir(path)).rejects.toMatchObject({ code: "ENOENT" });
    },
    30_000,
  );

  it("keeps missing usage unknown and costs in their reported currencies", () => {
    expect(
      summarizeUsage(
        [
          { totalTokens: 10, cost: { amount: 0, currency: "USD" } },
          { inputTokens: 2, outputTokens: 3, cost: { amount: 0.2, currency: "EUR" } },
          { totalTokens: 4, cost: { amount: 0.1, currency: "USD" } },
          undefined,
        ],
        5,
      ),
    ).toEqual({
      knownTokens: 19,
      unknownTokenCalls: 2,
      unknownCostCalls: 2,
      knownCosts: [
        { currency: "EUR", amount: 0.2 },
        { currency: "USD", amount: 0.1 },
      ],
    });
  });

  it("uses the guarded configured-plugin path, resolves its module and excludes credentials from checks", async () => {
    const directory = await mkdtemp(join(tmpdir(), "veyra-eval-config-"));
    try {
      const solutions = Object.fromEntries(
        await Promise.all(
          taskIds.map(async (task) => [
            task,
            'if (process.env.VEYRA_GRADING_SECRET) throw new Error("unexpected credential");\n' +
              (await readFile(new URL(`./references/${task}.txt`, import.meta.url), "utf8")),
          ]),
        ),
      );
      await writeFile(
        join(directory, "solver.mjs"),
        `import {readFile,writeFile} from 'node:fs/promises'; import {join} from 'node:path';
const solutions=${JSON.stringify(solutions)};
export default {apiVersion:1,provider:'local-eval',version:'1.0.0',createAgent({id}) {return {id,provider:'local-eval',async run(input,controls) {if(id==='executor'){const {id:task}=JSON.parse(await readFile(join(controls.cwd,'task.json'),'utf8'));await writeFile(join(controls.cwd,'src/solution.js'),solutions[task]);}return {status:'success',summary:'Actual local fixture solution',...(id==='reviewer'?{outcome:'pass'}:{})};}};}};`,
      );
      const config = join(directory, "veyra.yaml");
      await writeFile(
        config,
        JSON.stringify({
          version: 1,
          workflow: { use: "dev" },
          plugins: { "local-eval": { module: "./solver.mjs", version: "1.0.0" } },
          agents: Object.fromEntries(
            ["planner", "executor", "reviewer"].map((id) => [id, { provider: "local-eval" }]),
          ),
        }),
      );
      const script = fileURLToPath(new URL("./manual-evaluation.ts", import.meta.url));
      const result = await runProcess({
        executable: process.execPath,
        args: [
          "--import",
          "tsx",
          script,
          "--live",
          "--config",
          config,
          "--allow-plugin",
          "local-eval",
        ],
        env: { VEYRA_LIVE_EVAL: "1", VEYRA_GRADING_SECRET: "fixture-grading-secret" },
        timeoutMs: 30_000,
        maxOutputBytes: 128 * 1024,
      });
      expect(result.exitCode, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(report.mode).toBe("live");
      expect(report.rows).toHaveLength(6);
      expect(
        report.rows.every(
          (row: { passed: boolean; metricsComplete: boolean }) => row.passed && row.metricsComplete,
        ),
      ).toBe(true);
      expect(result.stdout + result.stderr).not.toContain("fixture-grading-secret");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }, 40_000);

  it.each([0, 11, NaN, 1.5])(
    "rejects invalid trial count %s before running a task",
    async (trials) => {
      await expect(runEvaluation({ mode: "scripted", trials, env: {} })).rejects.toThrow(
        "trials must be",
      );
    },
  );

  it("requires explicit live consent/config and refuses an already cancelled suite", async () => {
    await expect(runEvaluation({ mode: "live", env: {} })).rejects.toThrow(
      "Live evaluation requires",
    );
    await expect(
      runEvaluation({ mode: "scripted", signal: AbortSignal.abort() }),
    ).rejects.toThrow();
    const script = fileURLToPath(new URL("./manual-evaluation.ts", import.meta.url));
    const result = await runProcess({
      executable: process.execPath,
      args: ["--import", "tsx", script, "--live"],
      env: { VEYRA_LIVE_EVAL: undefined },
      timeoutMs: 10_000,
    });
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain("VEYRA_LIVE_EVAL=1");
    expect(result.stdout).toBe("");
  });

  it("keeps every acceptance fixture initially failing and every reference solution meaningful", async () => {
    for (const task of taskIds) {
      const fixture = new URL(`../fixtures/evaluation/v1/${task}/`, import.meta.url);
      const before = await readFile(new URL("src/solution.js", fixture), "utf8");
      const reference = await readFile(
        new URL(`./references/${task}.txt`, import.meta.url),
        "utf8",
      );
      expect(reference).not.toBe(before);
      const result = await runProcess({
        executable: process.execPath,
        args: ["--test"],
        cwd: fileURLToPath(fixture),
        timeoutMs: 10_000,
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("task acceptance");
    }
  });
});
