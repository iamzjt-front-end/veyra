import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { DaemonClient } from "@veyraoss/daemon";
import { runProcess } from "@veyraoss/runtime";
import type { ProjectHandoff, ProjectExecutionResult } from "@veyraoss/protocol";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const daemonUrl = new URL("../../../packages/daemon/dist/index.js", import.meta.url).href;
const coreUrl = new URL("../../../packages/core/dist/index.js", import.meta.url).href;

/** Production CLI/daemon/native adapter and Verifier, isolated to a disposable Git fixture. */
export async function nativeDispatchFixture(
  executable = "codex",
  options: {
    signal?: AbortSignal;
    progress?: (stage: string) => void;
    mode?: "repair" | "inspect-failure" | "inspect-success";
  } = {},
) {
  const inspecting = options.mode?.startsWith("inspect") ?? false;
  const expectedFailure = options.mode === "inspect-failure";
  const report = await withFixtureWorkspace(async ({ path }) => {
    const command = async (executable: string, args: string[], timeoutMs = 15000) => {
      const result = await runProcess({
        executable,
        args,
        cwd: path,
        timeoutMs,
        env: { OPENAI_API_KEY: undefined },
        signal: options.signal,
        maxOutputBytes: 262144,
      });
      assert.equal(result.exitCode, 0, `${executable} failed: ${result.stderr}`);
      return result.stdout;
    };
    const registryRoot = join(path, ".veyra", "registry");
    await writeFile(join(path, ".gitignore"), ".veyra/\nbuild/\n");
    await writeFile(
      join(path, "AGENTS.md"),
      `# Native dispatch fixture\n${inspecting ? "Inspect only; do not modify any source, test, configuration or instruction file. Do not repair failures." : "Change only src/message.js."} Preserve tests, scripts, package.json, veyra.yaml, checks.yaml, .gitignore, this AGENTS.md and .veyra/. No dependency installation or unrelated file access. Do not commit, push, publish or deploy. Never copy credentials or native chat history. Veyra will run the protected verifier after execution.\n`,
    );
    await writeFile(
      join(path, "src/message.js"),
      `export function message() { return '${options.mode === "inspect-success" ? "Hello from the Veyra fixture" : "BROKEN"}'; }\n`,
    );
    await mkdir(join(path, "scripts"));
    await writeFile(
      join(path, "scripts/build.mjs"),
      "import { mkdir, copyFile } from 'node:fs/promises';\nawait mkdir('build', { recursive: true });\nawait copyFile('src/message.js', 'build/message.js');\n",
    );
    await writeFile(
      join(path, "veyra.yaml"),
      JSON.stringify({ version: 1, agents: {}, workflow: { use: "./checks.yaml" } }),
    );
    await writeFile(
      join(path, "checks.yaml"),
      JSON.stringify({
        version: 1,
        name: "local-checks",
        start: "test",
        steps: {
          test: { type: "command", run: ["node --test"], next: "build", timeoutMs: 10000 },
          build: {
            type: "command",
            run: ["node --check src/message.js", "node scripts/build.mjs"],
            next: "diff",
            timeoutMs: 10000,
          },
          diff: {
            type: "command",
            run: ["git diff --no-ext-diff --no-textconv -- src/message.js"],
            timeoutMs: 10000,
          },
        },
      }),
    );
    await command("git", ["init", "--quiet"]);
    await command("git", [
      "add",
      "AGENTS.md",
      ".gitignore",
      "package.json",
      "src",
      "test",
      "scripts",
      "veyra.yaml",
      "checks.yaml",
    ]);
    const initial = await runProcess({
      executable: process.execPath,
      args: ["--test"],
      cwd: path,
      timeoutMs: 10000,
    });
    assert.equal(initial.exitCode, options.mode === "inspect-success" ? 0 : 1);
    const cli = async (...args: string[]) =>
      JSON.parse(await command(process.execPath, [entry, ...args, "--json"]));
    const { project } = await cli("project", "add", path, "--registry", registryRoot);
    await cli(
      "project",
      "bind",
      project.id,
      "--executor",
      "codex/native",
      "--codex-executable",
      executable,
      "--registry",
      registryRoot,
    );
    const protectedPaths = [
      "AGENTS.md",
      ".gitignore",
      "package.json",
      "test/message.test.js",
      "scripts/build.mjs",
      "veyra.yaml",
      "checks.yaml",
      ".veyra/project.yaml",
      ...(inspecting ? ["src/message.js"] : []),
    ];
    const protectedFiles = new Map(
      await Promise.all(
        protectedPaths.map(async (file) => [file, await readFile(join(path, file))] as const),
      ),
    );
    options.progress?.("fixture_ready");
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const child = spawn(
      process.execPath,
      [entry, "daemon", "start", "--registry", registryRoot, "--json"],
      { cwd: path, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    const api = new DaemonClient({ registryRoot });
    let stopped = false;
    try {
      let ready = "";
      while (!ready.includes("\n")) {
        const [chunk] = await Promise.race([
          once(child.stdout, "data", { signal: AbortSignal.timeout(10000) }),
          exited.then(() => {
            throw new Error("Daemon exited before readiness");
          }),
        ]);
        ready += String(chunk);
      }
      assert.equal(JSON.parse(ready).type, "daemon.started");
      options.progress?.("daemon_ready");
      const provenance = {
        role: "planner" as const,
        surface: "native-dispatch-smoke",
        actor: "explicit-local-user",
        contentTrust: "untrusted" as const,
        at: new Date().toISOString(),
      };
      const handoff: ProjectHandoff = {
        version: 1,
        kind: "handoff",
        id: randomUUID(),
        projectId: project.id,
        runId: randomUUID(),
        provenance,
        context: {
          goal: "Repair the fixture so message() returns exactly 'Hello from the Veyra fixture'.",
          constraints: [
            "Change only src/message.js; preserve all protected tests, instructions, configuration and scripts.",
          ],
          decisions: [],
          currentTask: "repair",
          plan: {
            id: "repair-plan",
            revision: 1,
            summary: "Repair the exported greeting, then let Veyra verify it.",
            tasks: [
              {
                id: "repair",
                description: "Implement the exact expected message in src/message.js.",
              },
            ],
            acceptanceCriteria: [
              "node --test passes",
              "The protected build succeeds",
              "Only src/message.js changes",
            ],
            provenance,
          },
        },
        references: [
          { kind: "file", path: "src/message.js" },
          { kind: "file", path: "test/message.test.js" },
        ],
        requestedVerification: [
          { id: "test", kind: "test" },
          { id: "build", kind: "build" },
          {
            id: "diff",
            kind: "shell",
            description: "Collect a deterministic Git patch as Verifier evidence.",
          },
        ],
      };
      if (inspecting) {
        handoff.context.goal =
          "Inspect the fixture using the configured test, build and diff checks. Do not modify source or repair failures. Report failure if a requested check fails; let Veyra collect independent evidence.";
        handoff.context.constraints = [
          "Do not modify source, tests, scripts or configuration; do not repair, commit, publish or deploy. Only disposable build outputs may be generated by the existing build command.",
        ];
        handoff.context.currentTask = "inspect";
        handoff.context.plan = {
          id: "inspection-plan",
          revision: 1,
          summary: "Inspect only and collect real verification evidence.",
          tasks: [{ id: "inspect", description: handoff.context.goal }],
          acceptanceCriteria: [
            "Source and protected files stay unchanged",
            "All three configured checks return independent evidence even when a check fails",
          ],
          provenance,
        };
      }
      options.signal?.throwIfAborted();
      await api.call("runs.dispatch", { projectId: project.id, handoff });
      options.progress?.("native_running");
      const locator = { projectId: project.id, runId: handoff.runId };
      const deadline = Date.now() + (inspecting ? 300000 : 150000);
      for (;;) {
        if (options.signal?.aborted || Date.now() > deadline) {
          await api.call("runs.cancel", locator);
          throw new Error("Native dispatch smoke cancelled or exceeded its deadline");
        }
        const view = await api.call("runs.wait", { ...locator, waitMs: 1000 });
        if (!["queued", "running"].includes(view.status)) break;
      }
      // This independent process fetches through IPC, then resolves exact persisted Core evidence.
      const reader = `
        const {DaemonClient,projectTool}=await import(${JSON.stringify(daemonUrl)});
        const {LocalRunStore}=await import(${JSON.stringify(coreUrl)});
        const client=new DaemonClient({registryRoot:process.argv[1]});
        const locator={projectId:process.argv[2],runId:process.argv[3]};
        const result=await client.call('results.get',locator);
        const events=await new LocalRunStore({stateDir:process.argv[4]}).readEvents(locator.runId);
        const checks=(result?.verification??[]).map(check=>({id:check.id,status:check.status,event:events.find(e=>e.eventId===check.evidence?.eventId)}));
        const transport=await projectTool({version:1,method:'results.get',params:locator},{client,allowed:id=>id===locator.projectId,authorize:()=>{},env:{}});
        const executor=events.find(event=>event.type==='agent.completed')?.result;
        console.log(JSON.stringify({result,checks,transport,executorStatus:executor?.status,view:await client.call('runs.get',locator)}));
      `;
      const retrieved = JSON.parse(
        await command(process.execPath, [
          "--input-type=module",
          "-e",
          reader,
          registryRoot,
          project.id,
          handoff.runId,
          join(path, ".veyra"),
        ]),
      );
      const result = retrieved.result as ProjectExecutionResult;
      options.progress?.("result_collected");
      assert.equal(
        result.status,
        expectedFailure ? "failed" : "completed",
        JSON.stringify({ status: result.status, summary: result.summary, risks: result.risks }),
      );
      assert.equal(retrieved.view.status, expectedFailure ? "failed" : "completed");
      assert.equal(result.session?.projectId, project.id);
      assert.equal(result.session?.runId, handoff.runId);
      assert.ok(result.session?.id);
      assert.deepEqual(result.changedFiles, inspecting ? [] : ["src/message.js"]);
      assert.deepEqual(
        result.verification?.map((check) => [check.id, check.status]),
        [
          ["test", expectedFailure ? "failed" : "passed"],
          ["build", "passed"],
          ["diff", "passed"],
        ],
      );
      assert.equal(retrieved.transport.verificationEvidence.length, 3);
      assert.deepEqual(retrieved.transport.result, result);
      for (const check of retrieved.checks) {
        const failed = expectedFailure && check.id === "test";
        assert.equal(check.event?.type, "verification.completed");
        assert.equal(check.event.success, !failed);
        assert.ok(check.event.results.length > 0);
        assert.ok(
          check.event.results.every(
            (result: { exitCode: number }) => result.exitCode === (failed ? 1 : 0),
          ),
        );
        assert.ok(
          retrieved.transport.verificationEvidence.some(
            (event: { eventId: string }) => event.eventId === check.event.eventId,
          ),
        );
      }
      const patch = retrieved.checks.find((check: { id: string }) => check.id === "diff").event
        .results[0].stdout;
      if (inspecting) assert.equal(patch, "");
      else assert.match(patch, /diff --git a\/src\/message\.js b\/src\/message\.js/);
      for (const file of [...protectedPaths, "src/message.js", "build/message.js"]) {
        const stat = await lstat(join(path, file));
        assert.ok(
          stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1,
          `Unsafe fixture file: ${file}`,
        );
      }
      for (const [file, before] of protectedFiles)
        assert.deepEqual(
          await readFile(join(path, file)),
          before,
          `Protected file changed: ${file}`,
        );
      assert.deepEqual(
        (await command("git", ["diff", "--name-only"])).trim().split("\n").filter(Boolean),
        inspecting ? [] : ["src/message.js"],
      );
      assert.equal(await command("git", ["ls-files", "--others", "--exclude-standard"]), "");
      assert.equal(
        await readFile(join(path, "build/message.js"), "utf8"),
        await readFile(join(path, "src/message.js"), "utf8"),
      );
      await api.call("stop", undefined);
      assert.equal((await exited)[0], 0);
      stopped = true;
      options.progress?.("daemon_stopped");
      return {
        status: "passed",
        mode: options.mode ?? "repair",
        executionOutcome: result.status,
        executorStatus: retrieved.executorStatus,
        verificationEvidenceCount: retrieved.transport.verificationEvidence.length,
        projectId: project.id,
        runId: handoff.runId,
        sessionId: result.session.id,
        processes: { daemon: 1, resultReader: 1 },
        apiKeyPresent: false,
        verification: result.verification,
        changedFiles: result.changedFiles,
        gitDiffBytes: Buffer.byteLength(patch),
        buildArtifact: "build/message.js",
        protectedFilesUnchanged: true,
      };
    } finally {
      if (!stopped && child.exitCode === null && child.signalCode === null) {
        await api.call("stop", undefined).catch(() => {});
        const completed = await Promise.race([
          exited.then(() => true),
          delay(5000).then(() => false),
        ]);
        if (!completed) child.kill("SIGKILL");
      }
      await exited;
    }
  });
  return { ...report, disposableWorkspaceRemoved: true, daemonStopped: true };
}
