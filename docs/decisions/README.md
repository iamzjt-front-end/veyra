# Architecture decisions

Record durable decisions here when changing package responsibilities, protocol/schema compatibility, persistence semantics, extension trust, execution policy or a substantial dependency. Small implementation choices that preserve existing contracts belong in code and PR descriptions; they do not need an ADR.

## Process

1. Read the current [architecture](../ARCHITECTURE.md), relevant reference documents and [TODO](../TODO.md). Describe the concrete requirement and affected contracts before proposing a design.
2. Add `NNNN-short-title.md` using the template below, choosing the next unused number. Start with `Proposed`. Compare reasonable options, failure/recovery behavior, compatibility, security and verification. Link the requesting TODO/issue.
3. Request maintainer review in the PR. A design contradicting stable boundaries or requiring a new security/product decision needs explicit approval before dependent implementation. Existing documented decisions and routine compatible work do not acquire an extra approval requirement from this process.
4. Record `Accepted` only with the review/decision reference. Then implement the scoped TODO, update affected source-of-truth documents and test the resulting contract. Acceptance of a design is not evidence that implementation passed.
5. Keep the record when a decision changes. Add a new ADR and mark the old one `Superseded by NNNN`, with links in both directions. Do not rewrite history to make old tradeoffs disappear.

There are no numbered ADRs yet. [Architecture](../ARCHITECTURE.md) remains the current accepted baseline; [remote control design](../REMOTE-CONTROL-DESIGN.md) is a deferred design, not approval to implement remote execution.

## Template

```markdown
# NNNN: Concrete decision title

Status: Proposed | Accepted | Rejected | Superseded by NNNN
Date: YYYY-MM-DD
Task: Link to the requirement
Decision reference: PR/review link once decided

## Context

Describe the problem, constraints and current observable behavior.

## Options

Compare viable choices and their costs, including retaining current behavior.

## Decision

Specify the selected contracts, package ownership and failure semantics.

## Consequences

Record compatibility/migration, operational limits and security implications.

## Verification

Identify tests/evidence needed before implementation can be marked complete.
```
