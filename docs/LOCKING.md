# Local concurrency and locking

Cooperating Veyra processes can share one local state directory. Core serializes control of each run, Runtime leases its workspace, and the store serializes short file operations. An isolated worktree can execute alongside another run's worktree; two runs cannot execute in the same leased workspace.

## Scopes and ordering

| Scope       | Location                                         | Held across                                                     | Contention                       |
| ----------- | ------------------------------------------------ | --------------------------------------------------------------- | -------------------------------- |
| Run control | `<stateDir>/state/locks/runs/<run-id>/`          | Run/resume execution, an approval decision, or worktree removal | Waits up to 100 ms, then refuses |
| Workspace   | Common Git metadata or the workspace's `.veyra/` | Work in that directory                                          | Refuses another owner            |
| Store       | `<stateDir>/state/locks/store/`                  | One public store read or mutation                               | Waits up to 30 seconds           |

Core acquires run control before workspace ownership, then takes the store lock only for individual file operations. Worktree preparation briefly leases the source directory and releases it before execution in the new worktree. Provider calls never hold the store lock. Reads participate in coordination so they cannot observe another writer halfway through a JSONL append. Each call is a consistent observation; several separate reads are not a transaction.

`LocalRunStore.withRunLock(runId, action, recoverInterrupted?)` supplies the control scope; engine methods handle it automatically and release ownership in `finally`. Do not recursively acquire the same run lock from its callback. Store mutations retain their local queue and also coordinate across store instances and processes. Concurrent event appends receive unique, increasing sequences, and state replacement increments a store-owned `revision`. Legacy snapshots without a revision remain readable; their next update starts at one. Callers cannot set a revision, and counter overflow is refused before replacement.

Resume reads the state revision and final event ID before acquiring control, then checks both again under the lease. If they changed, `stale_resume` requires inspecting the new boundary before retrying. A competing resume therefore cannot accidentally advance a new pause created by the first request. Approval decisions use the same run lease plus the existing exact approval-ID check.

## Ticket protocol

Runtime's `acquireLocalLock()` uses unique participant files, following the choosing phase and ordered tickets of [Lamport's bakery algorithm](https://lamport.azurewebsites.net/pubs/bakery.pdf). It atomically publishes a complete choosing record, selects a number greater than visible tickets, then waits for choosing participants and lower `(number, UUID)` pairs. Each participant changes only its own file. New owners never reuse a retired owner's filename, so simultaneous stale recovery cannot unlink a replacement owner's record.

Ticket JSON contains its schema version, UUID, canonical scope directory, logical holder, local PID/hostname/start metadata, and ticket number. It contains no provider configuration or credentials. Files use restrictive POSIX permissions. Complete records are published through a same-directory temporary file and hard link/rename; incomplete temporary files are ignored. These ephemeral coordination files do not supply the durable state guarantees described in [state storage](STATE.md).

The protocol requires a local filesystem with atomic link/rename and consistent directory visibility, and cooperating current-version callers. It is not a distributed lock, a security sandbox, or protection against direct filesystem writers or hostile same-user changes. Do not concurrently use older Veyra binaries that bypass store/run locks. Unsupported hard links fail rather than falling back to an unsafe protocol. Symlinked scopes/entries, invalid metadata, more than 1,024 entries, and unsafe ticket counters are refused. Waits use monotonic time; file age is never ownership evidence.

## Stopped owners and recovery

A ticket can be retired only when its hostname is local, a signal-zero probe reports `ESRCH`, and its logical holder matches. A live PID, PID reuse, foreign hostname, denied probe, or malformed metadata prevents automatic retirement. `lock_busy`, `lock_timeout`, `invalid_lock`, and `lock_lost` distinguish contention, an expired wait, unsafe metadata, and ownership changing before release.

The short store lock automatically retires proven dead store holders, allowing inspection after a writer dies. This does not repair a torn event, validate a scheduling boundary, or prove provider effects completed. Run and workspace leases require explicit recovery after confirming the previous coordinator **and its child processes have stopped**:

```bash
ve status <run-id> --json
ve resume <run-id> --recover-interrupted
ve resume <run-id> --approve --approval-id <pending-id> --recover-interrupted
ve workspace remove <run-id> --recover-interrupted
```

Resume still enforces [completed checkpoint evidence](CRASH-RECOVERY.md); the flag cannot replay an unknown attempt or bypass an approval. Worktree removal still requires a terminal run and a clean, unchanged, owned worktree. Approval resolution accepts `recoverInterrupted` programmatically; it records a human decision and does not itself execute the next step.

The existing [workspace lease protocol](WORKSPACES.md) keeps its guard and owner metadata. A crash during its guard update, an unowned guard, or malformed ownership needs scoped manual inspection; Veyra does not guess ownership or steal by age. Preserve uncertain metadata and history, identify the exact stopped owner and associated children, and remove only a proven stale target. Never broadly delete another task's locks.

Inspection can create/release coordination metadata in an existing state directory, but it never rewrites saved run records. Discovering an absent store leaves it absent. Locks prevent cooperating concurrency races; event append, snapshot replacement, workspace changes, and external effects remain separate operations, with the conservative crash policy still in force.
