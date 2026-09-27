# Adopt Target Architecture NAWABARI-TA-1

Status: **Accepted**. Date: **2026-09-27**. Decision owner: human product owner with the design owner.
Authority: explicit approval of the Architecture Reconstruction Report and every recommended option, followed by
explicit authorization to roll out documentation and open a documentation PR. Issue operations remain read-only.
This record supersedes the report's unadopted status; it does not claim that target gaps have been implemented.

## Q1: trusted host operator capability

Accept option A. Only the trusted host operator can obtain the machine-wide Control Server credential.
Unauthenticated root HTML must contain no secret; protected runtimes must not receive credential or bootstrap material.
Use a trusted local delivery channel, not a URL, log, repository record, or ambient projected environment.
Retain browser protections and inherited network semantics. Do not add remote IAM/OAuth or isolate all networking as an
unrequested substitute. This explicitly supersedes #664's unauthenticated root-document token bootstrap.

## Q2: claims-off applies to bounded mutation

Accept option A. When claim enforcement is off, otherwise-valid bounded mutation and working-set expansion do not require
an own claim or its strength. Profile, upstream scope, effective working set, deny/immutable constraints, ownership,
and applicable conflicts with other sessions remain enforced. READONLY never grants WRITE/CREATE/DELETE.
This clarifies the combination of #540 and bounded working-set contracts; it does not remove resource coordination.

## Q3: hard machine/user singleton, optional server

Accept option A. At most one Control Server may run per local machine/user context, independent of chosen port or repository.
Represent its lease and endpoint as service discovery only; do not move repository state into machine-global storage.
Use exact process-generation evidence for stale ownership. Zero servers is valid: CLI/TUI/domain operations remain direct.
No mandatory daemon, automatic service installation, or remote listener is introduced.

## Q4: strong durability for canonical mutations

Accept option A as the supported standard. Canonical state mutations require a qualified local filesystem with the
required atomic replacement and durability guarantees. Unsupported or unproven capability must not silently become a
successful degraded write. Read/diagnostic access may remain available. No degraded-durability mode is adopted.
A successful probe alone is not a universal power-loss proof. Qualification and failure-cut tests must state their limits.

## Q5: bounded durable receipts, no implicit pruning

Accept option A for this refactoring. Preserve the existing bounded, fail-closed retry guarantee.
Separate logical ownership/capacity of non-authorizing history and durable operation receipts, even within one JSON store.
History eviction cannot remove receipts; capacity exhaustion is explicit. Do not add TTL, retry horizon, automatic receipt
retirement, or expired-ID reuse without a later architecture decision.

## Q6: current public baseline and explicit migration

Accept option A. Retain the supported current public contracts; permit bounded additive changes and explicit one-way
migrations only as specified by an accepted task within this architecture. Unknown required features fail closed and
must not be overwritten by an older writer. A downgrade is not implicitly supported.
Retire internal aliases/stores only after consumer/export inventory proves they are unnecessary.
Keep consumed strict/compatibility paths, versioned observation parsers, and provider compatibility matrices.
This does not authorize an indiscriminate breaking release or perpetual compatibility for unused internal code.

## Previously settled decisions retained

Keep machine-local repository authority, one owned worktree/branch per active session, one repository transaction boundary,
XState lifecycle semantics without persisted actor snapshots, pure ResourceClaim compatibility, default claim opt-out,
explicit narrowing-only working sets, opt-in protected runtime, and evidence-bound recovery.
Keep #503's persisted `parked`, canonical XState integration, atomic retention/claim release and reacquisition;
these are implementation obligations, not reopened design questions.

Historical context: [#503](https://github.com/yohn-jp/nawabari/issues/503),
[#540](https://github.com/yohn-jp/nawabari/issues/540), [#664](https://github.com/yohn-jp/nawabari/issues/664).
The [responsibility documents](../index.md) contain the enduring rules; mutable Issue bodies do not replace them.
