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

- `.veyra/project.yaml`: identity and locator metadata;
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

The registry is versioned JSON containing only Project descriptors. It never reads project context, run state, provider config or chat history. A lookup probes only each Project's metadata and returns `available` or `stale`, with an explicit reason. Missing, relocated or replaced Projects remain listed until explicitly unregistered. Conflicting IDs/roots are rejected even if the old entry is stale.

Writers reuse Runtime's local process-aware lock and stale-owner recovery. A complete private temporary file is synced then renamed atomically, followed by directory sync. Readers see the old or new complete snapshot; abandoned temporary files are ignored. Invalid registry data is preserved and blocks mutation. The registry is bounded to 1000 entries / 1 MiB and rejects linked registry directories/files. It is intended for a local filesystem, not shared network storage.

`ProjectStateStore` owns the latest bounded engineering snapshot under `.veyra/state.json`, with revision checks and the existing secret redactor. See [Shared Project State](../../docs/PROJECT-STATE.md) for contracts, provenance, limits and the distinction from native session-local data.
