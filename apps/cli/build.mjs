import { cp, rm } from "node:fs/promises";
// Copy only the current generated assets; obsolete hashed bundles must not accumulate.
for (const [source, target] of [
  ["../chatgpt-extension/dist/", "./dist/browser-extension/"],
  ["../dashboard/dist/", "./dist/control-center/"],
]) {
  const destination = new URL(target, import.meta.url);
  await rm(destination, { recursive: true, force: true });
  await cp(new URL(source, import.meta.url), destination, { recursive: true });
}
