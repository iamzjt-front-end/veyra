# Example gallery

These are complete configurations for the implemented CLI. Copy the contents of one example directory into a disposable project; keep its custom `workflow.yaml` next to `veyra.yaml` when present. Built-in preset names resolve from the installed Workflow package. Examples are validated and exercised with deterministic injected providers and real local commands in the default tests. **Those tests do not establish live model access or provider quality.** Current live smoke blockers remain in [TODO](../../docs/TODO.md).

| Example                                             | Flow and purpose                                                                          | Prerequisites / expected result                                                                                                        |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| [GPT + Codex](gpt-codex/veyra.yaml)                 | OpenAI planner/reviewer, Codex executor, deterministic verify/fix loop                    | `OPENAI_API_KEY`, accessible OpenAI model, native Codex login, project `check/test/build` scripts; completes on verified reviewer pass |
| [Claude + Codex](claude-codex/veyra.yaml)           | Claude planner/reviewer with Codex execution                                              | `ANTHROPIC_API_KEY`, accessible Claude model, native Codex login and the same project scripts                                          |
| [GPT + Claude Code](gpt-claude-code/veyra.yaml)     | OpenAI reasoning with bounded native Claude Code execution                                | OpenAI key/model, native Claude Code login and allowed tools, project scripts; native permission requests may pause                    |
| [Cross-model review](cross-model-review/veyra.yaml) | OpenAI plans, Codex executes, Claude independently reviews                                | Both API keys/models, Codex login and project scripts; no claim that two providers imply a better review                               |
| [Parallel reviewers](parallel-reviewers/veyra.yaml) | Two independent provider reviews after checks, all-pass consensus, human report           | Both API keys/models and `check/test`; pauses with separate reviews and aggregate evidence; no concurrent edits                        |
| [Human approval](human-approval/veyra.yaml)         | Gate before a real read-only Node version command                                         | Node only; exits 3 before the command, then completes only after explicit approval                                                     |
| [Bugfix](bugfix/veyra.yaml)                         | Reproduce, diagnose, fix, targeted check, broad checks, review                            | OpenAI/Codex setup plus project-specific `test:targeted`, `check/test/build`; a passing reproduction is not proof of a reproduced bug  |
| [Research](research/veyra.yaml)                     | OpenAI plans, Claude researches supplied evidence, OpenAI synthesizes, human acknowledges | Both API keys/models; supply source text/references in the goal; no browsing tools are enabled; pauses with synthesis                  |
| [CI / headless](ci-headless/veyra.yaml)             | Provider-free deterministic project checks with a five-minute bound                       | pnpm and `check/test/build`; exit 0 on success, 1 on failed checks; no provider credentials                                            |

Model names are placeholders: replace every `your-openai-model` / `your-claude-model` with a model your account can access and whose adapter supports the needed structured response. Config validation does not test that access. API credentials belong in the environment; native CLIs use their documented login. Veyra does not install native executables, weaken permissions or bypass a rejected tool request. See [authentication](../../docs/AUTHENTICATION.md) and the specific [provider references](../../docs/PLUGINS.md).

## Validate, run and inspect

After [building the checkout](../../docs/DEVELOPMENT.md), use the copied project's absolute config path:

```sh
pnpm ve -- workflow validate dev --config /absolute/project/veyra.yaml
pnpm ve -- doctor --config /absolute/project/veyra.yaml
pnpm ve -- run "Describe a small, concrete change and its acceptance checks" --config /absolute/project/veyra.yaml --non-interactive
pnpm ve -- status --config /absolute/project/veyra.yaml --json
pnpm ve -- review --config /absolute/project/veyra.yaml --json
```

Replace `dev` with `bugfix`, `research` or `./workflow.yaml` according to the selected config. Paths with `--config` resolve from its directory. Read the project's scripts before execution, and start with a disposable project or reviewed [worktree configuration](../../docs/WORKSPACES.md). API planners/reviewers receive supplied run context; they do not automatically read every repository file. Include the evidence needed by the goal.

For gate examples, exit **3** is a deliberate pause. Inspect the returned run and approval IDs, then use:

```sh
pnpm ve -- resume <run-id> --config /absolute/project/veyra.yaml --approve --approval-id <approval-id>
```

Use `--reject` to refuse; examples without a rejection transition fail safely. A research/review report approval acknowledges delivery, not verification success or permission for new changes. `--non-interactive` never approves gates. The [preset reference](../../docs/PRESETS.md) explains retry budgets and evidence limits.

## Use the CI example

Copy both files from `ci-headless` into a disposable checkout of the project being checked. Install that project's dependencies using its lockfile. With an installed, approved Veyra release, the CI command is:

```sh
ve run "Run project checks" --config /absolute/project/veyra.yaml --non-interactive --json
```

Before public publication, use the source `pnpm ve -- run ...` form from the built Veyra checkout. Preserve the command's exit status when redirecting JSON Lines. Do not print all environment variables or upload raw run history by default. Adding an agent later requires deliberate credentials and permissions; a headless flag does not remove those boundaries.

Default gallery tests copy the dependency-free [fixture project](../../test/fixtures/minimal-project/package.json), add real build/targeted scripts, load every config through the CLI, execute shell checks and resume the three gate examples. Provider methods are injected only in test code. They also verify that a negative parallel review stays negative at the report gate and a failing CI check prevents the build. No example execution runs against the contributor's working tree.
