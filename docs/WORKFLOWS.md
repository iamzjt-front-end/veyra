# Workflow loading and validation

`@veyra/workflow` owns YAML loading and graph validation. Core receives a `WorkflowDefinition` and does not parse YAML or import the config parser.

- `loadWorkflow(reference, cwd?)` loads `dev`, `bugfix`, `review`, or `research` from the repository's built-in presets, independently of the project working directory. Other references are absolute paths or paths resolved relative to `cwd` (the current directory by default). Pass the config directory when resolving `workflow.use`.
- `parseWorkflow(value)` validates in-memory data and returns an independent definition, including inline child definitions. It performs no file loading. `buildWorkflowGraph(definition)` requires resolved children and returns namespaced steps plus scope information for execution and state validation.
- `assertWorkflow(definition)` checks the same schema and destinations for callers that already have a typed definition.
- `WorkflowError` identifies the field and, when loading a file, its absolute path. YAML errors include a parser code and line/column without echoing source values.

## Version 1 structure

Required fields are a non-empty `name`, `version: 1`, a non-empty `start` step ID, and a `steps` object. Step IDs and transition outcome keys must be non-empty strings. The start step and every `next`/`on` destination must exist as actual entries in the step map.

| Node type     | Fields specific to this type                                                            |
| ------------- | --------------------------------------------------------------------------------------- |
| `agent`       | Required non-empty `agent`, referencing a configured agent name                         |
| `command`     | Required non-empty `run` array of non-empty command strings                             |
| `human`       | Optional non-empty `message`                                                            |
| `parallel`    | Required `children` IDs; optional `concurrency` and `failurePolicy`                     |
| `router`      | Required `route` label/reference and `on` map; optional `next` fallback                 |
| `subworkflow` | Required `use` reference or inline `workflow`; optional `inputs` and `outputs` mappings |
| `end`         | Terminal node; no transitions or retry settings                                         |

Non-terminal nodes may have `next`, `on`, and `retry: { max: <non-negative safe integer> }`. All nodes may have an optional JSON-compatible `metadata` object. Unknown fields and fields belonging to a different node type are rejected.

Agent, human and subworkflow nodes support named `inputs` references as described below. Command strings remain explicitly configured shell commands; they do not accept these bindings or interpolate agent output.

## JSON Schema and compatibility

