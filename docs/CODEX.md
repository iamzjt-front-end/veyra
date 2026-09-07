# Codex CLI executor

`@veyra/codex` implements the provider-neutral `AgentAdapter` contract using the installed Codex CLI. Process spawning, working directories, stream capture, timeout, and cancellation belong to `@veyra/runtime`. SDK mode remains planned.

```ts
import { CodexAdapter } from "@veyra/codex";

const executor = new CodexAdapter({ mode: "cli", workingDirectory: process.cwd() });
const readiness = await executor.doctor();
const result = await executor.run(
  {
    runId: "example",
    stepId: "execute",
    role: "executor",
    goal: "Repair the failing greeting test",
    instructions: "Change the implementation and preserve the existing tests.",
    context: { planner: { instructions: "Use the expected greeting." } },
  },
  { timeoutMs: 180_000 },
);
```

## Invocation and permissions

The invocation was checked against installed `codex-cli 0.153.4`, `codex exec --help`, and `codex login --help`. It uses `codex exec --json --ephemeral --color never --sandbox workspace-write --output-schema <temporary-schema> -`. The prompt goes through stdin as literal UTF-8, with EOF, without shell interpolation. The temporary schema is removed after execution.

An optional `model` adds `--model`; otherwise the installed CLI chooses its configured model. Optional `executable` selects an existing executable path. Veyra preserves installed user/project configuration and `AGENTS.md`; it does not pass flags that ignore them or bypass approval/sandbox controls. A workspace-write coding agent can modify the target working directory and execute commands subject to Codex's own permissions. Worktree isolation is a later TODO; callers should choose the working directory deliberately.

The task envelope carries the original goal, current instructions, relevant context, and artifact references. The prompt requires scoped edits, preserves project instructions, and requests `needs_input` when human approval or unavailable access is required. It forbids committing, pushing, publishing, deploying, and exposing credentials. Provider claims still need independent verification.

See the official [non-interactive Codex guide](https://learn.chatgpt.com/docs/non-interactive-mode). Installed CLI help is authoritative for the available flags.

## Result and limits

The final structured message contains `status` (`success`, `failure`, or `needs_input`), `summary`, `changedFiles`, and `commandsRun`. It becomes an `AgentResult` with execution metadata, timing, and token usage when available. Cost is omitted when unknown. Changed paths and commands are execution claims, not verified artifacts.

The adapter incrementally parses JSONL so a late final result survives bounded stdout retention. A successful process exit also requires a completed turn and valid final schema. Malformed output, unsuccessful exits, failed turns, timeouts, and cancellation produce normalized failures. Unknown JSONL event types are tolerated. Individual records exceeding 1 MiB of text are dropped with a diagnostic flag; a valid final completion is still required.

`data.process` retains exit code, signal, duration, stdout/stderr prefixes, truncation flags, and termination reason when applicable. `maxOutputBytes` defaults to 64 KiB per stream and accepts zero through 1 MiB. The prompt is capped at 256 KiB. The default timeout is 15 minutes. Per-run `cwd`, `timeoutMs`, and `AbortSignal` override configured directory/timeout values and remain outside persisted input. Large-log artifacts and centralized retention are later TODOs.

Known credential values from `OPENAI_API_KEY`, `CODEX_API_KEY`, and `CODEX_ACCESS_TOKEN` are redacted from prompts and retained diagnostics; credential-shaped fields and environment objects are removed from prompt context. Bearer diagnostics are masked. This does not claim that every unknown secret in arbitrary tool output is detectable; centralized redaction remains a separate hardening task.

## Authentication and readiness

The adapter relies on the installed CLI's existing authentication. It does not read, copy, or manage login token files, perform login, or persist credentials. `doctor()` runs `--version` and the read-only `login status` command with bounded output and a five-second timeout each. It reports executable/version/authentication readiness without exposing raw authentication output. A successful login check does not guarantee network availability or model access. A missing executable is distinct from an inconclusive readiness check.

## Verification

The default adapter tests mock the runtime and require no provider account or network. They cover structured output, stdin/prompt construction, directory and execution controls, missing executables, process failures, timeout/cancellation, bounded streaming, redaction, schema cleanup, and readiness.

For an installed, logged-in CLI, explicitly run:

```bash
pnpm --filter @veyra/codex smoke
```

This optional live command consumes the existing Codex account's usage. It copies the deterministic fixture into a temporary directory, initializes a disposable Git repository, adds restrictive `AGENTS.md`, and starts with a failing test. It asks Codex to modify only `src/message.js`, then independently checks the changed-file list, instruction preservation, syntax, and tests. The temporary repository is removed even on failure. This script is excluded from the default test suite.
