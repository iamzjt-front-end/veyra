# Contributing to Veyra

Veyra coordinates provider-neutral agents, deterministic verification and human decisions. Contributions should preserve those boundaries and make behavior observable, testable and resumable.

## Start here

1. Follow the [local development guide](docs/DEVELOPMENT.md).
2. Read [AGENTS.md](AGENTS.md), [Architecture](docs/ARCHITECTURE.md) and the [canonical TODO](docs/TODO.md). Select the first eligible item unless the maintainer explicitly requests another task. Implement one item and its necessary supporting changes at a time.
3. Check `git status --short --branch` before editing. Preserve existing changes and planned package directories. Use a focused branch/commit; do not rewrite shared history.
4. For a boundary, compatibility or trust change, follow the [architecture decision process](docs/decisions/README.md) before implementing it.

The product is **Veyra**, the executable is **`ve`**, and official npm names use **`@veyraoss/*`**. Configuration and local history remain `veyra.yaml` and `.veyra/`.

## Implement and verify

Use strict TypeScript and small explicit interfaces. Keep providers in `plugins/*`, process lifecycle in Runtime, deterministic checks in Verifier, and orchestration in Core. UIs consume the shared contracts/events. A provider-specific implementation must not become a Core dependency.

The [plugin tutorial](docs/tutorials/PLUGIN.md) walks through an actual local extension and explains how to adapt it for a remote or native provider. The [workflow tutorial](docs/tutorials/WORKFLOW.md) covers validation, persisted evidence and explicit approval without provider credentials. These tutorials complement the [SDK reference](docs/PLUGINS.md) and [DSL reference](docs/WORKFLOWS.md).

Add meaningful regression coverage for changed behavior, including relevant failure paths. Follow the [test strategy](docs/TESTING.md): unit tests for pure contracts, local integration tests for process/state boundaries and deterministic end-to-end tests for public flows. Tests modify disposable copies and clean up after failure. Default tests must work without provider credentials; a blocked live smoke remains a documented blocker, not a passing test.

Before requesting review, run the current TODO's checks and all five baseline commands:

```sh
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
```

Inspect `git diff --check` and the full diff. Include the behavior change, relevant evidence, commands/results and remaining limits in the PR description. Do not include keys, tokens, native login files, generated build/cache output or local `.veyra/` histories. Document a command that cannot run and its exact blocker. Update TODO checkboxes only after all corresponding criteria pass; synchronize the roadmap when milestone status changes.

## Versions and releases

Add a Changeset for a user-visible package change with `pnpm changeset`; documentation/tooling-only changes may use an empty note. See [Versioning](docs/VERSIONING.md) for the fixed official package set, compatibility and generated changelogs. Package versions and config/workflow/state/API schema versions are separate contracts.

The [release process](docs/RELEASING.md) prepares and verifies immutable tarballs before the protected publication job. Local packing and a passing PR never authorize public npm publication, a public GitHub release or deployment. Those actions require explicit human approval. Packages are currently unpublished candidates; do not advertise registry installation as available.
