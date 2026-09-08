# Author a workflow with a human gate

This tutorial runs a real Node version check, persists its evidence and pauses for a human decision. It uses no model, credentials or project edits. First [build the checkout](../DEVELOPMENT.md). In a new disposable directory, create these two files.

`veyra.yaml`:

```yaml
version: 1
project:
  name: workflow-workshop
workflow:
  use: ./workflow.yaml
agents: {}
runtime:
  maxFixIterations: 0
```

`workflow.yaml`:

```yaml
name: inspect-and-approve
version: 1
start: inspect
steps:
  inspect:
    type: command
    run:
      - node --version
    timeoutMs: 5000
    on:
      success: approve
  approve:
    type: human
    message: Accept the recorded Node version check?
    inputs:
      evidence:
        from: inspect
        path: /results/0/stdout
    on:
      approved: done
      rejected: declined
  done:
    type: end
  declined:
    type: end
```

From the Veyra checkout, replace `/absolute/workshop` with that directory:

```sh
pnpm ve -- workflow validate /absolute/workshop/workflow.yaml --config /absolute/workshop/veyra.yaml
pnpm ve -- run "Inspect the local Node runtime" --config /absolute/workshop/veyra.yaml --non-interactive
pnpm ve -- status --config /absolute/workshop/veyra.yaml --json
pnpm ve -- review --config /absolute/workshop/veyra.yaml --json
```

Validation checks the graph and bindings without executing commands. The run checks Node through Verifier, then exits **3**, meaning paused at a gate. This is expected; do not chain the inspection commands after it with `&&` in a script. `status` identifies the run and pending approval; `review` exposes the saved verification evidence. The gate input selects the actual command stdout through a JSON Pointer, without shell interpolation or rereading a mutable file.

After inspecting the evidence, explicitly approve using the returned run and approval IDs:

```sh
pnpm ve -- resume <run-id> --config /absolute/workshop/veyra.yaml --approve --approval-id <approval-id> --comment "Checked Node version"
```

Resume finishes with exit 0 without rerunning `inspect`. Use `--reject` instead to take the `declined` terminal branch; that branch deliberately completes the workflow with a recorded rejection. If rejection should fail your workflow, omit its transition instead. A gate never treats `--non-interactive` as approval. Trust the persisted IDs and evidence, not a guessed active run.

## Change the workflow deliberately

Change `node --version` to `node -e "process.exit(1)"` and start a **new** run to exercise failure: it exits 1 before the approval because there is no successful result to accept. Change `success: approve` to a missing destination and validation exits 2 before execution. Restore the original before continuing. Editing YAML does not alter a paused run's saved workflow.

For an agent step, add a named binding under `agents` in config and a `type: agent` node referencing it. The [plugin tutorial](PLUGIN.md) demonstrates one without a network. Use explicit `on` outcomes and bounded retries when adding repair loops. Parallel children need independent work; named inputs require an already-produced result. See [DSL](../WORKFLOWS.md), [presets](../PRESETS.md) and [approval semantics](../APPROVALS.md) before expanding this example.
