import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { request as httpRequest } from "node:http";
import { readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { initializeProject, ProjectRegistry } from "@veyraoss/project";
import type { ProjectId } from "@veyraoss/protocol";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { startDaemon } from "../src/index.js";

const exec = promisify(execFile);
const origin = `chrome-extension://${"a".repeat(32)}`;
const configUrl = new URL("../../config/dist/index.js", import.meta.url).href;
const { parseConfig } = (await import(configUrl)) as typeof import("../../config/src/index.js");

describe("opt-in authenticated daemon loopback", () => {
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
      const pairing = JSON.parse(await readFile(pairingFile, "utf8"));
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
        expect((await stat(pairingFile)).mode & 0o777).toBe(0o600);
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
        const pairing = JSON.parse(await readFile(daemon.http.pairingFile, "utf8"));
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
