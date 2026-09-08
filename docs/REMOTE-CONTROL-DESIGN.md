# Remote worker and control-plane design

Status: M5.10 design only. Veyra currently executes locally. This document proposes a bounded future remote mode; it adds no listener, worker daemon, network protocol implementation, credentials, deployment or public command. Remote workers remain deferred until explicitly approved under the [TODO](TODO.md). Dashboard implementation also awaits its stable-TUI prerequisite.

The first remote deployment would serve one operator and explicitly registered projects/workers. Hosted Veyra Cloud, public worker registration, organization/RBAC, automatic repository synchronization, a marketplace and arbitrary terminal tunneling are outside this design. Local CLI/TUI operation remains complete without a control-plane account or network connection.

## Ownership and topology

```text
Operator's local CLI/TUI/Dashboard
                  |
       authenticated project actions
                  v
Dashboard bridge -> Core -> durable local run store
                     |
             injected execution interfaces
                     |
          authenticated worker connection
                     ^
           outbound connection from worker
                     |
          Runtime -> provider adapters
              +----> Verifier -> configured checks
```

Core remains the only workflow scheduler. It owns transitions, budgets, retry limits, approval state and the authoritative ordered event log. A worker executes assigned leaf attempts and reports evidence; it cannot select the next workflow step, grant approval or declare a run complete. CLI, TUI and Dashboard issue Core actions and display the same persisted events.

The Dashboard bridge and its HTTP/SSE surface stay in `apps/dashboard`. Runtime owns worker transport and execution lifecycle; Verifier owns deterministic checks, with transport injected for remote dispatch. Protocol owns versioned data contracts; Config owns explicit configuration and validation; SDK exposes approved extension contracts. Provider-specific code remains in `plugins/*`. No new package boundary or dependency is introduced by this document. A future reusable package requires the repository's architecture decision process.

A worker initiates a connection to one explicitly configured controller, avoiding an inbound worker command port. The controller's remote listener is separate from the local Dashboard listener and disabled by default. A future opt-in deployment must specify its interface and authenticated TLS configuration; missing configuration fails startup instead of falling back to plaintext or wildcard binding. The ordinary Dashboard binds to loopback by default. A VPN can reduce exposure but does not replace application authentication.

## Identity, enrollment and authorization

The proposed initial worker authentication is mutual TLS with operator-managed enrollment. Each installation generates its own private key locally. An operator reviews the worker identity/public-key fingerprint out of band, signs or registers its certificate through an explicitly configured trust authority, and creates a controller-side allowlist entry. There is no unauthenticated self-enrollment endpoint, shared fleet password or first-contact automatic trust.

The controller maps a verified certificate to an immutable worker ID and an authorization record: allowed projects/workspaces, installed provider bindings, permitted workflow definitions, maximum concurrency and whether mutating attempts are permitted. A presented display name or capability declaration grants no authority. The worker independently verifies the controller's certificate/identity and its own local project policy. Both ends reject expired, revoked, mismatched or untrusted identities. Private keys remain outside repository/run state with restrictive permissions or an operator-managed credential store.

Enrollment metadata contains public IDs/fingerprints and policy only. Revocation immediately blocks new assignments and closes active sessions; the worker cancels and drains active work when notified or when its lease expires. Certificate rotation is explicit, with a bounded overlap of old/new enrolled identities, then revocation of the old identity. Restart/session resumption rechecks current authorization; a cached TLS session must not bypass revocation. Initial deployments can disable session resumption to keep this boundary simple. Loss of either trust registry or its integrity fails closed.

Operator sessions and worker identities are separate. The proposed first remote mode keeps the operator surface on the controller's local machine; remote browser login is a later design. Local HTTP still requires authentication, exact Host/Origin validation and CSRF protection for mutations. A local launcher provisions a short-lived, single-use secret through an explicit local channel to establish an HttpOnly, SameSite session; it must not put that secret in a URL, access log or run event. Non-browser clients use separately scoped credentials. Same-origin checks supplement authentication rather than replacing it. The browser cannot impersonate a worker or use its transport endpoint.

