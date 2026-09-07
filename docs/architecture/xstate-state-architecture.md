# Nawabari XState State Architecture

## Status

Accepted architecture direction for the staged migration of Nawabari lifecycle and state semantics to XState v5.

This document defines the target boundaries, migration order, invariants, and cross-product integration contract. It does not authorize a flag-day rewrite and does not replace Git, filesystem, or registry facts with XState snapshots.

## Decision

Nawabari will adopt XState v5 as the generic state-machine and actor runtime for product-owned state-transition semantics.

Nawabari remains the authority for its domain vocabulary, invariants, policies, external observations, and mutation adapters. XState becomes the authority for generic transition execution, actor lifecycle, nested/parallel state composition, graph traversal, and transition availability.

The migration starts with the session lifecycle because Nawabari already has an implementation-owned classifier and transition table for termination/recovery semantics. Existing behavior is normative input and must be preserved before XState becomes authoritative.

## Existing authorities

The current codebase already contains several state-like authorities:

- `SessionRecord.state`: persisted lifecycle record state (`new`, `active`, `closing`, `closed`, `stale`).
- `session-lifecycle-classification.ts`: derived operational lifecycle classification and transition table (`active`, `close-ready`, `blocked-recoverable`, `discarded`, `stale-inconsistent`, `closed`).
- `session-lifecycle-actions.ts`: typed caller-action projection from lifecycle classification.
- `resource-claims.ts`: resource-claim transition and compatibility matrices.
- `operation-authorization.ts`: operation vocabulary and required claim-access policy.
- cleanup/reconciliation logic in `session-registry.ts`: durable `closing` marker, close/discard retry, partial cleanup re-observation, finalization, and claim release.
- `contract.ts`: machine-facing projection of lifecycle, claim, operation, result, and failure contracts.

The XState migration must converge these authorities where they represent state-transition semantics while retaining independent domain policies where they do not.

## Source-of-truth boundary

XState does not become the source of truth for external facts.

Authoritative observed state remains owned by the current boundaries:

- Git refs, HEADs, ancestry, trees, and worktree registration: Git observation authorities.
- Worktree/filesystem identity and presence: existing filesystem/Git observation authorities.
- persisted session lifecycle intent and durable cleanup markers: Nawabari session registry.
- resource claims and claim-set generation: Nawabari resource-claim registry semantics.
- sandbox/runtime capabilities: existing runtime and sandbox authorities.

XState owns:

- which events are admissible from a product state;
- transition semantics;
- state composition;
- deterministic transition availability;
- actor lifecycle where actors are used;
- graph-based reachability and transition coverage;
- state-machine metadata from which public lifecycle discovery can be projected.

The canonical execution shape is:

```text
observe authoritative facts
        |
        v
hydrate machine input/context
        |
        v
XState transition evaluation
        |
        v
perform bounded effect through existing adapter
        |
        v
re-observe authoritative facts
        |
        v
persist/confirm Nawabari state
        |
        v
project result / diagnostics / contract
```

No guard may hide ambient Git/filesystem/network mutation. External evidence is gathered before transition evaluation or through explicit invoked actors/effect boundaries.

## State model layers

Persisted state and derived operational state remain separate concepts.

### Persisted session record state

```text
new
active
closing
closed
stale
```

This is durable local lifecycle intent/history stored by Nawabari.

### Derived operational lifecycle state

```text
active
close-ready
blocked-recoverable
discarded
stale-inconsistent
closed
```

This is derived from persisted state plus authoritative physical and proof observations.

The XState model must not collapse these two vocabularies into one enum merely for convenience. Persisted record state belongs in authoritative input/context; operational state belongs in the statechart and/or a projection of its snapshot.

## Session actor target

The first production XState authority is the Nawabari session actor.

Conceptually:

```text
Session Actor
|
+-- lifecycle
|   +-- active
|   +-- checking-close
|   +-- blocked-recoverable
|   +-- closing
|   +-- reconciling
|   +-- stale-inconsistent
|   +-- closed
|
+-- context
    +-- SessionRecord
    +-- physical observation
    +-- integration proof/readiness
    +-- blockers
    +-- GC authorization evidence
    +-- claim-set generation
```

Exact nested-state names are implementation details until the parity phase completes. Public state vocabulary remains backward compatible unless changed by a separate contract Issue.

## Event model

Internal event names should be capability-shaped and product-owned rather than CLI-shaped. CLI commands are adapters that map to events.

