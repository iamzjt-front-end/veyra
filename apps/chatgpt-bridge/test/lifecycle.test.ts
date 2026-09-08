import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import type { ProjectId } from "@veyraoss/protocol";
import { expect, it } from "vitest";
import { withFixtureWorkspace } from "../../../test/helpers/workspace.js";
import { startBridge } from "../src/server.js";

it.each([
  "http://unsafe.invalid",
  "https://user:password@unsafe.invalid",
  "https://unsafe.invalid/path",
])("rejects invalid external metadata origin %s before listening", async (publicUrl) => {
  await expect(
    startBridge({
      port: 0,
      projectIds: [randomUUID() as ProjectId],
      pairingCode: randomBytes(32).toString("base64url"),
      publicUrl,
    }),
  ).rejects.toThrow("HTTPS origin");
});

it("rejects unscoped or unpaired startup without acquiring a server", async () => {
  await expect(
    startBridge({ port: 0, projectIds: [], pairingCode: randomBytes(32).toString("base64url") }),
  ).rejects.toThrow("one to eight");
  await expect(
    startBridge({ port: 0, projectIds: [randomUUID() as ProjectId], pairingCode: "short" }),
  ).rejects.toThrow("pairing code");
});

it("keeps pairing material in an owned private file and removes it on SIGTERM while closing the socket", async () => {
  await withFixtureWorkspace(async ({ path }) => {
    const registryRoot = join(await realpath(path), "registry");
    const child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("../dist/main.js", import.meta.url)),
        "--project",
        randomUUID(),
        "--registry",
        registryRoot,
        "--port",
        "0",
      ],
      { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, OPENAI_API_KEY: "" } },
    );
    const exit = once(child, "exit");
    const lines = createInterface({ input: child.stdout });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr = (stderr + String(chunk)).slice(-4096);
    });
    let localUrl = "";
    try {
      const [line] = await once(lines, "line", { signal: AbortSignal.timeout(5000) });
      const started = JSON.parse(line) as {
        type: string;
        localUrl: string;
        pairingFile: string;
        exposure: string;
      };
      localUrl = started.localUrl;
      expect(started).toMatchObject({ type: "bridge.started", exposure: "loopback-only" });
      expect(new URL(localUrl).hostname).toBe("127.0.0.1");
      expect((await lstat(started.pairingFile)).mode & 0o777).toBe(0o600);
      const pairing = await readFile(started.pairingFile, "utf8");
      expect(pairing).toHaveLength(43);
      expect(line).not.toContain(pairing);
      expect(stderr).not.toContain(pairing);
      expect((await fetch(`${localUrl}/mcp`)).status).toBe(401);
      child.kill("SIGTERM");
      expect(await exit).toEqual([0, null]);
      expect(await readdir(registryRoot)).toEqual([]);
      await expect(fetch(`${localUrl}/mcp`)).rejects.toThrow();
    } finally {
      lines.close();
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await exit;
    }
  });
}, 10000);
