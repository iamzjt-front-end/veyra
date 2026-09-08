# Release notes

Run `pnpm changeset` for a user-visible package change. Select the directly affected official packages, choose the bump described in [Versioning](../docs/VERSIONING.md), and explain the resulting behavior and any migration.

Commit the generated Markdown note with the implementation. For documentation or test-only changes with no package behavior impact, use `pnpm changeset --empty` and explain the exemption in the change description.

`pnpm release:status` previews accumulated notes. `pnpm release:version` consumes them into package versions and changelogs and refreshes the lockfile/formatting locally. Neither command publishes, tags or commits. Public publication requires separate, explicit human approval.
