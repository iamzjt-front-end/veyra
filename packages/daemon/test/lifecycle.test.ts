import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import {
  initializeProject,
  ProjectRegistry,
  ProjectStateStore,
  projectPaths,
} from "@veyraoss/project";
import {
  daemonProjects,
  daemonStatus,
  startDaemon,
  stopDaemon,
  type DaemonMetadata,
} from "../src/index.js";

const moduleUrl = new URL("../dist/index.js", import.meta.url).href;
const exec = promisify(execFile);

async function childDaemon(registryRoot: string) {
  const script = `const {startDaemon}=await import(${JSON.stringify(moduleUrl)});
    const daemon=await startDaemon({registryRoot:process.argv[1]});
    process.on('SIGTERM',()=>void daemon.stop());
    process.stdout.write(JSON.stringify(daemon.metadata)+'\\n'); await daemon.closed;`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script, registryRoot], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exited = once(child, "exit");
  let diagnostics = "";
  child.stderr.on("data", (chunk) => {
    diagnostics = `${diagnostics}${chunk}`.slice(-8192);
  });
  try {
    let source = "";
    while (!source.includes("\n")) {
      const [chunk] = await Promise.race([
        once(child.stdout, "data", { signal: AbortSignal.timeout(10000) }),
        exited.then(() => {
          throw new Error(`Daemon exited before readiness: ${diagnostics}`);
        }),
      ]);
      source += String(chunk);
    }
    return { child, exited, metadata: JSON.parse(source) as DaemonMetadata };
  } catch (error) {
    await terminate(child, exited);
    throw error;
  }
}
async function terminate(child: ChildProcess, exited: Promise<unknown>) {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await exited;
}
async function rawRequest(socketPath: string, source: string) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const socket = connect(socketPath);
    let received = "";
    let settled = false;
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error("No daemon response"));
    }, 5000);
    socket.on("error", (error) => {
      settled = true;
      reject(error);
    });
    socket.once("connect", () => socket.write(source));
    socket.on("data", (chunk) => {
      received += String(chunk);
      if (!received.includes("\n")) return;
      settled = true;
      socket.destroy();
      clearTimeout(timer);
      try {
        resolve(JSON.parse(received));
      } catch (error) {
        reject(error);
      }
    });
    socket.once("close", () => {
      clearTimeout(timer);
      if (!settled) reject(new Error("Daemon closed before sending a response"));
    });
  });
}

