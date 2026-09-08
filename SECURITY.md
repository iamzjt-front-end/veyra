# Security policy

Veyra executes configured commands and trusted agents on the local machine. Review the [execution safety model](docs/COMMAND-SAFETY.md), [authentication/redaction limits](docs/AUTHENTICATION.md), [plugin trust](docs/PLUGINS.md) and [workspace policy](docs/WORKSPACES.md) before running an unfamiliar workflow. Worktrees isolate working files; they are not an operating-system sandbox.

## Supported code

Veyra is pre-release. Security fixes target current `main`; the official `@veyraoss/*` 0.1.0 packages are unpublished candidates. There is no supported older release line or guaranteed response time. A public release must state its supported version policy before publication. Config/workflow/state compatibility and public package publication still follow their documented review and approval rules.

## Report a vulnerability privately

Use [Report a vulnerability](https://github.com/iamzjt-front-end/veyra/security/advisories/new) in this repository's Security tab. Private vulnerability reporting is enabled. GitHub documents this [private reporting channel](https://docs.github.com/en/code-security/how-tos/report-and-fix-vulnerabilities/configure-vulnerability-reporting/configure-for-a-repository).

Include the affected commit/package version, OS/Node version, the relevant trust boundary, a minimal disposable reproduction, observed impact and any proposed mitigation. Useful reports include unintended execution, credential disclosure, path escapes or corruption/recovery behavior that violates the documented contract. Report safely: use synthetic credentials and your own disposable files, and avoid accessing other people's data or accounts.

Do not open a public issue with exploit details, API keys, login state, private project files or raw `.veyra/` history. Redact sensitive data before attaching a reproduction. If a credential has already been exposed, use the issuing provider's revocation/rotation controls; deleting a public comment does not revoke a credential.

Maintainers will triage privately, request only necessary reproduction details, coordinate a fix and discuss disclosure timing with the reporter. Disclosure, advisory publication and package releases require a maintainer decision; filing a report does not automatically publish an advisory. This volunteer project offers no bug bounty or service-level commitment.

Ordinary bugs and usage questions belong in the issue templates. Harassment/spam belongs in the [Code of Conduct reporting flow](CODE_OF_CONDUCT.md#reporting-and-enforcement), not a security advisory. Dependency changes follow the [update policy](docs/DEPENDENCIES.md).
