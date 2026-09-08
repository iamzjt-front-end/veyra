# CLI commands

The public executable is `ve`. In this checkout, build the workspace and use `pnpm ve -- <command>` from the repository root. For another project, pass `--config /absolute/project/veyra.yaml`; paths and execution resolve relative to that config's directory. Public package installation is a later milestone.

## Inspect workflows before running

```bash
pnpm ve -- workflow list
pnpm ve -- workflow validate examples/workflows/v1/parallel.yaml
pnpm ve -- workflow validate dev --config /absolute/project/veyra.yaml --json
```

`workflow list` reads the four built-in definitions and lists their names and required agents without loading project configuration. `workflow validate <preset-or-file>` resolves nested workflows and checks the strict DSL and graph before reporting the effective start, step count, required bindings and unreachable-step warnings. It does not execute shell commands, construct adapters, contact providers, resolve approvals or create run state. Intentional cycles are valid; their execution remains subject to saved retry and lifetime limits.

Without `--config`, file paths resolve relative to the current directory and even an existing `veyra.yaml` is left unread. The output explicitly says agent configuration was not checked. With `--config`, the workflow path resolves relative to that configuration file and all missing reachable agent bindings and undeclared providers are reported together, including namespaced child step IDs. This checks bindings and built-in/declared plugin names, not module availability/runtime versions, credential validity, model access, external service availability or project command behavior; use `ve doctor` for environment/readiness checks. No plugin code is imported. Graph and configuration errors return exit code 2. Unreachable nodes produce warnings and do not require adapters; all potentially reachable branches and group children do.

`--json` returns a `workflow.list` or `workflow.validation` object. Binding errors set `valid: false` with `diagnostics`; loader/argument errors use the standard `error` object. The same binding preflight runs before `run` constructs any adapter or creates state, and before adapter construction on resume. Programmatically injected adapter factories own support for their custom providers; validation never invokes those factories.

See the [workflow example gallery](../examples/workflows/README.md) for complete simple, branching, parallel, approval, subworkflow, judge and policy definitions. Select a file for execution with `ve run "goal" --workflow <path> --config <file>`. The CLI delegates execution and resume to the shared Core model.

## Initialize and run

```bash
pnpm ve -- init
pnpm ve -- doctor
pnpm ve -- run "repair the failing test" --non-interactive
```

`init` creates `veyra.yaml` with the `dev` preset, an OpenAI planner/reviewer, a Codex executor, and a three-repair default. The default model matches the repository example, `gpt-5.6-sol`; use `--model <model>` to choose another available Responses/structured-output model. The default model's API capabilities were checked in the [official model reference](https://developers.openai.com/api/docs/models/gpt-5.6-sol). Actual API access requires the user's credentials and model access.

Initialization prints setup guidance for `OPENAI_API_KEY` and the installed Codex login. It appends only the Veyra state/run ignore block to `.gitignore`, preserving existing rules. An existing config is preserved unless `--force` is explicitly supplied; symlink/non-regular destinations are refused even with force. Replacement files use a same-directory temporary file and rename. Config and ignore-file updates are separate operations, so an I/O error may require completing the remaining setup step manually.

`run <goal>` loads configuration, loads the selected workflow, constructs only referenced adapters, and delegates execution to Core. `--workflow <preset-or-file>` overrides the configured workflow for this run. The supplied goal and selected workflow are saved. The adapter composition supports OpenAI, OpenAI-compatible/local endpoints, Codex, Claude, Claude Code, Gemini API/CLI and OpenCode without binding workflow roles to a provider; unregistered providers produce an actionable error. Command-only workflows can use an empty agents object and require no provider credentials. See [compatible endpoint setup](OPENAI-COMPATIBLE.md) for explicit base URLs and output-mode support.

Review the chosen workflow's verifier commands before running it in a project. The built-in dev preset uses `pnpm check`, `pnpm test`, and `pnpm build`; a project with different commands needs its own workflow. Coding agents modify the configured project directory under their own permission system. Optional [worktree isolation](WORKSPACES.md) provides a separate working directory for each run.

