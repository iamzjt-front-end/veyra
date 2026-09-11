import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { DaemonClient } from "@veyraoss/daemon";
import { ProjectHandoffStore } from "@veyraoss/project";
import type { ProjectHandoff } from "@veyraoss/protocol";
import { startCoordinator } from "../src/coordinator.js";
import { initializeNativeProject } from "../src/project-init.js";
import { NativeService } from "../src/native-service.js";
import { BROWSER_ORIGIN, setupNative } from "../src/native-installation.js";

const directory = resolve(process.argv[2] ?? "");
const evidence = JSON.parse(await readFile(join(directory, "acceptance.json"), "utf8"));
if (
  evidence.status !== "passed" ||
  evidence.selected?.root !== directory ||
  evidence.selected?.title !== "Veyra existing-conversation proof"
)
  throw new Error("Pass only the durable fixture produced by manual-conversation-smoke.ts.");
const registryRoot = join(directory, ".veyra", "isolated-registry");
const { project } = await initializeNativeProject(directory, { registryRoot });
assert.equal(project.id, evidence.projectId);
await writeFile(
  join(directory, "veyra.yaml"),
  JSON.stringify({ version: 1, agents: {}, workflow: { use: "checks.yaml" } }),
);
await writeFile(
  join(directory, "checks.yaml"),
  JSON.stringify({
    version: 1,
    name: "continuation-verification",
    start: "verify",
    steps: {
      verify: {
        type: "command",
        run: ["node -e \"console.log('independent native continuation verification')\""],
      },
    },
  }),
);
const installed = await setupNative({
  registryRoot,
  manifestDirs: [join(registryRoot, "fixture-host")],
  entry: import.meta.filename,
});
const daemon = await startCoordinator({
  registryRoot,
  env: { ...process.env, OPENAI_API_KEY: undefined },
});
try {
  const client = new DaemonClient({ registryRoot });
  const service = new NativeService(installed.statePath, BROWSER_ORIGIN, async () => client);
  const call = async (method: string, params?: unknown) => {
    const response = (await service.handle({
      version: 1,
      id: randomUUID(),
      method,
      installationId: installed.installationId,
      ...(params === undefined ? {} : { params }),
    })) as { ok: boolean; error?: string; data: unknown };
    assert.equal(response.ok, true, response.error);
    return response.data;
  };
  await call("hello");
  await call("codex.conversations.select", evidence.selected);
  // Ordinary Bind also renews the Project grant. It must preserve the selected task scope.
  await call("projects.authorize", { projectId: project.id });
  await call("codex.conversations.check", {
    projectId: project.id,
    conversation: evidence.selected,
  });
  const runId = randomUUID();
  const provenance = {
    role: "planner" as const,
    surface: "explicit-local-fixture",
    actor: "fixture-user",
    contentTrust: "untrusted" as const,
    at: new Date().toISOString(),
  };
  const handoff: ProjectHandoff = {
    version: 1,
    kind: "handoff",
    id: randomUUID(),
    projectId: project.id,
    runId,
    provenance,
    context: {
      goal: "No tools and no file changes. Return success with a short summary that this exact native conversation continued. Veyra will run the independent check.",
      constraints: ["Do not change files, execute commands, access credentials or other tasks."],
      decisions: [],
      plan: {
        id: "continuation-proof",
        revision: 1,
        summary:
          "Continue the selected native task and preserve independent verification evidence.",
        tasks: [{ id: "acknowledge", description: "Acknowledge in the same native task." }],
        acceptanceCriteria: ["Same native conversation ID", "Independent verification recorded"],
        provenance,
      },
      currentTask: "acknowledge",
    },
    requestedVerification: [{ id: "verify", kind: "shell" }],
  };
  const forbidden = (await service.handle({
    version: 1,
    id: randomUUID(),
    method: "runs.dispatch",
    installationId: installed.installationId,
    params: { projectId: project.id, handoff, nativeConversationId: randomUUID() },
  })) as { ok: boolean };
  assert.equal(forbidden.ok, false);
  assert.equal(await new ProjectHandoffStore({ project }).getHandoff(runId), undefined);
  await call("runs.dispatch", {
    projectId: project.id,
    handoff,
    nativeConversationId: evidence.selected.id,
  });
  let run = await client.call("runs.get", { projectId: project.id, runId });
  while (["running", "queued"].includes(run.status))
    run = await client.call("runs.wait", { projectId: project.id, runId, waitMs: 30_000 });
  const result = await client.call("results.get", { projectId: project.id, runId });
  await writeFile(
    join(directory, "daemon-dispatch.json"),
    JSON.stringify({ run, result }, null, 2),
  );
  assert.equal(run.status, "completed", JSON.stringify({ run, result }));
  assert.equal(
    (await new ProjectHandoffStore({ project }).getSession(runId))?.id,
    evidence.selected.id,
  );
  assert.ok(result);
  assert.equal(result?.verification?.[0]?.status, "passed");
  assert.ok(result.evidence.some((reference) => reference.source === "verifier"));
  const replay = (await service.handle({
    version: 1,
    id: randomUUID(),
    method: "runs.dispatch",
    installationId: installed.installationId,
    params: { projectId: project.id, handoff, nativeConversationId: evidence.selected.id },
  })) as { ok: boolean };
  assert.equal(replay.ok, false);
  console.log(
    JSON.stringify({
      status: "passed",
      directory,
      runId,
      nativeConversationId: evidence.selected.id,
      scopedAuthorization: true,
      verifierEvidence: true,
      duplicateDispatch: "denied",
      apiKeyUsed: false,
    }),
  );
} finally {
  await daemon.stop();
}
