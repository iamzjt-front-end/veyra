# Evaluation harness

The local evaluation harness measures a small, versioned set of code tasks through Veyra's real engine, process runner, Verifier and persisted events. It compares an executor-plus-checks baseline with a planner/executor/checks/reviewer workflow. It is development tooling under `test/evaluation/`, not a provider router or a production benchmark service.

## Tasks and grading

The [version 1 fixtures](../test/fixtures/evaluation/v1/) contain three dependency-free Node projects: return an exact greeting, add signed numbers, and sort a copy without mutating the input. Each has an explicit goal, initially failing acceptance test and project instructions. `src/solution.js` is the only permitted source change. These are intentionally small harness calibration tasks, not representative evidence of broad software-engineering ability.

Every sample gets a fresh temporary project and local Git repository. The evaluator supplies a fixed workflow and its own `.veyra/` state path; the caller's runtime/worktree/state settings are not used. After execution it checks protected source/config/test files, rejects linked/oversized source files and grades the submitted source against pristine acceptance files in a separate temporary directory. Editing participant tests cannot earn a pass. Git metadata and managed `.veyra/` state are excluded from file comparison. Verifier/grader children receive a minimal environment without inherited credentials; native agents and explicitly trusted plugins still have their normal host privileges. This is not a sandbox against malicious code.

A sample passes only if the workflow completed, protected files stayed intact and independent grading passed. Pauses, provider/setup failures, exhausted repairs, invalid state and grading failures remain failed samples in the denominator. No model's success claim replaces the tests. All temporary projects, grading copies and histories are removed in `finally`, including after failed tasks. Reports retain metrics/identities, not prompts, goals, command output, API credentials or complete histories.

## Compare under explicit limits

Both variants use the same initial files, goal, acceptance tests and executor binding, with at most **two executor invocations** and a 60-second step deadline. The single variant executes, verifies and allows one repair after a failed check. The orchestrated variant adds planning and review and permits one repair after failed verification or review. Each sample has a ten-minute cancellation signal and at most 20 step starts; cancellation still depends on trusted adapters honoring it. Human pauses are never automatically approved or resumed.

The extra reasoning calls are a real difference, not free work. Compare total calls, elapsed time and known usage/cost alongside completion. Each task/trial alternates variant order; each sample uses fresh adapter instances. This reduces a simple ordering bias but does not eliminate provider variance, caching, shared native account state, task familiarity or prompt differences. Configured native sessions/tools and model access can still affect results. There is no automatic dollar budget or price lookup; configure provider limits deliberately before a live run.

## Run the scripted calibration

```sh
pnpm evaluate
```

This builds the workspace and runs six samples, with **no live provider calls**. The scripted adapter intentionally solves greeting immediately, repairs addition once, and never repairs the immutable-sort task. Expected completion is 2/3 for each variant, with two executor repairs per variant across the three tasks. These outcomes verify measurement and failure handling; they say nothing about which model or orchestration strategy is better. Scripted usage/cost is absent and reported as unknown, not invented as zero.

After building, invoke the entry point directly for machine-readable JSON or a new output file:

```sh
pnpm exec tsx test/evaluation/manual-evaluation.ts --trials 2 --out /absolute/new-results.json
```

`--trials` accepts 1–10 (six samples per trial). The output file must not exist and is created with owner-only permissions; without `--out`, stdout is the report. Exit 0 in scripted mode means calibration produced a report, not that every task passed. Invalid arguments, setup outside a sample, cancellation of the suite or inability to write the report exit 2. SIGINT/SIGTERM request cancellation and cleanup.

## Opt into configured providers

Use a reviewed config containing `planner`, `executor` and `reviewer` bindings, such as a configured copy of the [GPT + Codex example](../examples/gallery/gpt-codex/veyra.yaml). Replace all model placeholders, install/authenticate required native tools, and check readiness first. The config's provider options and namespace settings are retained. Relative local plugin paths resolve from that config directory; each requires the same explicit `--allow-plugin <provider>` trust decision as the CLI.

```sh
VEYRA_LIVE_EVAL=1 pnpm exec tsx test/evaluation/manual-evaluation.ts --live --config /absolute/providers/veyra.yaml --trials 1 --out /absolute/new-live-results.json
```

Both the environment opt-in and `--live --config` are required. This may consume the configured accounts' quota. The live path always uses configured adapters, with no scripted injection. A plugin may itself be a local tool; the report's `mode: live` identifies the configured-adapter path and does not prove a network model was called. The default tests exercise that path with an explicitly trusted local fixture plugin. Actual model-quality comparisons have **not** been run: required live-provider setup remains blocked in [TODO](TODO.md). Live mode exits 1 if any sample fails, while still producing the complete report; inspect per-sample failure codes and metrics.

## Report fields and interpretation

Reports use `schemaVersion: 1`, suite ID `local-code-v1`, a SHA-256 fixture revision, harness revision and provider-configuration hash, source commit/dirty status, Node/platform/architecture, trial count, order and generation time. Preserve these identifiers when comparing runs; a dirty source checkout is not an immutable experiment. Native/model versions come from recorded adapter descriptors where available; missing metadata stays missing.

Each row contains workflow status, independent grading/protection results, completion, elapsed wall time, observed agent/executor calls, executor repairs, retry events, provider identities and usage. Duration includes adapter construction, execution, state reads and grading, but excludes initial fixture preparation, inter-sample waits and final cleanup. `executorRepairs` is executor calls after the first; `retryEvents` additionally counts retries of verification or other steps. They are deliberately different metrics. `metricsComplete: false` means execution/history inspection did not finish; observed counts are not a claim of complete accounting.

Usage sums reported `totalTokens`, or input plus output only when both exist. Cache/reasoning subtotals are not added again. Missing usage and started calls without completed usage increase unknown-call counts. Cost totals retain each reported currency separately, including an explicit reported zero; unknown costs stay unknown. No exchange rate, model price or native account estimate is invented. The per-variant summary includes all sample outcomes, completion rate, mean duration and executor repairs; use row-level calls and known/unknown costs to assess the added work.

Do not rank models using the scripted calibration, compare different fixture/config/tool versions as if controlled, discard failed attempts, or advertise conclusions from three tiny tasks. For a real comparison, record a representative task set, multiple independent trials, exact provider/model/tool configuration, raw per-sample metrics and uncertainty before making a claim.

## Verification

`pnpm exec vitest run --config vitest.config.ts test/evaluation/evaluation.test.ts` checks real calibration results, initial failing fixtures, repair limits, tampered tests, symlink refusal, cleanup after errors, unknown/mixed-currency usage, trial validation, opt-in guards and the configured local-plugin path. These cases also run in `pnpm test`. See [Testing](TESTING.md) and the [telemetry policy](TELEMETRY.md) for local/remote data boundaries.