The [preset reference](PRESETS.md) lists required agent bindings, commands and retry limits. `bugfix` requires a project-specific `test:targeted` script. `review` uses a Git diff and checks without an executor; `research` uses a researcher and synthesis judge without shell commands. Both finish at a human report gate, so non-interactive execution returns exit code 3 until its report is acknowledged.

[Workflow execution policies](WORKFLOWS.md#workflow-execution-policies) enforce saved deadlines, retry/backoff, group concurrency and lifetime limits. Policy approval gates use the same status/resume/approve commands as explicit human nodes. Token/cost budgets require a programmatically injected Core `BudgetHook`; the CLI does not provide accounting or infer prices and fails before agent execution when a workflow declares a budget without that hook.

## Inspect saved runs

Workflow loading resolves and snapshots nested `subworkflow` references before constructing providers, including agents used only inside a child. Status/approval IDs use namespaced child steps such as `suite/gate`; the existing resume/approve commands handle them. Subworkflow boundary events appear in both text and JSON output. Resume executes the saved child definitions even if their source files change or disappear.

```bash
pnpm ve -- status
pnpm ve -- status <run-id> --json
pnpm ve -- review --run-id <run-id>
```

Without an ID, these commands select the active run, or the latest saved run when there is no active pointer. Status includes ID, status, current step, per-step retries, creation/update timestamps, working directory, and any pending approval. Review reads the latest reviewer/pass-fail result plus latest deterministic verification results and artifact references. Neither command reruns a provider. Missing state is reported with instructions to start a run.

## Resume and approve

```bash
pnpm ve -- resume <run-id>
pnpm ve -- resume <run-id> --approve --approval-id <pending-id> --comment "Approved scope"
pnpm ve -- resume <run-id> --reject --approval-id <pending-id>
```

A paused agent can resume with the saved workflow, effective retry limits, and prior evidence. An unresolved human gate requires an explicit `--approve` or `--reject`; plain resume refuses it. A supplied `--approval-id` must match the pending ID. When omitted with an explicit decision flag, the CLI reads the selected run's current ID and passes it to Core. For scripts and remote controls, specify both run and approval IDs to make the target explicit. Approval resolution is saved before execution continues. Rejection follows its explicit branch or fails; it never falls through an approved `next` action.

`status` reports `interrupted` when a saved running run's recorded local owner PID has died, and `unknown` when ownership is missing, foreign or cannot be probed. JSON retains `storedStatus` and includes `ownerStatus` plus `recovery.allowed/reason/checkpoint`; inspection does not alter state or construct providers. A live PID remains `running` and prevents interrupted recovery.

After confirming the previous owner and its child processes stopped, `resume --recover-interrupted` can continue a matched completed attempt boundary or the initial run-start boundary. It can finalize a completed terminal step without executing it again, and can reconcile an interruption during recovery itself. It preserves completed work and retry counts. Unknown agent/command effects, unmatched attempts, pending approvals, corrupt history and unknown owner liveness are refused. Run/store locks and workspace leases coordinate cooperating processes. A competing resume that observed an older boundary is refused with `stale_resume`; inspect the new state before retrying. A stale lease on a fully paused run can be reclaimed with the same flag, including an explicit `--approve` or `--reject`. See [locking and stale owners](LOCKING.md). Completed and failed saved runs do not restart through resume. See [crash recovery and partial-work policy](CRASH-RECOVERY.md).

## Doctor and output

Doctor reports Node/pnpm versions, platform, working-directory access, config/workflow validity, and provider readiness. Referenced workflow agents are required; other configured agents are optional. With no project config, provider checks are optional. An explicitly selected missing config fails the check. OpenAI, Claude and Gemini readiness check only environment-variable presence; they do not validate account/model access or make an API call. Codex and Claude Code use bounded native CLI support/authentication checks. Secrets and login tokens are never printed. Claude planner/reviewer/judge bindings use provider `claude` and `ANTHROPIC_API_KEY`; see the [Claude adapter reference](CLAUDE.md). Executor bindings can use `claude-code` with native login and permission rules; see [Claude Code](CLAUDE-CODE.md). Gemini planner/reviewer bindings use provider `gemini` and `GEMINI_API_KEY`; see [Gemini](GEMINI.md) for its explicit image-input capability.

For configured agents with valid metadata, `doctor --json` also returns a `descriptor` with the adapter's version, model when configured, roles and advertised capabilities, plus the readiness `scope`. These are declarations of implemented adapter behavior, not live model capability tests. `workflow validate` checks the syntax of explicit `requires` constraints; Core matches descriptors before each invocation. See [capability discovery and requirements](CAPABILITIES.md).

Run, resume and doctor accept repeatable `--allow-plugin <provider>` flags to explicitly trust configured local third-party modules for that command. Run/resume load only required providers; doctor reports untrusted required/optional plugins without importing them. Trust must be supplied again on resume. Status, review and workflow validation never load plugins. See [plugin registration and loading](PLUGINS.md) before granting trust: imported code has full host-process privileges, and version pins are not integrity checks.

Output is readable plain text by default, without ANSI styling. `--json` produces one JSON object for inspection/doctor/init/errors; run/resume produce JSON Lines containing persisted events and a final `type: "result"` record. Known credential values are redacted before output and supplied to Core's store. `--non-interactive` explicitly selects the existing prompt-free behavior: human gates pause and never auto-approve. With no arguments, `ve` currently prints help; TUI mode remains planned.

| Exit code     | Meaning                                                                                |
| ------------- | -------------------------------------------------------------------------------------- |
| `0`           | Completed run or successful inspection/setup                                           |
| `1`           | Failed run, required doctor check, or unknown command                                  |
| `2`           | Invalid arguments/configuration/control request, missing state, or setup/storage error |
| `3`           | Run paused, including a human gate                                                     |
| `130` / `143` | CLI interrupted by SIGINT / SIGTERM after cancellation propagates                      |

Ctrl-C/SIGTERM cancel the live run, await active cleanup and persist its failure reason. Repeated signals keep cleanup running; the first signal determines exit 130/143. `status` displays the saved error code/message, including `run_cancelled` and `step_timeout`. Failed cancelled runs cannot resume. See [cancellation semantics](CANCELLATION.md).

Default tests inject fake adapters through the CLI application's service interface; there is no production fake-provider flag or hidden test environment switch. The public entry-point integration also runs a real command-only fixture without credentials.

## Explicit provider routing

Agent nodes may opt into [ordered provider fallbacks](PROVIDER-ROUTING.md). Run text and JSON events report each evaluated candidate and selection reason before invocation. `workflow validate` checks every configured candidate without imports/probes. `doctor` includes per-step `routing` decisions using its collected readiness snapshots; an eligible fallback can satisfy a routed step, while independently pinned providers must still be ready. Configuration errors cannot be hidden by fallback. Omit workflow `routing` and explicitly configure `provider`/`model` to keep a binding pinned.

## Workspace inspection and cleanup

Optional `runtime.workspace.mode: worktree` creates a detached per-run workspace. `run.started` and `status` show the saved directory, isolation mode and starting commit; `status --json` adds `workspace` and `workspaceAvailable`. Resume retains that location even when current configuration changes. `ve workspace remove <run-id> [--config <file>] [--recover-interrupted] [--json]` removes only a clean, unchanged, Veyra-owned worktree for a completed/failed run and preserves its run history. There is no force option. See [workspace policies and boundaries](WORKSPACES.md).

## Command safety visibility

Doctor/run output displays declared native permission controls when an adapter supplies them, including explicit unknown/native configuration modes. Verification startup identifies its trusted command source and host shell permissions. `status` shows the protected operation preview for policy-generated approval gates. See [command safety](COMMAND-SAFETY.md) for the enforced gate behavior, intentional shell syntax and native-provider boundaries.
