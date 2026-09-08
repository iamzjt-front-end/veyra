# Workflow loading and validation

`@veyra/workflow` owns YAML loading and graph validation. Core receives a `WorkflowDefinition` and does not parse YAML or import the config parser.

- `loadWorkflow(reference, cwd?)` loads `dev`, `bugfix`, `review`, or `research` from the Workflow package's built-in assets, independently of the project working directory. Its build copies the canonical root `workflows/*.yaml` into `dist/presets/`, so presets also work outside the checkout; build before running source-based loader tests. Other references are absolute paths or paths resolved relative to `cwd` (the current directory by default). Pass the config directory when resolving `workflow.use`.
- `listBuiltinWorkflows()` returns an independent list of the preset names accepted by that loader. The CLI exposes this through `ve workflow list`; `ve workflow validate <name/path>` offers read-only DSL/graph validation and optional configuration binding checks.
- `parseWorkflow(value)` validates in-memory data and returns an independent definition, including inline child definitions. It performs no file loading. `buildWorkflowGraph(definition)` requires resolved children and returns namespaced steps plus scope information for execution and state validation.
- `assertWorkflow(definition)` checks the same schema and destinations for callers that already have a typed definition.
- `WorkflowError` identifies the field and, when loading a file, its absolute path. YAML errors include a parser code and line/column without echoing source values.

## Version 1 structure

Required fields are a non-empty `name`, `version: 1`, a non-empty `start` step ID, and a `steps` object. Optional `policy` declares the execution limits described below. Step IDs and transition outcome keys must be non-empty strings. The start step and every `next`/`on` destination must exist as actual entries in the step map.

| Node type     | Fields specific to this type                                                                |
| ------------- | ------------------------------------------------------------------------------------------- |
| `agent`       | Required non-empty `agent`, referencing a configured agent name                             |
| `command`     | Required non-empty `run` array of non-empty command strings                                 |
| `human`       | Optional non-empty `message`                                                                |
| `parallel`    | Required `children` IDs; optional `concurrency` and `failurePolicy`                         |
| `router`      | Required `route` label/reference and `on` map; optional `next` fallback                     |
| `subworkflow` | Required `use` reference or inline `workflow`; optional `inputs` and `outputs` mappings     |
| `consensus`   | Required `reviewers` IDs; optional `mode`, `quorum`, `judge`, `verification`, `concurrency` |
| `end`         | Terminal node; no transitions or retry settings                                             |

Non-terminal nodes may have `next`, `on`, and `retry: { max: <non-negative safe integer>, backoff?: { initialMs, multiplier?, maxMs? } }`. Agent and command leaves also accept `timeoutMs`. All nodes may have an optional JSON-compatible `metadata` object. Unknown fields and fields belonging to a different node type are rejected.

Agent, human and subworkflow nodes support named `inputs` references as described below. Command strings remain explicitly configured shell commands; they do not accept these bindings or interpolate agent output.

M3.9 adds optional agent `instructions`, a non-blank literal string of at most 16,384 characters. Core appends this guidance to the normal context/project instructions and any consensus reviewer/judge instructions, persists it in `agent.input`, and passes that saved envelope to the adapter. There is no template evaluation or shell interpolation. Existing workflows keep their default guidance. This small field makes [built-in preset behavior](PRESETS.md) executable; reusable role profiles remain a later milestone.

M4.1 adds optional agent-only `requires: { role, capabilities }` in this `0.1.0` development checkout. Either property may be omitted. The role is a non-blank string of at most 128 characters; capabilities contain up to 64 unique lowercase identifiers of at most 128 characters each. At invocation, Core checks the pinned adapter's descriptor and every explicit requirement, records `agent.selected`, and uses the required role in the input. Saved requirements remain authoritative on resume. Missing or incompatible metadata fails before invocation. Existing workflows keep their pinned binding semantics. Optional agent-only `routing` enables explicit ordered fallbacks, scoped readiness and user-supplied cost estimates; it requires `requires.role`. See [provider routing](PROVIDER-ROUTING.md) for its schema, fallback boundaries and audit events. See the [capability reference](CAPABILITIES.md) and [complete example](../examples/workflows/v1/capabilities.yaml).

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
| [consensus.yaml](../examples/workflows/v1/consensus.yaml)     | Collects independent reviews and a judge decision after required command evidence.                                                          |
| [policy.yaml](../examples/workflows/v1/policy.yaml)           | Applies approval, deadline, retry, concurrency and lifetime limits to fixture checks.                                                       |

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

