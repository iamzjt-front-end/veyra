# Public package strategy

Veyra will publish separate ESM packages for its existing responsibility boundaries under its official npm organization, **`@veyraoss`**. The terminal entry point will be the `@veyraoss/cli` package with the single executable **`ve`**. The product name remains Veyra, and configuration/state paths remain `veyra.yaml` and `.veyra/`. Ownership is verified; these are unpublished release candidates requiring human approval before publication.

| Candidate               | Responsibility                                       |
| ----------------------- | ---------------------------------------------------- |
| `@veyraoss/protocol`    | Provider-neutral contracts and guards                |
| `@veyraoss/project`     | Local Project identity and locator registry          |
| `@veyraoss/config`      | Configuration parsing and validation                 |
| `@veyraoss/runtime`     | Agent, process and workspace lifecycle               |
| `@veyraoss/workflow`    | Workflow parsing/graphs, schema and built-in presets |
| `@veyraoss/verifier`    | Deterministic command verification                   |
| `@veyraoss/core`        | Orchestration and persisted run coordination         |
| `@veyraoss/sdk`         | Public plugin interfaces and registry                |
| `@veyraoss/openai`      | Responses and OpenAI-compatible adapters             |
| `@veyraoss/codex`       | Codex CLI adapter                                    |
| `@veyraoss/claude`      | Claude API adapter                                   |
| `@veyraoss/claude-code` | Claude Code CLI adapter                              |
| `@veyraoss/gemini`      | Gemini API and CLI adapters                          |
| `@veyraoss/opencode`    | OpenCode CLI adapter                                 |
| `@veyraoss/cli`         | Headless CLI consuming the packages above            |

The repository root, TUI scaffold and Dashboard scaffold remain private. The fifteen candidates form a closed set for all current `@veyraoss/*` production dependencies. Publishing Core/SDK alone while leaving their required runtime packages unavailable would not produce installable packages. Native agent executables are installed separately; these packages do not redistribute or install provider CLIs automatically. Provider-specific code remains in plugins.

## Package contents

Library entry points expose conditional `types` and `import` exports with declarations in `dist`. They are ESM APIs; CommonJS entry points are not promised. The CLI is executable-only and has no importable package root. Workflow additionally exports `@veyraoss/workflow/workflow-v1.schema.json`.

Each package has an explicit `files` allowlist, MIT license, package description and repository directory. Tarballs contain compiled modules/declarations/maps, a README, license and package manifest; generated package changelogs are included when present. Workflow also includes its JSON schema and four built-in YAML presets. Source trees, tests, Turbo logs, development configuration and local state are excluded. Package licenses match the root license.

Root `workflows/*.yaml` remains the canonical preset source. Workflow's build copies those files to its own `dist/presets/`, and the loader resolves only that package-local location for built-ins. Installed packages never walk outside their package looking for the checkout's workflow directory. Custom workflow paths still resolve relative to the caller's working directory. Build outputs and preset inputs participate in Turbo caching; tests build their owning package first.

Use pnpm to create release-candidate tarballs: its pack operation converts `workspace:*` production dependencies to the corresponding package versions. See [pnpm pack](https://pnpm.io/10.x/cli/pack). The pinned pnpm 10.15.1 does not provide the newer `pack --dry-run`; the verification command creates real temporary tarballs and cleans them up.

```sh
pnpm packages:check
```

This builds packages and checks all fifteen tarballs, then exercises their public imports, TypeScript declarations, schema, presets and CLI from a temporary consumer outside the checkout. Only packed files supply `@veyraoss/*` modules; third-party dependencies reuse the frozen local install, without a network call. It also runs in `pnpm test`. `pnpm installation:check` separately verifies real npm global installation and removal in a disposable prefix; see [installation](INSTALLATION.md).

## Ownership and publication gate

The initial ownership check for the previous scope was blocked by `E401 Unauthorized`; anonymous package lookups returned 404 and did not establish ownership. The maintainer then created the official `@veyraoss` organization and explicitly requested this scope migration.

On 2026-09-08, `npm whoami --registry=https://registry.npmjs.org` returned `zjex`, and `npm org ls veyraoss --json --registry=https://registry.npmjs.org` returned `{"zjex":"owner"}`. Public registry metadata requests for the original fourteen names (before Project was added) returned HTTP 404. The authenticated organization response establishes ownership; absent package metadata alone would not. See [npm scopes](https://docs.npmjs.com/about-scopes/).

Only the fifteen selected packages omit `private` and declare `publishConfig.access: public` with the official npm registry. The root and TUI stay private; Dashboard remains an unpublished scaffold. The packed-manifest tests enforce this boundary. Maintainers must recheck authentication, organization permissions and name availability before the first release because registry state can change. Do not paste credentials into issues, configuration, workflow files or this document.

Public npm publication and GitHub releases require explicit human approval. Packing is local verification and grants no publication permission. Live provider smoke blockers and the v0.1 exit criteria remain recorded in [TODO](TODO.md); package verification does not clear them. [Versioning](VERSIONING.md) defines local release-note/changelog preparation, and [Release CI](RELEASING.md) defines artifact review and the protected publication workflow.
