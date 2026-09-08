// biome-ignore-all lint/suspicious/noUndeclaredEnvVars: This explicit opt-in entry point is not a Turbo-cached task.
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { loadConfig } from "../../packages/config/src/index.js";
import { runEvaluation } from "./harness.js";

const controller = new AbortController();
const interrupt = () => controller.abort();
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
try {
  const { values } = parseArgs({
    options: {
      live: { type: "boolean", default: false },
      config: { type: "string" },
      trials: { type: "string", default: "1" },
      out: { type: "string" },
      "allow-plugin": { type: "string", multiple: true },
    },
  });
  if (values.live && (process.env.VEYRA_LIVE_EVAL !== "1" || !values.config))
    throw new Error("Live evaluation requires VEYRA_LIVE_EVAL=1 and --config <file>.");
  if (!values.live && (values.config || values["allow-plugin"]))
    throw new Error("Provider config/trust flags require explicit --live mode.");
  const configPath = values.config ? resolve(values.config) : undefined;
  const config = configPath ? await loadConfig(configPath) : undefined;
  if (config && configPath)
    for (const plugin of Object.values(config.plugins ?? {}))
      if (plugin.module) plugin.module = resolve(dirname(configPath), plugin.module);
  const report = await runEvaluation({
    mode: values.live ? "live" : "scripted",
    trials: Number(values.trials),
    config,
    allowPlugins: values["allow-plugin"],
    signal: controller.signal,
  });
  const json = `${JSON.stringify(report, null, 2)}\n`;
  if (values.out) await writeFile(resolve(values.out), json, { flag: "wx", mode: 0o600 });
  else console.log(json.trimEnd());
  // A complete report may include failed tasks. Exit 1 makes live failures visible to CI.
  process.exitCode = values.live && report.rows.some((row) => !row.passed) ? 1 : 0;
} catch (error) {
  // Never echo a provider exception, config source or credential-bearing command output.
  const allowed = [
    "Live evaluation requires VEYRA_LIVE_EVAL=1 and --config <file>.",
    "Provider config/trust flags require explicit --live mode.",
    "trials must be an integer from 1 through 10",
  ];
  const message =
    error instanceof Error && allowed.includes(error.message)
      ? error.message
      : "Evaluation could not finish; check arguments, config, output path and local setup.";
  console.error(JSON.stringify({ status: "blocked", message }));
  process.exitCode = 2;
} finally {
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