Loading validates data and does not run commands, call agents, or resolve approvals. Repair-loop cycles are intentionally accepted, including the loop in [`dev.yaml`](../workflows/dev.yaml). Core enforces the snapshotted retry and lifetime limits below.

### Branch behavior and graph diagnostics

The current presets and explicit agent outcomes are covered by exact `on` branches plus an optional `next` fallback; no richer condition language is required for these workflows. Conditions stay declarative and deterministic. Core applies execution-status rules before scheduling the selected destination:

| Result                                     | Core behavior                                                                                                                                                               |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Successful agent with a matching outcome   | Uses that exact `on` target before `next`.                                                                                                                                  |
| Successful agent with an unmatched outcome | Uses `next` if configured; a non-empty `on` map without a matching/default path fails with `unhandled_outcome`.                                                             |
| Provider `failure` or reviewer `fail`      | Requires an explicit matching failure branch; `next` cannot silently convert failure into success. A provider failure cannot override its status with an outcome of `pass`. |
| Agent `needs_input`                        | Pauses before any branch executes.                                                                                                                                          |
| Human decision                             | Uses the explicit Core approval API; rejected decisions require an explicit rejected branch and never fall through to an approved action.                                   |

`analyzeWorkflow(definition)` builds the validated execution graph and checks every destination, including destinations inside unreachable branches. Resolve child references through `loadWorkflow` first. It returns `reachableSteps` and `unreachableSteps` in definition order, inserting namespaced child nodes after their call. Reachability follows all possible `on` targets, `next` edges, parallel/consensus children, judges and subworkflow starts, terminating on cycles; it does not predict what a provider will report or treat data references as execution edges. Unreachable nodes are diagnostics, not automatic deletions or hard errors. Execution safety still comes from Core's bounded retry policy.

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

## Consensus and judge

The version 1 `consensus` node collects 2–32 independent reviewer leaf steps. Each reviewer has its own configured agent name, which may use the same provider/model or a different injected adapter. Reviewer and judge nodes must be `agent` leaves without `next`/`on`; each belongs to only one parallel or consensus group. Start and transitions enter the group. Explicit child inputs must select outputs outside the group. See [the complete example](../examples/workflows/v1/consensus.yaml).

```yaml
decision:
  type: consensus
  reviewers: [correctness, maintainability]
  mode: judge
  judge: arbitrate
  verification: [verify]
  concurrency: 2
  on:
    pass: done
    fail: inspect
correctness:
  type: agent
  agent: correctness-reviewer
maintainability:
  type: agent
  agent: maintainability-reviewer
arbitrate:
  type: agent
  agent: review-judge
```

This excerpt also requires `verify` (a command step executed before `decision`), `done` and `inspect` steps. Configure the named agents in `veyra.yaml`. Core injects role `reviewer` for independent reviews and `judge` for arbitration; adapter names remain arbitrary. The OpenAI adapter supports both roles using its strict pass/fail output schema. Cross-model review is optional; no provider/model selection is hardcoded in Core.

| Mode                 | Decision                                                                                         |
| -------------------- | ------------------------------------------------------------------------------------------------ |
| `all-pass` (default) | Every reviewer must explicitly pass.                                                             |
| `quorum`             | At least the configured integer `quorum` (1 through reviewer count) must pass.                   |
| `judge`              | After every reviewer completes, the distinct `judge` agent returns the final pass/fail decision. |

Every review must have `status: success` and explicit `outcome: pass` or `fail`. A completed negative review remains a valid vote. Missing/arbitrary verdicts, malformed results, provider exceptions, or exhausted child retries produce a technical `error` vote and fail the aggregate, including in quorum/judge mode. A judge cannot turn missing reviews into success. Group outcome is `pass`/`fail`; failure requires `on.fail` to recover. An ordinary `next` cannot hide a failed decision.

`verification` optionally names up to 16 unique command steps. Listing a step makes its successful completion mandatory before reviewer/judge invocation. Core checks the most recent attempt's persisted verifier result within the current scope, then freezes its event reference. Missing or failed evidence fails the group with `verification_failed` before any reviewer or judge runs. Omitting the list allows review without mandatory command checks. Command evidence is never counted as a vote or replaced by a model's claim. Authors must place checks after the changes they intend to verify; listing evidence does not run a command or infer whether later changes invalidated it.

