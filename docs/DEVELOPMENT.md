# Local development

Use Node.js >=20 and the pinned pnpm 10.15.1. CI currently verifies Node.js 22 on macOS and Linux; consult [Platforms](PLATFORMS.md) before assuming another environment is supported. Clone the repository and enter its root:

```sh
git clone https://github.com/iamzjt-front-end/veyra.git
cd veyra
corepack enable
pnpm install --frozen-lockfile
pnpm build
pnpm ve -- doctor
```

For Corepack signing-key errors, use the verified setup advice in the [README](../README.md#development). Do not regenerate the lockfile to bypass an installation failure. No API key is needed to build or run the default tests. Doctor can report optional native providers as unavailable; required readiness depends on the selected project configuration.

## Find the owning package

The [architecture map](ARCHITECTURE.md) is authoritative. Production code goes under the owner's `src/`, tests under its `test/`, and public contracts through Protocol/SDK. Root tests cover cross-package behavior. Workspace packages are linked by pnpm; consuming code imports their public `@veyraoss/*` exports. Build dependencies after changing exported types or bundled presets.

For example, while changing Workflow:

```sh
pnpm --filter @veyraoss/workflow build
pnpm --filter @veyraoss/workflow test
pnpm --filter @veyraoss/workflow check
```

Run the [complete baseline](../CONTRIBUTING.md#implement-and-verify) before marking the task complete. `pnpm check` includes strict production, test/helper and standalone-script checks. `pnpm format` applies Prettier; `pnpm lint` checks Biome rules. Turbo caches deterministic package tasks. Use `TURBO_FORCE=true pnpm test` only when an uncached run is needed to investigate cache-sensitive behavior; do not delete user state to force a test.

## Exercise the CLI safely

`pnpm ve -- <command>` runs the checkout CLI. Built package imports still need `pnpm build`. To target a disposable project outside the checkout, pass its absolute config path:

```sh
pnpm ve -- workflow validate /absolute/project/workflow.yaml --config /absolute/project/veyra.yaml
pnpm ve -- run "Check the example" --config /absolute/project/veyra.yaml --non-interactive
pnpm ve -- status --config /absolute/project/veyra.yaml --json
```

The config directory determines project paths and execution. Review shell commands and provider permissions first. Start with the [provider-free workflow tutorial](tutorials/WORKFLOW.md); do not test a coding agent against unrelated working changes. `--non-interactive` leaves human gates paused and never approves them.

`pnpm packages:check` verifies isolated packed imports without registry access. `pnpm installation:check` separately performs a real disposable global npm installation and needs the public registry. See [Testing](TESTING.md), [Installation](INSTALLATION.md), and the explicit opt-in [live smoke](LIVE_SMOKE.md). Live API tests may spend provider credits and are never part of ordinary PR tests.

See [Contributing](../CONTRIBUTING.md) for scope/review rules, [architecture decisions](decisions/README.md) for design changes, and [Release CI](RELEASING.md) for release preparation and approval.

Root Turbo commands opt out of anonymous telemetry for each invocation. `pnpm telemetry:check` verifies the effective setting; direct Turbo invocations need the same environment override. See the [telemetry policy](TELEMETRY.md).
