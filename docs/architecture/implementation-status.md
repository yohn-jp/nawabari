# Implementation status and convergence

Classification: dated implementation assessment, **not normative authority or certification**.
Target: [NAWABARI-TA-1](index.md), accepted on 2026-09-27.
Reconstruction baseline: `9c836c12c01a75dd77edf32ad023ca452c5c6053`.
Rollout base: `3f814154c6ba9509ae9a1a15db41c890fc02271c`; its source tree is unchanged from the reconstruction baseline.
This documentation change alters no product code, schemas, dependencies, tests, workflow, or generated state diagram.

## Retained foundations

Keep repository-scoped ownership/locking, atomic write and uncertainty distinctions, numeric revisions and claim CAS,
XState lifecycle projection, explicit working-set provenance, upper profile pinning, strict/compatibility materialization,
protected supervisor release ordering, owned boot/cgroup observation, typed file-operation receipts, and atomic handoff.
Do not reimplement these producers merely because the target assigns them clearer logical owners.

## Gaps and required ownership

- D00, security priority: inherited networking and control-token root HTML leave the operator capability reachable to local
  payloads. Q1 requires trusted-host-only delivery. This is static composition analysis, not an executed exploit or fix.
  Evidence: [server](../../src/control-server.ts), [sandbox](../../src/domain/sandbox.ts).
- D01: the backend snapshot supplies registry/time but not the five actual observation producers. Wire one application
  collector; hand-written bundles do not prove that public path. Evidence: [backend](../../src/domain/session-backend.ts),
  [snapshot](../../src/repository-runtime-snapshot.ts), [fixture](../../src/repository-runtime-integration.test.ts).
- D02: parking/retention producers do not constitute canonical persisted/XState/backend/CLI integration. Implement retained
  #503 semantics through the lifecycle/state boundary. Evidence: [machine](../../src/state/session/machine.ts),
  [retention](../../src/session-retention.ts), [registry feature support](../../src/registry/runtime-records.ts).
- D03: application action policy lives under UI and is imported by the backend. Move the responsibility, not duplicate it.
- D04: approved preview/effect is not passed through to the final mutation as a complete approval witness. Bind it and test
  changes after preview. This is a race-resistant contract gap, not a reported destructive incident.
- D05: request-instance Map coalescing is not durable retry recognition. Preserve operation-specific no-replay/receipt rules.
  D03-D05 evidence: [current dispatcher](../../src/ui/session-actions.ts), [backend](../../src/domain/session-backend.ts).
- D06: catalog read-modify-write can lose concurrent registrations. Serialize locator updates without adding domain state.
  Evidence: [catalog](../../src/control-repositories.ts).
- D07: synchronous lock waiting in the server thread can affect unrelated repositories/health. Isolate bounded I/O or make
  the adapter asynchronous; do not introduce another lock/store. Latency has not been measured in this documentation task.
  Evidence: [lock](../../src/registry/lock.ts), [server](../../src/control-server.ts).
- D08: apply Q2's claims-off rule consistently to bounded mutation/expansion while preserving all other restrictions.
  Evidence: [expansion and operation authority](../../src/session-registry.ts).
- D09: inventory/converge effective-policy decision overlap; distinguish decision from validation and backend compilation.
  Evidence: [profile decision](../../src/domain/filesystem-policy-decision.ts),
  [effective policy](../../src/domain/filesystem-policy.ts). Consumer/behavior analysis precedes deletion.
- D10: the separate RegistryMutationBoundary is a retirement candidate, not a proven unused consumer-free subsystem.
  Evidence: [alternative store](../../src/registry/store.ts), [main registry](../../src/session-registry.ts).
- D11: history and handoff receipts share a bounded container. Keep receipts protected and capacity failure explicit;
  separate logical ownership, not necessarily physical files. Evidence: [runtime records](../../src/registry/runtime-records.ts).
- D12: current atomic writer tolerates certain unsupported directory-fsync errors. Implement Q4 qualification/failure semantics;
  documentation adoption alone does not strengthen durability. Evidence: [atomic writer](../../src/registry/atomic.ts).
- D13: SessionRegistry combines transaction mechanics, domain decisions, observations, and effects. Separate owners while
  preserving one cross-record atomic boundary; line count is not the defect. Evidence: [registry](../../src/session-registry.ts).
- D14: obsolete all-or-nothing sandbox/security descriptions are replaced by mode-specific contracts in this PR.
  Runtime security gaps such as D00 remain open implementation work.
- D15: producer tests and composed/packed/system proofs need explicit owners. #645 remains the existing verification track.
- D16: old Epic branch/base/dispatch plans must not serve as current architecture. Responsibility documents and the accepted
  decision record supersede them; Issue metadata is not changed by this PR.

Q3 additionally requires a machine/user singleton lease; current port exclusivity alone does not satisfy it.
#525's exact-source verification result binding is an existing separate requirement, not certified by this adoption.
No current PASS, unused-consumer proof, or completed migration is inferred from historical PR bodies or closed Issues.

## Convergence work units

These are logical plan IDs from the accepted report, not new GitHub Issues or permission to implement.

- R0: adopt decisions and responsibility documentation (this documentation rollout).
- R1: trusted local operator capability, consuming Q1 and preserving network compatibility.
- R2: repository transaction/receipt/approval boundary and application action ownership, consuming Q4-Q6.
- R3: one effective-policy decision and claims-mode matrix, consuming Q2.
- R4: canonical parking/atomic retention using the already accepted semantics.
- R5: actual observation collection and full snapshot integration with freshness/unknown provenance.
- R6: catalog concurrency, multi-repository wait isolation, and Q3 singleton operations.
- R7: exact-source verification provenance, using existing #525 rather than a duplicate requirement.
- R8: exact-tree composed certification and evidence-based compatibility retirement.

```text
R0 -> R1
R0 -> verification foundation (#645)
R0 -> R2 -> R3 -> R4
          |           |
          +-> R5 collection -> R5 full integration <- R4
          +-> R6
R2 + R3 -> R7
R1 + R2 + R3 + R4 + R5 + R6 + R7 + proof foundation -> R8
```

R7 does not unconditionally wait for R4; relevant park/resume provenance invalidation is defined in the contract first.
R5 collection may proceed before parking integration; the full parking-aware composition consumes R4.
Logical independence does not authorize concurrent writes to SessionRegistry/backend/shared schema files.
Pin producer contracts and assign one writer for shared integration. #526 remains an independent release-operations track.

## Completion

Require real public paths, restart/response-loss/uncertainty and concurrency evidence, supported physical security proofs,
and removal of retired decisions/consumers on the exact composed tree. A green source-only lane, producer file, or closed
Epic alone is insufficient. Remaining defects return to their owner; a certification worker does not redesign or repair them.
Issue classification and proposed issuance are reported separately and require explicit authorization for any mutation.
