import { randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { request } from "node:http";
import { expect, it } from "vitest";
import { startDaemon } from "@veyraoss/daemon";
import { initializeProject, saveProjectBindings } from "@veyraoss/project";
import type { ProjectId } from "@veyraoss/protocol";
import { parseConfig } from "@veyraoss/config";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { fixtureProjectState } from "../../../test/helpers/project-state.js";
import { startBridge } from "../src/server.js";
import { authorize, connect, token, callback } from "./oauth-client.js";

it("binds discovery and grants to the approved HTTPS origin while listening only on loopback", async () => {
  const pairingCode = randomBytes(32).toString("base64url");
  const bridge = await startBridge({
    projectIds: [randomUUID() as ProjectId],
    port: 0,
    pairingCode,
    publicUrl: "https://approved-bridge.example",
  });
  try {
    expect(new URL(bridge.localUrl).hostname).toBe("127.0.0.1");
    expect(bridge.mcpUrl).toBe("https://approved-bridge.example/mcp");
    const discovery = await fetch(`${bridge.localUrl}/.well-known/oauth-protected-resource/mcp`);
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      resource: bridge.mcpUrl,
      authorization_servers: ["https://approved-bridge.example/"],
    });
    const grant = await authorize(bridge.localUrl, pairingCode, "veyra:read", bridge.mcpUrl);
    expect(
      (await token(bridge.localUrl, { ...grant.params, resource: `${bridge.localUrl}/mcp` }))
        .status,
    ).toBe(400);
    const granted = await token(bridge.localUrl, grant.params);
    expect(granted.status).toBe(200);
    const access = (await granted.json()).access_token;
    const response = await fetch(`${bridge.localUrl}/mcp`, {
      headers: { Authorization: `Bearer ${access}`, Origin: "https://approved-bridge.example" },
    });
    expect(response.status).toBe(405);
  } finally {
    await bridge.stop();
  }
});

