# Claude Code executor

`@veyra/claude-code` runs the installed `claude` executable through `@veyra/runtime` and implements the provider-neutral executor contract. It is registered as the CLI built-in provider `claude-code`. The separate [Claude API adapter](CLAUDE.md) supplies reasoning roles and uses its own API credential.

```yaml
agents:
  executor:
    provider: claude-code
    # model: an-accessible-model-or-native-alias
    options:
      timeoutMs: 900000
      maxTurns: 20
      # Explicit native tool grants; choose rules appropriate to this project.
      allowedTools: [Read, Edit, Write, "Bash(pnpm check)", "Bash(pnpm test)", "Bash(pnpm build)"]
```

See the [complete development configuration](../examples/providers/claude-code.yaml). The config package treats provider names/options as data; the CLI composes adapters through the [SDK registry](PLUGINS.md). Core has no Claude Code import.

## Invocation and permissions

The adapter sends a literal UTF-8 task envelope through stdin and EOF, without a shell. It invokes `--print --input-format text --output-format json --no-session-persistence --permission-mode default --max-turns <count> --json-schema <schema>`, plus an optional model and explicitly configured `allowedTools`. The native JSON contract and available flags were checked against Claude Code 2.1.159, local help and the official [programmatic CLI guide](https://code.claude.com/docs/en/headless).

Veyra adds no tool grants by default and explicitly selects native `default` permission mode. It exposes no bypass-permission option, arbitrary extra arguments, session continuation, or fallback to unstructured output. Existing native user/project permission rules still apply; configured `allowedTools` are native allow rules and do not override native deny rules. A denied or deferred tool becomes `needs_input`, even if the model claims success. Native execution errors remain failures. Review and adjust native permissions deliberately before retrying; a Veyra human approval does not automatically grant a Claude tool permission.

The installed CLI loads its normal user/project instructions, settings, hooks, and extensions. Print mode skips its workspace trust dialog, so run it only in a directory whose configuration you trust. Veyra does not enable `--bare`, which would skip normal instruction discovery and native subscription authentication. It does not modify the host's configuration or login files. `--no-session-persistence` disables native resumable session history; it does not disable every native cache, hook, or extension side effect. Veyra's own workflow state remains resumable, and a resumed step starts a new CLI invocation with saved context.

The prompt directs the executor to read `AGENTS.md` and `CLAUDE.md`, preserve project instructions, scope edits to the current task, and report unavailable access or approvals. It prohibits delegation, background jobs, commits, pushes, publishing, deployment, and credential-file access. Prompt instructions are not a filesystem sandbox. Worktree isolation remains a separate TODO; callers select the working directory intentionally.

## Results and limits

The provider's final `result` envelope must report success without `is_error`, incomplete termination, or permission denials and contain a valid `structured_output`. That object has exactly `status` (`success`, `failure`, `needs_input`), non-empty `summary`, `changedFiles`, and `commandsRun`. File and command lists are execution claims; the deterministic verifier independently checks them. A zero exit without valid structured output cannot complete a step. Native turn/budget/schema-generation errors, unsuccessful process exits, runtime failures, timeouts, and cancellation have normalized error codes.

JSON print mode avoids verbose conversation/thinking records. The adapter assembles at most 1 MiB of final JSON while runtime independently retains bounded stdout/stderr prefixes, so a complete final response can still be parsed when retained logs are truncated. Structured claims are capped at 256 KiB. `data.process` contains exit code, signal, duration, retained diagnostics, truncation flags and optional termination reason. Known environment credential values and bearer strings are masked in input/results/diagnostics; credential-shaped fields and environment objects are removed from input context. Unknown secrets in arbitrary native output are not guaranteed detectable; centralized redaction remains a hardening TODO.

Options are strictly validated: `id` (binding name), `model` (otherwise native default), `executable` (otherwise `claude`), `workingDirectory`, `timeoutMs` (1–86400000 ms, default 15 minutes), `maxOutputBytes` (0–1 MiB per stream, default 64 KiB), `maxTurns` (1–1000, default 20), and `allowedTools` (up to 32 native rules). Per-run `cwd`, `timeoutMs`, and `signal` override directory/deadline defaults and are never persisted as input. Process-tree shutdown and stream draining belong to Runtime. No automatic retry occurs inside this adapter; workflow policy owns retries.

Execution identity includes parent/attempt metadata and timing. Token usage sums uncached input, cache creation, and cache reads only when all are available valid counts; partial/unknown totals stay absent. Cache-read and output counts are exposed separately. A finite nonnegative native `total_cost_usd` is mapped to USD cost. It is the CLI's reported estimate, which can differ from billing; no price table or fabricated zero is applied. See the official [result contract](https://code.claude.com/docs/en/agent-sdk/typescript#sdkresultmessage).

## Readiness and verification

`describe()` is side-effect free and advertises executor, code-execution, tool-use, local-cli and structured-output support. `checkReadiness()` runs bounded `--version`, `--help` and `auth status` probes under one default five-second deadline. Missing executables, missing required flags, and unauthenticated access are unavailable; malformed/truncated/interrupted checks are unknown. Raw authentication output and account identity are discarded. A local ready result confirms CLI support and reported login only; it does not establish network or model access. `ve doctor` calls this same contract.

Default tests mock CLI results, verify actual runtime transport with a disposable Node child, and exercise malformed output, permission requests, accounting, cancellation/timeouts, limits, redaction and readiness. They do not invoke Claude or use network credentials. For a trusted, installed and authenticated CLI, explicitly opt in:

```bash
pnpm --filter @veyra/claude-code... build
VEYRA_LIVE_SMOKE=1 pnpm --filter @veyra/claude-code smoke
# Optional accessible model/native alias:
VEYRA_LIVE_SMOKE=1 pnpm --filter @veyra/claude-code smoke -- <model>
```

The smoke consumes the installed account's usage. It creates a disposable Git fixture with a failing greeting test and matching `AGENTS.md`/`CLAUDE.md`. Only Read and Edit of `src/message.js` are granted. Independent Node syntax/tests and Git checks verify the exact file change, preserved instructions/tests, and absence of untracked files. The directory is removed on success or failure. Without `VEYRA_LIVE_SMOKE=1`, it exits 2 before any fixture/provider work.
