# Configuration

`@veyra/config` exports `loadConfig(path)` to read a single `veyra.yaml` document and `parseConfig(value)` to validate already-parsed data without file, environment, or provider access. Both return a normalized `VeyraConfig` or throw `ConfigError`. Loading does not write files or connect providers.

## Schema version 1

Required fields are `version: 1`, an `agents` object, and `workflow.use` (a non-empty preset name or workflow path). Agent names are arbitrary non-empty keys; each agent requires a non-empty `provider`. `model` is optional, and `options` is an object containing JSON-compatible provider-specific values. Agents may be empty for a command-only workflow. Provider and model names are opaque to the config package; they are not restricted to OpenAI/Codex.

The optional `project` object requires `name` when present. Unknown fields at the root and inside project, agent, workflow, runtime, or approval objects are rejected; arbitrary provider settings belong under the agent's `options` object.

| Optional value             | Default  | Validation                                               |
| -------------------------- | -------- | -------------------------------------------------------- |
| Agent `options`            | `{}`     | JSON-compatible object, no cycles or non-finite numbers  |
| `runtime.maxFixIterations` | `3`      | Non-negative safe integer; default per-step repair limit |
| `runtime.stateDir`         | `.veyra` | Non-empty path string                                    |
| `approval.requiredFor`     | `[]`     | Array of non-empty operation names                       |

Project name and model have no inferred default. Returned objects and arrays are independent copies. Paths remain as configured; callers resolve relative paths against the config directory when executing a project. Workflow contents are validated by [`@veyra/workflow`](WORKFLOWS.md). Provider readiness belongs to the adapters; explicit human gates use the [Core approval API](APPROVALS.md). `approval.requiredFor` does not yet insert gates or classify provider commands automatically.

Core snapshots effective workflow policies when a run starts. An explicit step `retry.max` overrides workflow `policy.retry.max`, which overrides `runtime.maxFixIterations`; zero disables repairs while allowing initial work. Child workflow retry defaults override inherited defaults. See [execution policies](WORKFLOWS.md#workflow-execution-policies) for saved deadlines, concurrency caps, approval selection, failure behavior, budget hooks and lifetime step limits.

See [`veyra.example.yaml`](../veyra.example.yaml) for the full shape. Keep credentials in environment variables or the provider's native login, never in generated config or committed examples. The loader does not interpolate environment variables or log config values. File errors include the absolute path; validation errors identify the field; malformed YAML errors include the parser error code and line/column without displaying a source excerpt.
