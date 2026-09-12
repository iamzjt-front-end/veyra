import { startCoordinator } from "./coordinator.js";
import { readInstallation } from "./native-installation.js";
const controller = new AbortController();
process.once("SIGTERM", () => controller.abort());
process.once("SIGINT", () => controller.abort());
try {
  const installation = await readInstallation(process.argv[2] ?? "");
  const daemon = await startCoordinator({
    registryRoot: installation.registryRoot,
    signal: controller.signal,
    idleTimeoutMs: 60000,
    nativeInstallationPath: process.argv[2],
  });
  await daemon.closed;
} catch {
  process.exitCode = 1;
}
