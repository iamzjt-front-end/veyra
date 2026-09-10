import { dirname } from "node:path";
import { NativeService } from "./native-service.js";
import { serveNative } from "./native-framing.js";
import { nativeHostEnvironment } from "./native-environment.js";
try {
  if (process.argv.length !== 4) throw new Error("Unexpected native launch arguments.");
  process.env.PATH = [
    ...new Set([
      dirname(process.execPath),
      "/opt/homebrew/bin",
      "/usr/local/bin",
      ...(process.env.PATH ?? "/usr/bin:/bin").split(":"),
    ]),
  ].join(":");
  const environment = await nativeHostEnvironment(process.env);
  for (const [key, value] of Object.entries(environment))
    if (value !== undefined) process.env[key] = value;
  const service = new NativeService(process.argv[2] ?? "", process.argv[3] ?? "");
  await serveNative(process.stdin, process.stdout, (value) => service.handle(value));
} catch {
  process.stderr.write(
    "Veyra native bridge stopped. Inspect Extension Diagnostics or run ve setup.\n",
  );
  process.exitCode = 1;
}
