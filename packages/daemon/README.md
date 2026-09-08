# Local daemon

`@veyraoss/daemon` provides a foreground local coordinator and a typed local tool API. It delegates Project identity/registry/shared state to `@veyraoss/project` and execution to the existing Core, Runtime and Verifier.

```sh
ve daemon start                  # foreground; keep this terminal/service running
ve daemon status                 # another terminal/process
ve daemon projects
ve daemon stop
```

All commands accept `--registry <directory>` and `--json`. A service manager can own the foreground process. `SIGINT`/`SIGTERM` request graceful shutdown. No API key or native-agent login is required to start the coordinator.

`startDaemon({ registryRoot, signal })` returns a handle with metadata, `closed`, a cancellation signal and idempotent `stop()`. Separate clients call `daemonStatus`, `daemonProjects` and `stopDaemon`. Tests always supply a disposable registry root.

## Discovery and local trust

One daemon owns a registry root. The process-aware Runtime lock prevents duplicate starts. Non-secret discovery metadata lives at `<registry-root>/daemon/daemon.json`: instance UUID, process owner, canonical registry root, start time and socket location. PID liveness is conservative: live or unknown owners are never killed/replaced based on metadata. Only a provably stopped local owner permits stale recovery. Corrupt metadata is preserved and fails closed.

Connections use a Unix socket, never a TCP/public listener. To fit macOS socket path limits, the socket is under the current user's mode-0700 `/tmp/veyra-<uid>/` directory; its name is derived from the canonical registry root and mode is 0600. Discovery and logs also require private current-user ownership. The trust boundary is the local OS user, not a secret copied from Codex. Other applications running as the same OS user can call the daemon; this is not an isolation boundary against that user. A future bridge must add its own explicit narrow authorization.

Shutdown aborts in-flight listing and execution, waits for Runtime cleanup, closes client sockets, releases the local lease and removes the current instance's discovery/socket. Project/registry data remains untouched. A killed process leaves metadata/lock/socket for conservative recovery on restart. An orphan socket with no verifiable discovery record is preserved for inspection.

Resources are bounded: 32 concurrent clients, 35-second idle timeout, 256-KiB requests, 2-MiB responses and 64 log records of bounded messages. Logs are structured JSON Lines at `daemon/daemon.jsonl`, coalesced to one pending disk write and filtered through the existing secret redactor. Raw request text, native credentials, provider configuration and chat histories are never logged or copied.

Supported platforms follow Veyra's macOS/Linux policy; use a local filesystem. Registry/shared engineering state remains owned by Project. The daemon does not create a cloud dependency or a second business-state database.

## Version 1 tool API

`DaemonOperations`, request/response types and runtime guards are exported by Protocol and SDK. The transport is one JSON-line request/response per private Unix connection. Unknown versions, fields and methods fail validation. Use `DaemonClient` from this package to validate both directions and preserve typed remote error codes:

```ts
const client = new DaemonClient({ registryRoot });
const registered = await client.call("projects.register", { path: absoluteProjectPath });
const projectId = registered.project.id;
const accepted = await client.call("runs.dispatch", { projectId, handoff });
const locator = { projectId, runId: accepted.runId };
const run = await client.call("runs.wait", { ...locator, waitMs: 30000 });
const result = await client.call("results.get", locator);
```

| Method                     | Input                          | Result                                                  |
| -------------------------- | ------------------------------ | ------------------------------------------------------- |
| `health`                   | `undefined`                    | Daemon discovery/readiness metadata                     |
| `projects.list`            | `undefined`                    | Registered Projects including stale entries             |
| `projects.get`             | `{ projectId }`                | Registered Project and live locator health              |
| `projects.register`        | `{ path }`                     | Existing initialized Project, resolved by absolute path |
| `runs.dispatch`            | `{ projectId, handoff }`       | Accepted run UUID and queued/running status             |
| `runs.get` / `runs.cancel` | `{ projectId, runId }`         | Current run status; cancel requests Runtime abort       |
| `runs.wait`                | `{ projectId, runId, waitMs }` | Status on completion or bounded timeout (0–30000 ms)    |
| `handoffs.get`             | `{ projectId, runId }`         | Immutable accepted handoff                              |
| `results.get`              | `{ projectId, runId }`         | Bounded execution result, or `null` while unavailable   |
| `stop`                     | `undefined`                    | `{ stopping: true }`; use `stopDaemon` to await cleanup |

Registration is the only path-based operation; all subsequent Project/run access is scoped by Project ID. There is no generic read/write-file, command, JavaScript or plugin-loading RPC. Same-user callers may dispatch the Project's trusted local workflow, so access is execution authority. Provenance in a handoff is caller-supplied untrusted attribution, not a grant of authority or proof of a ChatGPT identity.

The service host supplies `startDaemon({ resolveExecution(project, handoff) })` with trusted config, workflow and adapter objects. Without it, dispatch returns `execution_unavailable`. `ve daemon start` loads an explicit `veyra.yaml` and its workflow from the registered Project root, using existing adapter factories and exact `--allow-plugin` approval for external plugins. A command-only or fake workflow needs no API key. Native default selection/session binding is separate from this transport contract.

Dispatch admits at most four active runs, one per Project, with no unbounded queue. It reserves the latest shared-state revision before execution, archives a redacted handoff, and passes its UUID to Core. Existing run IDs are never overwritten/replayed. A pending handoff blocks new dispatch with `run_busy`; crashed or incomplete execution must be inspected through persisted state before reconciliation. Dispatch uses Core's existing workspace policy, workflow retry/approval rules and a 120-second invocation timeout. Paused approval runs remain paused; this API does not bypass a gate.

`runs.wait` waits on a completion promise or a bounded timer, without polling disk. A timeout may return a still-running status; callers can issue another bounded wait. Socket disconnection does not cancel a run. Explicit cancel and daemon shutdown propagate an AbortSignal through Core/Runtime. After restart, recorded running work is `interrupted`, never replayed automatically. A terminal Core run with no archived result is `interrupted`/`result_incomplete`; a failed latest-state reconciliation leaves the intent pending for inspection rather than silently dispatching more work.

Each handoff/result is limited to 64 KiB and stored under the Project's `.veyra/handoffs/`. Results contain summaries, bounded changed-file declarations and existing event/artifact references. Agent declarations are untrusted; actual verification lives in referenced Core events. Large payloads stay in the existing artifact store. Exact Project evidence/diff collection is developed in the canonical handoff/native E2E tasks.

Stable failures include `daemon_unavailable`, `project_not_found`, `project_stale`, `run_not_found`, `run_busy`, `run_exists`, `execution_unavailable` and `invalid_request`. Unsafe/corrupt storage or execution composition failures return `operation_failed` without echoing raw input. Inspect local Project/run evidence before retrying an uncertain dispatch with a new ID.