Each start/cancel/resume/approval request checks the authenticated principal, project, run, action and current revision on the server. An approval also supplies the current Core `approvalId`; stale or repeated decisions are rejected by Core. Workers never receive an operator approval credential. Authorization failure is audited without raw credentials and causes no execution. WebSocket deployments must validate origins where browsers are allowed, authorize messages after the handshake, limit payloads and close revoked sessions; these controls follow the [OWASP WebSocket security guidance](https://cheatsheetseries.owasp.org/cheatsheets/WebSocket_Security_Cheat_Sheet.html).

## Transport and protocol boundary

The proposed worker channel is WSS over TLS 1.3 with mutual certificate authentication, hostname/service-identity verification and an explicit trust store. There is no `insecure` bypass or automatic redirect to another controller. Disable TLS early data for control messages because replayable early requests cannot safely start mutating work. TLS 1.3 supports certificate-based peer authentication, and its early-data replay limits require application care; see [RFC 9846](https://www.rfc-editor.org/info/rfc9846/). This is a Veyra design choice, not a requirement to implement custom cryptography.

The first handshake negotiates one exact protocol major version and feature set before accepting any task data. Unsupported versions fail with an actionable error; downgrades are not implicit. A worker advertises its ID, boot/session ID, OS/architecture, installed plugin versions, Protocol descriptors, readiness scope and execution capacity. Core applies explicit provider requirements/preferences within the intersection of worker and controller permissions. Metadata does not prove model quality, remote access or trustworthy results.

Proposed message families are hello, assign, assignment acknowledgment, cancel, lease renewal, event/result upload, acknowledgment and reconciliation. Their schemas will be added to Protocol only with the approved implementation. Every assignment binds a controller identity, worker session, project/workspace ID, run ID, step/attempt ID, command ID, lease generation, workflow/policy digest, input digest and deadline. Canonical digest encoding must be specified with fixtures before interoperability claims. Duplicate IDs with differing payloads are rejected, never treated as edits to an active task.

Use existing `AgentInput`, `AgentResult`, verifier results and execution identities within bounded envelopes. The initial design caps control messages at 64 KiB, agent input at the existing 256 KiB and inline result data at 1 MiB; larger evidence uses authenticated, size-bounded artifact transfer. Framing overhead needs its own explicit bound in the future schema. Apply per-worker concurrency/byte rates, backpressure, bounded queues and idle deadlines. Reject unknown fields, malformed UTF-8/JSON, invalid enums, excessive depth and oversized content before dispatch. No evaluation, serialized callbacks, shell interpolation or generic `exec` endpoint is allowed.

## Workspace and credential boundary

Each project/workspace ID resolves through an operator-created mapping on the worker to a canonical local root. A controller-supplied absolute path, repository URL, archive path or symlink cannot choose another workspace. The worker validates the real root and isolation lease before every assignment. Repository provisioning and plugin installation are explicit local administration, never task-message side effects.

A run's mutating executor and deterministic verifier use the same allocated workspace/revision. Switching workers after mutation needs explicit reconciliation and workspace transfer design; it is not an ordinary provider fallback. Read-only reasoning can run elsewhere only when its required inputs/evidence are explicitly transferred. Native provider permissions continue to apply. Declared capabilities, TLS and a git worktree do not sandbox a coding agent or make arbitrary untrusted code safe.

Workers obtain provider credentials from their own environment/native login under the [authentication policy](AUTHENTICATION.md). The controller does not distribute API keys or native auth files in assignments. A worker lacking required credentials reports scoped unavailability. Operator authorization to run a configured workflow remains distinct from provider authentication.

Transfer only explicitly referenced, authorized inputs/artifacts. Source code, goals, diffs and output may be sensitive even after credential redaction; enabling remote work requires identifying which worker can receive them. Do not implicitly upload a repository, `.git`, environment snapshot or native history. Artifact requests use opaque IDs scoped to the run, with type/size/digest metadata; receivers write beneath a dedicated artifact root and reject traversal, symlinks and archive extraction by default. Workers redact before upload and the controller redacts again before persistence/display. Neither layer claims to detect every unknown secret.

## Delivery, interruption and human control

Transport delivery is retryable; filesystem mutation is not assumed idempotent. Do not claim exactly-once execution across a network failure. HTTP likewise requires knowledge that a non-idempotent request is safe before retrying it; see [RFC 9110, section 9.2.2](https://www.rfc-editor.org/rfc/rfc9110.html#section-9.2.2).

The future implementation needs a durable controller outbox and worker attempt journal, using local JSON initially. Core persists an assignment boundary before sending it. The worker durably records acceptance before beginning the effect, enforces one active owner per attempt/workspace, and persists its terminal result before acknowledging completion. Repeating the same command ID returns the known acknowledgment/result or `in_progress`; it does not start another process. A journal gap or ambiguous crash becomes `unknown`, with no automatic redispatch. New attempt IDs cannot bypass an unresolved earlier workspace owner.

| Condition                                           | Required behavior                                                                                                                                            |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Connection lost before acceptance is known          | Reconcile by the original command/attempt ID; do not issue another execution ID.                                                                             |
| Acknowledgment lost after acceptance                | Return journaled status; do not repeat the effect.                                                                                                           |
| Worker restarts with an accepted/running attempt    | Report interruption and retained workspace/evidence; require reconciliation before new mutation.                                                             |
| Lease expires or controller disappears              | Stop accepting work, cancel/drain active Runtime processes, retain journal/workspace and report uncertain completion on reconnect.                           |
| Result uploaded twice                               | Deduplicate by worker session, attempt and result/event ID; reject conflicting content.                                                                      |
| Old session reconnects                              | Reject stale lease generations and task messages; accept bounded reconciliation evidence only through the authenticated recovery path.                       |
| User cancels                                        | Persist intent, send the same idempotent cancel command until acknowledged, and report cancellation complete only after worker process cleanup is confirmed. |
| Approval is pending                                 | Do not dispatch gated work; only a current authorized Core approval action can release it.                                                                   |
| Provider becomes unavailable after execution starts | Retain failure/partial-work evidence; never switch providers/workers silently.                                                                               |

Leases fence new accepted commands; they cannot instantly stop a partitioned or compromised machine from touching its own files. Never reuse or automatically transfer an uncertain workspace merely because a lease expired. A human must review retained changes, verify the prior owner stopped and approve an explicit recovery boundary before replay. These requirements depend on M6.1 and M6.4–M6.6; current single-writer local state is insufficient for remote operation.

The controller validates every worker event/result and assigns its own ordered persisted sequence before exposing it to surfaces. Preserve worker identity, session, attempt, worker event ID and evidence digest as provenance; remote execution claims are untrusted evidence. A worker cannot submit an authoritative `approval.resolved` or `run.completed` event. Verifier reports remain distinct from LLM review, and important acceptance checks may require independent reproduction on a trusted worker.

## Local-only operation and implementation gate

Local operation keeps direct injected Runtime/Verifier execution and the existing `.veyra/` store. No remote registration, credential, network call or daemon is required by `ve run/status/review/resume/doctor`. Remote configuration is opt-in and cannot become a hidden fallback when a local provider fails. Disabling a future remote mode must stop new assignments, drain or explicitly report active remote attempts, and preserve readable local history; it must not silently migrate or erase state.

Before remote implementation is authorized, complete the relevant local Dashboard bridge and M6 isolation, redaction, recovery, locking, cancellation, retention and provenance work. The implementation proposal must specify exact enrollment/revocation UX, operating limits, protocol schemas/canonical digests and supported platforms. It must obtain the explicit approval required for deferred remote workers. This design does not authorize deployment, paid infrastructure or access to additional credentials.

Verification required of that future implementation includes mutually authenticated ephemeral loopback peers, wrong/expired/revoked identities, cross-project denial, unauthorized browser origins, stale/double approval, malformed/oversized messages, reconnect/replay/outbox crash points, cancellation with a real child process tree, conflicting results, worker loss after filesystem mutation, artifact traversal, secret-free state/logs and a full local-only regression with networking disabled. Tests must demonstrate failure before effects, not merely HTTP error status. No such remote integration test is claimed here: M5.10 verification is design review, link validation and the repository baseline against unchanged runtime behavior.
