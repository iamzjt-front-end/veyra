import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";
await mkdir("dist", { recursive: true });
await build({
  entryPoints: ["src/background.ts", "src/content.ts", "src/popup.ts"],
  outdir: "dist",
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "chrome120",
});
await cp("static", "dist", { recursive: true });
