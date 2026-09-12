/** Real native host/coordinator/Verifier proof on the preceding script's isolated durable task. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@veyraoss/daemon";
import { ProjectHandoffStore } from "@veyraoss/project";
import type { ProjectHandoff } from "@veyraoss/protocol";
import { withAppServer, record } from "../../../plugins/codex/src/app-server.js";
import { startCoordinator } from "../src/coordinator.js";
import { initializeNativeProject } from "../src/project-init.js";
import { NativeService } from "../src/native-service.js";
import { BROWSER_ORIGIN, setupNative } from "../src/native-installation.js";

if (!process.argv[2] || !process.argv[3])
  throw new Error("Supply the passed shared-adapter fixture and native executable.");
const root = resolve(process.argv[2]);
const executable = process.argv[3];
const previous = JSON.parse(await readFile(join(root, "shared-adapter-evidence.json"), "utf8"));
assert.equal(previous.root, root);
assert.equal(previous.status, "passed");
assert.equal(previous.serverStopped, true);
const selected = {
  id: previous.threadId as string,
  title: "Veyra shared native adapter proof",
  root,
};
const ipc = await mkdtemp(join(tmpdir(), "ve-dispatch-"));
const socket = join(ipc, "codex.sock");
const env = { ...process.env, OPENAI_API_KEY: undefined };
const server = spawn(executable, ["app-server", "--listen", `unix://${socket}`], {
  cwd: root,
  env,
  stdio: "ignore",
});
const exited = once(server, "exit");
const report: Record<string, unknown> = {
  root,
  nativeConversationId: selected.id,
  apiKeyUsed: false,
  serverPid: server.pid,
  desktopMigrated: false,
};
try {
  for (let i = 0; i < 100; i++) {
    if (await lstat(socket).catch(() => undefined)) break;
    if (server.exitCode !== null) throw new Error("Fixture native server exited before listening.");
    await delay(50);
  }
  await withAppServer(
    { executable, env: { ...env, VEYRA_CODEX_SOCKET: socket }, timeoutMs: 180000 },
    async (owner) => {
      const resumed = await owner.call("thread/resume", {
        threadId: selected.id,
        excludeTurns: true,
      });
      assert.ok(record(resumed) && record(resumed.thread) && resumed.thread.id === selected.id);
      const registryRoot = join(root, ".veyra", "shared-proof-registry");
      const { project } = await initializeNativeProject(root, { registryRoot, env });
      assert.equal(project.id, previous.projectId);
      await writeFile(
        join(root, "veyra.yaml"),
        JSON.stringify({ version: 1, agents: {}, workflow: { use: "shared-checks.yaml" } }),
      );
      await writeFile(
        join(root, "shared-checks.yaml"),
        JSON.stringify({
          version: 1,
          name: "shared-native-verification",
          start: "verify",
          steps: {
            verify: {
              type: "command",
              run: ["node -e \"console.log('real shared native verification')\""],
            },
          },
        }),
      );
      const installation = await setupNative({
        registryRoot,
        env,
        codexSocket: socket,
        manifestDirs: [join(registryRoot, "fixture-host")],
        entry: import.meta.filename,
      });
      const daemon = await startCoordinator({
        registryRoot,
        env,
        nativeInstallationPath: installation.statePath,
      });
      try {
        const client = new DaemonClient({ registryRoot });
        const service = new NativeService(
          installation.statePath,
          BROWSER_ORIGIN,
          async () => client,
        );
        const call = async (method: string, params?: unknown) => {
          const response = await service.handle({
            version: 1,
            id: randomUUID(),
            method,
            installationId: installation.installationId,
            ...(params === undefined ? {} : { params }),
          });
          assert.ok(record(response) && response.ok === true, JSON.stringify(response));
          return response.data;
        };
        await call("hello");
        await call("codex.conversations.select", selected);
        await call("projects.authorize", { projectId: project.id });
        await call("codex.conversations.check", { projectId: project.id, conversation: selected });
        const runId = randomUUID();
        const provenance = {
          role: "planner" as const,
          surface: "explicit-shared-native-fixture",
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
            goal: "No tools, no commands and no file changes. Acknowledge success in this exact existing task. Veyra independently runs its configured verifier.",
            constraints: [
              "Do not inspect credentials or other tasks. Do not modify files or execute tools.",
            ],
            decisions: [],
            plan: {
              id: "shared-proof",
              revision: 1,
              summary: "One shared native turn plus independent verification.",
              tasks: [{ id: "acknowledge", description: "Acknowledge the shared connection." }],
              acceptanceCriteria: ["Same native ID", "Real independent Verifier evidence"],
              provenance,
            },
            currentTask: "acknowledge",
          },
          requestedVerification: [{ id: "verify", kind: "shell" }],
        };
        const params = { projectId: project.id, handoff, nativeConversationId: selected.id };
        await call("runs.dispatch", params);
        let run = await client.call("runs.get", { projectId: project.id, runId });
        while (["running", "queued"].includes(run.status))
          run = await client.call("runs.wait", { projectId: project.id, runId, waitMs: 30000 });
        const result = await client.call("results.get", { projectId: project.id, runId });
        await writeFile(
          join(root, "shared-dispatch-result.json"),
          JSON.stringify({ run, result }, null, 2),
        );
        assert.equal(run.status, "completed", JSON.stringify({ run, result }));
        assert.equal(
          (await new ProjectHandoffStore({ project }).getSession(runId))?.id,
          selected.id,
        );
        assert.equal(result?.verification?.[0]?.status, "passed");
        assert.ok(result?.evidence.some((reference) => reference.source === "verifier"));
        await assert.rejects(call("runs.dispatch", params));
        const observed = await owner.call("thread/read", {
          threadId: selected.id,
          includeTurns: false,
        });
        assert.ok(
          record(observed) &&
            record(observed.thread) &&
            record(observed.thread.status) &&
            observed.thread.status.type === "idle",
        );
        report.runId = runId;
        report.verifierEvidence = true;
        report.duplicateRefused = true;
        report.otherClientStillConnected = true;
        report.status = "passed";
      } finally {
        await daemon.stop();
      }
    },
  );
} catch (error) {
  report.status = "failed";
  report.error = String(error);
  throw error;
} finally {
  server.kill("SIGTERM");
  const timer = setTimeout(() => server.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
  report.serverStopped = true;
  await writeFile(join(root, "shared-dispatch-evidence.json"), JSON.stringify(report, null, 2));
  await rm(ipc, { recursive: true, force: true });
  console.log(JSON.stringify(report));
}
