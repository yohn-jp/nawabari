# Target Architecture

Revision: **NAWABARI-TA-1**. Status: **Accepted design**. Adopted: **2026-09-27**.
The human owner approved the Architecture Reconstruction Report and all six recommended options.
The [decision record](decisions/2026-09-27-target-architecture.md) freezes those choices.
Acceptance of the design does not assert implementation or authorize Issue changes, product commits, or merges.

The reconstruction inspected `9c836c12c01a75dd77edf32ad023ca452c5c6053`.
Documentation rollout is based on `3f814154c6ba9509ae9a1a15db41c890fc02271c` (0.13.0 release commit).
The `src` tree is unchanged between those baselines. See [implementation status](implementation-status.md) for gaps.

## Authority and changes

The latest explicit human decision controls intent. This accepted architecture and supported public contracts control
semantics. An accepted Implementation Issue defines scope and acceptance inside those boundaries.
Current code, schemas, tests, generated artifacts, and live repository state establish what is implemented; they do not
silently legitimize deviations from the accepted design. PR bodies and historical Issue execution plans are evidence,
not independent sources of authority. Shared executable governance still applies and must not be bypassed.

Only the human owner and design owner may approve changes to authority boundaries, subsystem responsibility, canonical
state/source of truth, lifecycle semantics, persistence model, public-contract meaning, security/isolation, or compatibility.
An Implementation Agent must return `ARCHITECTURE_DECISION_REQUIRED` with exact base, affected contract, reachable failure,
alternatives, and consequences when a required change is not already decided.
Internal naming, algorithms, and async/worker implementation choices remain delegated inside these invariants.

Future semantic amendments update the owning document and add a decision record with a new architecture revision.
Do not edit a historical adoption decision to pretend a later change was originally accepted.
Issue plans must bind the architecture revision, input producers, public consumers, failure semantics, and proof boundary.

## Responsibility documents

- [Product boundary](product-boundary.md): product, actors, machine/repository scope, and non-goals.
- [State and authority](state-and-authority.md): identities, owners, derived/physical state, and dependencies.
- [Session lifecycle](session-lifecycle.md): XState, bootstrap, park/resume, termination, recovery, and GC.
- [Filesystem and isolation](filesystem-isolation.md): scope, working set, deny, claims application, and exact mutations.
- [Resource coordination](resource-coordination.md): compatibility, claims, conflict evidence, and atomic handoff.
- [Runtime and processes](runtime-process.md): materialization, admission, owned execution, and process observation.
- [Persistence and concurrency](persistence-concurrency.md): transactions, versions, durability, receipts, and crash windows.
- [Control surfaces](control-surfaces.md): CLI/public API, TUI/Web, operator capability, catalog, and optional server.
- [Verification and provenance](verification-provenance.md): proof layers, environments, source binding, and completion.

These are logical responsibilities, not a requirement to create separate packages, databases, daemons, or a generic framework.
A canonicalization is justified only if it removes an authority or duplicated decision, enforces an invariant once, or
allows a consumer-side subsystem to be removed. Moving code while retaining both decisions does not complete it.

## Documentation disposition

README, SECURITY, CONTRIBUTING, and root AGENTS are rewritten as entry/reporting/workflow documents pointing here.
The former XState architecture is superseded by lifecycle/state/verification contracts; the generated diagram is retained.
The former runtime-projection architecture is replaced by runtime/filesystem contracts and a focused implementation reference.
Provider documents move to historical evidence, with a current reference preserving materializer/provider responsibilities.
Old URLs become navigation-only stubs. Exact historical content remains in evidence or immutable Git history.
Benchmarks and release notes are retained as historical evidence. Shared governance mirrors remain unchanged.

[Implementation status](implementation-status.md) is a dated assessment, not another normative contract.
It records adoption gaps without silently withdrawing requirements or treating proposed work units as issued Issues.
