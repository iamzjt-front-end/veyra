# Project

`@veyraoss/project` owns local Project identity. It does not load providers, read credentials or execute agents. It is an unpublished package candidate consumed by the CLI; publication requires human approval.

```ts
import { initializeProject, openProject, projectPaths } from "@veyraoss/project";

const project = await initializeProject("/Users/me/Projects/my-app", { name: "My app" });
const reopened = await openProject("/Users/me/Projects/my-app/src");
console.log(reopened.id === project.id, projectPaths(reopened).state);
```

The directory must already exist. `initializeProject` writes only `.veyra/project.yaml` (private file permissions); it never overwrites existing metadata or changes `veyra.yaml`. `loadProject` loads an exact root; `openProject` searches physical ancestors from an existing directory. Returned descriptors are JSON data, with no open handles to close. A new process reopens the same persisted UUID.

Version 1 metadata contains exactly `version`, `id` (UUID v4), `name`, `root` (canonical absolute real path) and `createdAt` (UTC ISO timestamp). Workflow/provider configuration remains separate. No arbitrary extension fields, credential fields or conversations are accepted.

Project-owned paths are derived from the root:

- `.veyra/project.yaml`: identity, locator metadata and optional role bindings;
- `.veyra/state.json`: shared coordination state;
- `.veyra/context/`: bounded engineering context;
- `.veyra/handoffs/`: handoffs and execution results;
- `.veyra/runs/`: existing run snapshots/events;
- `.veyra/artifacts/`: evidence references.

Only the metadata is created during initialization. Other paths are reserved for their owning operations and created lazily.

Root aliases are resolved with `realpath`, including nested symlinks. `.veyra` and metadata must not be symlinks; metadata hard links and oversized/malformed YAML are rejected. Invalid nearer metadata stops ancestor lookup. These checks resist accidental path confusion; they are not an OS sandbox against a process concurrently replacing directories it owns. Platforms follow Veyra's macOS/Linux policy.

Identity is bound to its recorded canonical root. A copied or moved metadata file fails with `project_path_mismatch` instead of silently adopting an identity at a different path. `assertUniqueProjectIds` rejects conflicting IDs/roots in an explicit collection; the registry applies the same check across registered Projects. Relocation requires an explicit future operation; no identity is automatically rewritten or deleted.

## Local registry

`ProjectRegistry` exposes `register(path)`, `unregister(id)`, `list()` and `get(id)`. It defaults to `~/.veyra/projects.json`; pass `{ root: temporaryDirectory }` in tests or when running an isolated instance. Reads of an absent registry return an empty list without creating it. Registration opens an initialized Project, including from nested directories.

```sh
ve project add /Users/me/Projects/my-app
ve projects
ve project show <project-id>
ve project remove <project-id>
```

Each command accepts `--json` and `--registry <directory>`. `add` initializes identity only when no Project exists in the folder or its ancestors. It does not require `veyra.yaml` or any provider. `remove` removes only the locator entry and preserves all project files.

The registry is versioned JSON containing only Project descriptors. A lookup validates each Project's metadata, including optional bindings, but does not copy those bindings into the registry. It never reads project context, run state or chat history. Missing, relocated or replaced Projects return `stale` with a reason and remain listed until explicitly unregistered. Conflicting IDs/roots are rejected even if the old entry is stale.

Writers reuse Runtime's local process-aware lock and stale-owner recovery. A complete private temporary file is synced then renamed atomically, followed by directory sync. Readers see the old or new complete snapshot; abandoned temporary files are ignored. Invalid registry data is preserved and blocks mutation. The registry is bounded to 1000 entries / 1 MiB and rejects linked registry directories/files. It is intended for a local filesystem, not shared network storage.

`ProjectStateStore` owns the latest bounded engineering snapshot under `.veyra/state.json`, with revision checks and the existing secret redactor. See [Shared Project State](../../docs/PROJECT-STATE.md) for contracts, provenance, limits and the distinction from native session-local data.

## Project role bindings

`loadProjectBindings(project)` reads the optional versioned `bindings` block in `project.yaml`. `saveProjectBindings(project, roles, expectedRevision)` atomically replaces it under a process lock; revision zero means no previous binding. Stale writers fail with `bindings_conflict`. Identity is preserved and the metadata stays private. Existing identity-only Projects need no migration.

Each role maps to `{ provider, mode, executable?, model?, session? }`. Role and provider are independent names; `mode` is `native` or `api`. The strict protocol rejects credential/environment/history fields, bounds the block to 16 KiB/32 roles and validates optional native session references against provider and Project identity. The complete YAML stays within 64 KiB. Native-specific adapter selection belongs to the host composition, not this package or Core.

```sh
ve project bind <project-id> --executor codex/native
ve project show <project-id> --json
# From the project or a nested directory:
ve doctor --json
ve status --json
```

Optional bind flags are `--codex-executable <path>`, `--model <model>` and `--session-run <run-uuid>`. Session selection reads only a previously archived safe reference in this Project. Rebinding replaces the executor's options while preserving other roles. An executable path containing `/` resolves at bind time; a bare command resolves on the later native process's PATH. The CLI currently composes only `codex/native`; other stored bindings fail explicitly when selected for execution.

A bound Project can dispatch through the daemon without `veyra.yaml` or planner/reviewer API credentials. Each new run creates its own native session. A stored session belongs to its original run and is eligible for continuation only with that exact run identity; existing Core runs are never replayed. Shared Project State carries context across fresh runs. See [Codex continuity](../../docs/CODEX.md) for native history loss and recovery.