Candidate session events include:

```text
SESSION.OBSERVE
SESSION.CLOSE.REQUESTED
SESSION.DISCARD.REQUESTED
SESSION.RECONCILE.REQUESTED
SESSION.GC.REQUESTED
SESSION.CLEANUP.RETRY
SESSION.CLEANUP.FINALIZE
SESSION.MARK_STALE
```

Events that cross a product boundary must use a separately versioned public protocol. Internal machine events are not automatically public integration contracts.

## Cleanup and recovery

The durable `closing` state and existing cleanup-head/discard intent records are preserved.

Close/discard must remain retry-safe across partial physical mutation. XState coordinates the transition protocol, but identity checks and physical mutations remain in existing authorities.

The modeled recovery outcomes remain at least:

```text
completed
retryable
unresolved
```

A representative transition shape is:

```text
active
  |
  | SESSION.CLOSE.REQUESTED
  v
checking-close
  |\
  | \ blocked/recoverable
  |  +------------------> blocked-recoverable
  |
  +--> closing
        |
        | partial failure / restart
        v
     reconciling
       |   |   \
       |   |    +--> stale-inconsistent / unresolved
       |   +-------> closing / retryable
       +-----------> closed / completed
```

Normal close must never acquire discard authority. Discard remains explicit caller intent.

## Resource claims

The existing transition matrix:

```text
none <-> read <-> write <-> exclusive-write
```

with transition classes `acquire`, `no-op`, `change`, `release` is already an explicit finite-state model.

### Issue #258 decision: retain the pure exact-resource transition authority

Retain `RESOURCE_CLAIM_TRANSITION_MATRIX` as the sole exact-resource transition authority. Do not migrate this finite classification table to XState.

This is a code-level decision based on the current implementation:

| Criterion              | Current exact-resource implementation                                                           | Decision consequence                                                                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| State domain           | Four closed values: `none`, `read`, `write`, `exclusive-write`                                  | A total 4 x 4 table is sufficient for every valid pair.                                                             |
| Transition semantics   | `classifyResourceClaimTransition()` validates the two modes and performs a direct matrix lookup | The classifier is a pure validated lookup, not a competing semantic authority.                                      |
| Observation and guards | No external observation or contextual guard is needed to classify a pair                        | No XState guard or context is required.                                                                             |
| Effects and recovery   | Classification performs no asynchronous effect and has no intermediate or recovery state        | No actor lifecycle or statechart runtime semantics are needed.                                                      |
| Coverage               | The matrix has one deterministic class for every source/requested pair                          | Exhaustive table tests provide direct coverage; graph traversal would add machinery without adding domain evidence. |

The distinction from Session lifecycle is therefore intentional:

```text
Session lifecycle
    -> contextual state machine
    -> XState authority

Exact-resource claim transition
    -> finite pure classification table
    -> RESOURCE_CLAIM_TRANSITION_MATRIX authority
```

This decision must be revisited only if exact-resource transitions acquire contextual guards, external observation, asynchronous effects, intermediate/recovery states, or actor lifecycle semantics. Per-resource actors and statecharts are not introduced for architectural symmetry.

The following authorities remain independent and are not copied into XState configuration or guards:

- `RESOURCE_CLAIM_COMPATIBILITY_MATRIX`: overlapping claim compatibility and conflict policy.
- `RESOURCE_CLAIM_ACCESS_STRENGTH` and `claimModeGrantsAccess()`: access-strength policy.
- `canonicalizeClaimResource()` and `canonicalizeConcretePath()`: path canonicalization.
- `claimsOverlap()`, `claimsConflict()`, and `resourceClaimConflictsWithAccess()`: overlap/conflict evaluation.
- `OPERATION_AUTHORIZATION_POLICY`: operation authorization policy.

The Product State Manifest remains a projection of the Session actor. This decision does not add a Resource Claim actor or statechart to the manifest.

Do not replace the independent compatibility/access policy merely because the exact-resource transition table is used alongside XState elsewhere.

## Operation authorization

`OPERATION_AUTHORIZATION_POLICY` remains a domain policy authority, not a state machine.

It maps capability-shaped operations to required resource-claim strength and enforcement metadata. XState guards may consume this authority; they must not duplicate or re-encode it.

## Machine contract projection

`contract.ts` must move toward being a projection of authoritative implementation metadata rather than a second hand-maintained state definition.

Target direction:

