import assert from "node:assert/strict";
import { test } from "node:test";

import type { JsonValue } from "./domain/errors.js";
import { adaptRepositoryRuntimeSnapshotForMatrixV1 } from "./resource-coordination-compatibility.js";
import { getNawabariRepositoryRuntimeSnapshot, type RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";
import { projectFileSessionMatrix } from "./resource-coordination-view.js";
import type { ResourceCoordinationRecord, ResourceCoordinationSnapshot } from "./resource-coordination-snapshot.js";
import type { RepositoryRegistryView } from "./session-registry.js";

const OBSERVED_AT = "2026-09-27T00:00:00.000Z";
const REPOSITORY_ID = "repository-coordination-adapter";
const REGISTRY_REVISION = 17;
const CLAIM_SET_GENERATION = 6;

test("maps a complete, identity-matched raw row whose matrix fields are losslessly available", () => {
  const raw = rawCoordination({ resources: [representableRow()] });
  const snapshot = snapshotWithRaw(raw);
  const adapted = adaptRepositoryRuntimeSnapshotForMatrixV1(snapshot);

  assert.deepEqual(adapted.observations.coordination, {
    status: "available",
    observed_at: OBSERVED_AT,
    value: {
      contract_id: "nawabari.repository-coordination-observation.v1",
      schema_version: 1,
      rows: [
        {
          resource: "src/example.ts",
          participants: [
            {
              session_id: "session-a",
              worktree_path: "/tmp/worktree-a",
              state: "active",
              claim_id: "claim-a",
              mode: "write",
              requested_mode: null,
              observed_change: "none",
              integrated: false,
            },
          ],
          permission: "allowed",
          conflict: "none",
          physical_modification: "none",
          mergeability: "clean",
          classification: "available",
          blockers: [],
          next_actions: [],
        },
      ],
    },
  });
  const originalObservation = snapshot.observations.coordination;
  assert.equal(originalObservation.status, "available");
  if (originalObservation.status !== "available") return;
  assert.deepEqual(originalObservation.value, raw);

  const matrix = projectFileSessionMatrix(adapted);
  if (!matrix.ok) throw matrix.error;
  assert.equal(matrix.value.status, "available");
  if (matrix.value.status !== "available") return;
  assert.equal(matrix.value.rows[0]?.permission, "allowed");
  assert.equal(matrix.value.rows[0]?.physical_modification, "none");
  assert.equal(matrix.value.rows[0]?.mergeability, "clean");
});

test("preserves the existing matrix-v1 observation without changing its meaning", () => {
  const legacyValue = {
    contract_id: "nawabari.repository-coordination-observation.v1",
    schema_version: 1,
    rows: [],
  } as JsonValue;
  const snapshot = snapshotWithRaw(legacyValue);
  const adapted = adaptRepositoryRuntimeSnapshotForMatrixV1(snapshot);

  assert.equal(adapted, snapshot);
  assert.deepEqual(adapted.observations.coordination, snapshot.observations.coordination);
});

test("projects incomplete, stale, or unrepresentable raw coordination as explicit matrix unavailable", () => {
  const validRow = representableRow();
  const rawRegistry = rawCoordination().registry;
  const invalidSamples: readonly (ResourceCoordinationSnapshot | JsonValue)[] = [
    rawCoordination({ complete: false, incompleteReasons: ["INCOMPLETE_AUTHORITY_EVIDENCE"] }),
    rawCoordination({ truncated: true }),
    rawCoordination({ registry: { ...rawRegistry, registryRevision: REGISTRY_REVISION + 1 } }),
    rawCoordination({ resources: [representableRow({ conflict: "conflict" })] }),
    rawRow({ ...validRow, blockers: [{ kind: "incomplete-evidence" }] }),
    rawRow({ ...validRow, nextActions: [{ actionId: "proceed-without-claim" }] }),
    rawRow({ ...validRow, participants: [{ ...participant(), claimId: null, mode: null }] }),
    rawRow({ ...validRow, participants: [{ ...participant(), worktreePath: null }] }),
    rawRow({ ...validRow, participants: [{ ...participant(), state: null }] }),
    rawRow({ ...validRow, participants: [{ ...participant(), observedChange: null }] }),
    rawRow({ ...validRow, participants: [{ ...participant(), integrated: "unknown" }] }),
  ];

  for (const raw of invalidSamples) assertMatrixUnavailable(snapshotWithRaw(raw));
});

test("keeps unknown producer evidence explicit and leaves its source envelope untouched", () => {
  const projected = getNawabariRepositoryRuntimeSnapshot({
    registry: registryView(),
    captured_at: OBSERVED_AT,
    coordination: { status: "unknown", observed_at: null, reason: "producer unavailable" },
  });
  if (!projected.ok) throw projected.error;

  const adapted = adaptRepositoryRuntimeSnapshotForMatrixV1(projected.value);
  assert.equal(adapted, projected.value);
  assertMatrixUnavailable(adapted);
});

function assertMatrixUnavailable(snapshot: RepositoryRuntimeSnapshot): void {
  const adapted = adaptRepositoryRuntimeSnapshotForMatrixV1(snapshot);
  const observation = adapted.observations.coordination;
  assert.equal(observation.status, "unknown");
  if (observation.status !== "unknown") return;
  assert.ok(observation.reason.length > 0);
  const matrix = projectFileSessionMatrix(adapted);
  if (!matrix.ok) throw matrix.error;
  assert.equal(matrix.value.status, "unavailable");
}

function snapshotWithRaw(raw: ResourceCoordinationSnapshot | JsonValue): RepositoryRuntimeSnapshot {
  const result = getNawabariRepositoryRuntimeSnapshot({
    registry: registryView(),
    captured_at: OBSERVED_AT,
    coordination: { status: "available", observed_at: OBSERVED_AT, value: raw as unknown as JsonValue },
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function registryView(): RepositoryRegistryView {
  return {
    repositoryId: REPOSITORY_ID,
    registrySchemaVersion: 2,
    registryRevision: REGISTRY_REVISION,
    runtimeEpoch: 3,
    claimSetGeneration: CLAIM_SET_GENERATION,
    sessions: [],
    claims: [],
    runtimeRecords: { requiredFeatures: [], records: {} },
  };
}

function rawCoordination(overrides: Partial<ResourceCoordinationSnapshot> = {}): ResourceCoordinationSnapshot {
  return {
    schemaVersion: 1,
    registry: {
      repositoryId: REPOSITORY_ID,
      registryRevision: REGISTRY_REVISION,
      claimSetGeneration: CLAIM_SET_GENERATION,
    },
    contract: {
      id: "resource-coordination-snapshot",
      version: 1,
      persisted: false,
      mutation: false,
      fileContents: false,
    },
    complete: true,
    incompleteReasons: [],
    truncated: false,
    resources: [],
    ...overrides,
  };
}

function rawRow(row: Record<string, unknown>): JsonValue {
  return { ...rawCoordination(), resources: [row] } as unknown as JsonValue;
}

function representableRow(overrides: Partial<ResourceCoordinationRecord> = {}): ResourceCoordinationRecord {
  return {
    resource: "src/example.ts",
    participants: [participant()],
    requestedModes: [],
    permission: "allowed",
    conflict: "none",
    physicalModification: "clean",
    mergeability: "mergeable",
    classification: "available",
    blockers: [],
    nextActions: [],
    ...overrides,
  };
}

function participant(overrides: Partial<ResourceCoordinationRecord["participants"][number]> = {}) {
  return {
    sessionId: "session-a",
    worktreePath: "/tmp/worktree-a",
    state: "active",
    claimId: "claim-a",
    mode: "write" as const,
    requestedMode: null,
    observedChange: "clean" as const,
    integrated: false,
    ...overrides,
  };
}
