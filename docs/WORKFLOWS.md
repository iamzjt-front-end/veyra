# Workflow loading and validation

`@veyra/workflow` owns YAML loading and graph validation. Core receives a `WorkflowDefinition` and does not parse YAML or import the config parser.

- `loadWorkflow(reference, cwd?)` loads `dev`, `bugfix`, `review`, or `research` from the repository's built-in presets, independently of the project working directory. Other references are absolute paths or paths resolved relative to `cwd` (the current directory by default). Pass the config directory when resolving `workflow.use`.
- `parseWorkflow(value)` validates in-memory data and returns an independent graph object.
- `assertWorkflow(definition)` checks the same schema and destinations for callers that already have a typed definition.
- `WorkflowError` identifies the field and, when loading a file, its absolute path. YAML errors include a parser code and line/column without echoing source values.

## Version 1 structure

Required fields are a non-empty `name`, `version: 1`, a non-empty `start` step ID, and a `steps` object. Step IDs and transition outcome keys must be non-empty strings. The start step and every `next`/`on` destination must exist as actual entries in the step map.

| Node type | Fields specific to this type                                    |
| --------- | --------------------------------------------------------------- |
| `agent`   | Required non-empty `agent`, referencing a configured agent name |
| `command` | Required non-empty `run` array of non-empty command strings     |
| `human`   | Optional non-empty `message`                                    |
| `end`     | Terminal node; no transitions or retry settings                 |

Non-terminal nodes may have `next`, `on`, and `retry: { max: <non-negative safe integer> }`. All nodes may have an optional JSON-compatible `metadata` object. Unknown fields and fields belonging to a different node type are rejected. `parallel`, `router`, and `subworkflow` remain in the type vocabulary but are explicitly unsupported in v0.1.

## Outcome transitions

`resolveNextStep(step, outcome)` looks for an exact, own-key match in `step.on[outcome.status]`. If none exists, it uses `step.next`; if neither exists, it returns `undefined`. There are no implicit aliases, wildcard conditions, or LLM decisions inside this function.

The caller supplies the outcome label. The existing presets use `success`/`failure` for verification and `pass`/`fail` for review. Human gates can map `approved`/`rejected`. Agent results may supply other explicit outcome strings. Matching an `on` entry takes precedence over `next`.

```yaml
name: approval-example
version: 1
start: approval
steps:
  approval:
    type: human
    message: Continue with the next step?
    on:
      approved: done
      rejected: stopped
  done:
    type: end
  stopped:
    type: end
```

Loading validates data and does not run commands, call agents, or resolve approvals. Retry counts are validated here; enforcement and execution semantics belong to the later Core/runtime tasks. Repair-loop cycles are intentionally accepted, including the loop in [`dev.yaml`](../workflows/dev.yaml). General cycle safety and richer workflow policies remain planned.
