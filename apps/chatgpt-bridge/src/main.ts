import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, open, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { isProjectId } from "@veyraoss/protocol";
import { startBridge } from "./server.js";

const { values, positionals } = parseArgs({
  options: {
    registry: { type: "string" },
    project: { type: "string", multiple: true },
    port: { type: "string" },
    "public-url": { type: "string" },
    help: { type: "boolean" },
  },
  allowPositionals: true,
  strict: true,
});
if (values.help) {
  console.log(
    "Veyra ChatGPT MCP proof: pnpm --filter @veyraoss/chatgpt-bridge start --project <uuid> [--registry <directory>] [--port 3180] [--public-url https://approved-forwarder.example]\nDefaults to loopback only. No tunnel is started. Install/link in ChatGPT explicitly after local verification.",
  );
} else {
  if (positionals.length || !values.project?.length || !values.project.every(isProjectId))
    throw new Error("Specify one or more --project UUIDs.");
  const port = values.port === undefined ? 3180 : Number(values.port);
  if (!Number.isInteger(port) || (port !== 0 && port < 1024) || port > 65535)
    throw new Error("Port must be 0 (automatic) or 1024–65535.");
  const registryRoot = resolve(values.registry ?? join(homedir(), ".veyra"));
  await mkdir(registryRoot, { recursive: true, mode: 0o700 });
  const rootStat = await lstat(registryRoot);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    rootStat.uid !== process.getuid?.() ||
    rootStat.mode & 0o077 ||
    (await realpath(registryRoot)) !== registryRoot
  )
    throw new Error("Use an owned, private canonical registry directory.");
  const pairingFile = join(registryRoot, `.bridge-pairing-${randomUUID()}`);
  const code = randomBytes(32).toString("base64url");
  const file = await open(pairingFile, "wx", 0o600);
  try {
    try {
      await file.writeFile(code);
    } finally {
      await file.close();
    }
    const bridge = await startBridge({
      projectIds: values.project,
      registryRoot,
      port,
      publicUrl: values["public-url"],
      pairingCode: code,
    });
    console.log(
      JSON.stringify({
        type: "bridge.started",
        localUrl: bridge.localUrl,
        mcpUrl: bridge.mcpUrl,
        projectIds: values.project,
        pairingFile,
        exposure: values["public-url"]
          ? "external-forwarding-must-be-authorized-separately"
          : "loopback-only",
        authorization: "explicit-local-pairing",
        status: "local-proof-not-chatgpt-acceptance",
      }),
    );
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.removeListener("SIGINT", stop);
        process.removeListener("SIGTERM", stop);
        resolve();
      };
      process.once("SIGINT", stop);
      process.once("SIGTERM", stop);
    });
    await bridge.stop();
  } finally {
    await unlink(pairingFile);
  }
}
