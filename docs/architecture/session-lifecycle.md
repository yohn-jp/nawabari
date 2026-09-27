# Session lifecycle

Normative owner: session transition semantics and recovery decisions. Revision: [NAWABARI-TA-1](index.md).
Parking below is accepted design, not a claim that current public commands implement it; see
[implementation status](implementation-status.md).

## Canonical decision and state layers

XState owns execution of Nawabari's session transition semantics. Nawabari owns vocabulary, invariants, pure guards,
explicit evidence collection, and physical effects. Guards do not perform hidden Git, filesystem, or network mutation.
The lifecycle classification facade, public transition table, actions, manifest, and generated diagram derive from
this canonical machine. Raw actors/snapshots are not a persistent or cross-product source of truth.
Transient operation actors may sequence observe/effect/reobserve without owning a second session lifecycle.
ResourceClaim compatibility remains its separately accepted pure matrix; symmetry is not a reason to migrate it to XState.

Persisted current states are `new`, `active`, `closing`, `closed`, and `stale`; the accepted parking contract adds `parked`.
Operational states such as `close-ready`, `blocked-recoverable`, `discarded`, and `stale-inconsistent` are derived from
persisted intent plus physical/proof observations. Do not collapse these layers or persist an actor snapshot as truth.
`parking` is in-progress protocol state, not another persisted session state.

## Provisioning and bootstrap

Provisioning establishes immutable session identity, owned worktree/branch, initial claims, applicable working set,
and selected profile pin through the repository boundary. Git worktree creation and a JSON write are not one filesystem
transaction: partial creation must remain observable and must not lead to automatic adoption or unsafe deletion.

A session with required bootstrap actions remains `new` after durable ownership and before readiness.
Only the pinned, allowlisted bootstrap purpose may execute there; ordinary launch remains ineligible.
Actions run through the selected protected runtime, not raw shell or ambient tool discovery.
Failure or uncertainty leaves an inspectable non-ready owner and does not automatically replay actions or destroy work.
Activation requires accepted bootstrap evidence and current ownership; a process exit label alone is not a general
success proof. Existing captured action results and the canonical activation protocol must remain distinct.

## Active, close, discard, and cleanup

`active` is a lifecycle condition, not proof that admission is open, tools exist, or no process is running.
Close requires the existing lossless cleanup/integration proof, clean/unambiguous physical ownership, and safe runtime state.
An exact caller-supplied integration revision is independently verified through Git ancestry/content evidence.
Neither GitHub merge status nor an operator assertion replaces that proof.

Discard is a separate explicit abandonment intent; it does not fabricate integration evidence.
Keep durable ordinary-close versus discard intent and captured cleanup/discard HEADs through partial failure.
A retry of ordinary close cannot acquire discard authority, and an ordinary completed close cannot become a retroactive discard.
Cleanup is a bounded effect under the accepted lifecycle operation, not a separate unrestricted deletion service.
Final mutation must still match the approved destructive target/effect as specified by the application command contract.

## Park and resume

The retained #503 contract requires canonical XState parking and atomic repository retention, not an independent table.
Park retains worktree/branch and their contents, closes new launch admission, and proves owned runtime quiescence.
Under the repository lock, revalidate identity, selected pin, current claims/generation, fence, and physical evidence;
then commit `parked`, retention intent, and release of all target-session claims together. Readers are released too.
Keep other sessions untouched. Active/unknown runtime, stale evidence, or uncertain durability cannot authorize completion.

Resume verifies the retained physical identity, same pinned profile, latest applicable external scope, desired claims,
all-session conflicts, and current CAS. Restore active state, reacquired claims, retention consumption, and admission
through the same atomic authority. Failure retains parked ownership and acquires no partial claim set.
Desired claims are not a reservation and cannot force another session to release resources.
Do not fabricate a missing pin or treat missing required scope as permission.

Only authoritative park finalization produces `parked`; only successful atomic resume produces `active`.
While parking, close/discard/GC cannot bypass the in-progress protocol.
Parked termination retains normal ownership/integration/explicit-discard/runtime safety rules.
Existing observational `retain-session` is not an alias for park; `reconcile-physical-state` is not implicit repair.

## Reconciliation and garbage collection

Observe current facts, hydrate the canonical decision, execute a bounded authorized effect, reobserve, then persist/confirm.
Reconciliation diagnostics classify drift and safe next actions without applying them.
Explicit reconciliation apply still consumes lifecycle and physical evidence; missing paths or elapsed time are insufficient.
GC selects candidates but delegates destructive work to the same canonical lifecycle/cleanup rules.
Age, heartbeat suspicion, history truncation, and a `stale` label never independently authorize cleanup.

After crash, reconstruct from persisted intent/receipts and fresh Git/FS/runtime evidence, not the lost actor instance.
Preserve completed, retryable, and unresolved distinctions. Repeat an effect only when its operation-specific evidence
proves retry safe. A terminal label does not authorize deleting arbitrary remnants.

## Required proof

Prove canonical state/event parity, ordinary/discard intent separation, partial-cleanup cut points, and unknown evidence.
Prove park -> restart -> conflicting resume rejection -> safe resume through a real temporary registry and public path.
Verify atomic claim release/reacquisition, current pin/scope checks, and real owned-cgroup quiescence on supported Linux.

Anchors: [machine](../../src/state/session/machine.ts), [actors](../../src/state/session/actors.ts),
[classification facade](../../src/session-lifecycle-classification.ts), [retention](../../src/session-retention.ts),
and [accepted integration contract #503](https://github.com/yohn-jp/nawabari/issues/503).
