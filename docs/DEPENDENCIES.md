# Dependency update policy

Dependency changes are reviewed repository work. Keep production dependencies small and owned by the package that uses them. Core must remain provider-neutral; provider SDKs belong in plugins. Do not add a framework to avoid understanding an existing contract.

## Review an update

1. Identify the required fix or capability and read the upstream release notes/advisory from the package's maintainers. Check supported Node/platform versions, ESM exports, license, install scripts, transitive changes and compatibility with our declared baseline.
2. Change only the relevant manifest entries using the pinned pnpm version and regenerate `pnpm-lock.yaml` deliberately. Inspect the complete lockfile diff. Do not hand-edit resolved integrity values or run an unreviewed `audit fix --force`.
3. Run `pnpm install --frozen-lockfile`, the owning package's relevant tests and all five [baseline checks](../CONTRIBUTING.md#implement-and-verify). A runtime or packaging change also needs `pnpm packages:check`; an installer change needs the separate network-dependent `pnpm installation:check`. Exercise any changed process/authentication boundary with deterministic failure/cancellation tests.
4. Add release notes for user-visible package behavior and describe compatibility risks. Merge only after review and passing CI. Updating a dependency does not authorize a new public release.

## Cadence and security fixes

Use focused manual update PRs as needed and review dependency health before each release. Security reports receive priority according to actual exposure and reachability, not only a scanner score. Document a temporary mitigation and the affected versions when an update cannot land immediately; coordinate sensitive details through [Security](../SECURITY.md).

This repository currently has no automated version-update or auto-merge configuration. GitHub Dependabot security updates are disabled; enabling an update bot later should open reviewable PRs, never bypass verification or approval. No scheduler or automatic publication is introduced by this policy. Review available dependency alerts and, when registry access is appropriate, `pnpm audit`; record registry failures instead of treating an unavailable scan as clean. An audit result complements tests and review, not proof of safety.

GitHub Actions stay pinned to full verified upstream commit SHAs, with the release tag in comments. Toolchain pins such as Node, Corepack, pnpm and release npm should be updated intentionally with their compatibility matrix and hosted CI results. See [Platforms](PLATFORMS.md) and [Release CI](RELEASING.md).