Review collection uses wait-all scheduling with concurrency 1–32 (default min(4, reviewer count)). Each reviewer sees the same pre-collection context, excluding this group's previous review/judge outputs and artifacts even after a retry. Queued and resumed reviewers do not receive peer conclusions. Their results are independently persisted before a declaration-ordered join. `needs_input` pauses after active work drains; completed positive and negative reviews are retained. A technical error fails the group even if another reviewer needs input. A paused judge resumes with retained reviews instead of invoking reviewers again. Review and judge retries spend their own saved budgets; resuming keeps the parent attempt.

Judge input includes every review and the separate command evidence under `context.consensus`. Each entry references its full persisted event. Evidence up to 4 KiB is supplied directly; larger entries are explicitly marked with a bounded preview. The complete agent envelope remains limited to 256 KiB. Agents can select outside-group values through ordinary `inputs`; commands never interpolate model output. All reviewers share the configured working directory and adapter instances. This is input independence, not filesystem or provider-session isolation (M6.1).

`consensus.started/paused/completed` exposes the saved policy, pause phase and final outcome to every surface. The final `StepOutput` has type `consensus`, mode/threshold, ordered `reviews`, optional `judge`, separate `verification`, and a failure reason when applicable. Each vote identifies the child step/attempt and an `outputEventId`; full review text and data remain in their own redacted `agent.completed` events. Downstream named inputs may select this output or an individual reviewer/judge output.

## Workflow execution policies

M3.8 adds the following optional version 1 fields in the `0.1.0` development checkout. Use the matching schema and implementation; older readers reject these fields. [policy.yaml](../examples/workflows/v1/policy.yaml) is a complete provider-free example for the disposable fixture project.

```yaml
policy:
  stepTimeoutMs: 60000
  retry:
    max: 3
    backoff: { initialMs: 1000, multiplier: 2, maxMs: 10000 }
  concurrency: 2
  approval: { before: [execute] }
  failureStrategy: branch
  maxSteps: 100
```

| Field             | Meaning and limits                                                                                        |
| ----------------- | --------------------------------------------------------------------------------------------------------- |
| `stepTimeoutMs`   | Agent/command deadline, integer 1–86,400,000 ms.                                                          |
| `retry`           | Default repair limit and optional exponential backoff for this scope and descendants.                     |
| `concurrency`     | Cap of 1–32 active leaves in each parallel/consensus group.                                               |
| `approval.before` | Up to 128 unique local executable step IDs that require human approval.                                   |
| `failureStrategy` | `branch` preserves explicit recovery branches; `stop` ends the run when a step/group fails.               |
| `budget`          | Optional `maxTokens` and/or `maxCost: { amount, currency }` ceilings supplied to an injected budget hook. |
| `maxSteps`        | Lifetime limit of 1–1000 starts in this scope, including all descendants.                                 |

`withExecutionDefaults()` copies and validates the workflow, then materializes retry defaults and deadline/concurrency caps throughout its resolved child tree before persistence. A scope's `policy.retry` overrides its inherited retry default; a step's `retry.max` overrides that default, and its explicit backoff overrides inherited backoff. Without a workflow retry policy, `config.runtime.maxFixIterations` supplies the default. Deadlines and concurrency caps use the smallest applicable parent, child and leaf/group limit, so a child cannot weaken an ancestor's cap. A request-level timeout may tighten the saved deadline. Resume uses the saved policy rather than edited YAML or new config defaults.

A leaf deadline starts before resolving and persisting its input. It covers the whole agent invocation or complete command list, rather than resetting for each command. Runtime receives an abort signal and timeout; Core waits for active cleanup before reporting `step_timeout`. Native processes are cancelled and drained by Runtime. Third-party adapters must honor cancellation: JavaScript that ignores the signal cannot be forcibly stopped by Core. Retry backoff occurs before the leaf deadline begins, is recorded as `step.retrying.delayMs`, and is cancellable, including when a fail-fast peer stops the group. Delays have no jitter: `min(maxMs, initialMs × multiplier^(retryCount − 1))`. Initial/capped delays are integers from 0–3,600,000 ms; multiplier is an integer from 1–32, default 2; the default cap is the greater of 30,000 ms and the initial delay. No configured backoff means no delay.

