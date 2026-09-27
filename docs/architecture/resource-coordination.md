# Resource coordination

Normative owner: claims, compatibility, coordinated transitions, and handoff. Revision: [NAWABARI-TA-1](index.md).

## Claims are not the complete authorization model

A ResourceClaim is canonical repository-relative allocation/access evidence owned by one session and bound to its worktree.
Its access modes remain `read`, `write`, and `exclusive-write`; `none` is transition vocabulary, not a persisted claim mode.
Claims-on makes own-claim strength an additional operation precondition. Claims-off does not require an own claim for an
otherwise-valid owned operation, but never disables other-session conflict protection or filesystem/scope restrictions.
The [filesystem contract](filesystem-isolation.md) owns the final conjunction and Q2's bounded-expansion semantics.

Preserve the existing compatibility matrix: read/read and read/write may coexist; ordinary write/write conflicts;
exclusive-write excludes every overlapping claim. A read declaration is not a consistency lease.
Preserve exact-resource acquire/change/release/no-op semantics and cumulative claim access strength.
The operation policy retains its distinction between authorization vocabulary and actual public executors.
For claim-enforced governed commit/push, retain the required exclusive-write strength; do not change it in a refactor.

The only adopted sharing exception is explicit isolated-worktree write/write sharing with the same declared group and
fresh evidence of different valid owned worktrees in the same repository. Do not infer group membership, promote shared
access to exclusive access, or permit sharing from missing/ambiguous physical evidence.
Reuse canonical path matching/conflict predicates rather than adding a UI or orchestration-side table.

## Transition transaction

Normalize a complete request, observe all affected owners/claims, verify expected generation and overlap, then commit
once under the repository lock. Full replacement, multi-delta updates, and release preserve their existing meanings.
A failed member rejects the whole transaction; do not release all and race to reacquire.
Increment claim generation only when canonical claims change and registry revision for an actual persisted mutation.
Check reduction/drain requirements before relinquishing authority used by managed execution.

## Atomic handoff

Handoff transfers the intended resource after closing source launch admission and proving owned execution quiescence.
Unknown, active, missing, or merely empty record-list evidence does not prove safe handoff.
Revalidate source/destination identity, destination scope, current all-claim conflicts, and CAS under the final lock.
Commit source removal, destination claim, and durable same-intent receipt atomically; preserve unrelated claims.
Runtime supplies process/fence evidence and never performs the claim transfer itself.
Destination scope expansion is a prior explicit working-set operation; handoff must not expand it.

A completed same-intent retry uses durable receipt recognition instead of refencing/retransferring.
Changed intent under a reused operation ID is rejected. Uncertain commit/effect requires reconciliation, not blind replay.
Receipt capacity and retention follow [persistence/concurrency](persistence-concurrency.md), not presentation history policy.

## Observation

Declared intent, changed Git/FS content, physical divergence, mergeability, and conflict are distinct.
Bounded preview is non-mutating: no worktree/index/ref/registry/claim-generation changes.
Metadata-only preview does not imply source-content access. Patch/hunk content requires explicit bounded read authority.
Wait/block, overlap graphs, conflict matrices, and next-action hints are projections, not a persisted scheduling queue.
No automatic winner selection, merge, force-release of another owner, or semantic correctness decision is introduced.

## Required proof

Retain mode/sharing matrices, atomic multi-request rejection, stale generation, protected-runtime reduction, positive
supported-Linux handoff, response-loss/restart receipt recognition, and preview immutability/content gating.

Anchors: [claims](../../src/resource-claims.ts), [operation policy](../../src/operation-authorization.ts),
[transactions](../../src/coordination-transactions.ts), [handoff](../../src/resource-handoff.ts),
and [source design #400](https://github.com/yohn-jp/nawabari/issues/400).