```text
XState machine + domain policy authorities
               |
               +--> runtime
               +--> graph tests
               +--> machine contract
               +--> CLI discovery/help
               +--> architecture diagrams
               +--> future MCP/API projection
```

The public contract remains versioned and backward compatible during migration. XState internal state node identifiers are not automatically public schema values.

## Public library boundary

Nawabari currently exposes primarily a CLI surface. Cross-product integration requires a stable library/protocol boundary so Mottainai and future adapters do not have to reproduce CLI parsing or depend on machine internals.

The target public surface should expose stable concepts such as:

```text
NawabariCommand / NawabariEvent
NawabariObservation
NawabariStateSnapshot (public projection, not raw XState snapshot)
NawabariTransitionDecision
NawabariContract
```

Raw machine instances, actor refs, internal state-node identifiers, and private context objects must not become cross-product API accidentally.

## Cross-product actor protocol

Nawabari is the reference implementation for a later multi-product state architecture spanning Inari and Mottainai.

Ownership remains independent:

```text
Inari      -> GitHub/governance desired and observed state
Mottainai  -> task/execution/agent orchestration state
Nawabari   -> local workspace/session/Git isolation state
```

Products connect through versioned public events and snapshots, not by sharing one giant machine or reaching into another product's actor internals.

A future topology may resemble:

```text
Inari Actor(s)
   |
   | governed work / PR / merge events
   v
Mottainai Actor(s)
   |
   | workspace request / execution events
   v
Nawabari Actor(s)

Nawabari may emit workspace/session events back to Mottainai; Mottainai may emit execution completion back to Inari. Transport (MCP, local IPC, HTTP, Actions, queue) remains an adapter concern.
```

The protocol must make producer, consumer, event version, correlation identity, and idempotency expectations explicit.

## Product state manifest and visualization

The architecture must support generated state documentation and cross-product diagrams without introducing a hand-maintained second authority.

Each product should eventually generate a product state manifest from its executable machines plus explicit public metadata. The manifest can contain:

- product/version;
- actor identities;
- public state projections;
- accepted/emitted public events;
- event versions;
- public transition metadata;
- source-of-truth/authority metadata;
- cross-product connection declarations.

Generated manifests can then be composed into:

- per-machine statecharts;
- per-product actor/state diagrams;
- cross-product event topology;
- interactive architecture views;
- CI validation of producer/consumer contract compatibility.

The generation direction is one-way:

```text
XState/domain authority -> Product State Manifest -> diagrams/docs/CI
```

Diagrams are projections, never an editable source of truth.

Nawabari's first implementation is `src/product-state-manifest.ts`, exposed
through the stable `nawabari/manifest` package subpath. It projects the public
state API and machine contract for the Session actor. The public command
descriptors carry versioned producer/consumer, correlation, and idempotency
metadata. No public cross-product event is currently emitted, so the manifest
declares an explicit empty `not-exposed` event surface rather than inventing
runtime events. The generated Session diagram is
`docs/architecture/generated/session-lifecycle.mmd`; `pnpm run manifest:check`
fails when that output drifts from the projection.

## Proposed module layout

Initial target:

```text
src/state/
  session/
    machine.ts
    types.ts
    guards.ts
    actors.ts
    projections.ts
    machine.test.ts
  index.ts
```

Existing domain observation, Git, registry, claim, authorization, and sandbox modules remain outside `src/state/` unless a later Issue demonstrates that moving them improves authority boundaries.

## Migration plan

### Phase 1: dependency and architecture foundation

- Add XState v5 as an explicit dependency.
- Establish `src/state/session/` types and machine boundary.
- Define internal event/context naming rules.
- Add architecture checks preventing CLI/Git/filesystem concerns from becoming machine-internal authorities.

### Phase 2: shadow session machine

- Encode the current session lifecycle classifier/transition behavior in XState.
- Keep production behavior on the existing implementation.
- Build a parity harness comparing every existing classification/transition outcome to XState.
- Use graph traversal to prove reachable states/transitions and identify impossible/uncovered paths.

### Phase 3: semantic authority switch

- Make XState the sole transition authority for the canonical session lifecycle.
- Retain current public `SessionLifecycleClassification` and transition schemas as projections.
- Remove the manually maintained transition table after parity and contract tests prove equivalence.

### Phase 4: close/discard/reconciliation protocol

