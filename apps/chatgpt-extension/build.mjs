import { cp, mkdir } from "node:fs/promises";
import { build } from "esbuild";
await mkdir("dist", { recursive: true });
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
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
});
await cp("static", "dist", { recursive: true });
