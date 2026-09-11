import { readFile, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
import { runProcess } from "../packages/runtime/src/index.js";
import { withFixtureWorkspace } from "./helpers/workspace.js";

it("runs cold local CLI commands and inspects saved verification without outbound Node calls", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const registryRoot = join(path, "registry");
    const marker = join(path, "network-attempt");
    const guard = join(path, "deny-network.mjs");
    await writeFile(
      guard,
      `import {appendFileSync} from 'node:fs';
import {syncBuiltinESMExports} from 'node:module';
import http from 'node:http'; import https from 'node:https';
import net from 'node:net'; import tls from 'node:tls'; import dns from 'node:dns'; import dgram from 'node:dgram';
const deny=()=>{appendFileSync(${JSON.stringify(marker)},'attempt\\n');throw new Error('Outbound Node call is forbidden in this local CLI regression');};
globalThis.fetch=deny;
for(const [api,names] of [[http,['request','get']],[https,['request','get']],[net,['connect','createConnection']],[tls,['connect']],[dns,['lookup','resolve']],[dns.promises,['lookup','resolve']],[dgram,['createSocket']]])for(const name of names)api[name]=deny;
net.Socket.prototype.connect=deny;syncBuiltinESMExports();`,
    );
    const cli = fileURLToPath(new URL("../apps/cli/dist/index.js", import.meta.url));
    const ve = async (...args: string[]) => {
      const result = await runProcess({
        executable: process.execPath,
        args: [
          "--import",
          guard,
          cli,
          ...args,
          ...(args[0] === "init" ? ["--registry", registryRoot] : []),
          "--json",
        ],
        cwd: path,
        env: { NODE_OPTIONS: undefined },
        timeoutMs: 15_000,
      });
      expect(result.exitCode, result.stdout + result.stderr).toBe(0);
      return result.stdout
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
    };
    expect((await ve("version"))[0].executable).toBe("ve");
    expect((await ve("workflow", "list"))[0].workflows).toHaveLength(4);
    await ve("workflow", "validate", "dev");
    await ve("init");
    expect(JSON.parse(await readFile(join(registryRoot, "projects.json"), "utf8"))).toMatchObject({
      version: 1,
      projects: [{ root: await realpath(path) }],
    });
    await writeFile(
      join(path, "veyra.yaml"),
      JSON.stringify({ version: 1, workflow: { use: "./workflow.yaml" }, agents: {} }),
    );
    await writeFile(
      join(path, "workflow.yaml"),
      JSON.stringify({
        version: 1,
        name: "local-only",
        start: "verify",
        steps: {
          verify: { type: "command", run: ["node --version"], next: "done" },
          done: { type: "end" },
        },
      }),
    );
    const run = await ve("run", "Record local verification", "--non-interactive");
    expect(run.at(-1).status).toBe("completed");
    expect((await ve("status"))[0].status).toBe("completed");
    const review = (await ve("review"))[0];
    expect(review.verification.success).toBe(true);
    expect(review.verification.results[0].durationMs).toBeGreaterThanOrEqual(0);
    await expect(readFile(marker)).rejects.toMatchObject({ code: "ENOENT" });
  });
}, 30_000);

it("disables Turbo telemetry for the repository without changing global preferences", async () => {
  const result = await runProcess({
    executable: "pnpm",
    args: ["telemetry:check"],
    env: { TURBO_TELEMETRY_DISABLED: "0", DO_NOT_TRACK: "0" },
    timeoutMs: 15_000,
  });
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/Status:\s*Disabled/);
});