- Move transition coordination for close/discard/reconcile/GC cleanup into the session actor.
- Retain existing effect adapters and identity/proof authorities.
- Model retry/idempotency/partial cleanup explicitly.
- Add fault-injection and restart/re-hydration tests.

### Phase 5: projections and adapters

- Drive lifecycle actions, diagnostics, status, and CLI availability from the XState/public snapshot projection.
- Keep human output as presentation over structured state.
- Remove command-local lifecycle conditionals.

### Phase 6: machine contract generation

- Generate lifecycle state/transition discovery from XState metadata and public projection definitions.
- Preserve stable contract schema versions.
- Add drift/conformance tests proving no hand-maintained duplicate transition authority remains.

### Phase 7: public state/contract API

- Add explicit package exports for stable state/contract surfaces.
- Keep raw actor/machine internals private.
- Provide a transport-neutral boundary suitable for Mottainai/Inari adapters.

### Phase 8: resource-claim evaluation (completed by #258)

- Retain `RESOURCE_CLAIM_TRANSITION_MATRIX` as the exact-resource transition authority.
- Reconsider migration only if the transition domain gains the contextual, effectful, or actor-lifecycle characteristics documented above.

### Phase 9: generated visualization and cross-product manifest foundation

- Generate per-product state diagrams from executable state definitions.
- Define the first Nawabari Product State Manifest schema/projection.
- Reserve public event metadata required for later Mottainai/Inari composition.

## Issue decomposition rules

Implementation Issues created from this architecture must satisfy all of the following:

- one coding-agent session scope;
- one clear authority migration or projection boundary;
- no simultaneous state-engine migration and unrelated UX change;
- explicit source-of-truth boundary;
- deterministic acceptance criteria;
- backward-compatibility statement for public JSON/failure/CLI contracts;
- focused parity or graph/fault-injection validation where relevant.

## Initial implementation Issue set

The architecture should be implemented through at least these leaf Issues:

1. Add XState v5 and establish the session state module boundary.
2. Encode the current lifecycle classifier/transition table as a shadow XState session machine.
3. Add parity and graph-coverage tests between current lifecycle authority and the shadow machine.
4. Switch canonical session transition semantics to XState while preserving public lifecycle projections.
5. Model close/discard/reconciliation partial-cleanup coordination and retry in the session actor.
6. Converge lifecycle next-action/status/diagnostic projections on the XState-derived public snapshot.
7. Generate session lifecycle machine-contract metadata from the XState authority.
8. Add stable package exports for Nawabari state/contract integration without exposing raw actor internals.
9. Evaluate resource-claim transition semantics and record the authority decision; #258 retains the pure matrix.
10. Define/generate Nawabari Product State Manifest and state diagrams as groundwork for Inari/Mottainai composition.

Leaves 1-3 may proceed with limited parallelism once interfaces are agreed. The authority switch depends on parity proof. Cleanup/reconciliation migration depends on the authority switch or an explicitly compatible staged adapter. Contract/public API work follows stable public projection semantics.

## Testing strategy

The migration must add stronger evidence than the current hand-maintained transition tables provide.

Required categories:

- current-behavior parity tests;
- XState graph reachability/transition coverage;
- impossible/forbidden transition assertions;
- fail-closed guard tests for ambiguous observation;
- partial-cleanup fault injection;
- restart/re-hydration from authoritative registry/Git facts;
- idempotent retry tests;
- public JSON/result/failure compatibility tests;
- exact packed-package conformance;
- generated contract/diagram drift tests once generation exists.

## Non-goals

- Replacing the session registry with persisted raw XState snapshots.
- Moving Git/filesystem/network effects into guards.
- Building a general distributed workflow engine inside Nawabari.
- Making Inari or Mottainai state authoritative inside Nawabari.
- Creating a single cross-product mega-machine.
- Rewriting resource-claim compatibility or authorization policy solely for XState uniformity.
- Changing public state vocabulary in the first migration wave.

## Success criteria

The migration is complete when:

- session transition semantics have one executable XState authority;
- Git/filesystem/registry facts retain their existing authoritative boundaries;
- close/discard/reconciliation recovery is explicitly modeled and regression-proven;
- diagnostics, safe actions, status, help/discovery, and machine contracts project from shared state authority;
- no duplicate manually maintained session transition table remains;
- the state model can generate a trustworthy per-product diagram;
- Nawabari exposes a stable transport-neutral state/contract boundary suitable for later Inari/Mottainai composition.
