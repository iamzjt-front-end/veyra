# Execution workspaces

Core selects a workspace through `LocalWorkspaceManager` in `@veyra/runtime`, saves its location in the run's immutable `input.json`, then invokes agents and verifiers with that same `cwd`. The `run.started.workspace` event exposes the selection to every surface. A run has one workspace; parallel children share it and must coordinate their own writes.

## Shared directory default

Without `runtime.workspace`, execution uses the requested project directory. `mode: shared` makes that default explicit. Existing tracked, staged and untracked changes remain available to agents; Veyra does not stash, reset or discard them. Shared directories are never removed by Veyra.

A cooperative lease prevents two Veyra invocations from actively executing in the same workspace. Git repositories use the canonical working-tree root, so subdirectories, symlink aliases and different state directories share the lease. Outside Git, the lease covers the canonical requested directory: use the same project root for overlapping work. It does not detect arbitrary overlaps between independently selected non-Git project roots.

## Opt-in Git worktrees

```yaml
runtime:
  stateDir: .veyra
  workspace:
    mode: worktree
    dirtyPolicy: reject
```

Worktree mode requires Git and a committed `HEAD`. Veyra creates a detached worktree at `<stateDir>/worktrees/<run-id>` from the exact commit recorded in the input snapshot. A project directory inside the repository maps to its corresponding committed subdirectory. No branch, push, merge or dependency installation happens automatically. Install dependencies in the isolated worktree when its configured commands need them; untracked files, ignored caches, local credentials and `node_modules` are not copied from the source.

`dirtyPolicy: reject` is the default for worktree mode. Staged changes, tracked modifications/deletions and untracked project files block creation. Ignored source files and Veyra's reserved `.veyra/` state or generated `runs/`, `state/` and `worktrees/` beneath the configured state directory do not count as untracked project changes. Tracked changes in those locations still block creation. Git index flags such as assume-unchanged or skip-worktree also block the clean-tree check because they can conceal modifications. Keep generated state out of version control.

To deliberately execute committed `HEAD` while leaving source changes where they are, set `dirtyPolicy: use-head`. This setting neither includes nor discards those source changes. There is no automatic copy/stash policy. Both policies record the source root, actual working directory, worktree root, Git metadata path, starting commit and dirty policy.

Worktree preparation briefly leases the source workspace. An active shared-directory run blocks preparation; after preparation, separate worktrees have separate leases and may execute concurrently. Worktrees share Git objects/configuration and have ordinary host filesystem access. An agent using absolute paths or Git commands against another checkout can cross this boundary. Native provider permission modes, explicit approval gates and configured verification still apply. Worktrees are file separation, not a security sandbox.

## Resume and ownership

`ve resume` uses the saved directory and ownership record. Changing current configuration to shared mode, moving source `HEAD`, or changing the current shell directory does not relocate a paused run. Missing, replaced or mismatched worktree metadata blocks resume. Pre-workspace input snapshots remain readable and retain their saved shared `cwd`.

The execution lease is released after completion, failure, pause or drained cancellation. A paused worktree is preserved. A paused shared run has no private copy, so intervening changes in that directory remain visible when it resumes.

Git leases live in the common Git directory under `veyra-workspaces/<hash-of-canonical-root>/`; non-Git leases live in the selected directory's `.veyra/`. Each `veyra-workspace.lock/owner.json` records only a PID, run ID, root and ownership token. An atomic guard serializes lease updates. Worktree ownership is separately recorded as `veyra-workspace.json` in that worktree's private Git metadata.

There is no age-based lease stealing. A live PID, a different run owner or malformed ownership blocks execution. `resume --recover-interrupted` may retire a lease only for that same run after the old PID is absent and Core has verified an existing completed scheduling checkpoint. Unknown partial mutations remain blocked. PID reuse is conservatively treated as live. A process crash during a lease update can leave its `.guard` directory; inspect the recorded owner and confirm every associated process has stopped before removing that specific stale guard. Do not remove another task's lease or use broad cleanup commands.

Core also holds a [run control lease](LOCKING.md) across execution, approval and cleanup, while short store locks serialize file operations across processes. Separate worktrees can therefore execute concurrently against the same store; state/event writes and provider effects remain separate operations. Local files and cooperating Veyra processes are assumed; hostile same-user filesystem races and independent native commands are outside the lease guarantee.

## Inspect and preserve work

```bash
ve status <run-id>
ve status <run-id> --json
git -C /absolute/worktree/path diff
git -C /absolute/worktree/path status --short
```

Status shows the actual `cwd`, workspace mode, availability, source and base commit. JSON retains the same `workspace` contract as the run input/event. The TUI and Dashboard remain subject to their own milestone prerequisites; no interface-specific execution logic is needed.

Every worktree is preserved by default, including failed and paused runs. There is no automatic reset or deletion. Save desired edits/commits through your normal Git review process before deciding to remove it. A failed setup preserves any created directory and reports its path; inspect `git worktree list` and that location. If failure happened before a run snapshot was saved, use Git directly after inspecting the files and registration.

## Explicit cleanup

```bash
ve workspace remove <run-id>
ve workspace remove <run-id> --config /absolute/project/veyra.yaml --json
```

The command accepts only a completed or failed run with a matching Veyra-owned worktree. It acquires the workspace lease, checks the source repository and starting commit, and refuses tracked changes, untracked files, ignored files, index flags that conceal edits or additional commits. It delegates to `git worktree remove` without `--force`. Paused/running runs, shared directories, replacement paths and active leases are refused. There is deliberately no force option.

If the coordinator died after completing a run, `ve workspace remove <run-id> --recover-interrupted` may reclaim its proven stale run/workspace leases after you confirm its children have stopped. This does not relax the clean, unchanged, terminal-run checks.

After removal, input/state/events/artifacts remain in the original state directory, and `workspace.removed` records the action. Status reports the saved directory as missing or removed. If event persistence fails after Git removed the worktree, the command reports that failure; inspect availability instead of assuming filesystem deletion and event append were one transaction. Git worktree removal can also fail because of Git's own locks or submodule rules; Veyra preserves the failure instead of forcing cleanup.

Git management uses argument arrays with no shell, clears inherited `GIT_*` repository/config overrides for those management commands, and bounds each command to 30 seconds and 1 MiB per output stream. Raw Git output is excluded from public errors. User Git configuration, hooks and filters otherwise retain their native behavior. Agents and verifiers keep their existing environment/permission policies.

Deterministic integration tests create disposable Git repositories with local fixture identities, run real worktree operations and cross-process contention checks, and remove the entire fixture afterward. They do not use a network provider or modify the contributor's checkout.
