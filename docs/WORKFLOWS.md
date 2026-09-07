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

## JSON Schema and compatibility

The editor/tooling schema is [workflow-v1.schema.json](../packages/workflow/schema/workflow-v1.schema.json), also available as the package export `@veyra/workflow/workflow-v1.schema.json`. It uses [JSON Schema draft-07](https://json-schema.org/draft-07/draft-handrews-json-schema-validation-01). Its `urn:veyra:workflow:1` identifier is an identifier, not a hosted download endpoint. Package publishing is separate roadmap work; the file is available in this checkout.

For a YAML language server, select the schema with a comment containing its relative or absolute file path, as in the examples below. A top-level `$schema` data field is not part of the Workflow DSL and is rejected. Comments do not alter workflow data.

| Example                                                       | Purpose                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [minimal.yaml](../examples/workflows/v1/minimal.yaml)         | A command-only workflow with no configured providers required.                                                                              |
| [approval.yaml](../examples/workflows/v1/approval.yaml)       | An explicit approved/rejected branch before a read-only command.                                                                            |
| [review-loop.yaml](../examples/workflows/v1/review-loop.yaml) | Executor, deterministic test, reviewer and a single allowed repair; requires configured executor/reviewer agents and a project test script. |

Schema validation covers data shape, exact supported node types, required fields, unknown fields, non-blank strings, and retry integer bounds. `parseWorkflow`/`loadWorkflow` additionally check actual start/transition destinations and reject non-JSON in-memory metadata and YAML alias problems. A schema-valid object is not necessarily a valid graph, and validation never grants permission to execute commands. Always use the runtime loader before execution. Tests validate every preset/example and compare invalid structural cases through both validators; Ajv is a development-only dependency, not another runtime parser.

Workflow `version` is independent of the npm package version. The compatibility policy is:

- A reader accepts only implemented schema versions. Missing, string-valued, or future versions fail explicitly at `version`; a file load also identifies its absolute path. There is no silent downgrade or ignored unknown execution field.
- Existing version 1 field meanings and default transition/retry behavior remain stable. An incompatible semantic change requires a new workflow schema version, a separate schema file, migration documentation and tests for old saved runs before rollout.
- Additive optional fields/node kinds may extend version 1 only when existing documents keep the same meaning and the implementation has tests. Such additions must document the minimum supported Veyra package version. Older strict readers can reject them; authors should pin their tool/package version and matching schema.
- Configuration and effective workflow data saved with a run remain authoritative on resume. A package upgrade must not silently reinterpret or migrate that snapshot. Compatibility changes require explicit validation/migration support.
- Reserved node kinds remain rejected until their own implementation tasks pass. Documentation/schema availability alone does not make them executable.

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

Loading validates data and does not run commands, call agents, or resolve approvals. Repair-loop cycles are intentionally accepted, including the loop in [`dev.yaml`](../workflows/dev.yaml). Core enforces the retry policy below; richer workflow policies remain planned.

## v0.1 retry policy

Each executable step (`agent` or `command`) has an independent repair budget. Its explicit `retry.max` wins; otherwise `config.runtime.maxFixIterations` supplies the limit. `withRetryDefaults()` copies and validates the workflow, materializing these effective limits in the saved run snapshot. Resume uses that snapshot even if the current config changes.

`nextRetry()` evaluates the next execution without mutating state:

- The first normal entry uses count `0` and is allowed even when the maximum is zero.
- The first entry reached through `failure`/`fail` is a repair and uses count `1`.
- Every revisit, including resuming a paused agent, increments that step's count. Successful cycles therefore consume a finite budget too.
- No execution occurs when it would exceed the maximum. Counters are saved before invoking the runtime/verifier; interrupted work never refunds a used budget automatically.

For default `dev`, `fix.retry.max: 3` allows exactly three fix calls after the initial executor call. The repeated verifier has its own default budget: one initial check plus three repeats. A step override changes only that step; raising a whole loop's limit may require adjusting other repeated steps too. Human and end nodes do not consume repair budgets. A fixed 1000-step lifetime backstop, retained across resume, additionally bounds very large configured limits.

Exhaustion fails the run with `retry_exhausted` and identifies the step and used/maximum counts. A step may instead provide `on.retry_exhausted` pointing directly to a `human` gate; Core follows that explicit gate and pauses. An ordinary `next` or a non-human exhaustion target cannot turn exhausted retries into success. Approval does not reset budgets.

`retryCounts` stores the per-step used counts. `step.retrying` reports the count, maximum, and attempt identity when a repair starts. Attempt numbers count actual invocations and are distinct from repair counts: the first `fix` call can be attempt `1` and repair count `1`.