describe("local daemon lifecycle", () => {
  it("serves another process, stops and restarts without losing Project state", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registryRoot = join(path, "registry");
      const project = await initializeProject(path);
      await new ProjectRegistry({ root: registryRoot }).register(path);
      const { context, provenance } = fixtureProjectState(project.id);
      await new ProjectStateStore({ project }).save({ context, provenance }, 0);
      const before = await readFile(projectPaths(project).state);
      const daemon = await childDaemon(registryRoot);
      try {
        const client = await exec(
          process.execPath,
          [
            "--input-type=module",
            "-e",
            `const api=await import(${JSON.stringify(moduleUrl)}); const options={registryRoot:process.argv[1]}; console.log(JSON.stringify({health:await api.daemonStatus(options),projects:await api.daemonProjects(options)}));`,
            registryRoot,
          ],
          { timeout: 15000 },
        );
        expect(JSON.parse(client.stdout)).toMatchObject({
          health: { status: "running", metadata: { id: daemon.metadata.id } },
          projects: [{ project, status: "available" }],
        });
        expect((await stat(daemon.metadata.socketPath)).mode & 0o777).toBe(0o600);
        await stopDaemon({ registryRoot });
        await daemon.exited;
        expect(await daemonStatus({ registryRoot })).toEqual({ status: "stopped" });
        await expect(stat(daemon.metadata.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
        expect(await readdir(join(registryRoot, "daemon", ".instance-lock"))).toEqual([]);
        const restarted = await startDaemon({ registryRoot });
        try {
          expect(restarted.metadata.id).not.toBe(daemon.metadata.id);
          expect((await daemonProjects({ registryRoot }))[0]?.project).toEqual(project);
          expect(await readFile(projectPaths(project).state)).toEqual(before);
        } finally {
          await restarted.stop();
        }
      } finally {
        await terminate(daemon.child, daemon.exited);
      }
    });
  }, 30000);

  it("refuses duplicate live owners and recovers a killed owner plus stale socket", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registryRoot = join(path, "registry");
      const daemon = await childDaemon(registryRoot);
      try {
        await expect(startDaemon({ registryRoot })).rejects.toMatchObject({
          code: "daemon_running",
        });
        daemon.child.kill("SIGKILL");
        await daemon.exited;
        expect(await daemonStatus({ registryRoot })).toEqual({ status: "stopped" });
        expect((await stat(daemon.metadata.socketPath)).isSocket()).toBe(true);
        const recovered = await startDaemon({ registryRoot });
        try {
          expect((await daemonStatus({ registryRoot })).status).toBe("running");
        } finally {
          await recovered.stop();
        }
        await expect(stat(daemon.metadata.socketPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await terminate(daemon.child, daemon.exited);
      }
    });
  }, 20000);

  it("closes unfinished clients on cancellation and shields metadata/logs from observer mutation", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registryRoot = join(path, "registry");
      const controller = new AbortController();
      const daemon = await startDaemon({
        registryRoot,
        signal: controller.signal,
        env: { TEST_SECRET: "Local" },
        onLog: (entry) => {
          entry.message = "observer-secret-value";
        },
      });
      const socketPath = daemon.metadata.socketPath;
      const socket = connect(socketPath);
      const disconnected = once(socket, "close");
      socket.on("error", () => {});
      try {
        await once(socket, "connect");
        socket.write('{"version":');
        daemon.metadata.id = "caller mutation";
        expect((await daemonStatus({ registryRoot })).status).toBe("running");
        controller.abort();
        await daemon.closed;
        await disconnected;
        expect(daemon.signal.aborted).toBe(true);
        const logs = await readFile(join(registryRoot, "daemon", "daemon.jsonl"), "utf8");
        expect(logs).toContain("[REDACTED]");
        expect(logs).not.toContain("Local");
        expect(logs).not.toContain("observer-secret-value");
        expect(
          logs
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line).type),
        ).toEqual(["daemon.ready", "daemon.stopping"]);
      } finally {
        socket.destroy();
        await daemon.stop();
      }
    });
  });

  it("rejects invalid/oversized requests without echoing raw content and bounds logs", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registryRoot = join(path, "registry");
      const daemon = await startDaemon({ registryRoot });
      try {
        const source = `${JSON.stringify({ version: 1, method: "secret-user-request" })}\n`;
        for (let i = 0; i < 70; i++)
          expect(await rawRequest(daemon.metadata.socketPath, source)).toMatchObject({
            ok: false,
            error: { code: "invalid_request" },
          });
        expect(
          await rawRequest(daemon.metadata.socketPath, "x".repeat(256 * 1024 + 1)),
        ).toMatchObject({
          ok: false,
          error: { code: "invalid_request" },
        });
        expect((await daemonStatus({ registryRoot })).status).toBe("running");
      } finally {
        await daemon.stop();
      }
      const logs = await readFile(join(registryRoot, "daemon", "daemon.jsonl"), "utf8");
      expect(logs).not.toContain("secret-user-request");
      expect(logs.trim().split("\n").length).toBeLessThanOrEqual(64);
      expect(Buffer.byteLength(logs)).toBeLessThan(65536);
    });
  }, 15000);

  it.each(["invalid-metadata", "linked-directory", "public-directory"])(
    "preserves %s instead of replacing it",
    async (kind) => {
      await withFixtureWorkspace(async ({ path }) => {
        const registryRoot = join(path, "registry");
        const directory = join(registryRoot, "daemon");
        await mkdir(registryRoot, { mode: 0o700 });
        if (kind === "linked-directory") {
          await mkdir(join(path, "outside"), { mode: 0o700 });
          await symlink(join(path, "outside"), directory);
        } else {
          await mkdir(directory, { mode: 0o700 });
          if (kind === "public-directory") await chmod(directory, 0o755);
          else
            await writeFile(join(directory, "daemon.json"), '{"auth":"do-not-echo"}', {
              mode: 0o600,
            });
        }
        await expect(startDaemon({ registryRoot })).rejects.toMatchObject({
          code: "invalid_daemon_state",
        });
        expect((await daemonStatus({ registryRoot })).status).toBe("unavailable");
        if (kind === "invalid-metadata")
          expect(await readFile(join(directory, "daemon.json"), "utf8")).toBe(
            '{"auth":"do-not-echo"}',
          );
      });
    },
  );
});
