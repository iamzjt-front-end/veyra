import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";

const exec = promisify(execFile);
const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));

it("runs a foreground daemon and controls it from independent CLI processes", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const registryRoot = join(path, "registry");
    const env = { ...process.env };
    delete env.OPENAI_API_KEY;
    const run = async (...args: string[]) =>
      JSON.parse(
        (
          await exec(process.execPath, [entry, ...args, "--registry", registryRoot, "--json"], {
            cwd: path,
            env,
            timeout: 15000,
          })
        ).stdout,
      );
    const project = await run("project", "add", path);
    const child = spawn(
      process.execPath,
      [entry, "daemon", "start", "--registry", registryRoot, "--json"],
      { cwd: path, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    const exited = once(child, "exit");
    try {
      let source = "";
      while (!source.includes("\n")) {
        const [chunk] = await Promise.race([
          once(child.stdout, "data", { signal: AbortSignal.timeout(10000) }),
          exited.then(() => {
            throw new Error("Daemon exited before readiness");
          }),
        ]);
        source += String(chunk);
      }
      expect(JSON.parse(source).type).toBe("daemon.started");
      expect((await run("daemon", "status")).status).toBe("running");
      expect((await run("daemon", "projects")).projects).toEqual([project]);
      expect(await run("daemon", "stop")).toEqual({ type: "daemon.stopped" });
      expect((await exited)[0]).toBe(0);
      await expect(run("daemon", "status")).rejects.toMatchObject({ code: 1 });
      expect(await run("daemon", "stop")).toEqual({ type: "daemon.stopped" });
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exited;
    }
  });
}, 30000);
