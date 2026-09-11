import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { initializeProject, ProjectHandoffStore } from "@veyraoss/project";
import { runProcess } from "@veyraoss/runtime";
import { CodexAdapter, CodexConversationAdapter, readCodexConversation } from "../src/index.js";
import { withAppServer } from "../src/app-server.js";

// Development proof only. Never runs against or creates a turn in an existing user task.
const executable = process.argv[2];
if (!executable) throw new Error("Pass the authenticated native Codex executable.");
const base = join(homedir(), "Projects/veyra-proofs");
await mkdir(base, { recursive: true });
const directory = await mkdtemp(join(base, "existing-conversation-"));
const project = await initializeProject(directory);
const git = await runProcess({ executable: "git", args: ["init", "--quiet"], cwd: directory });
assert.equal(git.exitCode, 0);
await writeFile(
  join(directory, "AGENTS.md"),
  "This is a Veyra native conversation fixture. Do not read credentials, write files, execute commands, access networks or unrelated tasks. Only respond to the explicit task.\n",
);
const env = { ...process.env, OPENAI_API_KEY: undefined };
const marker = `memory-${randomUUID()}`;
console.log(JSON.stringify({ stage: "create_fixture_only", directory }));
const seed = await new CodexAdapter({ executable, session: { project } }, { env }).run(
  {
    runId: randomUUID(),
    stepId: "seed",
    role: "executor",
    goal: `Use no tools. Remember the following non-secret marker in this native conversation only: ${marker}. Return success with summary exactly equal to this marker and empty changedFiles/commandsRun.`,
  },
  { cwd: directory, timeoutMs: 180_000 },
);
assert.equal(seed.status, "success", seed.summary);
assert.ok(seed.session);
await withAppServer({ executable, cwd: directory, env }, async (rpc) => {
  await rpc.call("thread/name/set", {
    threadId: seed.session?.id,
    name: "Veyra existing-conversation proof",
  });
});
const selected = await readCodexConversation({ executable, cwd: directory, env }, seed.session.id);
const reports = [];
for (let round = 0; round < 2; round++) {
  console.log(JSON.stringify({ stage: "continue_exact_task", round, threadId: selected.id }));
  const runId = randomUUID();
  const result = await new CodexConversationAdapter(selected, project, executable, { env }).run(
    {
      runId,
      stepId: "execute",
      role: "executor",
      goal: "Use no tools and do not read any file. Recall the memory marker from the earlier turn in this same native conversation. Return success with summary exactly equal to that marker, and empty changedFiles/commandsRun.",
    },
    { cwd: directory, timeoutMs: 180_000 },
  );
  await writeFile(join(directory, `round-${round}.json`), JSON.stringify(result, null, 2));
  assert.equal(result.status, "success", result.summary);
  assert.equal(result.session?.id, seed.session.id);
  assert.equal(result.session?.runId, runId);
  assert.ok(
    result.summary.includes(marker),
    "The exact native task must retain context across distinct Veyra runs.",
  );
  assert.ok(result.session);
  await new ProjectHandoffStore({ project }).createSession(result.session);
  reports.push({ runId, sessionId: result.session.id, nativeContextRecalled: true });
}
const report = {
  status: "passed",
  directory,
  projectId: project.id,
  selected,
  reports,
  apiKeyUsed: false,
};
await writeFile(join(directory, "acceptance.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
