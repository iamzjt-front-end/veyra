# Gemini CLI executor

`GeminiCliAdapter` is exported by `@veyraoss/gemini` and registered as `gemini-cli`. It shares the existing Gemini package with the [API adapter](GEMINI.md), with separate implementation modules, provider names and authentication paths. Process lifecycle belongs entirely to Runtime; Core has no provider import.

```yaml
agents:
  executor:
    provider: gemini-cli
    # model: an-accessible-model-or-native-alias
    options:
      timeoutMs: 900000
```

The [development configuration](../examples/providers/gemini-cli.yaml) combines this executor with separately configured reasoning agents. Install and configure the native CLI yourself; the adapter never installs it or starts login. The current implementation follows the official [v0.58.0 CLI reference](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/docs/cli/cli-reference.md) and [headless contract](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/docs/cli/headless.md). This executable is not installed in the current validation environment, so live provider execution remains unverified. Default tests use injected processes and a real disposable Node child.

## Invocation and native policy

Runtime invokes `gemini --prompt <fixed instruction> --output-format json --approval-mode default`, plus optional `--model=<model>`. The complete task goes through stdin and EOF without a shell. The prompt preserves `AGENTS.md`/`GEMINI.md`, scopes work to the task and prohibits delegation, background jobs, commits, publishing and credential access. JSON Unicode escapes prevent task data from triggering the CLI's [native file inclusion preprocessing](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/nonInteractiveCli.ts); the decoded task text stays unchanged.

The adapter adds no tool permissions and exposes no arbitrary argument, YOLO, trust-bypass, session-resume or model-fallback switch. Configure required permissions deliberately in the native policy. Headless native approval requests become denials; Veyra approval does not grant native tool permission. Native instructions, configuration, hooks, MCP servers and extensions still apply. These settings can execute code; use a trusted workspace. Prompt instructions are not a sandbox. See the native [configuration/policy composition](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/config/config.ts).

Veyra does not change native login files, history, telemetry or caches. Native session retention/settings remain effective. Each Veyra invocation starts fresh without resuming a native session; Veyra resume supplies saved workflow context. Native settings own session-turn limits and internal retries; Runtime enforces an outer deadline, while workflow policy controls Veyra retries.

## Results and limits

The native JSON envelope's `response` must itself be JSON with exactly `status` (`success`, `failure`, `needs_input`), non-empty `summary`, `changedFiles` and `commandsRun` string arrays. Free text, Markdown fences, extra fields and malformed output fail. This is prompt-requested structured content with strict local validation; Gemini CLI does not offer a schema-constrained output flag here. Changed files and commands are claims requiring independent verification.

Native errors, nonzero exits, signals and Runtime failures cannot become success. Authentication exit 41 becomes `needs_input`; invalid input/config, turn limits and cancellation have actionable codes. Rejected tool decisions pause execution. Any native warning conservatively fails as incomplete, because hooks and loop/turn limits can stop a run with exit zero. See the official [JSON types](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/core/src/output/types.ts) and [error handling](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/utils/errors.ts).

The prompt is capped at 256 KiB after escaping; assembled JSON at 1 MiB; structured response at 256 KiB; each result list at 1024 entries. Runtime independently retains bounded stdout/stderr prefixes. Results include execution/attempt/parent identity, timing, process exit/signal/termination reason and truncation flags. Known environment credential values and bearer strings are redacted, including JSON-encoded forms. Credential fields/environment objects are masked in the task. Credentials known only to the native CLI and arbitrary unknown secret strings cannot be guaranteed detectable in native logs.

Supported options are `id` (binding name), `model` (native default if omitted), `executable` (default `gemini`), `workingDirectory`, `timeoutMs` (1–86400000 ms, default 15 minutes) and `maxOutputBytes` (0–1 MiB per stream, default 64 KiB). Per-run directory/timeout/signal override defaults. Unknown options fail.

Usage sums each model's reported `prompt`, `candidates`, `total`, `cached` and `thoughts` into the corresponding protocol counts. Prompt already includes cache; candidate output excludes thought tokens. Nested role metrics are not counted again. Each aggregate requires valid counts for every reported model; missing, invalid or overflowing fields and unknown costs stay absent. See [native metrics](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/core/src/telemetry/uiTelemetry.ts).

## Offline readiness

`describe()` advertises executor and code-execution/tool-use/local-cli/structured-output. Doctor runs only `--version` and `--help` under one five-second deadline. Missing binaries/required flags are unavailable; incomplete probes are unknown. No inference request, credential-file read or login is used to probe access.

With `GEMINI_API_KEY` present and no alternate native-auth environment hint, readiness is `ready` at **configuration** scope only. Native settings can override that authentication choice. Google login, Vertex/ADC, gateway configuration and absent environment credentials are reported as **unknown**, not as invalid login. Saved keys, `.env` and native login may still allow execution. The native CLI owns authentication selection and actual access checks; see its [non-interactive authentication flow](https://github.com/google-gemini/gemini-cli/blob/v0.58.0/packages/cli/src/validateNonInterActiveAuth.ts). Run `gemini` directly to configure or diagnose authentication before retrying a paused step.
