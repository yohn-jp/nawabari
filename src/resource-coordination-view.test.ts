import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getNawabariRepositoryRuntimeSnapshot,
  type RepositoryRuntimeSnapshotInput,
  type RepositoryRuntimeSnapshot,
} from "./repository-runtime-snapshot.js";
import { projectFileSessionMatrix } from "./resource-coordination-view.js";
import type { RepositoryRegistryView, SessionRecord } from "./session-registry.js";

const TIMESTAMP = "2026-01-02T03:04:05.006Z";

test("projects an A-write/B-read coordination row from the canonical observation", () => {
  const result = projectFileSessionMatrix(
    snapshot({
      rows: [
        row("src/a.ts", [participant("session-a", "write", "modified"), participant("session-b", "read", "none")]),
      ],
    }),
    {},
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.value.status !== "available") return;
  assert.equal(result.value.rows[0]?.row_kind, "observed-path");
  assert.deepEqual(
    result.value.rows[0]?.participants.map((item) => item.session_id),
    ["session-a", "session-b"],
  );
});

test("keeps blocked and unresolved facts from the coordination producer", () => {
  const result = projectFileSessionMatrix(
    snapshot({
      rows: [row("src/b.ts", [participant("session-a", "write", "none")], { permission: "blocked" })],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok || result.value.status !== "available") return;
  assert.equal(result.value.rows[0]?.permission, "blocked");
  assert.equal(result.value.rows[0]?.classification, "canonical");
});

test("returns explicit unavailability when coordination evidence is unknown", () => {
  const result = projectFileSessionMatrix(snapshotWithoutCoordination());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value, {
    status: "unavailable",
    reason: "observation not supplied",
    rows: [],
    truncated: false,
    cursor: null,
  });
});

test("uses deterministic pagination and rejects a cursor from another registry revision", () => {
  const input = snapshot({ rows: [row("a", []), row("b", []), row("c", [])] });
  const first = projectFileSessionMatrix(input, { limit: 2 });
  assert.equal(first.ok, true);
  if (!first.ok || first.value.status !== "available" || first.value.cursor === null) return;
  assert.deepEqual(
    first.value.rows.map((item) => item.resource),
    ["a", "b"],
  );

  const second = projectFileSessionMatrix(input, { cursor: first.value.cursor, limit: 2 });
  assert.equal(second.ok, true);
  if (!second.ok || second.value.status !== "available") return;
  assert.deepEqual(
    second.value.rows.map((item) => item.resource),
    ["c"],
  );

  const changed = snapshot({ rows: [row("a", []), row("b", []), row("c", [])], revision: 8 });
  const stale = projectFileSessionMatrix(changed, { cursor: first.value.cursor });
  assert.equal(stale.ok, false);
  if (stale.ok) return;
  assert.equal(stale.error.code, "STALE_REGISTRY");
});

test("rejects malformed available coordination data instead of downgrading it", () => {
  const result = projectFileSessionMatrix(snapshot({ rows: [{ resource: "a" }] }));
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

function snapshot(options: {
  readonly rows: readonly Record<string, unknown>[];
  readonly revision?: number;
}): RepositoryRuntimeSnapshot {
  const result = getNawabariRepositoryRuntimeSnapshot({
    registry: registry(options.revision ?? 7),
    captured_at: TIMESTAMP,
    coordination: {
      status: "available",
      observed_at: TIMESTAMP,
      value: {
        contract_id: "nawabari.repository-coordination-observation.v1",
        schema_version: 1,
        rows: options.rows,
      },
    },
  } as unknown as RepositoryRuntimeSnapshotInput);
  assert.equal(result.ok, true);
  if (result.ok) return result.value;
  throw new Error("fixture snapshot projection failed");
}

function snapshotWithoutCoordination(): RepositoryRuntimeSnapshot {
  const result = getNawabariRepositoryRuntimeSnapshot({ registry: registry(), captured_at: TIMESTAMP });
  assert.equal(result.ok, true);
  if (result.ok) return result.value;
  throw new Error("fixture snapshot projection failed");
}

function row(
  resource: string,
  participants: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
) {
  return {
    resource,
    participants,
    permission: "allowed",
    conflict: "none",
    physical_modification: "none",
    mergeability: "clean",
    classification: "canonical",
    blockers: [],
    next_actions: [],
    ...overrides,
  };
}

function participant(session_id: string, mode: string, observed_change: string) {
  return {
    session_id,
    worktree_path: `/tmp/${session_id}`,
    state: "active",
    claim_id: `claim-${session_id}`,
    mode,
    requested_mode: null,
    observed_change,
    integrated: null,
  };
}

function registry(revision = 7): RepositoryRegistryView {
  return {
    repositoryId: "repo-1",
    registrySchemaVersion: 2,
    registryRevision: revision,
    runtimeEpoch: 3,
    claimSetGeneration: 2,
    sessions: [session("session-a"), session("session-b")],
    claims: [],
    runtimeRecords: { requiredFeatures: [], records: {} },
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
