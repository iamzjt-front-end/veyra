# Project

`@veyraoss/project` owns local Project identity. It does not load providers, read credentials or execute agents. The package is currently workspace-private while P0 introduces its public consumers.

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

Identity is bound to its recorded canonical root. A copied or moved metadata file fails with `project_path_mismatch` instead of silently adopting an identity at a different path. `assertUniqueProjectIds` rejects conflicting IDs/roots in an explicit collection; global registry enforcement belongs to P0.2. Relocation requires an explicit future operation; no identity is automatically rewritten or deleted.
