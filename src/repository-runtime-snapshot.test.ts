import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getNawabariRepositoryRuntimeSnapshot,
  REPOSITORY_RUNTIME_SNAPSHOT_CONTRACT_ID,
  serializeRepositoryRuntimeSnapshot,
  type RepositoryRuntimeObservation,
  type RepositoryRuntimeSnapshotInput,
} from "./repository-runtime-snapshot.js";
import type { ResourceClaim } from "./resource-claims.js";
import type { RepositoryRegistryView, SessionRecord } from "./session-registry.js";

const TIMESTAMP = "2026-01-02T03:04:05.006Z";

test("projects missing observations as explicit incomplete facts", () => {
  const result = getNawabariRepositoryRuntimeSnapshot(input());
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.contract_id, REPOSITORY_RUNTIME_SNAPSHOT_CONTRACT_ID);
  assert.equal(result.value.complete, false);
  assert.deepEqual(result.value.incomplete_reasons, [
    "observation not supplied",
    "observation not supplied",
    "observation not supplied",
    "observation not supplied",
    "observation not supplied",
  ]);
  assert.deepEqual(result.value.observations.lifecycle, {
    status: "unknown",
    observed_at: null,
    reason: "observation not supplied",
  });
  assert.equal(Object.isFrozen(result.value), true);
  assert.equal(Object.isFrozen(result.value.sessions), true);
  assert.equal(Object.isFrozen(result.value.claims), true);
});

test("keeps available observations and deterministic session/claim ordering", () => {
  const firstSession = session("session-b");
  const secondSession = session("session-a");
  const firstClaim = claim("claim-b", "z/resource", "session-b");
  const secondClaim = claim("claim-a", "a/resource", "session-a");
  const available: RepositoryRuntimeObservation<Record<string, never>> = {
    status: "available",
    observed_at: TIMESTAMP,
    value: {},
  };
  const result = getNawabariRepositoryRuntimeSnapshot(
    input({
      registry: registry({ sessions: [firstSession, secondSession], claims: [firstClaim, secondClaim] }),
      coordination: available,
      profiles: available,
      filesystem: available,
      processes: available,
      lifecycle: available,
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.complete, true);
  assert.deepEqual(
    result.value.sessions.map(({ sessionId }) => sessionId),
    ["session-a", "session-b"],
  );
  assert.deepEqual(
    result.value.claims.map(({ claimId }) => claimId),
    ["claim-a", "claim-b"],
  );
  assert.deepEqual(result.value.observations.coordination, available);
  assert.equal(serializeRepositoryRuntimeSnapshot(result.value).endsWith("\n"), true);
});

test("records deterministic truncation reasons after unknown observations", () => {
  const result = getNawabariRepositoryRuntimeSnapshot(
    input({ registry: registry({ sessions: Array.from({ length: 1_025 }, (_, index) => session(`s-${index}`)) }) }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;

  assert.equal(result.value.sessions.length, 1_024);
  assert.equal(result.value.incomplete_reasons.at(-1), "sessions truncated at 1024");
});

test("rejects non-canonical timestamps and unbounded observation reasons", () => {
  const timestamp = getNawabariRepositoryRuntimeSnapshot(input({ captured_at: "2026-01-02T03:04:05Z" }));
  assert.equal(timestamp.ok, false);
  if (timestamp.ok) return;
  assert.equal(timestamp.error.code, "INVALID_ARGUMENT");

  const reason = getNawabariRepositoryRuntimeSnapshot(
    input({ coordination: { status: "unknown", observed_at: null, reason: "x".repeat(513) } }),
  );
  assert.equal(reason.ok, false);
  if (reason.ok) return;
  assert.equal(reason.error.code, "INVALID_ARGUMENT");
});

test("rejects a missing timestamp for an available observation", () => {
  const result = getNawabariRepositoryRuntimeSnapshot(
    input({ coordination: { status: "available", observed_at: null, value: {} } as never }),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

function input(overrides: Partial<RepositoryRuntimeSnapshotInput> = {}): RepositoryRuntimeSnapshotInput {
  return {
    registry: registry(),
    captured_at: TIMESTAMP,
    ...overrides,
  };
}

function registry(overrides: Partial<RepositoryRegistryView> = {}): RepositoryRegistryView {
  return {
    repositoryId: "repo-1",
    registrySchemaVersion: 2,
    registryRevision: 7,
    runtimeEpoch: 3,
    claimSetGeneration: 2,
    sessions: [],
    claims: [],
    runtimeRecords: { requiredFeatures: [], records: {} },
    ...overrides,
  };
}

function session(sessionId: string): SessionRecord {
  return {
    schemaVersion: 1,
    sessionId,
    repositoryId: "repo-1",
    worktreeId: `worktree-${sessionId}`,
    worktreePath: `/tmp/${sessionId}`,
    branchId: `refs/heads/${sessionId}`,
    branchName: sessionId,
    state: "active",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}

function claim(claimId: string, resource: string, sessionId: string): ResourceClaim {
  return {
    schemaVersion: 2,
    claimId,
    sessionId,
    repositoryId: "repo-1",
    worktreePath: `/tmp/${sessionId}`,
    resource,
    mode: "read",
    createdAt: TIMESTAMP,
    updatedAt: TIMESTAMP,
  };
}
