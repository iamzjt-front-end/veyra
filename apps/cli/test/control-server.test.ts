import { request as httpRequest } from "node:http";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { DaemonClient, startDaemon } from "@veyraoss/daemon";
import { initializeProject } from "@veyraoss/project";
import { parseConfig } from "@veyraoss/config";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { startControlServer } from "../src/control-server.js";

async function fixture(
  run: (ctx: {
    server: Awaited<ReturnType<typeof startControlServer>>;
    client: DaemonClient;
    projectId: import("@veyraoss/protocol").ProjectId;
    secondId: import("@veyraoss/protocol").ProjectId;
    path: string;
    revoke: () => void;
  }) => Promise<void>,
) {
  await withFixtureWorkspace(async ({ path }) => {
    const registryRoot = join(path, "registry");
    let revoked = false;
    const daemon = await startDaemon({
      registryRoot,
      resolveExecution: () => ({
        config: parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } }),
        workflow: {
          version: 1,
          name: "fixture",
          start: "verify",
          steps: { verify: { type: "command", run: [`${process.execPath} -e "process.exit(0)"`] } },
        },
        agents: {},
      }),
    });
    const client = new DaemonClient({ registryRoot });
    await initializeProject(path);
    const first = await client.call("projects.register", { path });
    await mkdir(join(path, "second"));
    await initializeProject(join(path, "second"));
    const second = await client.call("projects.register", { path: join(path, "second") });
    const assets = join(path, "assets");
    await mkdir(assets);
    await writeFile(join(assets, "index.html"), "<!doctype html><title>Veyra</title>");
    const server = await startControlServer({
      assets,
      registryRoot,
      client: async () => client,
      authorize: async () => {
        if (revoked) throw new Error("Revoked");
      },
      inspect: async () => ({ ready: true, message: "Test readiness", checks: [] }),
    });
    try {
      await run({
        server,
        client,
        projectId: first.project.id,
        secondId: second.project.id,
        path,
        revoke: () => {
          revoked = true;
        },
      });
    } finally {
      await server.stop();
      await daemon.stop();
    }
  });
}
async function session(server: Awaited<ReturnType<typeof startControlServer>>, url: string) {
  const exchange = () =>
    fetch(`${server.origin}/session`, {
      method: "POST",
      headers: { Origin: server.origin, "Content-Type": "application/json" },
      body: JSON.stringify({ token: new URL(url).hash.slice(11) }),
    });
  const response = await exchange();
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";")[0];
  assert.ok(cookie);
  const data = (await response.json()) as { csrf: string };
  return {
    cookie,
    csrf: data.csrf,
    exchange,
    tool: (method: string, params?: unknown, headers: Record<string, string> = {}) =>
      fetch(`${server.origin}/api/tool`, {
        method: "POST",
        headers: {
          Origin: server.origin,
          "Content-Type": "application/json",
          Cookie: cookie,
          "X-Veyra-CSRF": data.csrf,
          ...headers,
        },
        body: JSON.stringify({ version: 1, method, ...(params ? { params } : {}) }),
      }),
  };
}
describe("local Control Center authorization", () => {
  it("persists UI language through an authorized session without granting Project actions", async () =>
    fixture(async ({ server, projectId, secondId, revoke }) => {
      const access = await session(server, await server.issue([projectId]));
      const get = () =>
        fetch(`${server.origin}/api/preferences`, { headers: { Cookie: access.cookie } });
      const set = (body: unknown, overrides: Record<string, string> = {}) =>
        fetch(`${server.origin}/api/preferences`, {
          method: "POST",
          headers: {
            Origin: server.origin,
            Cookie: access.cookie,
            "X-Veyra-CSRF": access.csrf,
            "Content-Type": "application/json",
            ...overrides,
          },
          body: JSON.stringify(body),
        });
      expect((await fetch(`${server.origin}/api/preferences`)).status).toBe(403);
      expect(await (await get()).json()).toEqual({ locale: "zh-CN" });
      const forgedHeaders: Record<string, string>[] = [
        { Origin: "https://evil.example" },
        { "X-Veyra-CSRF": "wrong" },
        { Cookie: "" },
      ];
      for (const headers of forgedHeaders)
        expect((await set({ locale: "en" }, headers)).status).toBe(403);
      for (const body of [{ locale: "fr" }, { locale: "en", projectId: secondId }, ["en"], null])
        expect((await set(body)).status).toBe(403);
      expect(await (await get()).json()).toEqual({ locale: "zh-CN" });
      expect(await (await set({ locale: "en" })).json()).toEqual({ locale: "en" });
      const reopened = await session(server, await server.issue([projectId]));
      expect(
        await (
          await fetch(`${server.origin}/api/preferences`, { headers: { Cookie: reopened.cookie } })
        ).json(),
      ).toEqual({ locale: "en" });
      expect((await access.tool("projects.get", { projectId: secondId })).status).toBe(403);
      expect((await access.tool("runs.dispatch", { projectId })).status).toBe(403);
      revoke();
      expect((await get()).status).toBe(403);
      expect((await set({ locale: "zh-CN" })).status).toBe(403);
    }));
  it("uses one-use invitations, exact origin/host, CSRF, project scope and revocation", async () =>
    fixture(async ({ server, projectId, secondId, revoke }) => {
      const access = await session(server, await server.issue([projectId]));
      expect((await access.exchange()).status).toBe(403);
      expect((await fetch(`${server.origin}/api/session`)).status).toBe(403);
      expect(
        (await fetch(`${server.origin}/api/session`, { headers: { Cookie: access.cookie } }))
          .status,
      ).toBe(200);
      expect(await (await access.tool("projects.list")).json()).toMatchObject({
        ok: true,
        data: [{ project: { id: projectId } }],
      });
      expect((await access.tool("projects.get", { projectId: secondId })).status).toBe(403);
      expect(
        (await access.tool("projects.list", undefined, { Origin: "https://evil.example" })).status,
      ).toBe(403);
      const forged = await new Promise<number | undefined>((resolve, reject) => {
        const req = httpRequest(
          server.origin,
          { headers: { Host: "evil.example" } },
          (response) => {
            response.resume();
            resolve(response.statusCode);
          },
        );
        req.on("error", reject);
        req.end();
      });
      expect(forged).toBe(403);
      expect(
        (await access.tool("projects.list", undefined, { "X-Veyra-CSRF": "wrong" })).status,
      ).toBe(403);
      for (const method of [
        "stop",
        "projects.register",
        "fs.read",
        "runs.dispatch",
        "approvals.decide",
      ])
        expect((await access.tool(method, { projectId })).status).toBe(403);
      revoke();
      expect((await access.tool("projects.get", { projectId })).status).toBe(403);
    }));
  it("consumes a launch invitation exactly once under concurrent exchange", async () =>
    fixture(async ({ server }) => {
      const token = new URL(await server.issue()).hash.slice(11);
      const exchange = () =>
        fetch(`${server.origin}/session`, {
          method: "POST",
          headers: { Origin: server.origin, "Content-Type": "application/json" },
          body: JSON.stringify({ token }),
        });
      const responses = await Promise.all([exchange(), exchange(), exchange()]);
      expect(responses.map((response) => response.status).sort()).toEqual([200, 403, 403]);
    }));
  it(
    "returns real bounded native run history and scoped handoff/result evidence",
    async () =>
      fixture(async ({ server, client, projectId, secondId }) => {
        const fixture = fixtureProjectState(projectId);
        assert.ok(fixture.handoff);
        const ids: string[] = [];
        for (let i = 0; i < 3; i++) {
          const handoff = { ...fixture.handoff, id: randomUUID(), runId: randomUUID() };
          ids.push(handoff.runId);
          await client.call("runs.dispatch", { projectId, handoff });
          await client.call("runs.wait", { projectId, runId: handoff.runId, waitMs: 10000 });
        }
        const list = await client.call("runs.list", { projectId, limit: 2 });
        expect(list.runs.map((run) => run.runId)).toEqual(ids.slice(1).reverse());
        expect(list.hasMore).toBe(true);
        expect(await client.call("runs.list", { projectId: secondId, limit: 20 })).toEqual({
          runs: [],
          hasMore: false,
        });
        const access = await session(server, await server.issue([projectId]));
        const result = await (
          await access.tool("results.get", { projectId, runId: ids[0] })
        ).json();
        expect(result).toMatchObject({
          ok: true,
          data: { result: { projectId, runId: ids[0], status: "completed" } },
        });
        expect((await access.tool("runs.get", { projectId: secondId, runId: ids[0] })).status).toBe(
          403,
        );
      }),
    30000,
  );
  it("batches meaningful events, excludes token output, and invalidates a signed-out session", async () =>
    fixture(async ({ server, projectId, path }) => {
      const access = await session(server, await server.issue([projectId]));
      const abort = new AbortController();
      const response = await fetch(`${server.origin}/events`, {
        headers: { Cookie: access.cookie },
        signal: abort.signal,
      });
      const reader = response.body?.getReader();
      assert.ok(reader);
      expect(new TextDecoder().decode((await reader.read()).value)).toContain("ready");
      const dir = join(path, ".veyra");
      for (let i = 0; i < 30; i++) await writeFile(join(dir, "events.jsonl"), `token ${i}`);
      for (let i = 0; i < 20; i++)
        await writeFile(join(dir, "state.json"), JSON.stringify({ fixture: i }));
      expect(new TextDecoder().decode((await reader.read()).value)).toBe(
        "event: changed\ndata: {}\n\n",
      );
      expect(
        (
          await fetch(`${server.origin}/api/logout`, {
            method: "POST",
            headers: { Origin: server.origin, Cookie: access.cookie, "X-Veyra-CSRF": access.csrf },
          })
        ).status,
      ).toBe(200);
      expect((await reader.read()).done).toBe(true);
      abort.abort();
      expect((await access.tool("projects.list")).status).toBe(403);
    }));
  it("closes its listener on an idle deadline without polling", async () =>
    withFixtureWorkspace(async ({ path }) => {
      const server = await startControlServer({
        assets: path,
        registryRoot: path,
        client: async () => {
          throw new Error("Idle must not contact the coordinator");
        },
        authorize: async () => {},
        idleMs: 25,
      });
      await server.closed;
      await delay(1);
      await expect(fetch(server.origin)).rejects.toThrow();
    }));
});

