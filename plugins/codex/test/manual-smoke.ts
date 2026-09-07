import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runProcess } from "@veyra/runtime";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { CodexAdapter } from "../src/index.js";

// Opt-in only: this uses the installed CLI's existing authentication and model configuration.
const report = await withFixtureWorkspace(async ({ path }) => {
  const command = async (executable: string, args: string[]) => {
    const result = await runProcess({ executable, args, cwd: path, timeoutMs: 30_000 });
    assert.equal(result.exitCode, 0, `Fixture command failed: ${executable} ${args.join(" ")}`);
    return result;
  };
  const instructions =
    "# Smoke fixture\nOnly edit src/message.js. Do not edit tests, this AGENTS.md, or package.json. Do not install dependencies, access the network, commit, push, publish, or deploy.\n";
  await writeFile(join(path, "AGENTS.md"), instructions);
  const testPath = join(path, "test/message.test.js");
  const expected = "Hello from the verified Codex fixture";
  await writeFile(
    testPath,
    (await readFile(testPath, "utf8")).replace("Hello from the Veyra fixture", expected),
  );
  await command("git", ["init", "--quiet"]);
  await command("git", ["add", "."]);
  const adapter = new CodexAdapter({ timeoutMs: 180_000 });
  const readiness = await adapter.doctor({ cwd: path });
  assert.equal(readiness.ready, true, readiness.message);
  const before = await runProcess({
    executable: process.execPath,
    args: ["--test"],
    cwd: path,
    timeoutMs: 30_000,
  });
  assert.notEqual(before.exitCode, 0, "The smoke fixture must start with a failing test.");
  const result = await adapter.run(
    {
      runId: "codex-smoke",
      stepId: "execute",
      role: "executor",
      goal: `Make message() return exactly "${expected}" and pass the existing test.`,
      instructions:
        "Change only src/message.js, preserve AGENTS.md and the tests, and run node --test.",
      context: {
        planner: {
          instructions:
            "Replace the greeting string in src/message.js; no dependencies are needed.",
        },
        verification: { exitCode: before.exitCode, stdout: before.stdout },
      },
    },
    { cwd: path },
  );
  assert.equal(
    result.status,
    "success",
    JSON.stringify({
      status: result.status,
      summary: result.summary,
      error: result.error,
      process: result.data?.process,
    }),
  );
  assert.equal(await readFile(join(path, "AGENTS.md"), "utf8"), instructions);
  assert.ok((await readFile(join(path, "src/message.js"), "utf8")).includes(expected));
  await command(process.execPath, ["--check", "src/message.js"]);
  await command(process.execPath, ["--test"]);
  const changed = await command("git", ["diff", "--name-only"]);
  assert.deepEqual(changed.stdout.trim().split("\n"), ["src/message.js"]);
  const untracked = await command("git", ["ls-files", "--others", "--exclude-standard"]);
  assert.equal(untracked.stdout, "");
  return {
    status: "passed",
    codexVersion: readiness.version,
    modifiedFiles: ["src/message.js"],
    verification: ["node --check src/message.js", "node --test"],
    usage: result.usage,
  };
});
console.log(JSON.stringify({ ...report, disposableWorkspaceRemoved: true }, null, 2));
