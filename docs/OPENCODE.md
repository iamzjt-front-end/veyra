# OpenCode executor

`@veyra/opencode` exports `OpenCodeAdapter`, registered as the `opencode` built-in. Runtime owns every process, directory, stream, timeout and cancellation operation. Core remains provider-neutral. Install OpenCode and configure its normal provider access before using the [development example](../examples/providers/opencode.yaml).

```yaml
agents:
  executor:
    provider: opencode
    # model: provider/model
    options:
      timeoutMs: 900000
```

The adapter targets the checked [1.18.29 release](https://github.com/anomalyco/opencode/releases/tag/v1.18.29) contract and accepts stable 1.x versions from 1.18.29 onward. Earlier versions, prereleases and new major versions are rejected. A version preflight runs before every task, so an unsupported executable cannot create a session through this adapter.

## Native execution and permissions

Runtime invokes `opencode run --format json --dir <absolute cwd> --title "Veyra executor" --no-auto --no-thinking`, plus optional `--model=<provider/model>`. Task data goes through literal stdin and EOF, outside argv. Runtime cwd and native `--dir`/`PWD` agree even when the inherited shell directory differs. The [native run implementation](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/cli/cmd/run.ts) consumes stdin, emits JSONL events and uses an in-process server. Veyra does not attach remotely or launch a listening server.

Every invocation sets `OPENCODE_DISABLE_SHARE=true`, `OPENCODE_AUTO_SHARE=false`, `OPENCODE_DISABLE_AUTOUPDATE=true` and `OPENCODE_DISABLE_TERMINAL_TITLE=true`. The native [sharing implementation](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/share/share-next.ts) checks the disable switch before creating or synchronizing shares, even if settings request automatic sharing. Version/readiness probes additionally disable remote model-catalog fetching.

The adapter preserves native instructions, authentication, settings and tool permissions. It exposes no automatic permission approval, session continuation, thinking output, custom agent fallback, external attachment or arbitrary arguments. Native permissions allow many tools by default; `--no-auto` only rejects requests that need approval. Review [native permissions](https://opencode.ai/docs/permissions/) and use a trusted workspace. Native plugins, hooks, MCP, local history and provider retries remain effective. Veyra does not edit native settings or impose a filesystem sandbox.

The prompt requires `AGENTS.md` and native project instructions, scoped edits and truthful command/file claims. It prohibits subagents, background jobs, commits, pushes, publication, deployment and credential access. Prompt instructions are not an enforcement boundary. Veyra approval does not grant native tool permissions. Resume starts a fresh native invocation with saved Veyra context.

## Results and limits

The parser correlates session and message/part identities, accepts completed text from the final step with finish reason `stop`, and validates exactly `status` (`success`, `failure`, `needs_input`), non-empty `summary`, `changedFiles` and `commandsRun` string arrays. This JSON is requested through the prompt and checked locally; it is not native schema-constrained output. Unknown/malformed events, mismatched identities, unfinished iterations and conflicting replays fail. Execution claims require independent deterministic verification.

Authentication errors, HTTP 401/403 and native permission auto-rejection become `needs_input`. Other provider errors, tool failures, unsuccessful exits, signals, timeout and cancellation have stable codes. Tool failures conservatively fail the invocation even if the model later claims success. See the native [part/error schemas](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/schema/src/v1/session.ts).

The prompt is capped at 256 KiB; each event at 1 MiB; the stream at 10000 nonblank records; final text at 256 KiB; result lists at 1024 entries. Results include Veyra execution/attempt/parent identity, timing and bounded process diagnostics. Parsing continues beyond retained stdout prefixes. Oversized or incomplete streams cannot pass. Known environment credential values, JSON-encoded forms and bearer strings are masked. Credential fields/environment objects are removed from the task. Secrets known only to native configuration and arbitrary unknown secret strings remain outside this detection guarantee.

Usage sums unique step-finish records: effective input includes uncached input and cache read/write; output and reasoning stay separate; total uses the reported native total. Missing/invalid components or overflowing sums stay absent. Replays do not double count. Native zero cost can mean missing pricing, so native cost is not promoted to protocol cost. See [native accounting](https://github.com/anomalyco/opencode/blob/v1.18.29/packages/opencode/src/session/session.ts).

Supported options are `id`, `model` (optional `provider/model`; otherwise native default), `executable` (default `opencode`), `workingDirectory`, `timeoutMs` (1–86400000 ms, default 15 minutes), and `maxOutputBytes` (0–1 MiB per stream, default 64 KiB). Unknown fields fail. Per-run cwd/timeout/signal override defaults. One Runtime deadline covers version preflight and execution; timers/listeners are disposed afterward.

## Readiness and verification

Doctor runs `--version` and `run --help` under one five-second deadline. Help is accepted on stdout or stderr; the tested release writes it to stderr. Local readiness establishes supported version/flags only. Authentication, network and model access are untested. Missing executables/unsupported releases are unavailable; interrupted or malformed probes are unknown. Configure native access with `opencode auth login` or the provider's standard environment. No credential file, login or inference is used for readiness.

Default tests inject native events and use a disposable Node child for real Runtime stdin/output verification. They cover correlation, replay accounting, limits, errors, permissions, redaction and deadlines without OpenCode or a network. The guarded smoke is separate:

```bash
pnpm --filter @veyra/opencode... build
VEYRA_LIVE_SMOKE=1 pnpm --filter @veyra/opencode smoke
# Optional native model:
VEYRA_LIVE_SMOKE=1 pnpm --filter @veyra/opencode smoke -- provider/model
```

The smoke creates a disposable Git fixture with a failing greeting test and native policy allowing instruction/source reads and editing only `src/message.js`. Independent syntax/tests and Git checks require the exact source change, preserved tests/config/instructions and no untracked files. Cleanup runs on success or failure. Global/managed native settings still apply, and native history may remain outside the fixture. A pinned temporary 1.18.29 installation reached the configured provider, which rejected its credentials with HTTP 401 (`Invalid API Key`); live success remains blocked. See [M4.7](TODO.md#m47--opencode-executor) for the exact command and unblock action.
