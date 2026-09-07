# Real closed-loop smoke test

M1.14 supplies an opt-in command for the OpenAI planner → Codex executor → shell verifier → OpenAI reviewer loop. The live acceptance criterion remains unverified until it passes with working credentials; deterministic tests of the smoke tooling are not evidence of live provider access. See [TODO](TODO.md#m114--add-opt-in-real-gpt--codex-integration-smoke-test) for the recorded result.

From an installed checkout, with `OPENAI_API_KEY` already set in the shell and the Codex CLI installed and logged in:

```bash
VEYRA_LIVE_SMOKE=1 pnpm smoke:live
```

The command builds the workspace first. It requires both the explicit flag and a non-empty key before creating a fixture or invoking Codex. It then checks Codex's existing login, creates a disposable Git fixture under the OS temporary directory, and asks for a single greeting-string change. No key is written to config. No repository checkout, provider authentication file, commit, push, package publication, or deployment is part of this smoke test.

The fixture starts with a failing Node.js test. The built-in dev workflow runs `pnpm check`, `pnpm test`, and `pnpm build` after the edit and supplies their evidence to the reviewer. The smoke additionally checks that protected tests/configuration/instructions remain identical, that the build contains the expected greeting, and that only `src/message.js` changed. A passing agent claim or reviewer result alone is insufficient.

## Controls and results

| Environment variable | Behavior                                                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| `VEYRA_LIVE_SMOKE=1` | Explicitly enables live provider use. Absent/other values exit with a blocked report.                                    |
| `OPENAI_API_KEY`     | Existing OpenAI API credential; never copy the value into tracked files.                                                 |
| `VEYRA_SMOKE_MODEL`  | Optional planner/reviewer model; defaults to `gpt-5.6-sol`, matching `ve init`.                                          |
| `VEYRA_SMOKE_KEEP=1` | Retains the temporary fixture and prints its absolute path for debugging. Otherwise cleanup runs on success and failure. |

The executor uses the installed Codex CLI's existing model/auth configuration and permission system. Its timeout is three minutes; each OpenAI call has a one-minute timeout and a 2,048-output-token limit. The whole smoke has a ten-minute cancellation deadline. At most one repair is allowed. SIGINT/SIGTERM requests cancellation and normal cleanup; a forced process kill cannot run cleanup, so any surviving OS temporary fixture needs manual inspection/removal.

Progress event names go to stderr. The final JSON report includes status, reason, run ID when available, per-call usage when supplied by providers, and whether the fixture was removed. Exit codes are `0` for a passed smoke, `1` for execution/assertion failure, and `2` for a missing prerequisite. A retained fixture contains the standard `.veyra/runs/<id>/` state/events and can be inspected using `pnpm ve -- status --config <fixture>/veyra.yaml` or `review`.

## API use and cost

A no-repair success makes two OpenAI API requests (planner and reviewer) and one Codex execution. With one repair, the loop makes at most three OpenAI requests and two Codex executions. SDK automatic retries are disabled. The per-request output cap includes the model's output allowance; insufficient allowance can cause a reported incomplete-response failure. Input usage depends on the accumulated evidence, and Codex may make several internal model calls.

As of September 8, 2026, the [official GPT-5.6 Sol model reference](https://developers.openai.com/api/docs/models/gpt-5.6-sol) lists $4 per million uncached input tokens and $20 per million output tokens. For illustration, 5,000 total input tokens plus 1,000 output tokens would cost about $0.04 for the OpenAI planner/reviewer calls. This is an example calculation, not measured usage or a spending cap. Check current model pricing and the report's actual usage. Codex consumption depends separately on its configured account/model; the smoke does not estimate an unknown cost or create a paid resource.

## Default verification

`pnpm test` and CI never invoke the manual entry point. Five deterministic tests inject providers/readiness checks to cover opt-in/key guards, full local verification and cleanup, missing Codex readiness, protected-file tampering, retained failure evidence, and secret redaction. They make no live provider calls.