Approval policy compiles into ordinary persisted human nodes. Every graph entry into a protected step passes through its generated `@approval/<local-id>` gate (namespaced inside children). Each visit needs a fresh approval ID. A protected standalone agent that returns `needs_input` also requires a new decision before its next invocation. Approving retains the incoming repair outcome and all retry counts; rejection stops without invoking the target. Resuming an already approved pending group/subworkflow retains that invocation's approval. Approve a group rather than its owned leaves; missing, human, end, duplicate and owned-child targets are rejected. Explicit/generated ID collisions are rejected. This uses the normal Core/CLI approval controls and does not classify shell commands or bypass native provider permissions.

`failureStrategy: stop` applies to descendant scopes too, and disallows their recovery branches. Group failure is evaluated after the group's configured join/drain behavior; use `failurePolicy: fail-fast` to also cancel peers early. With the default `branch`, failures still require explicit matching recovery branches. Persistence errors, external cancellation, execution limits and budget denials remain fatal regardless of ordinary failure branches.

`maxSteps` counts actual `step.started` events, including groups, their leaves, routers, calls, human gates and end nodes. Counts accumulate across retries, repeated child calls and resume; opening an already pending group/call does not count twice. Each ancestor's limit applies to its descendants, and the root always has a 1000-start maximum even when no policy is declared. Exhaustion is `transition_limit`; approval cannot reset it. Retry exhaustion without an invocation does not count as a start. Interrupted backoff is still an unproven attempt and is not replayed automatically.

Budget enforcement is an optional programmatic Core hook, not a pricing engine. Construct `VeyraEngine({ budget })` with a `BudgetHook` that receives `before`/`after`, the attempt identity, enclosing scope ceilings and all persisted agent usage observations; return `{ allowed, reason? }`. Hooks can reserve estimated tokens/cost before invocation and reconcile actual observations afterwards. Missing usage stays unknown. The application owns estimates, currency handling, reservations for concurrent attempts and accounting, and must reattach its hook on resume. Declaring a budget without a hook fails before the agent runs (`missing_budget_hook`); malformed/throwing hooks fail with `budget_hook_failed`. A denial persists `budget.checked`, stops with `budget_exceeded`, and aborts/drains peers. Normal decisions are persisted too. Command costs are not inferred. The CLI has no built-in accounting hook, so budget-declaring workflows currently require programmatic composition.

## Retry accounting

Each executable step (`agent`, `command`, `parallel`, `router`, `subworkflow` or `consensus`) has an independent repair budget. Parallel children and namespaced child workflow steps also have individual budgets. Resuming an unfinished group/call retains its parent attempt while retried children spend their own budgets; a fresh child scope starts with normal entry semantics. Effective limits follow the policy precedence above. `withRetryDefaults()` remains an alias of `withExecutionDefaults()` for existing callers. Resume uses the saved snapshot even if the current config changes.

`nextRetry()` evaluates the next execution without mutating state:

- The first normal entry uses count `0` and is allowed even when the maximum is zero.
- The first entry reached through `failure`/`fail` is a repair and uses count `1`.
- Every revisit, including resuming a paused agent, increments that step's count. Successful cycles therefore consume a finite budget too.
- No execution occurs when it would exceed the maximum. Counters are saved before invoking the runtime/verifier; interrupted work never refunds a used budget automatically.

For default `dev`, `fix.retry.max: 3` allows exactly three fix calls after the initial executor call. The repeated verifier has its own default budget: one initial check plus three repeats. A step override changes only that step; raising a whole loop's limit may require adjusting other repeated steps too. Human and end nodes do not consume repair budgets, but do count against the lifetime start limit.

Exhaustion fails the run with `retry_exhausted` and identifies the step and used/maximum counts. A standalone step or parent group may instead provide `on.retry_exhausted` pointing directly to a `human` gate; Core follows that explicit gate and pauses. An owned parallel child's exhaustion is persisted in its failure result and makes the parent group fail. An ordinary `next` or a non-human exhaustion target cannot turn exhausted retries into success. Approval does not reset budgets.

`retryCounts` stores the per-step used counts. `step.retrying` reports the count, maximum, and attempt identity when a repair starts. Attempt numbers count actual invocations and are distinct from repair counts: the first `fix` call can be attempt `1` and repair count `1`.
