# Persistence and concurrency

Normative owner: durable repository state, atomicity, concurrency witnesses, and recovery outcomes.
Revision: [NAWABARI-TA-1](index.md). Decisions Q4-Q6 are accepted; implementation gaps remain explicit.

## One repository state boundary

Keep one repository-scoped JSON state at `<common-git-dir>/nawabari/session-registry.json` and its canonical lock.
Session, claim, admission, execution, profile, retention, and operation facts that must commit together share this boundary.
Do not split domain records into independent databases or add server-authoritative state.
SQLite, event sourcing, distributed transactions, and an always-running state daemon are not requirements.

The state boundary owns read/parse/feature gates, lock, validation, atomic serialization, and cross-record invariants.
Domain owners decide permissible typed changes. Application/physical adapters perform bounded Git/FS/process effects.
A storage class must not independently decide lifecycle or access policy. An unconstrained JSON mutation API is not a
replacement for domain contracts. A parallel unused storage abstraction is retired only after its consumers are proven absent.

Registry schema, session schema, claim schema, optional feature versions, and public wire versions are independent.
Keep existing supported readers and explicit migration. Unknown required feature/payload must cause fail-closed rejection,
not stripping, guessing, or an older writer overwriting newer state. One-way migration does not imply downgrade support.
Adopting `parked` or a new approval schema requires its explicitly approved migration/public compatibility obligations.

## Versions and locks

Registry revision advances for an actual persisted repository fact mutation.
Claim-set generation advances only when claims change; working-set revision identifies approved scope expansion.
Runtime epoch/fence identifies current launch-admission authority, not a generic UI timestamp or an implicit per-session
counter. Preserve the existing rebasing of unaffected open admissions when the repository runtime epoch changes.
A profile digest identifies pinned content; it is not a mutation generation.

CLI, server, and workers use the same repository lock and CAS rules. Re-read under the lock before deciding a mutation.
Do not authorize from an instance cache or stale snapshot. A reader may observe a complete older state, but must not claim
its joined physical observations are an atomic photograph.
Lock recovery uses exact process-generation evidence and the existing publication-grace/reclaim protocol.
Unknown ownership, malformed metadata, elapsed age, or PID alone cannot authorize stealing a lock.
Server singleton/discovery leases are operational metadata with separate scope, not alternative repository locks.

## Visibility versus durability

Atomic rename exposes the old or new complete document; it does not serialize writers or atomically commit Git/process/FS
effects. Canonical writes require same-directory temporary material, durable file data, atomic replacement, and required
parent-directory durability on a qualified supported local filesystem.
Under Q4, unsupported/unproven durability fails canonical mutation instead of silently succeeding in degraded mode.
Read and diagnostic access may remain available. No degraded mode or broad remote/shared-filesystem support is adopted.
Qualification must state the filesystem/platform assumptions; a successful syscall test alone cannot prove all power-loss behavior.

Distinguish failure before publication from failure after rename. The latter is durability uncertainty even if readers
already see the new state. Re-reading visibility helps recognition but is not by itself proof of power-loss durability.
Never roll back owned physical resources or replay an effect on the assumption that an error means nothing happened.
Discovery metadata is reconstructable and has different consequence from canonical state, but updates still need serialization.

## Operation protocol

```text
resolve context and collect bounded current facts
  -> plan and obtain explicit approval where required
  -> lock, re-read, check relevant versions/identity/approved effect
  -> commit required reservation/intent/admission fence
  -> unlock, execute or observe bounded physical work
  -> lock, re-read, check fresh physical and authority witnesses
  -> commit final state and required durable receipt
  -> unlock and project result
```

Use this protocol only where physical effects require it. Pure reads and simple claim CAS do not need a new generic journal.
Do not hold the repository lock while waiting for drain, long-running payloads, or network completion.
Preserve operation-specific Git, launch, file-operation, and handoff recovery evidence; do not force all into one invented
public status enum. Deterministic planning and required final revalidation are not redundant validation to be deleted.

## Approval and idempotency

A destructive plan binds target repository/session/worktree/branch, operation identity, approved effect and scope, and
relevant current Git/FS/policy/claim witnesses. The final owning mutation receives that approval, not only a session ID.
Current safety and approved effect must both hold; a fresh safety check does not expand the user's approval.
If they change after preview, reject without unsafe effect and require refresh/reconfirmation.

Separate in-process duplicate coalescing, stale-plan rejection, durable same-intent receipt recognition, and uncertain
no-replay outcomes. A dispatcher Map or HTTP operation ID alone is not restart-safe exactly-once execution.
Use existing operation-specific receipts where applicable; changed payload under a reused ID must fail.
A failed or unrecognized prior effect cannot be treated as proven absent.

## Receipt and history ownership

Under Q5, keep bounded durable receipts and explicit fail-closed capacity exhaustion.
History is bounded non-authorizing evidence with declared truncation/provenance; receipts are canonical facts needed for retry.
History pruning never evicts receipts, including when both variants share `recent_events` physically.
Expose capacity/uncertainty diagnostically. Do not invent receipt TTL, retry horizon, automatic retirement, or old-ID reuse.
No file-format split is required merely to distinguish logical ownership and retention rules.

## Crash windows

- Before lock-owner publication: use bounded grace and proven owner liveness, not age-based removal.
- Before rename: the old canonical document remains authoritative; a temporary file is not a committed record.
- After rename/before durability confirmation: retain uncertainty; observe identity and do not blindly repeat the mutation.
- After Git worktree creation/before ownership commit: compare physical and durable facts; do not silently adopt/delete.
- During bootstrap: retain non-ready ownership and action/execution evidence; no automatic replay.
- After payload release attempt/response loss: reobserve owned scopes; do not launch again from missing output.
- After file effect/before final receipt: operation-specific reconciliation; unknown remains no-replay.
- After handoff commit/response loss: recognize the durable same-intent receipt without a second transfer.
- After server restart/history eviction: canonical records and physical evidence remain authority, not server memory/history absence.

## Required proof

Prove concurrent CLI/server writes, each relevant CAS, feature migration, lock reclaim races, rename/fsync cut points,
response loss, changed-intent retry, receipt capacity, and physical-effect uncertainty.
Inject changes between preview and final mutation and between pre-I/O/final observation.

Anchors: [atomic writes](../../src/registry/atomic.ts), [lock](../../src/registry/lock.ts),
[state writer](../../src/session-registry.ts), [typed runtime records](../../src/registry/runtime-records.ts),
and [file-operation records](../../src/registry/file-operation-record.ts).
