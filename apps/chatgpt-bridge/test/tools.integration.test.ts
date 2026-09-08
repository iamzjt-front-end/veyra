import { randomBytes, randomUUID } from "node:crypto";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { DaemonClient, startDaemon, type ExecutionSetup } from "@veyraoss/daemon";
import { initializeProject, saveProjectBindings } from "@veyraoss/project";
import type { ProjectDescriptor, ProjectId } from "@veyraoss/protocol";
import { parseConfig } from "@veyraoss/config";
import { expect, it, vi } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { startBridge } from "../src/server.js";
import { connect } from "./oauth-client.js";

async function withTools(
  run: (fixture: {
    project: ProjectDescriptor;
    missing: ProjectId;
    client: Client;
    stopDaemon(): Promise<void>;
  }) => Promise<void>,
  execution?: ExecutionSetup,
) {
  await withFixtureWorkspace(async ({ path }) => {
    const project = await initializeProject(path);
    const missing = randomUUID() as ProjectId;
    const registryRoot = join(path, "registry");
    const daemon = await startDaemon({
      registryRoot,
      resolveExecution: execution ? () => execution : undefined,
      env: {},
    });
    try {
      await new DaemonClient({ registryRoot }).call("projects.register", { path });
      const code = randomBytes(32).toString("base64url");
      const bridge = await startBridge({
        registryRoot,
        projectIds: [project.id, missing],
        port: 0,
        pairingCode: code,
      });
      try {
        const { client } = await connect(bridge.localUrl, code);
        try {
          await run({ project, missing, client, stopDaemon: () => daemon.stop() });
        } finally {
          await client.close();
        }
      } finally {
        await bridge.stop();
      }
    } finally {
      await daemon.stop();
    }
  });
}
const call = async (client: Client, name: string, args = {}) =>
  (await client.callTool({ name, arguments: args })).structuredContent;
function handoff(projectId: ProjectId) {
  const value = fixtureProjectState(projectId).handoff;
  if (!value) throw new Error("Missing handoff");
  return { ...value, runId: randomUUID() };
}

it("shows missing Project, native binding/client and daemon readiness without exposing other Projects", async () => {
  await withTools(async ({ project, missing, client, stopDaemon }) => {
    expect(await call(client, "veyra_projects")).toMatchObject({
      ok: true,
      data: { projects: [{ id: project.id }, { id: missing, status: "missing" }] },
    });
    expect(await call(client, "veyra_project", { projectId: missing })).toMatchObject({
      ok: false,
      error: { code: "project_not_found" },
    });
    expect(await call(client, "veyra_project", { projectId: project.id })).toMatchObject({
      ok: true,
      data: { executor: null, readiness: { ready: false } },
    });
    await saveProjectBindings(
      project,
      {
        executor: {
          provider: "codex",
          mode: "native",
          executable: join(project.root, "not-installed-codex"),
        },
      },
      0,
    );
    expect(await call(client, "veyra_project", { projectId: project.id })).toMatchObject({
      ok: true,
      data: { readiness: { ready: false } },
    });
    await stopDaemon();
    expect(await call(client, "veyra_projects")).toMatchObject({
      ok: false,
      error: { code: "daemon_unavailable" },
    });
  });
}, 20000);

it("rejects malformed, cross-Project and command-injected handoffs before execution", async () => {
  await withTools(async ({ project, client }) => {
    const requested = handoff(project.id);
    const argumentsFor = (value: unknown) => ({ projectId: project.id, handoff: value });
    for (const value of [
      { ...requested, command: "whoami" },
      { ...requested, requestedVerification: [{ id: "injected", kind: "shell", run: ["whoami"] }] },
    ])
      expect(
        (await client.callTool({ name: "veyra_dispatch", arguments: argumentsFor(value) })).isError,
      ).toBe(true);
    expect(
      await call(client, "veyra_dispatch", argumentsFor({ ...requested, projectId: randomUUID() })),
    ).toMatchObject({ ok: false, error: { code: "invalid_handoff" } });
    expect(
      await call(
        client,
        "veyra_dispatch",
        argumentsFor({ ...requested, references: [{ kind: "file", path: "../unrelated" }] }),
      ),
    ).toMatchObject({ ok: false, error: { code: "invalid_handoff" } });
    expect(await call(client, "veyra_dispatch", argumentsFor(requested))).toMatchObject({
      ok: false,
      error: { code: "execution_unavailable" },
    });
  });
});

it.each(["failed", "paused", "cancelled"] as const)(
  "preserves actual %s execution and local human authority through MCP",
  async (status) => {
    let started = () => {};
    const ready = new Promise<void>((resolve) => {
      started = resolve;
    });
    const execute = vi.fn<ExecutionSetup["agents"][string]["run"]>(async (_input, options) => {
      started();
      if (status === "cancelled") await delay(30000, undefined, { signal: options?.signal });
      return { status: "success" as const, summary: "Executor claims success" };
    });
    const execution: ExecutionSetup = {
      config: parseConfig({ version: 1, agents: {}, workflow: { use: "fixture" } }),
      workflow: {
        version: 1,
        name: "fixture",
        start: "execute",
        ...(status === "paused" ? { policy: { approval: { before: ["execute"] } } } : {}),
        steps: {
          execute: { type: "agent", agent: "executor", next: "verify" },
          verify: { type: "command", run: ["node -e 'process.exit(1)'"] },
        },
      },
      agents: { executor: { id: "fake", provider: "fake", run: execute } },
    };
    await withTools(async ({ project, client }) => {
      const requested = {
        ...handoff(project.id),
        requestedVerification: [{ id: "verify", kind: "test" }],
      };
      const locator = { projectId: project.id, runId: requested.runId };
      expect(
        await call(client, "veyra_dispatch", { projectId: project.id, handoff: requested }),
      ).toMatchObject({ ok: true });
      if (status === "cancelled") {
        await ready;
        expect(await call(client, "veyra_run", { ...locator, waitMs: 0 })).toMatchObject({
          ok: true,
          data: { run: { status: "running" }, result: null },
        });
        expect(
          await call(client, "veyra_cancel", { ...locator, projectId: randomUUID() }),
        ).toMatchObject({ ok: false, error: { code: "project_forbidden" } });
        expect(await call(client, "veyra_cancel", locator)).toMatchObject({ ok: true });
      }
      const result = await call(client, "veyra_run", { ...locator, waitMs: 10000 });
      expect(result).toMatchObject({ ok: true, data: { run: { status } } });
      if (status === "paused") {
        expect(execute).not.toHaveBeenCalled();
        expect(result).toMatchObject({
          data: { result: null, nextAction: expect.stringContaining("human approval") },
        });
        expect(
          (await client.listTools()).tools.some((tool) => /approve|resolve/.test(tool.name)),
        ).toBe(false);
      } else {
        expect(result).toMatchObject({
          data: {
            result: {
              status,
              verification: [{ status: status === "failed" ? "failed" : "not_run" }],
            },
          },
        });
        if (status === "failed")
          expect(result).toMatchObject({
            data: { verificationEvidence: [{ success: false, results: [{ exitCode: 1 }] }] },
          });
      }
    }, execution);
  },
  20000,
);
