# Codex CLI executor

`@veyraoss/codex` implements the provider-neutral `AgentAdapter` contract using the installed Codex CLI. Process spawning, working directories, stream capture, timeout, and cancellation belong to `@veyraoss/runtime`. SDK mode remains planned.

```ts
import { CodexAdapter } from "@veyraoss/codex";

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

## Explicit Project session continuity

The default adapter stays ephemeral. To create resumable native work, supply `session: { project }`, where `project` is an opened Veyra `ProjectDescriptor`, and an explicit `cwd` or `workingDirectory` matching its physical root. The input run ID must be a UUID. This opts into the native client's own session persistence; Veyra still does not read native storage.

```ts
const first = await new CodexAdapter({ session: { project } }).run(input, { cwd: project.root });
if (first.session) await handoffStore.createSession(first.session);

// In another Veyra process, after opening the same Project:
const resume = await handoffStore.getSession(input.runId);
if (!resume) throw new Error("Inspect Shared State before explicitly starting fresh");
const next = await new CodexAdapter({ session: { project, resume } }).run(nextInput, {
  cwd: project.root,
  timeoutMs: 180_000,
});
```

Session creation omits `--ephemeral`. Continuation uses `codex exec --sandbox workspace-write --color never resume --json --output-schema <temporary-schema> <exact-session-uuid> -`, preserving explicit workspace-write visibility, native configuration/rules and Runtime cancellation/deadline handling. It never uses `--last`, a session name, history listing or private-storage scraping. The current CLI accepts the sandbox/color options on the parent `exec` command and the result schema on `resume`. See the [official non-interactive resume guide](https://learn.chatgpt.com/docs/non-interactive-mode#resume-a-non-interactive-session) and installed `codex exec resume --help`.

`AgentResult.session` is an optional provider-neutral `NativeSessionReference`: version, kind, provider, native UUID, Project ID, originating run UUID and creation time. The UUID comes from the native `thread.started` event, not model-written final text. Continuation requires the same Project and run UUID and verifies that the returned native ID is unchanged. Core validates reference/run/provider consistency before persisting an agent event; daemon results retain validated references and archive them through Project storage.

An absent, invalid or changed returned ID is `codex_session_unavailable`; unsuccessful resume is `codex_session_resume_failed`. Timeouts/cancellation retain their existing Runtime error semantics and may include a safe reference when the native ID was already observed. No condition silently starts a replacement or claims unknown effects succeeded. If native history is lost or the interface changes, inspect persisted run evidence and explicitly start fresh with a new run ID and bounded Project Shared State. That state, rather than native history, is Veyra's portable memory. Native-client history created by this opt-in remains owned by that client.

## Authentication and readiness

`describe()` advertises the CLI executor role with code-execution, tool-use, local-cli and structured-output capabilities. The optional `checkReadiness()` contract wraps `doctor()` as a scoped local readiness result. Planned SDK mode advertises no capabilities and reports unavailable. See [capabilities](CAPABILITIES.md).

The adapter relies on the installed CLI's existing authentication. It does not read, copy, or manage login token files, perform login, or persist credentials. `doctor()` runs `--version` and the read-only `login status` command with 4-KiB output limits and a five-second timeout each. It reports executable/version/authentication readiness without exposing raw authentication output. A successful login check does not guarantee network availability or model access. A missing executable is distinct from an installed but unauthenticated client or an inconclusive login probe; successful version evidence is retained when the later probe fails.

Default `ve doctor` treats this native executor readiness as the core path. No `OPENAI_API_KEY` is required and API integrations are optional. Use `ve doctor --codex-executable /path/to/codex` for an explicit installed executable; this override is passed as a Runtime executable, never interpreted as shell syntax. Programmatic callers can use `new CodexAdapter({ executable })`. Existing optional workflows keep their adapter options and are checked explicitly with `ve doctor --config veyra.yaml` or `--workflow <name/path>`.

The native client owns the account and authentication method. If it reports unauthenticated, sign in through its normal ChatGPT flow or run `codex login`, then rerun doctor. Veyra does not require a separate API login, substitute credentials, or acquire ChatGPT history access. The supported login-status behavior is documented in the [official command reference](https://learn.chatgpt.com/docs/developer-commands#codex-login); installed help remains authoritative for available commands.

## Verification

The default adapter tests mock the runtime and require no provider account or network. They cover structured output, stdin/prompt construction, directory and execution controls, missing executables, process failures, timeout/cancellation, bounded streaming, redaction, schema cleanup, and readiness.

For an installed, logged-in CLI, explicitly run:

```bash
pnpm --filter @veyraoss/codex smoke
```

This optional live command consumes the existing Codex account's usage. It copies the deterministic fixture into a temporary directory, initializes a disposable Git repository, adds restrictive `AGENTS.md`, and starts with a failing test. It asks Codex to modify only `src/message.js`, then independently checks the changed-file list, instruction preservation, syntax, and tests. The temporary repository is removed even on failure. This script is excluded from the default test suite.

After `pnpm build`, the separate opt-in continuity check is `env -u OPENAI_API_KEY pnpm --filter @veyraoss/codex smoke:session`. Two independent Veyra processes create then resume the same native session using the saved safe locator. Each stage begins with a failing fixture test and verifies implementation, protected files and Git diff scope afterward. The second stage must recall a marker from native-session context that is absent from the Veyra reference. The test project is removed on success or failure; native history stays under native-client ownership. Default tests run this same harness against an isolated fake executable and never require an account/network.
