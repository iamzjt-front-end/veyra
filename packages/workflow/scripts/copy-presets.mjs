import { copyFile, mkdir, readdir, rm } from "node:fs/promises";

// Root workflows remain the canonical source; installed packages own their built assets.
const source = new URL("../../../workflows/", import.meta.url);
const destination = new URL("../dist/presets/", import.meta.url);
await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
for (const name of await readdir(source)) {
  if (name.endsWith(".yaml")) await copyFile(new URL(name, source), new URL(name, destination));
}
