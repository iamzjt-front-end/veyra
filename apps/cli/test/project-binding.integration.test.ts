import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { DaemonClient } from "@veyraoss/daemon";
import { ProjectHandoffStore, saveProjectBindings, loadProjectBindings } from "@veyraoss/project";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

it("persists role/session metadata across cold CLI processes and dispatches the bound native executor without API config", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const registryRoot = join(path, "registry");
    const executable = join(path, "fixture native.cjs");
    const nativeId = randomUUID();
    await writeFile(
      executable,
      `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2);
if(args[0]==='--version'){console.log('codex-cli 0.153.4');process.exit(0);}
if(args[0]==='login'){console.log('Logged in using ChatGPT');process.exit(0);}
fs.readFileSync(0,'utf8');
if(process.env.OPENAI_API_KEY||args.includes('resume')||args.includes('--ephemeral')||!args.includes('fixture-model'))process.exit(2);
fs.writeFileSync('answer.txt','42');
console.log(JSON.stringify({type:'thread.started',thread_id:${JSON.stringify(nativeId)}}));
console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:JSON.stringify({status:'success',summary:'Wrote the answer',changedFiles:['answer.txt'],commandsRun:[]})}}));
console.log(JSON.stringify({type:'turn.completed'}));
`,
      { mode: 0o700 },
    );
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const run = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [entry, ...args, "--json"], {
            cwd: path,
            env,
            timeout: 15000,
          })
        ).stdout,
      );
    const projectCommand = (...args: string[]) =>
      run("project", ...args, "--registry", registryRoot);
    const { project } = await projectCommand("add", path);
    const priorSession = {
      version: 1 as const,
      kind: "session" as const,
      provider: "codex",
      id: randomUUID(),
      runId: randomUUID(),
      projectId: project.id,
      createdAt: project.createdAt,
    };
    await new ProjectHandoffStore({ project }).createSession(priorSession);
    const bound = await projectCommand(
      "bind",
      project.id,
      "--executor",
      "codex/native",
      "--codex-executable",
      executable,
      "--model",
      "fixture-model",
      "--session-run",
      priorSession.runId,
    );
    expect(bound.bindings.roles.executor).toEqual({
      provider: "codex",
      mode: "native",
      executable,
      model: "fixture-model",
      session: priorSession,
    });
    expect(await projectCommand("show", project.id)).toEqual(bound);
    expect(await run("doctor")).toMatchObject({
      ready: true,
      binding: {
        source: "project",
        role: "executor",
        provider: "codex",
        mode: "native",
        model: "fixture-model",
      },
      executor: { executable, ready: true },
    });
    expect(await run("status")).toMatchObject({
      status: "idle",
      project,
      bindings: bound.bindings,
    });
    await expect(
      projectCommand("show", project.id, "--executor", "codex/native"),
    ).rejects.toMatchObject({ code: 2 });
    await expect(
      projectCommand("bind", project.id, "--executor", "unknown/native"),
    ).rejects.toMatchObject({ code: 2 });
    const child = spawn(
      process.execPath,
      [entry, "daemon", "start", "--registry", registryRoot, "--json"],
      { cwd: path, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    try {
      let ready = "";
      while (!ready.includes("\n")) {
        const [chunk] = await Promise.race([
          once(child.stdout, "data", { signal: AbortSignal.timeout(10000) }),
          exited.then(() => {
            throw new Error("Daemon exited before ready");
          }),
        ]);
        ready += String(chunk);
      }
      const client = new DaemonClient({ registryRoot });
      const fixture = fixtureProjectState(project.id);
      if (!fixture.handoff) throw new Error("Missing fixture handoff");
      const handoff = { ...fixture.handoff, runId: randomUUID() };
      await client.call("runs.dispatch", { projectId: project.id, handoff });
      const locator = { projectId: project.id, runId: handoff.runId };
      expect(await client.call("runs.wait", { ...locator, waitMs: 10000 })).toMatchObject({
        status: "completed",
      });
      expect(await readFile(join(path, "answer.txt"), "utf8")).toBe("42");
      expect(await client.call("results.get", locator)).toMatchObject({
        status: "completed",
        session: { id: nativeId, runId: handoff.runId },
      });
      expect(await run("status")).toMatchObject({
        status: "completed",
        project,
        bindings: bound.bindings,
      });
      await run("daemon", "stop", "--registry", registryRoot);
      expect((await exited)[0]).toBe(0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
    expect(await projectCommand("show", project.id)).toEqual(bound);
    // Provider-neutral stored data must never silently select a different native vendor.
    await saveProjectBindings(
      project,
      { executor: { provider: "alternative", mode: "native" } },
      bound.bindings.revision,
    );
    await expect(run("doctor")).rejects.toMatchObject({
      code: 2,
      stdout: expect.stringContaining("unsupported_executor_binding"),
    });
    expect((await loadProjectBindings(project))?.roles.executor?.provider).toBe("alternative");
  });
}, 45000);
