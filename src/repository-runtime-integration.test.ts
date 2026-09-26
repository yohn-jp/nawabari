import assert from "node:assert/strict";
import test from "node:test";
import { classifyNawabariState } from "./public-state.js";
import { getNawabariRepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";
import { reconcileSessionRuntimeEvidence } from "./session-runtime-reconciliation.js";

test("repository runtime snapshot and reconciliation compose with public lifecycle state", () => {
  const timestamp = "2026-01-01T00:00:00.000Z";
  const snapshot = getNawabariRepositoryRuntimeSnapshot({
    captured_at: timestamp,
    registry: {
      repositoryId: "repo-1",
      registrySchemaVersion: 1,
      registryRevision: 9,
      runtimeEpoch: 1,
      claimSetGeneration: 1,
      claims: [],
      runtimeRecords: { requiredFeatures: [], records: {} },
      sessions: [
        {
          schemaVersion: 1,
          sessionId: "s1",
          repositoryId: "repo-1",
          worktreeId: "w1",
          worktreePath: "/tmp/w1",
          branchId: "b1",
          branchName: "b1",
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
    },
    coordination: {
      status: "available",
      observed_at: timestamp,
      value: { contract_id: "nawabari.repository-coordination-observation.v1", schema_version: 1, rows: [] },
    },
    profiles: {
      status: "available",
      observed_at: timestamp,
      value: {
        contract_id: "nawabari.repository-profile-observation.v1",
        schema_version: 1,
        sessions: [{ session_id: "s1", status: "current", profile_id: null, reason: null }],
      },
    },
    processes: {
      status: "available",
      observed_at: timestamp,
      value: {
        contract_id: "nawabari.repository-process-observation.v1",
        schema_version: 1,
        sessions: [{ session_id: "s1", status: "inactive", reason: null }],
      },
    },
    filesystem: {
      status: "available",
      observed_at: timestamp,
      value: {
        contract_id: "nawabari.repository-filesystem-observation.v2",
        schema_version: 2,
        sessions: [
          { session_id: "s1", policy_status: "clean", runtime_status: "clean", owner: "proven", reason: null },
        ],
        unmanaged_worktrees: [],
      },
    },
    lifecycle: {
      status: "available",
      observed_at: timestamp,
      value: {
        contract_id: "nawabari.repository-lifecycle-observation.v2",
        schema_version: 2,
        sessions: [
          {
            session_id: "s1",
            state: "active",
            physical_state: "present",
            recoverable_work: "absent",
            integration: "proven",
            cleanup: "complete",
            reason: null,
          },
        ],
      },
    },
  });
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  const reconciliation = reconcileSessionRuntimeEvidence(snapshot.value);
  assert.equal(reconciliation.ok, true);
  if (reconciliation.ok) {
    assert.equal(reconciliation.value.complete, true);
    assert.equal(reconciliation.value.findings[0]?.code, "managed-present");
  }
  assert.equal(
    classifyNawabariState({ sessionState: "active", physicalState: "healthy", phase: "current", blockers: [] }).state,
    "active",
  );
});