The editor/tooling schema is [workflow-v1.schema.json](../packages/workflow/schema/workflow-v1.schema.json), also available as the package export `@veyra/workflow/workflow-v1.schema.json`. It uses [JSON Schema draft-07](https://json-schema.org/draft-07/draft-handrews-json-schema-validation-01). Its `urn:veyra:workflow:1` identifier is an identifier, not a hosted download endpoint. Package publishing is separate roadmap work; the file is available in this checkout.

For a YAML language server, select the schema with a comment containing its relative or absolute file path, as in the examples below. A top-level `$schema` data field is not part of the Workflow DSL and is rejected. Comments do not alter workflow data.

| Example                                                       | Purpose                                                                                                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| [minimal.yaml](../examples/workflows/v1/minimal.yaml)         | A command-only workflow with no configured providers required.                                                                              |
| [approval.yaml](../examples/workflows/v1/approval.yaml)       | An explicit approved/rejected branch before a read-only command.                                                                            |
| [review-loop.yaml](../examples/workflows/v1/review-loop.yaml) | Executor, deterministic test, reviewer and a single allowed repair; requires configured executor/reviewer agents and a project test script. |
| [parallel.yaml](../examples/workflows/v1/parallel.yaml)       | Independent syntax and test commands for the disposable fixture project, with a bounded join.                                               |
| [router.yaml](../examples/workflows/v1/router.yaml)           | Routes persisted verification success to completion and failure to a human gate.                                                            |
| [subworkflow.yaml](../examples/workflows/v1/subworkflow.yaml) | Calls a reusable child file, maps its verification result, and presents it at a parent human gate.                                          |

Schema validation covers data shape, exact supported node types, required fields, unknown fields, non-blank strings, and retry integer bounds. `parseWorkflow`/`loadWorkflow` additionally check actual start/transition destinations and reject non-JSON in-memory metadata and YAML alias problems. A schema-valid object is not necessarily a valid graph, and validation never grants permission to execute commands. Always use the runtime loader before execution. Tests validate every preset/example and compare invalid structural cases through both validators; Ajv is a development-only dependency, not another runtime parser.

Workflow `version` is independent of the npm package version. The compatibility policy is:

- A reader accepts only implemented schema versions. Missing, string-valued, or future versions fail explicitly at `version`; a file load also identifies its absolute path. There is no silent downgrade or ignored unknown execution field.
- Existing version 1 field meanings and default transition/retry behavior remain stable. An incompatible semantic change requires a new workflow schema version, a separate schema file, migration documentation and tests for old saved runs before rollout.
- Additive optional fields/node kinds may extend version 1 only when existing documents keep the same meaning and the implementation has tests. Such additions must document the minimum supported Veyra package version. Older strict readers can reject them; authors should pin their tool/package version and matching schema.
- Configuration and effective workflow data saved with a run remain authoritative on resume. A package upgrade must not silently reinterpret or migrate that snapshot. Compatibility changes require explicit validation/migration support.
- Reserved node kinds remain rejected until their own implementation tasks pass. Documentation/schema availability alone does not make them executable.

## Named inputs and step outputs

[inputs.yaml](../examples/workflows/v1/inputs.yaml) is a complete provider-free example that presents selected verification fields at a human gate.

The M3.2 implementation in the `0.1.0` development checkout adds explicit, typed data selection to agent and human nodes. Earlier scaffold checkouts do not support `inputs`; use the matching package and schema from this checkout. Existing workflows without `inputs` keep their recent-output context.

```yaml
execute:
  type: agent
  agent: executor
  inputs:
    plan:
      from: plan
      path: /data/instructions
    testExitCode:
      from: verify
      path: /results/0/exitCode
```

The source IDs must exist in the workflow, and their outputs must already be available when this node executes. These selected values arrive as `AgentInput.context.inputs.plan` and `.testExitCode`, or `approval.required.context.inputs` for a human gate. Core uses the latest persisted output for each referenced step, including updated attempts after a repair. Resume reconstructs these values from the saved events and workflow. There is no implicit fallback to a missing field or unexecuted branch; the dependent step fails with `input_unavailable` before an agent or gate executes.

The provider-neutral `StepOutput` contract defines selectable fields:

| Source event / step      | Output fields                                                                                                                      |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `agent.completed`        | `type: agent`, `outcome`, `summary`, optional `data` and `artifacts`. A normalized provider failure uses outcome `failure`.        |
| `verification.completed` | `type: command`, `outcome: success/failure`, `results` and artifact references.                                                    |
| `approval.resolved`      | `type: human`, `outcome: approved/rejected`, optional `comment`.                                                                   |
| `parallel.completed`     | `type: parallel`, `outcome: success/failure`, declaration-ordered `results` containing child states and evidence event references. |
| `router.selected`        | `type: router`, `outcome` (the selected route label), `target` and `selection: static/input`.                                      |
| `subworkflow.completed`  | `type: subworkflow`, `outcome: success/failure`, mapped `outputs` on success or a normalized `error` on failure.                   |

`path` is an [RFC 6901 JSON Pointer](https://www.rfc-editor.org/info/rfc6901/): empty selects the whole normalized output; `/data/instructions` selects a property; `/results/0/exitCode` selects an array element. Escape a property-name `/` as `~1` and `~` as `~0`. Only own JSON properties and existing canonical array indices are read. No code, expression, wildcard, environment lookup, URI fragment or filesystem read is evaluated. Strings remain literal strings, and numbers, booleans, arrays, objects and null retain their JSON types.

Each node permits up to 16 named inputs, names up to 128 characters, and pointers up to 1024 characters/32 segments. The combined resolved input object is capped at 32 KiB of serialized JSON, including keys and escapes; excess data fails with `input_too_large` instead of silently truncating a selected value. Select a smaller nested field or an artifact reference for large results. Artifact paths are data references; selection never loads their file contents.

Automatic `context.steps` still retains the latest eight recent outputs with bounded excerpts and a 48 KiB serialized step-map cap; it is a convenience preview and can omit or truncate data. Explicit bindings select from the original redacted persisted output, including an older step or a small field inside a large result. Core retains older full outputs only for step IDs explicitly referenced by the saved workflow. It does not append the full event history to an agent prompt.

Before invoking an agent, Core records an `agent.input` event containing the resolved, redacted input and authoritative attempt identity. The adapter receives that saved input; later mutation cannot change the event on disk. The complete agent envelope has a 256 KiB limit. Execution controls such as abort signals, timeouts and working directories remain separate runtime arguments. Secrets must stay in provider-native authentication, never workflow data. Human input selections are recorded in the existing approval event.

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

### Branch behavior and graph diagnostics

The current presets and explicit agent outcomes are covered by exact `on` branches plus an optional `next` fallback; no richer condition language is required for these workflows. Conditions stay declarative and deterministic. Core applies execution-status rules before scheduling the selected destination:

| Result                                     | Core behavior                                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Successful agent with a matching outcome   | Uses that exact `on` target before `next`.                                                                                                                                  |
| Successful agent with an unmatched outcome | Uses `next` if configured; a non-empty `on` map without a matching/default path fails with `unhandled_outcome`.                                                             |
| Provider `failure` or reviewer `fail`      | Requires an explicit matching failure branch; `next` cannot silently convert failure into success. A provider failure cannot override its status with an outcome of `pass`. |
| Agent `needs_input`                        | Pauses before any branch executes.                                                                                                                                          |
| Human decision                             | Uses the explicit Core approval API; rejected decisions require an explicit rejected branch and never fall through to an approved action.                                   |

`analyzeWorkflow(definition)` builds the validated execution graph and checks every destination, including destinations inside unreachable branches. Resolve child references through `loadWorkflow` first. It returns `reachableSteps` and `unreachableSteps` in definition order, inserting namespaced child nodes after their call. Reachability follows all possible `on` targets, `next` edges, parallel children and subworkflow starts, terminating on cycles; it does not predict what a provider will report or treat data references as execution edges. Unreachable nodes are diagnostics, not automatic deletions or hard errors. Execution safety still comes from Core's bounded retry policy.

## Router nodes

The M3.5 implementation in the `0.1.0` development checkout supports deterministic routers. Match this checkout's implementation and schema; older strict readers reject the node.

```yaml
choose:
  type: router
  route: { from: classify, path: /data/route }
  on:
    inspect: review
    change: execute
  next: manual
```

`route` is either a static string (for example `route: inspect`) or the same bounded `{ from, path }` reference used by named inputs. References must identify a different non-terminal step and resolve to an available, non-empty string of at most 128 characters. Selection reads already persisted output; it never evaluates expressions or runs a provider. Missing/oversized input fails explicitly. Invalid types/blank/oversized labels fail with `invalid_route`.

`on` must declare 1–32 label-to-step mappings, each label at most 128 characters. Selection is an exact own-key match before the optional `next` fallback. An unmatched value without a fallback fails with `unmatched_route`. Every target is validated against the saved workflow; owned parallel children cannot be entered directly. A static unmatched label without a fallback is rejected before the run starts. A label that happens to equal an existing step ID cannot select that step unless its route is declared. The existing `failure`/`fail` labels retain their meaning for the destination's repair-budget accounting.

Optional agent-assisted routing uses an ordinary preceding agent to propose a label in its normalized result, then references that field as above. Providers remain injected behind `AgentAdapter`; the router does not call a vendor, create another agent interface or accept arbitrary model-proposed destinations. Agent completion/usage remains separate evidence, and deterministic verification outputs can drive the same router. A classifier must still satisfy its own execution/transition contract before routing occurs.

Core saves `router.selected` with the selected label, exact target, selection kind and optional source step/pointer before recording step completion or scheduling the target. Later inputs and human gates can reference that decision. Saved source data and decisions survive pause/resume; a proven completed router checkpoint can continue its successor without repeating classification. Router cycles consume their snapshotted retry budgets and the lifetime step limit.

## Parallel groups

The M3.4 implementation in the `0.1.0` development checkout adds parallel groups to version 1. Use this implementation and its matching schema; earlier scaffold checkouts reject this node.

```yaml
checks:
  type: parallel
  children: [syntax, tests]
  concurrency: 2
  failurePolicy: wait-all
  next: done
syntax:
  type: command
  run: ["node --check src/message.js"]
tests:
  type: command
  run: ["node --test"]
done:
  type: end
```

A group lists 1–32 unique child IDs. Each child must be an `agent` or `command` leaf without `next`/`on`, owned by exactly one group. Start and ordinary branches enter the group, never an owned child. Human gates and nested groups are outside this first parallel implementation. Put approval before or after the group. Explicit child inputs must refer to outputs outside that group; sibling/self/group references are rejected as dependencies between supposedly independent children. The runtime parser checks these graph rules in addition to the editor's structural schema.

`concurrency` is an integer from 1–32 and defaults to the smaller of four and the child count. The scheduler starts children in declaration order as slots become available. All children share the persisted pre-group input context, including queued children and children resumed later. Outputs from the current batch never leak into a sibling's input based on timing. Full audited inputs and results retain each child's identity. Child output references become available to later steps after the group joins.

`failurePolicy` defaults to `wait-all`: every child can finish, then any failure makes the group outcome `failure`. `fail-fast` aborts active peers when the first child failure is persisted, starts no further queued children, and records those queued children as `skipped`. Both policies await active runtime cleanup before completing the group. The parent requires an explicit `on.failure` to continue after failure; `next` is only a success fallback. Failures include provider errors, review `fail`, verification failure, invalid/missing input and exhausted child retry budgets.

External cancellation aborts all active children, drains them, records ordered results, and fails the run with `run_cancelled`. Adapters must honor the provided abort signal; the scheduler cannot terminate arbitrary third-party JavaScript that ignores it. Local process termination remains the runtime's responsibility.

An agent's `needs_input` stops new queued work while active peers finish. If no child failed, the group and run pause. Resume keeps successful children, reruns only `needs_input` children with new attempts, and starts pending children. The same parent group attempt, initial input snapshot and saved retry limits are retained. A child failure takes precedence over a pause. An interrupted group without a fully persisted pause is not replayed automatically; unknown in-flight effects still require the later crash-recovery work.

`parallel.started`, `parallel.child.completed`, `parallel.paused` and `parallel.completed` expose the same provider-neutral state to every surface. Child attempt/start/result events carry `parentStepId`; the run's `currentStep` remains the parent group. Child states are `pending`, `success`, `failure`, `needs_input`, `cancelled` or `skipped`. Each result references its evidence event through `outputEventId`, avoiding copies of large provider/verifier payloads. Aggregation and restored downstream context use child declaration order even when completion events arrive in another order.

Parallel children use the same configured working directory. Authors must choose independent commands/agents and avoid concurrent edits to the same files. Per-child worktree isolation remains M6.1; parallel scheduling does not bypass native provider permissions or create isolated worktrees.

## Subworkflows

The M3.6 implementation in the `0.1.0` development checkout supports reusable child workflows. Use its matching implementation and schema; earlier strict readers reject these definitions.

```yaml
suite:
  type: subworkflow
  use: ./checks.yaml
  inputs:
    plan: { from: planner, path: /data/instructions }
  outputs:
    report: { from: verify, path: /results }
  on:
    failure: inspect
  next: continue
```

`use` selects a built-in preset or a file. File references are relative to the file declaring the call, including nested references. `loadWorkflow` resolves every reference before execution and embeds the resulting definition in the call's `workflow` field. An inline `workflow` can also be supplied directly; when present, that explicit snapshot is authoritative and `use` is only its reference label. Core and the store require resolved graphs and never load child YAML or contact providers to resolve them. Resume uses the saved tree even if the original files change or disappear.

Recursive file references, including symlink aliases, are rejected. Inline/reference nesting is limited to eight calls below the root. Retry limits are frozen recursively into the saved tree. Finite cycles within a workflow retain the existing bounded retry and lifetime-step semantics; recursive call graphs are rejected.

Each invocation is a scope inside the same run and event log. For a call named `suite`, its local `verify` step becomes `suite/verify`; deeper calls add another segment. Within child ID segments, `/` is escaped as `~1` and `~` as `~0`. Root IDs retain their spelling. Ambiguous collisions with author-supplied IDs are rejected before execution. Graph destinations and references are validated within their original scope and rewritten consistently; a child cannot branch into a parent or sibling workflow. Calling the same definition from two nodes creates distinct step identities, contexts and retry keys.

`inputs` selects parent-scope outputs with the existing bounded reference format. The resolved, redacted map is saved in `subworkflow.started` before child execution and delivered to child agents and gates as `context.workflowInputs`. Each child scope otherwise starts with empty recent output context. Child node `inputs` and router references select previous outputs in that child scope. Parameters and selected output mappings each allow up to 16 names and 32 KiB combined JSON, with the same name/pointer limits as ordinary bindings. Commands do not interpolate these values.

`outputs` selects child-scope outputs when the child completes. Missing/oversized mappings fail the call. A successful call exposes only that mapped object through its own `StepOutput.outputs`; it does not dump child context into the parent. Omitted mappings produce an empty output object. Full child evidence remains under namespaced step IDs in the event log. An outer caller accesses a deeper result through each intervening call's declared output mapping.

An `end` or successful leaf finishes only its current scope. A child can handle a failure through its own explicit branch. Otherwise `subworkflow.completed` records the child error, and the caller receives outcome `failure`. The caller must provide `on.failure` to recover; `next` never hides child failure. Cancellation, broken persistence, event-subscriber failure and the lifetime execution limit stop the whole run and cannot be caught as ordinary child errors.

Human gates, agent input pauses and parallel pauses inside children propagate to the containing run. The saved `currentStep` is the qualified child step; `subworkflow.paused` events expose the enclosing calls. Approval uses the same pending ID and Core/CLI APIs. Resume retains open call attempts and mapped parameters, restores each scope independently, and continues the actual child step. A terminal child approval stays paused after the decision until resume closes the child scope and follows the parent's branch. Completed child work is not repeated. A new invocation reached by a call retry starts a fresh context but retains lifetime per-child retry counters.

Explicit interrupted recovery also recognizes proven completed child leaf/end checkpoints and returns through their enclosing calls without repeating effects. Unknown in-flight work and partially written boundaries remain refused. Children share the run's configured working directory and provider instances; context namespacing is not filesystem isolation. Per-child worktrees remain M6.1. A child workflow may contain parallel leaf groups; subworkflow nodes are not themselves parallel children in this implementation.

## v0.1 retry policy

Each executable step (`agent`, `command`, `parallel`, `router` or `subworkflow`) has an independent repair budget. Parallel children and namespaced child workflow steps also have individual budgets. Resuming an unfinished group/call retains its parent attempt while retried children spend their own budgets; a fresh child scope starts with normal entry semantics. Its explicit `retry.max` wins; otherwise `config.runtime.maxFixIterations` supplies the limit. `withRetryDefaults()` copies and validates the workflow, materializing these effective limits throughout the saved tree. Resume uses that snapshot even if the current config changes.

`nextRetry()` evaluates the next execution without mutating state:

- The first normal entry uses count `0` and is allowed even when the maximum is zero.
- The first entry reached through `failure`/`fail` is a repair and uses count `1`.
- Every revisit, including resuming a paused agent, increments that step's count. Successful cycles therefore consume a finite budget too.
- No execution occurs when it would exceed the maximum. Counters are saved before invoking the runtime/verifier; interrupted work never refunds a used budget automatically.

For default `dev`, `fix.retry.max: 3` allows exactly three fix calls after the initial executor call. The repeated verifier has its own default budget: one initial check plus three repeats. A step override changes only that step; raising a whole loop's limit may require adjusting other repeated steps too. Human and end nodes do not consume repair budgets. A fixed 1000-step lifetime backstop, retained across resume, additionally bounds very large configured limits.

Exhaustion fails the run with `retry_exhausted` and identifies the step and used/maximum counts. A standalone step or parent group may instead provide `on.retry_exhausted` pointing directly to a `human` gate; Core follows that explicit gate and pauses. An owned parallel child's exhaustion is persisted in its failure result and makes the parent group fail. An ordinary `next` or a non-human exhaustion target cannot turn exhausted retries into success. Approval does not reset budgets.

`retryCounts` stores the per-step used counts. `step.retrying` reports the count, maximum, and attempt identity when a repair starts. Attempt numbers count actual invocations and are distinct from repair counts: the first `fix` call can be attempt `1` and repair count `1`.
