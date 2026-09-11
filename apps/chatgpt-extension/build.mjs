import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { build } from "esbuild";
await mkdir("dist", { recursive: true });
const hash = createHash("sha256");
async function inputs(path) {
  const entries = await readdir(path, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, "en"))) {
    const name = `${path}/${entry.name}`;
    if (entry.isDirectory()) await inputs(name);
    else if (entry.isFile())
      hash
        .update(name)
        .update("\0")
        .update(await readFile(name))
        .update("\0");
  }
}
// Workspace exports resolve to dist. Fingerprint the actual dependency inputs too,
// so a freshly rebuilt UI/protocol cannot reuse a stale extension build identity.
for (const path of ["src", "static", "../../packages/protocol/dist", "../../packages/ui/dist"])
  await inputs(path);
for (const path of ["build.mjs", "package.json", "../../pnpm-lock.yaml"])
  hash.update(path).update(await readFile(path));
const buildId = hash.digest("hex");
await build({
  entryPoints: [
    "src/background.ts",
    "src/content.ts",
    "src/diagnostics.ts",
    "src/popup.tsx",
    "src/sidepanel.tsx",
  ],
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
  minify: true,
  define: {
    "process.env.NODE_ENV": JSON.stringify("production"),
    __VEYRA_EXTENSION_BUILD__: JSON.stringify(buildId),
  },
});
await cp("static", "dist", { recursive: true });
const artifacts = {};
for (const name of (await readdir("dist")).sort())
  if (/\.(js|css|html)$/.test(name))
    artifacts[name] = createHash("sha256")
      .update(await readFile(`dist/${name}`))
      .digest("hex");
await writeFile(
  "dist/build-info.json",
  `${JSON.stringify({ version: 1, buildId, artifacts }, null, 2)}\n`,
);
