# State and authority

Normative owner: identities, sources of truth, and dependency direction. Revision: [NAWABARI-TA-1](index.md).

## Four meanings of authority

Normative authority is the accepted architecture and public contract.
Decision authority is the canonical implementation evaluating supplied current facts.
Durable authority records what Nawabari owns, requested, fenced, or committed.
Physical evidence describes what Git, filesystems, processes, and the kernel currently expose.
A canonical read model is a projection of these sources, not a fifth authorization store.

## Identity

Repository identity is the resolved common Git directory, not a display name or remote URL.
Worktree identity includes the registry binding and independently verified Git/filesystem context; a reused path cannot
be silently adopted. Branch identity is tied to the owned mutable ref. Session identity is generated automatically,
immutable, and distinct from human labels. Execution identity belongs to one session and is bound to boot, supervisor
process generation, owned cgroup, profile/policy witness, and runtime epoch as required by the execution contract.

Machine catalog route keys are opaque locators derived from local repository identity, not authority IDs for provider
permissions. Repository relocation, clone copying, path reuse, or remote equality cannot silently repair identity drift.
Unknown/mismatched identity fails closed. No new globally stable repository-ID persistence scheme is adopted here.

## Logical owners

- Ownership domain: repository/session/worktree/branch binding and exclusive physical ownership invariants.
- Lifecycle domain: semantic session transitions and termination/parking/recovery admissibility.
- Access-policy domain: scope provenance, approved effective working set, and operation permission decisions.
- Coordination domain: canonical claims, compatibility, generation-safe transitions, and handoff.
- Profile/runtime domain: immutable selected profile, exact material, admission, and durable execution ownership.
- Repository State Boundary: schema/feature validation, lock, atomic commit, revisions, and cross-record invariants.
- Application services: compose domain decisions with physical effects, approval, and observation collection.
- Adapters/projections: CLI/HTTP input, browser/TUI rendering, discovery, diagnostics, and result serialization.

These are responsibilities, not separate databases or services. SessionRegistry may remain a facade, but it must not
remain an independent lifecycle/policy engine beside the canonical domain owners.
State persistence exposes typed domain changes, not a generic arbitrary-JSON-patch permission to every consumer.

## Authoritative, derived, and physical state

Persisted lifecycle intent, ownership bindings, claims, approved working-set revision/provenance, profile pins,
admission/execution records, retention intent, and operation receipts are durable facts in one repository state boundary.
The effective working set is an approved local authority result: do not recompute it from a newer external candidate and
silently change an existing session. A retained desired claim is only reacquisition intent, not an active reservation.

Operational lifecycle classification, current filesystem compilation, runtime material projection, drift, attention,
conflict/mergeability, and RepositoryRuntimeSnapshot are derived from the relevant current inputs.
Persisting a snapshot as a cache or historical observation never promotes it to present authorization.
Git refs/HEAD/worktree registration, descriptor-bound file identity, boot identity, and cgroup occupancy remain physical
sources. A record saying `exited` does not prove the current owned scope empty.

`unknown` denotes unavailable evidence; `stale` denotes evidence/version mismatch or the existing persisted lifecycle
meaning; `blocked` denotes a command result. None is shorthand for permission to delete or release.
Timestamps alone are not concurrency generations or liveness proof.

## Dependency map

```text
CLI / TUI                 optional local HTTP / Web
    \                         /
             Application services
        /                           \
 Session commands             Observation collection
   |      |      |                 |
Lifecycle Policy Coordination      +--> pure snapshot / views
   \      |      /
       typed repository transactions
             |            |
       durable state   physical adapter ports
                          |          |
                        Git/FS    runtime/supervisor/kernel

Machine catalog --> repository locator resolution only
Protected payload -X-> machine-wide operator capability
```

Application code consumes domain contracts; physical adapters implement observation/effect ports.
Domain/application must not import a UI implementation to decide admissibility or destructive approval.
Runtime observers do not change claims; snapshot renderers do not infer lifecycle permission.
Read and command paths use the same source owners without requiring HTTP for direct CLI operation.

## Distinct witnesses

An operator capability establishes the caller's right to use the operator surface.
A concurrency witness binds a plan to relevant repository revision, claim generation, working-set revision, and runtime fence.
An approval witness binds explicit consent to the target, operation identity, effect, and destructive scope.
A physical witness binds current evidence to the exact Git/FS/process object being acted on.
No witness replaces another. All final mutations revalidate the relevant witnesses at their owning boundary.

Implementation anchors: [SessionRegistry](../../src/session-registry.ts),
[local backend](../../src/domain/session-backend.ts), [public state](../../src/public-state.ts),
and [runtime snapshot](../../src/repository-runtime-snapshot.ts).
