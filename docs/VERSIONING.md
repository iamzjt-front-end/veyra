# Versioning and changelog

The fourteen official packages in [Package strategy](PACKAGES.md) use one version and advance together. Their explicit Changesets `fixed` group excludes the private repository root and TUI scaffold. Dashboard has no package manifest. Root/scaffold versions are development metadata and are not the CLI version.

## Compatibility policy

Veyra follows [Semantic Versioning 2.0.0](https://semver.org/). Before 1.0, patch releases preserve the supported public contracts; minor releases may introduce incompatible changes and must describe the migration. Compatible features also use a minor bump. After 1.0, incompatible changes use a major bump, compatible features use a minor bump, and compatible fixes use a patch bump. A version number alone does not assert that unfinished roadmap features or live provider integrations are verified.

Public contracts include exported TypeScript/ESM APIs, CLI arguments and JSON output, configuration/workflow schemas, plugin contracts and persisted run formats. Internal refactors without behavior changes and repository-only test/docs changes need no package bump. Security or correctness fixes that change an advertised contract must explicitly describe the effect and use the appropriate bump. Do not change versions manually in individual official packages.

Official packages are tested and released as one set. Their `workspace:*` dependencies become exact package versions when packed with pnpm. Use matching official package versions; mixing minor lines is unsupported. Schema `version: 1`, event/descriptor schema versions and SDK `PLUGIN_API_VERSION = 1` are separate contract identifiers: routine package bumps do not change them. An incompatible plugin wire contract requires an explicit API-version transition, migration guidance and the corresponding package bump. An unsupported plugin API version is rejected by the existing registry.

Third-party plugins version independently. Authors should declare the SDK versions they test against, pin a compatible SDK dependency, and provide migration notes for breaking changes. A plugin's `apiVersion` selects the host contract; its SemVer `version` identifies the implementation. Configured `plugins.<provider>.version` remains an exact implementation pin, including for built-ins. Update those pins when upgrading. Core stays provider-neutral; package versioning adds no provider dependency there.

`ve version` and `ve version --json` report the installed CLI manifest version. Official plugin descriptors and registrations read their own package manifest versions, including the shared OpenAI/compatible and Gemini/API/CLI variants. Native executable versions and model identifiers remain independent.

## Contributor workflow

1. Implement and verify one focused change.
2. Run `pnpm changeset`, select directly affected packages and choose the bump above. Describe the user-visible result, compatibility impact and migration, if any. The fixed group propagates the highest requested bump to all fourteen packages.
3. Commit the generated `.changeset/*.md` note with the change. For a repository-only change, `pnpm changeset --empty` records the no-release decision; explain why in the change description.
4. Run `pnpm release:status` to inspect the accumulated plan. It is read-only. No registry access or credentials are needed.

The pinned Changesets CLI 2.31.1 provides the [fixed-package workflow](https://changesets.dev/guide/fixed-packages). Its installed config schema is pinned at 3.1.4. Changesets CLI 3 requires newer Node versions than Veyra's declared Node 20 minimum, so upgrading it needs a separate compatibility decision. The default Git changelog generator uses local history and does not require a GitHub API token.

## Local release preparation

Start from a clean checkout with the pending notes committed. Inspect the plan, then prepare a reviewable local version change:

```sh
pnpm install --frozen-lockfile
pnpm release:status
pnpm release:version
git diff
pnpm lint
pnpm format:check
pnpm check
pnpm test
pnpm build
pnpm packages:check
```

`release:version` runs Changesets versioning, refreshes `pnpm-lock.yaml`, and formats generated files. Notes become package changelog entries and are consumed. Repeating versioning without new notes makes no further version bump. Review all changed manifests, dependency versions, notes and lockfile before committing. The highest requested bump wins once per preparation batch; two patch notes do not cause two patch bumps.

Changesets does not commit automatically, version/tag private packages or publish as part of these scripts. No repository version was bumped to implement this workflow. The initial pending note can be previewed now; applying a release plan remains a deliberate local preparation step. Prereleases use explicit SemVer suffixes and a separate npm dist-tag when publication is eventually approved; no prerelease channel or publication workflow is enabled by this task.

Public npm publication and GitHub releases still require explicit human approval and all applicable live/exit gates in [TODO](TODO.md). M7.3 owns release CI. Never invoke publication merely because local preparation passes.

## Verification

`pnpm versioning:check` runs the real pinned CLI in temporary monorepos using the repository's package graph/configuration. It verifies patch/minor/major bumps, fixed-group propagation, generated notes and dependency entries, private-package exclusion, rejection of unknown targets, no repeat bump, and unchanged Git HEAD/tags. It also runs the full `release:version` script with offline resolution and checks the generated lockfile and formatting. Fixtures use the installed tooling without publishing or registry requests and are removed afterward.

The ordinary `pnpm test` includes these checks. Its tarball consumer also changes only the extracted manifests to a test prerelease version and starts fresh Node processes, verifying that `ve` and all eight official provider variants report the installed version without source edits or a rebuild.
