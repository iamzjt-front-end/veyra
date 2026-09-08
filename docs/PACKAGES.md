# Public package strategy

Veyra will publish separate ESM packages for its existing responsibility boundaries. The terminal entry point will be the `@veyra/cli` package with the single executable **`ve`**. There will be no unscoped `veyra` executable or duplicate CLI package. Package names are candidates pending authenticated verification of npm scope ownership; nothing has been published by this task.

| Candidate            | Responsibility                                       |
| -------------------- | ---------------------------------------------------- |
| `@veyra/protocol`    | Provider-neutral contracts and guards                |
| `@veyra/config`      | Configuration parsing and validation                 |
| `@veyra/runtime`     | Agent, process and workspace lifecycle               |
| `@veyra/workflow`    | Workflow parsing/graphs, schema and built-in presets |
| `@veyra/verifier`    | Deterministic command verification                   |
| `@veyra/core`        | Orchestration and persisted run coordination         |
| `@veyra/sdk`         | Public plugin interfaces and registry                |
| `@veyra/openai`      | Responses and OpenAI-compatible adapters             |
| `@veyra/codex`       | Codex CLI adapter                                    |
| `@veyra/claude`      | Claude API adapter                                   |
| `@veyra/claude-code` | Claude Code CLI adapter                              |
| `@veyra/gemini`      | Gemini API and CLI adapters                          |
| `@veyra/opencode`    | OpenCode CLI adapter                                 |
| `@veyra/cli`         | Headless CLI consuming the packages above            |

The repository root, TUI scaffold and Dashboard scaffold remain private. The fourteen candidates form a closed set for all current `@veyra/*` production dependencies. Publishing Core/SDK alone while leaving their required runtime packages unavailable would not produce installable packages. Native agent executables are installed separately; these packages do not redistribute or install provider CLIs automatically. Provider-specific code remains in plugins.

## Package contents

Library entry points expose conditional `types` and `import` exports with declarations in `dist`. They are ESM APIs; CommonJS entry points are not promised. The CLI is executable-only and has no importable package root. Workflow additionally exports `@veyra/workflow/workflow-v1.schema.json`.

Each package has an explicit `files` allowlist, MIT license, package description and repository directory. Tarballs contain compiled modules/declarations/maps, a README, license and package manifest; Workflow also includes its JSON schema and four built-in YAML presets. Source trees, tests, Turbo logs, development configuration and local state are excluded. Package licenses match the root license.

Root `workflows/*.yaml` remains the canonical preset source. Workflow's build copies those files to its own `dist/presets/`, and the loader resolves only that package-local location for built-ins. Installed packages never walk outside their package looking for the checkout's workflow directory. Custom workflow paths still resolve relative to the caller's working directory. Build outputs and preset inputs participate in Turbo caching; tests build their owning package first.

Use pnpm to create release-candidate tarballs: its pack operation converts `workspace:*` production dependencies to the corresponding package versions. See [pnpm pack](https://pnpm.io/10.x/cli/pack). The pinned pnpm 10.15.1 does not provide the newer `pack --dry-run`; the verification command creates real temporary tarballs and cleans them up.

```sh
pnpm packages:check
```

This builds packages and checks all fourteen tarballs, then exercises their public imports, TypeScript declarations, schema, presets and CLI from a temporary consumer outside the checkout. Only packed files supply `@veyra/*` modules; third-party dependencies reuse the frozen local install, without a network call. It also runs in `pnpm test`. This checks package boundaries; registry/global installation is tracked separately in M7.4.

## Ownership and publication gate

All candidates retain `private: true` until npm ownership is verified. A missing public registry package does **not** establish ownership of its scope. npm associates scopes with accounts or organizations; see [npm scopes](https://docs.npmjs.com/about-scopes/).

On 2026-09-08, `npm whoami --registry=https://registry.npmjs.org` returned `E401 Unauthorized`, and `npm org ls veyra --json --registry=https://registry.npmjs.org` returned `E401` with an invalid-authentication-token diagnostic. `npm view @veyra/core name version maintainers --json --registry=https://registry.npmjs.org` returned `E404 Not Found`; unauthenticated registry metadata requests for all fourteen candidate names also returned HTTP 404. Those results do not prove the account owns `@veyra` or may publish any candidate.

A maintainer must authenticate locally, verify the relevant account/organization and package publish permissions, and check every candidate name before the first release. Do not paste credentials into issues, configuration, workflow files or this document. If another scope is required, explicitly decide that naming change before altering the brand-owned package names. Once verified, remove `private` only from the selected candidates and set public access explicitly. The root and scaffold surfaces stay private.

Public npm publication and GitHub releases require explicit human approval. Packing is local verification and grants no publication permission. Live provider smoke blockers and the v0.1 exit criteria remain recorded in [TODO](TODO.md); package verification does not clear them. Version/changelog automation and release CI belong to their subsequent TODO items.
