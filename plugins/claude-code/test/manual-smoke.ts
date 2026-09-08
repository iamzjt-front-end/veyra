import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "@veyra/runtime";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { ClaudeCodeAdapter } from "../src/index.js";

async function main() {
  if (process.env.VEYRA_LIVE_SMOKE !== "1") {
    console.error(
      "Set VEYRA_LIVE_SMOKE=1 to run the Claude Code smoke test with the installed CLI's existing authentication.",
    );
    return 2;
  }
  const args = process.argv.slice(2).filter((arg) => arg !== "--");
  if (args.length > 1) {
    console.error("Usage: pnpm --filter @veyra/claude-code smoke -- [model]");
    return 2;
  }
  const adapter = new ClaudeCodeAdapter({
    timeoutMs: 180000,
    maxTurns: 8,
    allowedTools: ["Read", "Edit(./src/message.js)"],
    ...(args[0] ? { model: args[0] } : {}),
  });
  const report = await withFixtureWorkspace(async ({ path }) => {
    const readiness = await adapter.checkReadiness({ cwd: path, timeoutMs: 10000 });
    if (readiness.status !== "ready") return { status: "blocked", message: readiness.message };
    const instructions =
      "# Smoke fixture\nOnly edit src/message.js. Read and follow AGENTS.md. Do not edit tests, instructions, or package.json. Use Read and Edit tools only; do not invoke Bash or subagents. Do not install dependencies, access credentials or the network with tools, commit, push, publish, or deploy. Veyra runs independent verification after you finish.\n";
    await writeFile(join(path, "AGENTS.md"), instructions);
    await writeFile(join(path, "CLAUDE.md"), instructions);
    const testPath = join(path, "test/message.test.js");
    const expected = "Hello from the verified Claude Code fixture";
    const test = (await readFile(testPath, "utf8")).replace(
      "Hello from the Veyra fixture",
      expected,
    );
    await writeFile(testPath, test);
    const command = async (executable: string, args: string[]) => {
      const result = await runProcess({ executable, args, cwd: path, timeoutMs: 30000 });
      assert.equal(result.exitCode, 0, `Fixture command failed: ${executable} ${args.join(" ")}`);
      return result;
    };
    await command("git", ["init", "--quiet"]);
    await command("git", ["add", "."]);
    const before = await runProcess({
      executable: process.execPath,
      args: ["--test"],
      cwd: path,
      timeoutMs: 30000,
    });
    assert.notEqual(before.exitCode, 0, "The fixture must start with a failing test.");
    const result = await adapter.run(
      {
        runId: "claude-code-smoke",
        stepId: "execute",
        role: "executor",
        goal: `Make message() return exactly "${expected}" by changing only src/message.js.`,
        instructions:
          "Read AGENTS.md and CLAUDE.md, use Read and Edit only, preserve tests and instructions. Do not run commands; Veyra runs tests afterward.",
        context: { verification: { exitCode: before.exitCode, stdout: before.stdout } },
      },
      { cwd: path },
    );
    if (result.status !== "success")
      return { status: "failed", claudeCodeVersion: readiness.version, result };
    assert.equal(await readFile(join(path, "AGENTS.md"), "utf8"), instructions);
    assert.equal(await readFile(join(path, "CLAUDE.md"), "utf8"), instructions);
    assert.equal(await readFile(testPath, "utf8"), test);
    assert.ok((await readFile(join(path, "src/message.js"), "utf8")).includes(expected));
    await command(process.execPath, ["--check", "src/message.js"]);
    await command(process.execPath, ["--test"]);
    assert.deepEqual((await command("git", ["diff", "--name-only"])).stdout.trim().split("\n"), [
      "src/message.js",
    ]);
    assert.equal(
      (await command("git", ["diff", "--cached", "--name-only", "--diff-filter=D"])).stdout,
      "",
    );
    assert.equal((await command("git", ["ls-files", "--others", "--exclude-standard"])).stdout, "");
    return {
      status: "passed",
      claudeCodeVersion: readiness.version,
      modifiedFiles: ["src/message.js"],
      verification: ["node --check src/message.js", "node --test"],
      usage: result.usage,
    };
  });
  console.log(JSON.stringify({ ...report, disposableWorkspaceRemoved: true }, null, 2));
  return report.status === "passed" ? 0 : report.status === "blocked" ? 2 : 1;
}
process.exitCode = await main();
