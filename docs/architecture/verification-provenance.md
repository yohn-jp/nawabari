# Verification and provenance

Normative owner: what each proof establishes, required environments, and exact-source evidence.
Revision: [NAWABARI-TA-1](index.md). This document adopts obligations; it does not report a new test run.

## Proof layers

Pure/domain tests prove deterministic policy, transition, parser, and projection semantics from controlled inputs.
Repository integration proves real state writes, Git/FS identity, CAS, crash/retry behavior, and the application composition.
Compiled-worker tests prove the actual built supervisor/worker boundary rather than a source-only or injected substitute.
Installed-package tests prove the exact packed artifact's exports, executable discovery, CLI paths, and consumer compatibility.
Supported Linux-system tests prove actual bubblewrap/Landlock, delegated cgroups, descendants, drain, and filesystem effects
with the environment/material required by the selected contract.

A hand-written observation bundle proves projection composition, not that a public backend collects observations.
A mocked empty cgroup proves a decision branch, not actual quiescence.
A merged producer or a closed Issue does not prove integration. A green child PR proves neither the final composed tree
nor a different host/artifact boundary. Preserve meaningful regressions rather than weakening them to match the new layout.

## Executable ownership and cost

The current full entry point is `pnpm run verify`; `pnpm run manifest:check` checks the generated machine projection.
#645 owns separating fast, bounded integration, compiled, installed-package, and Linux-system lanes without losing tests.
Map every acceptance invariant to its owning lane and prerequisites; keep exhaustive inventory so reclassification cannot
silently drop tests. Build/pack/install each exact artifact in its owning lane; avoid redundant builds inside unrelated tests.
Standalone compiled/package runs still prepare their required fresh artifact.

Do not repeat ordinary lint/typecheck/domain checks inside a delegated Linux lane merely because it calls the umbrella.
Do preserve repeated scenarios when they prove different source/build/package/kernel boundaries, including UID handoff,
tgrep, and pnpm conformance. Document that distinct purpose and measure invocation counts/duration before claiming savings.
Do not solve slow tests through blanket skips, global timeout growth, or a framework migration unrelated to the contract.

## Required acceptance matrix

- Lifecycle: state/event parity; real atomic park/retention/resume; public action path; real runtime quiescence.
- Filesystem: operation/path/mode/deny corpus; fresh scope/claim CAS; packed bounded workflow; actual enforcement denial.
- Runtime: durable record transitions; reserve/attach/release/GO crash cuts; public result identity; real descendants/cgroups.
- Observations: producer parsing; real backend collection; CLI/TUI/API semantic parity; live changes without fake observations.
- Approval: witness matching; change after preview/before commit; consistent CLI/HTTP rejection; no unsafe physical effect.
- Control: authentication/browser validation; protected payload cannot obtain machine capability; trusted operator succeeds.
- Persistence: current feature migration; concurrent writers; rename/fsync uncertainty; receipts survive restart and history eviction.
- Server operations: direct CLI without server; singleton/rotation; concurrent locator updates; A blocked while B/health respond.
- Verification provenance: exact source binding, changed input invalidation, and unknown-source rejection through public consumers.

Unsupported/missing capability is explicit BLOCKED/unsupported or a documented environment-gated skip, never positive proof.
Run required positive security evidence on the supported environment; an unsupported-host skip cannot fulfill that obligation.
Do not call current CI green from a historical PR body. Record exact SHA, artifact, environment, command, and result.

## Verification as a distinct execution authority

Canonical verification may need broader repository read access than the coding agent's effective working set.
That access is explicit and verifier-owned; it must not silently expand the agent's visibility or mutation scope.
Output is bounded and cannot become an arbitrary out-of-set source-content channel.
Relevant findings may request explicit expansion through the existing authority, not grant it automatically.
Nawabari owns protected execution and evidence binding, not test selection, task correctness, or release orchestration.

## Exact-source provenance (#525)

Bind reusable results to the actual local repository, session/worktree, HEAD/base, verification profile, and relevant pinned
profile, policy, working-set, and runtime identities. A relevant input change invalidates reuse deterministically.
HEAD alone cannot identify dirty/index content actually read by a verifier; where exact source cannot be established,
report unavailable/unresolved evidence rather than a reusable passing result.
Capture/recheck the relevant source around execution; concurrent mutation that invalidates that identity prevents reuse.
The exact witness representation must use the accepted state/policy owners, not a second freshness ledger.

Park/resume, claim/policy changes, bootstrap state, or runtime changes invalidate evidence when they change its relevant
source identity. Do not add an unconditional dependency on completing parking merely to define source-bound verification.
A serialized passing status without provable source is not authorization to commit, merge, publish, or widen a working set.

## Convergence and retirement

Certify the composed exact main/candidate tree through the public paths and required physical environments.
Prove both accepted behavior and the absence of retired decisions/consumers. Inventory runtime imports, public exports,
package consumers, and required compatibility paths before deleting aliases or a legacy store.
Keep consumed explicit compatibility runtime, versioned observation parsing, and provider compatibility matrices.
A certification worker reports defects; it does not independently change architecture, repair source, merge, or close Issues.

Source contracts: [#525](https://github.com/yohn-jp/nawabari/issues/525),
[#645](https://github.com/yohn-jp/nawabari/issues/645).
Execution owners: [package scripts](../../package.json), [CI](../../.github/workflows/ci.yml),
[compiled supervisor proofs](../../src/domain/session-launch-supervisor-worker.test.ts).
