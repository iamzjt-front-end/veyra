import { cp } from "node:fs/promises";
// Ship the experimental unpacked extension with the installed CLI; no source checkout needed.
await cp(
  new URL("../chatgpt-extension/dist/", import.meta.url),
  new URL("./dist/browser-extension/", import.meta.url),
  { recursive: true },
);
