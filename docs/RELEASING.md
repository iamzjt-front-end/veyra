# Release CI

The manual [Release workflow](../.github/workflows/release.yml) prepares review artifacts and optionally requests a protected publication job. Its default is **`publish: false`**. Pushes, pull requests, version preparation and tag creation do not trigger publication. Nothing has been published by implementing this workflow.

## Validate a candidate

Choose the exact official package version as `release_tag` (for the current development candidate, `v0.1.0`). Stable versions use npm tag `latest`; prereleases use `next`. A mismatched version/tag or an existing tag pointing to another commit fails before build or publication. Build-metadata suffixes are not accepted as release tags.

From the GitHub Actions **Release → Run workflow** UI, select the source branch, enter the version tag and leave publication disabled. Verification uses a fresh Ubuntu runner, pinned Node.js 22.22.0/Corepack, frozen pnpm dependencies, no dependency/build cache, all five baseline checks, and the isolated package consumer tests. It creates fourteen tarballs in dependency order, `release.json`, `SHA256SUMS` and `RELEASE_NOTES.md`. The artifact is attached to that workflow run for fourteen days; it is not an npm package or GitHub release.

Local metadata and packing checks are also available after installing/building:

```sh
pnpm release:check --tag v0.1.0 --dist-tag latest
pnpm release:pack --tag v0.1.0 --dist-tag latest --out /absolute/new/temporary-directory
pnpm release-ci:check
```

Replace the tag when package versions change. Packing requires a new output directory and will not overwrite an earlier bundle. A dirty checkout or unconsumed changeset produces a validation preview with `publishable: false`. This field describes metadata readiness; it does not prove live provider access or satisfy unfinished product exit gates. Review [TODO](TODO.md) before proposing any public release.

## Human approval and registry setup

The GitHub environment **`npm-release`** requires review by `iamzjt-front-end` and restricts deployment jobs to the `main` branch. These settings were created and read back through the repository API. The maintainer can dispatch and separately approve a job; self-review prevention is disabled for this single-maintainer repository. Keep the required-reviewer and branch restrictions in place. Repository administrators can change environment settings, so this gate assumes trusted repository administrators. See [GitHub environment approvals](https://docs.github.com/en/actions/reference/workflows-and-actions/deployments-and-environments).

Before an authorized publication, configure npm trusted publishing for each package using:

| Setting                    | Value                                            |
| -------------------------- | ------------------------------------------------ |
| GitHub owner               | `iamzjt-front-end`                               |
| Repository                 | `veyra`                                          |
| Workflow filename          | `release.yml`                                    |
| Environment                | `npm-release`                                    |
| Allowed publication action | Direct `npm publish` for this protected workflow |

The workflow uses npm 11.19.1 and OIDC; it does not read a stored npm write token. The repository is public, the candidates declare public access, and every publish requests npm provenance. npm's [trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/) describes the required per-package setup and automatic provenance; [provenance documentation](https://docs.npmjs.com/generating-provenance-statements/) describes verification. Registry-side trusted publisher setup and an actual signed publication have **not** been performed. Initial package creation/authentication must be handled by the maintainer under a separate explicit publication approval. Do not upload local npm credentials or tokens to workflow artifacts.

## Authorized publication procedure

Only after the user explicitly approves public publication:

1. Resolve or explicitly review the applicable live-provider and product exit gates in TODO. Prepare versions/changelogs with [Versioning](VERSIONING.md), consume all pending notes, run the complete checks and commit the clean result.
2. Confirm ownership, name availability, registry trusted-publisher configuration and the GitHub environment protection rules. Check that the desired version has not already been published.
3. Dispatch Release on `main` with the exact tag and `publish: true`. The verification job runs before any approval request. It refuses unconsumed notes or a dirty checkout.
4. Review that run's commit, validation results, tarballs, checksums and notes, then approve the `npm-release` environment job in GitHub. Do not approve an artifact from another run.
5. The approved job checks out the same SHA, downloads that run's immutable artifact by ID and validates every package identity/dependency and SHA-256/SHA-512 digest before the first npm operation. It publishes the reviewed bytes with public access, the chosen npm tag, lifecycle scripts disabled and provenance enabled, then checks registry integrity for each version.
6. Only after all npm integrity checks pass does the workflow create the matching GitHub release/tag at the verified commit and attach tarballs/checksums. Prereleases are marked as such and do not become the latest stable GitHub release.

The publication script also requires the expected GitHub repository, `main` ref, source SHA and the approved-job marker. These checks supplement the actual environment approval; setting environment variables locally does not grant publication authorization. Default tests substitute a disposable fake npm executable and never publish.

## Failure handling

Verification failures, tag conflicts and invalid bundles stop before publication. Raw child stdout/stderr and environment values are not echoed by the publication script, and npm debug logs/configuration files are not uploaded. Errors identify the failed command/exit code without retaining potentially credential-bearing npm diagnostics. The workflow uses no shell tracing or secret-bearing command arguments.

A release across fourteen packages is not atomic. If npm fails or registry integrity does not match, publication stops and no GitHub release is created. Some earlier packages may already exist. Do not blindly rerun, delete versions or overwrite tags: inspect the public versions and compare their integrity with the original artifact, then prepare a separately approved recovery. A GitHub API failure after npm succeeds likewise requires reconciliation without republishing existing versions. Published version identifiers are immutable; see [npm publish](https://docs.npmjs.com/cli/commands/npm-publish/).

## Verification scope

`pnpm release-ci:check` exercises real Git fixtures and actual pnpm tarballs. It checks release/tag versions, prerelease tag policy, dependency order, digest/notes generation, stale tags, pending/dirty work, approval refusal, tampering before any registry operation, exact publish arguments, registry-integrity mismatch and suppression of child diagnostics. npm calls are captured by a fake executable entirely inside each disposable fixture. The normal baseline includes these tests and strict checking of the standalone release script.

Workflow syntax/expressions are checked with actionlint 1.7.12, and hosted validation is run with publication disabled. This verifies preparation and the skipped publication path; it does not claim a successful live npm publish, trusted-publisher authentication, provenance attestation or public GitHub release.

The [validated candidate run](https://github.com/iamzjt-front-end/veyra/actions/runs/34212290491) at `bf7189e` passed all preparation steps, uploaded fourteen independently checked tarballs and skipped publication. The [mismatched-version probe](https://github.com/iamzjt-front-end/veyra/actions/runs/34212611857) failed at version/tag preflight and skipped publication. Both used `publish=false`.
