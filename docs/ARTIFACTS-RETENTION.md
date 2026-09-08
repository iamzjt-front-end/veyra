# Local artifacts and retention

Core stores large event payloads separately from the inline timeline. Cleanup is explicit and previews its candidates by default. No background process deletes history.

## Bounded event records

New events larger than 64 KiB of serialized JSON are written to `.veyra/runs/<run-id>/artifacts/<event-id>.json`. The store redacts the complete event before creating the file. Its `events.jsonl` line is an `event.stored` record containing the original event type, identity, sequence, a preview of at most 4 KiB of UTF-8, and an artifact reference. Small events keep their existing shape. The inline record is also checked against the 64 KiB limit.

Each managed reference includes an ID, `kind: event-payload`, a run-relative `path`, JSON media type, byte size, creation timestamp, producer run/step/attempt identity where applicable, and SHA-256 digest. Run-level events omit the producer step. The digest detects inconsistent local content; it is not a signature or proof that a provider's claims are true.

`LocalRunStore.readEvents(id)` validates and restores complete events, with the reference in their store-owned `payload` field. It checks the filename, size, digest, producer, timestamp, event identity and preview. Missing, corrupt or symlinked payloads fail the read and further appends. Callers cannot submit `event.stored` records or set `payload` during append. Arbitrary provider artifact paths are never read to restore events.

Core scheduling, named inputs, crash recovery and subscribers use these restored events. The CLI uses `eventView(event)` from `@veyraoss/core` for bounded JSON run/resume output and review inspection. Other surfaces can use the same helper. A preview is display text, not a complete event or a replacement for execution evidence. Large result references also appear in subsequent agents' bounded artifact context; Core does not follow those paths into prompts.

Publication writes and syncs the full payload before appending its reference. A crash between those operations may leave an unreferenced file, which readers ignore. The next append does not invent an event for it. A torn JSONL append still requires explicit repair/restoration under the existing [crash recovery policy](CRASH-RECOVERY.md). Old inline events remain readable and are not automatically migrated.

These files contain the entire **retained, redacted event**, not output already discarded by capture limits. Existing limits remain: Core agent input 256 KiB, normalized agent/verification results 1 MiB, verifier stdout and stderr 64 KiB each, and an individual store JSON record 16 MiB. Truncation flags remain part of verifier evidence. Terminal failure diagnostics are bounded to 4,096 characters after redaction. Native coding-agent files, provider histories and external artifact files remain outside this managed redaction/retention boundary. See [authentication and redaction](AUTHENTICATION.md).

## Preview and apply cleanup

From the checkout, prefix these commands with `pnpm ve --`:

```bash
ve prune
ve prune --older-than-days 90 --keep-last 50 --json
ve prune --older-than-days 90 --keep-last 50 --apply
```

Use the same policy flags for preview and apply. `--config <file>` selects the project and its configured state directory. Prune loads configuration but does not load workflow files, import plugins, construct providers or execute project commands.

The default policy retains runs updated within 30 days and always keeps the newest 20 runs, ordered by saved update time. A candidate must also be completed or failed, unselected by the active pointer, and have no retained worktree. Running, interrupted, unknown-owner running, and paused histories remain protected by their nonterminal saved state. Completing a run does not clear the active pointer. `--older-than-days 0 --keep-last 0` removes the age/count protection, while other safeguards remain enforced.

If a run has a retained worktree, inspect it and use the separate [`ve workspace remove`](WORKSPACES.md) command first. Prune never removes shared workspaces, source repositories, external provider artifact targets or native provider histories. It deletes the eligible run directory, including its snapshots, JSONL and all files physically inside its managed artifact directory.

The JSON result reports `dryRun`, the cutoff timestamp, `keepLast`, candidates with IDs/update times/byte sizes, successfully removed candidates, and skipped IDs/reasons. Preview calculates eligibility and file sizes; apply additionally validates complete event history before moving a candidate. Invalid policy values, corrupt history, symlinks and special files are refused. Age must be an integer from 0 through 365000 days; newest-count must be an integer from 0 through 100000.

Apply rechecks eligibility under the [store lock](LOCKING.md) after obtaining each run's control lease. Live or stale run leases are preserved; prune has no force or stale-owner recovery option. Concurrent selection/control/cleanup can change the result after preview. Busy or changed runs are reported as skipped. Coordination assumes cooperating processes and a local filesystem, not a hostile process running as the same user.

For each eligible run, apply atomically moves its directory to `.veyra/state/trash/<run-id>-<unique-id>`, syncs directory entries on POSIX, then recursively removes that exact moved directory while retaining the run lease. A cleanup failure reports the exact trash path and stops. The run may already be absent from the live list, and its trash copy may be partially deleted. Earlier candidates may already have been removed. Remaining trash is preserved for explicit scoped inspection; later prune calls do not automatically delete or restore it. This is not a transaction across all candidates. Do not move partially removed history back into the live list as if it were intact.

The API has the same defaults and behavior:

```ts
const preview = await store.pruneRuns({ olderThanDays: 90, keepLast: 50 });
const result = await store.pruneRuns({ olderThanDays: 90, keepLast: 50, apply: true });
```

## Repository size

The repository and `ve init` ignore `.veyra/state/`, `.veyra/runs/` and `.veyra/worktrees/`. Add an equivalent rule yourself when choosing a custom state directory. Ignore rules prevent accidental source-control bloat; local disk usage can still grow until explicit cleanup. There is no total disk quota. Restore complete snapshots and referenced payloads together when backing up or transferring local history.
