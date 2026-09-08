# Telemetry and local metrics

Veyra defaults to **no external product telemetry**. The implemented CLI/Core do not send usage analytics, crash reports, project identifiers, prompts, run events or local metrics to a Veyra service. There is no analytics account, collector endpoint or background reporting queue to configure. Installing Veyra or accepting a workflow gate does not opt the user into telemetry.

This policy applies to the CLI and packages now and to future TUI/Dashboard work. It does not claim that configured providers, trusted plugins, project commands or development services never use the network.

## Data stays local unless the workflow needs to send it

| Data/activity                                                  | Current behavior                                                                    |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Workflow snapshots, events, verification and approval evidence | Stored in the project's configured `.veyra/` state/history; inspected locally       |
| Bounded artifacts and retention                                | Local files and explicit cleanup; no automatic cloud upload                         |
| Token/cost observations                                        | Recorded only when an adapter supplies them; unknown usage remains unknown          |
| Evaluation reports                                             | Local JSON output/file selected by the caller; no reporting backend                 |
| API agent invocation                                           | Sends the configured task/input to the chosen provider as part of execution         |
| Native CLI / trusted plugin / project command                  | Has its own permitted filesystem/network behavior and vendor policy                 |
| npm installation and GitHub CI/release preparation             | Uses the selected registry/GitHub service; not an anonymous Veyra analytics channel |

Provider requests may include goal, instruction sources, selected context, evidence and artifacts according to the adapter contract. Native tools may have their own telemetry or account settings; review those tools' policies and configuration separately. Veyra does not rewrite native privacy preferences or promise that its policy disables third-party reporting. Doctor may invoke bounded native version/authentication probes, so their behavior is also outside the product-telemetry claim. Third-party JavaScript runs with host-process privileges after explicit trust.

Logs and reports can contain sensitive project evidence despite managed redaction. Inspect them before sharing. Follow [authentication/redaction limits](AUTHENTICATION.md), [plugin trust](PLUGINS.md), [command safety](COMMAND-SAFETY.md), [retention](ARTIFACTS-RETENTION.md) and [private security reporting](../SECURITY.md).

## Useful without a cloud service

`ve status --json` reads local run status, current step and retry counts. `ve review --json` reads the latest saved review/verification evidence, including command duration and exit status. Neither command constructs providers. [Evaluation](EVALUATION.md) produces local per-sample completion, repairs, timing and known/unknown usage/cost, with explicit source and fixture identifiers. No remote collector is needed for these records or comparisons.

Local state has its own [retention and cleanup policy](ARTIFACTS-RETENTION.md). Removing local history does not remove data already sent to a configured provider or manually shared elsewhere. There is no separate Veyra telemetry opt-out switch because no product reporting collector is implemented.

## Development tooling

Root build/dev/check/test/clean commands explicitly set `TURBO_TELEMETRY_DISABLED=1` for Turbo, including when invoked by CI. This overrides Turbo's per-user telemetry preference for those invocations without issuing a global enable/disable command. The shell assignment matches the repository's supported macOS/Linux development environments. Verify the effective setting with:

```sh
pnpm telemetry:check
```

It must report `Status: Disabled`. For a direct Turbo command outside the root scripts, supply the same environment variable. See [Turbo's telemetry policy](https://turborepo.dev/docs/telemetry) and its [opt-out implementation](https://github.com/vercel/turborepo/blob/main/crates/turborepo-telemetry/src/config.rs). Disabling telemetry does not disable explicitly configured remote caching, registry downloads or GitHub-hosted execution; this repository does not configure a remote cache or metrics exporter.

## Any future collection requires a separate design

External telemetry is not authorized by this TODO or the presence of event/metrics types. Before adding it, propose an [architecture decision](decisions/README.md) documenting the specific purpose, minimum fields, destination, retention, access, transport, failure behavior and removal controls. Keep collection off by default, require informed explicit opt-in, and keep local inspection fully usable without opting in. Provide an obvious disable control that stops future collection and explains any local queue/remote deletion behavior.

Do not collect prompts, source code, command output, credentials, raw histories, stable device/user identifiers or project paths as incidental analytics. Add tests for default-off behavior, opt-in/disable semantics, redaction, failure handling and local-only operation before any implementation can be accepted. Reusing a workflow approval, account login or installation event as telemetry consent is not allowed.

## Verification scope

The source/dependency audit found no Veyra analytics client or reporting endpoint. `test/telemetry.test.ts` starts fresh built CLI processes with outbound Node HTTP/HTTPS/fetch/socket/DNS/UDP hooks blocked. Version, workflow listing/validation, init, a provider-free run and local status/review pass without a blocked call, and saved verification timing remains inspectable. A separate real Turbo status check confirms the repository opt-out overrides an enabled environment setting. These are regressions for Veyra-managed paths, not a packet-level audit or a sandbox for native tools/plugins.
