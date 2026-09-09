import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { startControlServer } from "./control-server.js";
import { ensureCoordinator } from "./native-service.js";
import { builtEntry, privateWrite, readInstallation } from "./native-installation.js";
import { readControlMetadata } from "./control-launcher.js";
const path = process.argv[2];
if (!path) throw new Error("Local installation is required.");
const installation = await readInstallation(path);
const server = await startControlServer({
  assets: builtEntry("control-center"),
  registryRoot: installation.registryRoot,
  client: () => ensureCoordinator(path),
  authorize: async (grants) => {
    const current = await readInstallation(path);
    if (current.id !== installation.id)
      throw new Error("Local authorization changed. Reopen Veyra.");
    for (const [id, root] of grants ?? []) {
      const grant = current.grants[id];
      if (!grant || grant.root !== root || grant.expiresAt <= Date.now())
        throw new Error("Local Project grant was revoked or expired.");
    }
  },
});
const id = randomUUID(),
  metadataPath = join(installation.registryRoot, "browser", "control.json");
await privateWrite(
  metadataPath,
  JSON.stringify({
    version: 1,
    id,
    installationId: installation.id,
    pid: process.pid,
    origin: server.origin,
    launcherKey: server.launcherKey,
  }),
);
const stop = () => {
  void server.stop();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
await server.closed;
if ((await readControlMetadata(metadataPath))?.id === id) await unlink(metadataPath);
