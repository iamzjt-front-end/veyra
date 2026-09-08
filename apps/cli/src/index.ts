#!/usr/bin/env node
import { runCli } from "./application.js";

const controller = new AbortController();
let interrupted: number | undefined;
const interrupt = () => {
  interrupted ??= 130;
  process.exitCode = interrupted;
  controller.abort();
};
const terminate = () => {
  interrupted ??= 143;
  process.exitCode = interrupted;
  controller.abort();
};
// This process entry point owns the handlers through exit, including pending output drains.
process.on("SIGINT", interrupt);
process.on("SIGTERM", terminate);
const code = await runCli(process.argv.slice(2), { signal: controller.signal });
process.exitCode = interrupted ?? code;
