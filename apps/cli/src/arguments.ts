import { parseArgs } from "node:util";

const options = {
  config: { type: "string" },
  registry: { type: "string" },
  "http-port": { type: "string" },
  "http-origin": { type: "string" },
  "http-project": { type: "string", multiple: true },
  "codex-executable": { type: "string" },
  executor: { type: "string" },
  "session-run": { type: "string" },
  workflow: { type: "string" },
  "allow-plugin": { type: "string", multiple: true },
  model: { type: "string" },
  "run-id": { type: "string" },
  "approval-id": { type: "string" },
  comment: { type: "string" },
  json: { type: "boolean" },
  "non-interactive": { type: "boolean" },
  revoke: { type: "boolean" },
  force: { type: "boolean" },
  apply: { type: "boolean" },
  "older-than-days": { type: "string" },
  "keep-last": { type: "string" },
  approve: { type: "boolean" },
  reject: { type: "boolean" },
  "recover-interrupted": { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean", short: "v" },
} as const;
const allowed: Record<string, string[]> = {
  setup: ["registry", "revoke"],
  init: ["registry", "config", "workflow", "model", "force"],
  projects: ["registry"],
  project: ["registry", "executor", "codex-executable", "model", "session-run"],
  daemon: ["registry", "allow-plugin", "http-port", "http-origin", "http-project"],
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
  doctor: ["config", "workflow", "allow-plugin", "codex-executable"],
  workflow: ["config"],
  workspace: ["config", "recover-interrupted"],
  prune: ["config", "apply", "older-than-days", "keep-last"],
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
  if (parsed.values.registry !== undefined && !parsed.values.registry.trim())
    throw new CliError("invalid_registry", "--registry must name a directory.");
  if (
    parsed.values["codex-executable"] !== undefined &&
    (!parsed.values["codex-executable"].trim() || parsed.values["codex-executable"].includes("\0"))
  )
    throw new CliError("invalid_executable", "--codex-executable must name an executable.");
  if (parsed.values["codex-executable"] && (parsed.values.config || parsed.values.workflow))
    throw new CliError(
      "invalid_option",
      "Use --codex-executable for native doctor; selected workflows use their configured adapter executable.",
    );
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
    command !== "workspace" &&
    command !== "project" &&
    command !== "daemon" &&
    positionals.length > (["status", "review", "resume"].includes(command) ? 1 : 0)
  )
    throw new CliError("unexpected_argument", `Unexpected argument for ve ${command}.`);
  if (
    command === "project" &&
    (positionals.length !== 2 ||
      !["add", "remove", "show", "bind"].includes(positionals[0] ?? "") ||
      !positionals[1]?.trim())
  )
    throw new CliError(
      "invalid_project_command",
      "Use ve project add <path>, remove <project-id>, show <project-id>, or bind <project-id> --executor codex/native.",
    );
  if (command === "project") {
    const bindingOptions = ["executor", "codex-executable", "model", "session-run"] as const;
    if (positionals[0] !== "bind" && bindingOptions.some((key) => parsed.values[key] !== undefined))
      throw new CliError("invalid_option", "Binding options require ve project bind.");
    if (positionals[0] === "bind" && parsed.values.executor !== "codex/native")
      throw new CliError("unsupported_executor_binding", "Use --executor codex/native.");
  }
  if (
    command === "daemon" &&
    (positionals.length !== 1 ||
      !["start", "stop", "status", "projects"].includes(positionals[0] ?? ""))
  )
    throw new CliError(
      "invalid_daemon_command",
      "Use ve daemon start, stop, status or projects [--registry <directory>].",
    );
  const httpOptions = ["http-port", "http-origin", "http-project"] as const;
  if (httpOptions.some((key) => parsed.values[key] !== undefined)) {
    if (
      command !== "daemon" ||
      positionals[0] !== "start" ||
      !/^\d+$/.test(parsed.values["http-port"] ?? "") ||
      !parsed.values["http-origin"] ||
      !parsed.values["http-project"]?.length
    )
      throw new CliError(
        "invalid_loopback_options",
        "ve daemon start requires --http-port, --http-origin and --http-project together.",
      );
  }
  if (
    command === "workspace" &&
    (positionals.length !== 2 || positionals[0] !== "remove" || !positionals[1]?.trim())
  )
    throw new CliError(
      "invalid_workspace_command",
      "Use ve workspace remove <run-id> [--config <file>] [--json].",
    );
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
  for (const key of ["older-than-days", "keep-last"] as const)
    if (parsed.values[key] !== undefined && !/^\d+$/.test(parsed.values[key]))
      throw new CliError("invalid_retention_policy", `--${key} must be a non-negative integer.`);
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
  setup       one-time native Codex and browser bridge setup (no API key)
  daemon start           run the local daemon in the foreground (Ctrl-C to stop)
  daemon stop            stop the daemon for this registry root
  daemon status          inspect local daemon health
  daemon projects        list Projects through the running daemon
  projects    list registered Projects and stale locations
  project add <path>     initialize/open and register a local Project
  project remove <id>    unregister a Project (preserves project files)
  project show <id>      inspect a registered Project
  project bind <id> --executor codex/native  persist the Project executor
  init        initialize/register this Project and bind native Codex
  run <goal>  execute the configured workflow
  status [id] inspect active/latest run state
  review [id] inspect saved review and verification evidence
  resume [id] continue a paused run
  doctor      inspect native Codex readiness; --config/--workflow checks an optional workflow
  workflow list          list built-in workflows and required agents
  workflow validate <name/path>  validate a workflow without executing it
  workspace remove <id>  remove a clean, unchanged worktree after a terminal run
  prune       preview old terminal history eligible for cleanup
  version     print version
  help        show this help

Options:
  --revoke              revoke browser grants and rotate installation identity (setup)
  --registry <directory> select registry root (default: ~/.veyra)
  --http-port <port>    opt in to the daemon loopback HTTP transport (daemon start only)
  --http-origin <origin> exact chrome-extension://<id> allowed by that transport
  --http-project <id>  allow a Project on loopback; repeat for at most eight Projects
  --codex-executable <path> select the native Codex executable for doctor
  --config <file>       select configuration (default: ./veyra.yaml)
  --workflow <name/path> override workflow for run/doctor, or select it during init
  --allow-plugin <name> trust a configured local plugin for run/resume/doctor; repeat per provider
  --json               emit JSON (run/resume use JSON Lines)
  --non-interactive    run without prompts; gates pause until explicitly resolved
  --run-id <id>        select a run for status/review/resume
  --approve | --reject resolve the current human gate during resume
  --approval-id <id>   require this exact pending approval ID
  --comment <text>     record a comment with the decision
  --recover-interrupted  recover a completed boundary after the owner and its children stopped
  --model <model>      planner/reviewer model for init
  --force              replace an existing config during init
  --older-than-days <n> prune only history older than n days (default 30)
  --keep-last <n>       always preserve the newest n runs (default 20)
  --apply              delete eligible history during prune; default is a preview

No-argument TUI mode remains planned. Commands currently run headlessly.`;