it("enforces SDK OAuth PKCE, redirect/resource scoping, explicit pairing, revocation and network boundaries", async () => {
  const code = randomBytes(32).toString("base64url");
  const bridge = await startBridge({
    projectIds: [randomUUID() as ProjectId],
    port: 0,
    pairingCode: code,
  });
  try {
    expect(
      (
        await fetch(`${bridge.localUrl}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
    const malformed = await fetch(`${bridge.localUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid-secret-fixture",
    });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toEqual({ error: "invalid_request" });
    const oversized = await fetch(`${bridge.localUrl}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ value: "x".repeat(110000) }),
    });
    expect(oversized.status).toBe(413);
    expect(await oversized.json()).toEqual({ error: "request_too_large" });
    const metadata = await (
      await fetch(`${bridge.localUrl}/.well-known/oauth-authorization-server`)
    ).json();
    expect(metadata).toMatchObject({
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code"],
      token_endpoint_auth_methods_supported: ["none"],
    });
    const registration = await fetch(`${bridge.localUrl}/register`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        redirect_uris: ["https://attacker.invalid/callback"],
        token_endpoint_auth_method: "none",
      }),
    });
    expect(registration.status).toBe(400);
    const grant = await authorize(bridge.localUrl, code);
    expect((await token(bridge.localUrl, { ...grant.params, code_verifier: "wrong" })).status).toBe(
      400,
    );
    expect(
      (await token(bridge.localUrl, { ...grant.params, resource: "https://other.invalid/mcp" }))
        .status,
    ).toBe(400);
    expect(
      (await token(bridge.localUrl, { ...grant.params, redirect_uri: `${callback}/wrong` })).status,
    ).toBe(400);
    const redeemed = await token(bridge.localUrl, grant.params);
    expect(redeemed.status).toBe(200);
    const access = (await redeemed.json()).access_token;
    expect((await token(bridge.localUrl, grant.params)).status).toBe(400);
    const repeated = await fetch(`${bridge.localUrl}/approve`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: bridge.localUrl },
      body: new URLSearchParams({ transaction: grant.transaction, pairingCode: code }),
      redirect: "manual",
    });
    expect(repeated.status).toBe(403);
    // Node fetch rewrites Host; send the wire header with the native HTTP client.
    const forbiddenHost = await new Promise<number | undefined>((resolve, reject) => {
      request(
        `${bridge.localUrl}/mcp`,
        {
          headers: { Host: "attacker.invalid", Authorization: `Bearer ${access}` },
        },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      )
        .on("error", reject)
        .end();
    });
    expect(forbiddenHost).toBe(403);
    expect(
      (
        await fetch(`${bridge.localUrl}/mcp`, {
          headers: { Origin: "https://attacker.invalid", Authorization: `Bearer ${access}` },
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await fetch(`${bridge.localUrl}/revoke`, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({ client_id: grant.client.client_id, token: access }),
        })
      ).status,
    ).toBe(200);
    expect(
      (await fetch(`${bridge.localUrl}/mcp`, { headers: { Authorization: `Bearer ${access}` } }))
        .status,
    ).toBe(401);
  } finally {
    await bridge.stop();
  }
});

it("lets a fake ChatGPT MCP client dispatch scoped work, wait and review actual local verification without API keys", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const project = await initializeProject(path);
    const registryRoot = join(path, "registry");
    const executable = join(path, "native-readiness.cjs");
    await writeFile(
      executable,
      "#!/usr/bin/env node\nconsole.log(process.argv[2]==='--version'?'codex-cli 0.153.4':'Logged in using ChatGPT');\n",
      { mode: 0o700 },
    );
    await saveProjectBindings(
      project,
      { executor: { provider: "codex", mode: "native", executable } },
      0,
    );
    const config = parseConfig({ version: 1, agents: {}, workflow: { use: "./checks.yaml" } });
    const workflow = {
      version: 1 as const,
      name: "fixture",
      start: "execute",
      steps: {
        execute: { type: "agent" as const, agent: "executor", next: "verify" },
        verify: {
          type: "command" as const,
          run: [
            "node -e \"if(require('node:fs').readFileSync('answer.txt','utf8')!=='42')process.exit(1)\"",
          ],
        },
      },
    };
    await writeFile(join(path, "veyra.yaml"), JSON.stringify(config));
    await writeFile(join(path, "checks.yaml"), JSON.stringify(workflow));
    const daemon = await startDaemon({
      registryRoot,
      env: {},
      resolveExecution: () => ({
        config,
        workflow,
        agents: {
          executor: {
            id: "fake",
            provider: "fake",
            async run() {
              await writeFile(join(path, "answer.txt"), "42");
              return {
                status: "success" as const,
                summary: "Wrote answer",
                data: { changedFiles: ["answer.txt"] },
              };
            },
          },
        },
      }),
    });
    const code = randomBytes(32).toString("base64url");
    const bridge = await startBridge({
      projectIds: [project.id],
      registryRoot,
      port: 0,
      pairingCode: code,
    });
    const { DaemonClient } = await import("@veyraoss/daemon");
    await new DaemonClient({ registryRoot }).call("projects.register", { path });
    const { client } = await connect(bridge.localUrl, code);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((tool) => tool.name)).toEqual([
        "veyra_projects",
        "veyra_project",
        "veyra_dispatch",
        "veyra_run",
        "veyra_cancel",
      ]);
      expect(
        tools.tools.find((tool) => tool.name === "veyra_dispatch")?.annotations?.readOnlyHint,
      ).toBe(false);
      const call = async (name: string, args = {}) =>
        (await client.callTool({ name, arguments: args })).structuredContent;
      expect(await call("veyra_projects")).toMatchObject({
        ok: true,
        data: { projects: [{ id: project.id }] },
      });
      expect(await call("veyra_project", { projectId: project.id })).toMatchObject({
        ok: true,
        data: { readiness: { ready: true }, checks: [{ id: "verify" }] },
      });
      expect(await call("veyra_project", { projectId: randomUUID() })).toMatchObject({
        ok: false,
        error: { code: "project_forbidden" },
      });
      const fixture = fixtureProjectState(project.id);
      if (!fixture.handoff) throw new Error("Missing fixture handoff");
      const handoff = {
        ...fixture.handoff,
        runId: randomUUID(),
        requestedVerification: [{ id: "verify", kind: "test" }],
      };
      expect(await call("veyra_dispatch", { projectId: project.id, handoff })).toMatchObject({
        ok: true,
      });
      const result = await call("veyra_run", {
        projectId: project.id,
        runId: handoff.runId,
        waitMs: 10000,
      });
      expect(result).toMatchObject({
        ok: true,
        data: {
          result: { status: "completed", verification: [{ status: "passed" }] },
          verificationEvidence: [{ success: true, results: [{ exitCode: 0 }] }],
        },
      });
      expect(await call("veyra_dispatch", { projectId: project.id, handoff })).toMatchObject({
        ok: false,
        error: { code: "run_exists" },
      });
      const readonly = await connect(bridge.localUrl, code, "veyra:read");
      try {
        expect(
          (
            await readonly.client.callTool({
              name: "veyra_dispatch",
              arguments: { projectId: project.id, handoff },
            })
          ).structuredContent,
        ).toMatchObject({ ok: false, error: { code: "insufficient_scope" } });
      } finally {
        await readonly.client.close();
      }
      expect(JSON.stringify(result)).not.toContain(code);
    } finally {
      await client.close();
      await bridge.stop();
      await daemon.stop();
    }
  });
}, 20000);
