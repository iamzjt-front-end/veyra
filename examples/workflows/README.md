# Workflow examples

Each file in `v1/` is a complete workflow with a relative editor-schema reference. Load it as YAML; no TypeScript changes are needed. Start by validating a file from the Veyra repository root:

```bash
pnpm ve -- workflow list
pnpm ve -- workflow validate examples/workflows/v1/minimal.yaml
pnpm ve -- workflow validate examples/workflows/v1/parallel.yaml --json
```

Validation only reads files. Add `--config /absolute/project/veyra.yaml` to also check required bindings; with that flag, relative workflow paths resolve from the config directory, so use an absolute workflow path for examples in another checkout.

| Example                              | Concepts                                                    | Execution prerequisites                                                             |
| ------------------------------------ | ----------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| [minimal](v1/minimal.yaml)           | Simple command sequence                                     | Node.js; no agents.                                                                 |
| [approval](v1/approval.yaml)         | Explicit approved/rejected branches                         | Node.js; a human decision before continuing.                                        |
| [review loop](v1/review-loop.yaml)   | Verification/review branching and one repair                | Executor/reviewer bindings and the target project's test script.                    |
| [inputs](v1/inputs.yaml)             | Select typed command evidence at a human gate               | Node.js; no agents.                                                                 |
| [parallel](v1/parallel.yaml)         | Independent command children and bounded join               | The disposable `test/fixtures/minimal-project` layout.                              |
| [router](v1/router.yaml)             | Route a saved verification result                           | Node.js; no agents.                                                                 |
| [subworkflow](v1/subworkflow.yaml)   | Load a child file and map its result                        | Keep [its child](v1/subworkflow-child.yaml) beside the parent.                      |
| [consensus](v1/consensus.yaml)       | Independent reviews, required checks and judge              | The agent bindings and check commands declared in that file.                        |
| [policy](v1/policy.yaml)             | Approval, deadlines, retry, concurrency and lifetime limits | The disposable fixture layout plus a human decision.                                |
| [capabilities](v1/capabilities.yaml) | Explicit role/capability requirements and a plan gate       | An `analysis` binding advertising planner, reasoning and structured-output support. |

To run an example, provide a version 1 `veyra.yaml` in a disposable project. Command-only examples can use `agents: {}`; `workflow.use` may name the chosen file, or use `--workflow` to override it. For example, after replacing the absolute paths with your project and this checkout:

```bash
pnpm ve -- run "Check the disposable project" \
  --config /absolute/project/veyra.yaml \
  --workflow /absolute/veyra/examples/workflows/v1/minimal.yaml \
  --non-interactive
```

Run commands from the project specified by that config, with its scripts and dependencies already installed. Review all configured commands first. Agents and command children share that working directory; parallel examples require independent work, not concurrent edits to the same files. Veyra does not create isolated worktrees for these examples yet.

A human gate returns exit code 3 and a saved run/approval ID. Inspect it with `ve status --config <file> --json`, then explicitly approve or reject with `ve resume --config <file> --approve|--reject`. Resume uses the saved workflow, inputs, counters and events, including resolved children and completed parallel/review work. Editing a source file does not change an existing run.

Malformed definitions are rejected before execution. Intentional repair cycles are accepted but spend finite retry budgets and a root lifetime limit of at most 1000 step starts. Missing dynamic inputs fail at the dependent step; validation cannot predict future agent output. See the [DSL reference](../../docs/WORKFLOWS.md), [preset guide](../../docs/PRESETS.md) and [CLI reference](../../docs/CLI.md) for the precise contracts.