it(
  "ve open starts the packaged GUI once, reuses it, and leaves native credentials untouched",
  async () =>
    withFixtureWorkspace(async ({ path }) => {
      const { setupNative } = await import("../src/native-installation.js");
      const { runCli } = await import("../src/application.js");
      const { stopDaemon } = await import("@veyraoss/daemon");
      const { readControlMetadata } = await import("../src/control-launcher.js");
      const registryRoot = join(path, "registry");
      await setupNative({
        registryRoot,
        manifestDirs: [join(path, "chrome")],
        env: { PATH: "" },
        runProcess: async () => ({
          exitCode: 0,
          signal: null,
          stdout: "codex-cli 1.2.3\nLogged in using ChatGPT",
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
          durationMs: 1,
        }),
      });
      let pid: number | undefined;
      try {
        const output: string[] = [];
        const error: string[] = [];
        const open = () =>
          runCli(["open", "--registry", registryRoot, "--json"], {
            cwd: path,
            stdout: (text) => output.push(text),
            stderr: (text) => error.push(text),
            env: { PATH: "" },
          });
        expect(await open(), error.join("")).toBe(0);
        const first = JSON.parse(output.join("")) as { pid: number; url: string };
        pid = first.pid;
        expect(first.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/#bootstrap=[a-f0-9]{64}$/);
        const origin = new URL(first.url).origin;
        const response = await fetch(origin);
        expect(response.status).toBe(200);
        expect(response.headers.get("content-security-policy")).toContain("frame-ancestors 'none'");
        const html = await response.text();
        const asset = /src="(\/assets\/[^"]+\.js)"/.exec(html)?.[1];
        assert.ok(asset);
        expect((await fetch(origin + asset)).status).toBe(200);
        output.length = 0;
        expect(await open()).toBe(0);
        const second = JSON.parse(output.join("")) as { pid: number; url: string };
        expect(second.pid).toBe(pid);
        expect(second.url).not.toBe(first.url);
      } finally {
        if (pid) process.kill(pid, "SIGTERM");
        for (let i = 0; i < 100; i++) {
          if (!(await readControlMetadata(join(registryRoot, "browser", "control.json")))) break;
          await delay(30);
        }
        await stopDaemon({ registryRoot });
      }
    }),
  30000,
);
