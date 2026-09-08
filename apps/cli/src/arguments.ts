import { parseArgs } from "node:util";

const options = {
  config: { type: "string" },
  workflow: { type: "string" },
  "allow-plugin": { type: "string", multiple: true },
  model: { type: "string" },
  "run-id": { type: "string" },
  "approval-id": { type: "string" },
  comment: { type: "string" },
  json: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  force: { type: "boolean" },
  approve: { type: "boolean" },
  reject: { type: "boolean" },
  "recover-interrupted": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;
const allowed: Record<string, string[]> = {
  init: ["config", "workflow", "model", "force"],
  run: ["config", "workflow", "non-interactive", "allow-plugin"],
  status: ["config", "run-id"],
  review: ["config", "run-id"],
  resume: [
    "config",
    "run-id",
    "approve",
    "reject",
    "approval-id",
    "comment",
    "recover-interrupted",
    "non-interactive",
    "allow-plugin",
  ],
  doctor: ["config", "workflow", "allow-plugin"],
  workflow: ["config"],
  help: [],
  version: [],
};

export class CliError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly exitCode = 2,
  ) {
    super(message);
  }
}

export function argumentsFor(argv: string[]) {
  const args = argv[0] === "--" ? argv.slice(1) : [...argv];
  const parsed = parseArgs({ args, options, strict: true, allowPositionals: true });
  const command = parsed.values.help
    ? "help"
    : parsed.values.version
      ? "version"
      : (parsed.positionals[0] ?? "help");
  if (!Object.hasOwn(allowed, command))
    throw new CliError("unknown_command", `Unknown command: ${command}`, 1);
  for (const key of Object.keys(parsed.values)) {
    if (!["json", "help", "version", ...(allowed[command] ?? [])].includes(key))
      throw new CliError("invalid_option", `--${key} is not valid for ve ${command}.`);
  }
  const positionals =
    parsed.values.help || parsed.values.version ? [] : parsed.positionals.slice(1);
  if (command === "run" && !positionals.join(" ").trim())
    throw new CliError("missing_goal", 'Provide a goal: ve run "repair the failing test".');
  if (
    command !== "run" &&
    command !== "workflow" &&
    positionals.length > (["status", "review", "resume"].includes(command) ? 1 : 0)
  )
    throw new CliError("unexpected_argument", `Unexpected argument for ve ${command}.`);
  if (command === "workflow") {
    const [action, reference] = positionals;
    if (action !== "list" && action !== "validate")
      throw new CliError(
        "invalid_workflow_command",
        "Use ve workflow list or ve workflow validate <name/path>.",
      );
    if (action === "list" && (positionals.length !== 1 || parsed.values.config !== undefined))
      throw new CliError(
        "unexpected_argument",
        "ve workflow list accepts only --json; it does not load project configuration.",
      );
    if (action === "validate" && (positionals.length !== 2 || !reference?.trim()))
      throw new CliError(
        "missing_workflow_reference",
        "Supply a workflow: ve workflow validate <name/path> [--config <file>].",
      );
  }
  if (parsed.values["run-id"] && positionals.length)
    throw new CliError(
      "duplicate_run_id",
      "Supply the run ID either positionally or with --run-id.",
    );
  if (parsed.values.approve && parsed.values.reject)
    throw new CliError("conflicting_decision", "Choose either --approve or --reject.");
  if (
    (parsed.values["approval-id"] || parsed.values.comment) &&
    !parsed.values.approve &&
    !parsed.values.reject
  )
    throw new CliError(
      "missing_decision",
      "--approval-id and --comment require --approve or --reject.",
    );
  return { command, values: parsed.values, positionals };
}

export const help = `Veyra — one goal, many agents, verified execution.

Usage: ve <command>

Commands:
  init        create veyra.yaml and local-state ignore rules
  run <goal>  execute the configured workflow
  status [id] inspect active/latest run state
  review [id] inspect saved review and verification evidence
  resume [id] continue a paused run
  doctor      inspect environment and required provider readiness
  workflow list          list built-in workflows and required agents
  workflow validate <name/path>  validate a workflow without executing it
  version     print version
  help        show this help

Options:
  --config <file>       select configuration (default: ./veyra.yaml)
  --workflow <name/path> override workflow for run/doctor, or select it during init
  --allow-plugin <name> trust a configured local plugin for run/resume/doctor; repeat per provider
  --json               emit JSON (run/resume use JSON Lines)
  --non-interactive    run without prompts; gates pause until explicitly resolved
  --run-id <id>        select a run for status/review/resume
  --approve | --reject resolve the current human gate during resume
  --approval-id <id>   require this exact pending approval ID
  --comment <text>     record a comment with the decision
  --recover-interrupted  resume only a proven completed checkpoint after its owner stopped
  --model <model>      planner/reviewer model for init
  --force              replace an existing config during init

No-argument TUI mode remains planned. Commands currently run headlessly.`;
