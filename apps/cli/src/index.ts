#!/usr/bin/env node
import { runCli } from "./application.js";

const controller = new AbortController();
let interrupted: number | undefined;
const interrupt = () => {
  interrupted ??= 130;
  controller.abort();
};
const terminate = () => {
  interrupted ??= 143;
  controller.abort();
};
// Keep handlers while cleanup drains; a repeated interrupt must not kill the coordinator early.
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
try {
  const code = await runCli(process.argv.slice(2), { signal: controller.signal });
  process.exitCode = interrupted ?? code;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", terminate);
}
