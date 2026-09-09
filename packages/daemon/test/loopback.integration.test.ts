import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { initializeProject, ProjectRegistry } from "@veyraoss/project";
import type { ProjectId } from "@veyraoss/protocol";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { startDaemon } from "../src/index.js";

const exec = promisify(execFile);
const origin = `chrome-extension://${"a".repeat(32)}`;
const configUrl = new URL("../../config/dist/index.js", import.meta.url).href;
const { parseConfig } = (await import(configUrl)) as typeof import("../../config/src/index.js");

async function pair(url: string, code: string) {
  const response = await fetch(`${url}/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: origin },
    body: JSON.stringify({ version: 1, code }),
  });
  expect(response.status).toBe(200);
  return (await response.json()).data;
}

describe("opt-in authenticated daemon loopback", () => {
  it("cancels an active execution over authenticated HTTP and returns persisted cancellation", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const registryRoot = join(path, "registry");
      await new ProjectRegistry({ root: registryRoot }).register(path);
      let started!: () => void;
      const running = new Promise<void>((done) => {
        started = done;
      });
      let aborted = false;
      const daemon = await startDaemon({
        registryRoot,
        http: {
          port: 0,
          origin,
          projectIds: [project.id],
          inspectProject: async () => ({ ready: true, message: "fixture", checks: [] }),
        },
        resolveExecution: () => ({
          config: parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } }),
          workflow: {
            version: 1,
            name: "fixture",
            start: "execute",
            steps: { execute: { type: "agent", agent: "executor" } },
          },
          agents: {
            executor: {
              id: "fixture",
              provider: "fake",
              async run(_input, options) {
                started();
                try {
                  await delay(30000, undefined, { signal: options?.signal });
                } finally {
                  aborted = options?.signal?.aborted === true;
                }
                return { status: "success", summary: "Must be cancelled first" };
              },
            },
          },
        }),
      });
      if (!daemon.http) throw new Error("Missing transport");
      try {
        const invitation = JSON.parse(await readFile(daemon.http.pairingFile, "utf8"));
        const grant = await pair(daemon.http.url, invitation.code);
        const rpc = async (method: string, params: unknown) =>
          (
            await (
              await fetch(`${daemon.http?.url}/rpc`, {
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                  Origin: origin,
                  Authorization: `Bearer ${grant.token}`,
                },
                body: JSON.stringify({ version: 1, method, params }),
              })
            ).json()
          ).data;
        const handoff = { ...fixtureProjectState(project.id).handoff, runId: randomUUID() };
        const locator = { projectId: project.id, runId: handoff.runId };
        await rpc("runs.dispatch", { projectId: project.id, handoff });
        await running;
        expect(await rpc("runs.get", locator)).toMatchObject({
          status: "running",
          execution: { agentStatus: "running" },
        });
        await rpc("runs.cancel", locator);
        expect(await rpc("runs.wait", { ...locator, waitMs: 10000 })).toMatchObject({
          status: "cancelled",
        });
        expect(aborted).toBe(true);
        expect(await rpc("results.get", locator)).toMatchObject({
          result: { status: "cancelled" },
        });
      } finally {
        await daemon.stop();
      }
    });
  });
  it("exchanges a single-use invitation, enforces expiry and revokes in-flight dispatch authority", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const registryRoot = join(path, "registry");
      await new ProjectRegistry({ root: registryRoot }).register(path);
      let inspected!: () => void;
      let release!: () => void;
      const waiting = new Promise<void>((done) => {
        inspected = done;
      });
      const resume = new Promise<void>((done) => {
        release = done;
      });
      const daemon = await startDaemon({
        registryRoot,
        http: {
          port: 0,
          origin,
          projectIds: [project.id],
          inspectProject: async () => {
            inspected();
            await resume;
            return { ready: true, message: "fixture", checks: [] };
          },
        },
      });
      if (!daemon.http) throw new Error("Missing transport");
      const { url, pairingFile } = daemon.http;
      const invitation = JSON.parse(await readFile(pairingFile, "utf8"));
      const post = (path: string, body: unknown, token?: string, from = origin) =>
        fetch(`${url}${path}`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: from,
            ...(token ? { Authorization: `Bearer ${token}` } : {}),
          },
          body: JSON.stringify(body),
        });
      try {
        expect(invitation).not.toHaveProperty("token");
        expect(invitation.projectIds).toEqual([project.id]);
        expect(invitation.expiresAt - Date.now()).toBeLessThanOrEqual(600000);
        expect(
          (
            await post(
              "/pair",
              { version: 1, code: invitation.code },
              undefined,
              "https://evil.test",
            )
          ).status,
        ).toBe(403);
        expect(
          (await post("/rpc", { version: 1, method: "projects.list" }, invitation.code)).status,
        ).toBe(401);
        const expired = vi.spyOn(Date, "now").mockReturnValue(invitation.expiresAt + 1);
        try {
          expect((await post("/pair", { version: 1, code: invitation.code })).status).toBe(400);
        } finally {
          expired.mockRestore();
        }
        const responses = await Promise.all([
          post("/pair", { version: 1, code: invitation.code }),
          post("/pair", { version: 1, code: invitation.code }),
        ]);
        expect(responses.map((item) => item.status).sort()).toEqual([200, 400]);
        const accepted = responses.find((item) => item.status === 200);
        if (!accepted) throw new Error("No accepted pairing response");
        const grant = (await accepted.json()).data;
        expect(grant.token).not.toBe(invitation.code);
        await expect(stat(pairingFile)).rejects.toMatchObject({ code: "ENOENT" });
        const late = vi.spyOn(Date, "now").mockReturnValue(grant.expiresAt + 1);
        try {
          expect(
            (await post("/rpc", { version: 1, method: "projects.list" }, grant.token)).status,
          ).toBe(401);
        } finally {
          late.mockRestore();
        }
        const dispatch = post(
          "/rpc",
          {
            version: 1,
            method: "runs.dispatch",
            params: {
              projectId: project.id,
              handoff: { ...fixtureProjectState(project.id).handoff, runId: randomUUID() },
            },
          },
          grant.token,
        );
        await waiting;
        expect((await post("/grant/revoke", { version: 1 }, "wrong")).status).toBe(401);
        expect((await post("/grant/revoke", { version: 1 }, grant.token)).status).toBe(200);
        release();
        expect((await (await dispatch).json()).error.code).toBe("grant_unavailable");
        expect(
          (await post("/rpc", { version: 1, method: "projects.list" }, grant.token)).status,
        ).toBe(401);
        expect((await post("/pair", { version: 1, code: invitation.code })).status).toBe(400);
      } finally {
        release();
        await daemon.stop();
      }
    });
  });
  it("uses an explicit local grant, rejects web/Host/Project/request boundaries and cleans the pairing file", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const project = await initializeProject(path);
      const registryRoot = join(path, "registry");
      await new ProjectRegistry({ root: registryRoot }).register(path);
      const daemon = await startDaemon({
        registryRoot,
        http: { port: 0, origin, projectIds: [project.id] },
      });
      if (!daemon.http) throw new Error("Missing HTTP transport");
      const { url, pairingFile } = daemon.http;
      const invitation = JSON.parse(await readFile(pairingFile, "utf8"));
      const fileMode = (await stat(pairingFile)).mode & 0o777;
      const pairing = await pair(url, invitation.code);
      const rpc = (body: unknown, headers: Record<string, string> = {}) =>
        fetch(`${url}/rpc`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Origin: origin,
            Authorization: `Bearer ${pairing.token}`,
            ...headers,
          },
          body: JSON.stringify(body),
        });
      try {
        expect(url).toMatch(/^http:\/\/127\.0\.0\.1:/);
        expect(fileMode).toBe(0o600);
        expect(await (await fetch(`${url}/health`)).json()).toEqual({
          service: "veyra-daemon",
          version: 1,
        });
        expect(
          (await rpc({ version: 1, method: "projects.list" }, { Authorization: "Bearer wrong" }))
            .status,
        ).toBe(401);
        expect(
          (await rpc({ version: 1, method: "projects.list" }, { Origin: "https://chatgpt.com" }))
            .status,
        ).toBe(403);
        const spoofedHost = await new Promise<number | undefined>((resolve, reject) => {
          const request = httpRequest(
            `${url}/health`,
            { headers: { Host: "evil.test" } },
            (response) => {
              response.resume();
              resolve(response.statusCode);
            },
          );
          request.on("error", reject);
          request.end();
        });
        expect(spoofedHost).toBe(403);
        const list = await rpc({ version: 1, method: "projects.list" });
        expect(list.headers.get("Access-Control-Allow-Origin")).toBe(origin);
        expect(await list.json()).toMatchObject({
          ok: true,
          data: [{ project: { id: project.id } }],
        });
        for (const body of [
          { version: 1, method: "stop" },
          { version: 1, method: "projects.register", params: { path } },
          { version: 1, method: "projects.get", params: { projectId: randomUUID() } },
          {
            version: 1,
            method: "projects.get",
            params: { projectId: project.id, shell: "touch injected" },
          },
          {
            version: 1,
            method: "runs.dispatch",
            params: {
              projectId: project.id,
              handoff: { ...fixtureProjectState(project.id).handoff, runId: randomUUID() },
            },
          },
        ])
          expect((await rpc(body)).status).toBe(400);
        const view = await (
          await rpc({ version: 1, method: "projects.get", params: { projectId: project.id } })
        ).json();
        expect(view.data.readiness.ready).toBe(false);
        expect(view.data.project.root).toBe(project.root);
        expect(JSON.stringify(view)).not.toContain(pairing.token);
      } finally {
        await daemon.stop();
      }
      await expect(stat(pairingFile)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fetch(`${url}/health`)).rejects.toThrow();
    });
  });
  it.each([0, 1])(
    "returns actual verifier exit %i and scoped Git evidence without a model provider or API key",
    async (exitCode) => {
      await withFixtureWorkspace(async ({ path }) => {
        await exec("git", ["init", "--quiet"], { cwd: path });
        await writeFile(join(path, "answer.txt"), "before\n");
        await exec("git", ["add", "answer.txt"], { cwd: path });
        await exec(
          "git",
          [
            "-c",
            "user.name=Fixture",
            "-c",
            "user.email=fixture@example.invalid",
            "commit",
            "--quiet",
            "-m",
            "fixture",
          ],
          { cwd: path },
        );
        const project = await initializeProject(path);
        const registryRoot = join(path, "registry");
        await new ProjectRegistry({ root: registryRoot }).register(path);
        const daemon = await startDaemon({
          registryRoot,
          env: { FIXTURE_SECRET: "private-fixture-value" },
          http: {
            port: 0,
            origin,
            projectIds: [project.id],
            inspectProject: async () => ({
              ready: true,
              message: "Fixture executor ready",
              checks: [{ id: "verify" }],
            }),
          },
          resolveExecution: () => ({
            config: parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } }),
            workflow: {
              version: 1,
              name: "fixture",
              start: "execute",
              steps: {
                execute: { type: "agent", agent: "executor", next: "verify" },
                verify: {
                  type: "command",
                  run: [
                    `${process.execPath} -e 'console.log("verifier-evidence");process.exit(${exitCode})'`,
                  ],
                },
              },
            },
            agents: {
              executor: {
                id: "fixture",
                provider: "fake",
                async run() {
                  await writeFile(join(path, "answer.txt"), "after private-fixture-value\n");
                  return {
                    status: "success",
                    summary: "Executor claims success",
                    data: { changedFiles: ["answer.txt"] },
                  };
                },
              },
            },
          }),
        });
        if (!daemon.http) throw new Error("Missing HTTP transport");
        const invitation = JSON.parse(await readFile(daemon.http.pairingFile, "utf8"));
        const pairing = await pair(daemon.http.url, invitation.code);
        const rpc = async (method: string, params?: unknown) =>
          (
            await fetch(`${daemon.http?.url}/rpc`, {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Origin: origin,
                Authorization: `Bearer ${pairing.token}`,
              },
              body: JSON.stringify({ version: 1, method, params }),
            })
          ).json();
        try {
          const handoff = {
            ...fixtureProjectState(project.id).handoff,
            runId: randomUUID(),
            requestedVerification: [{ id: "verify", kind: "test" }],
          };
          const locator = { projectId: project.id, runId: handoff.runId };
          expect((await rpc("runs.dispatch", { projectId: project.id, handoff })).ok).toBe(true);
          await rpc("runs.wait", { ...locator, waitMs: 10000 });
          const run = await rpc("runs.get", locator);
          expect(run.data.execution.agentStatus).toBe("success");
          const result = await rpc("results.get", locator);
          expect(result.data.result.status).toBe(exitCode === 0 ? "completed" : "failed");
          expect(result.data.verificationEvidence[0]).toMatchObject({
            success: exitCode === 0,
            results: [{ exitCode, stdout: "verifier-evidence\n" }],
          });
          expect(result.data.workspaceDiff).toMatchObject({
            source: "git",
            available: true,
            scope: "current_workspace_including_preexisting_changes",
          });
          expect(result.data.workspaceDiff.patch).toContain("-before");
          expect(JSON.stringify(result)).not.toContain("private-fixture-value");
          expect((await rpc("runs.dispatch", { projectId: project.id, handoff })).error.code).toBe(
            "run_exists",
          );
        } finally {
          await daemon.stop();
        }
      });
    },
  );
  it("rejects public/unscoped launch settings without leaving a live daemon", async () => {
    await withFixtureWorkspace(async ({ path }) => {
      const registryRoot = join(path, "registry");
      for (const http of [
        { port: 3181, origin: "https://chatgpt.com", projectIds: [randomUUID() as ProjectId] },
        { port: 3181, origin, projectIds: [] },
        { port: 65536, origin, projectIds: [randomUUID() as ProjectId] },
      ])
        await expect(startDaemon({ registryRoot, http })).rejects.toMatchObject({
          code: "invalid_loopback_options",
        });
      const daemon = await startDaemon({ registryRoot });
      expect(daemon.http).toBeUndefined();
      await daemon.stop();
    });
  });
});
