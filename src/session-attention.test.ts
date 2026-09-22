import assert from "node:assert/strict";
import { test } from "node:test";

import {
  getNawabariRepositoryRuntimeSnapshot,
  type RepositoryRuntimeObservation,
  type RepositoryRuntimeSnapshot,
  type RepositoryRuntimeSnapshotInput,
} from "./repository-runtime-snapshot.js";
import type { JsonValue } from "./domain/errors.js";
import { projectAgentRuntimeStatus, projectSessionAttention } from "./session-attention.js";
import type { RepositoryRegistryView, SessionRecord } from "./session-registry.js";

const TIMESTAMP = "2026-01-02T03:04:05.006Z";

test("maps fixed attention codes and severity, with deterministic evidence identity", () => {
  const result = projectSessionAttention(
    snapshot({
      coordinationRows: [coordinationRow("src/a.ts", "session-a", { permission: "blocked" })],
      profiles: [{ session_id: "session-a", status: "drift", profile_id: null, reason: "profile changed" }],
      processes: [{ session_id: "session-a", status: "unknown", reason: "not observed" }],
      filesystem: [{ session_id: "session-a", status: "violation", reason: "outside policy" }],
      lifecycle: [{ session_id: "session-a", state: "unmanaged", physical_state: null, reason: "not owned" }],
    }),
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(
    result.value.map((item) => [item.code, item.severity]),
    [
      ["coordination-blocked", "error"],
      ["policy-violation", "error"],
      ["process-unknown", "warning"],
      ["unmanaged-worktree", "warning"],
      ["profile-drift", "info"],
    ],
  );
  assert.equal(result.value[0]?.evidence_revision, "7");
  assert.equal(result.value[0]?.identity, JSON.stringify(["coordination-blocked", "session-a", "src/a.ts", "7"]));
});

test("redacts arbitrary repository content from agent runtime status", () => {
  const result = projectAgentRuntimeStatus(
    snapshot({
      coordinationRows: [coordinationRow("src/a.ts", "session-a", { permission: "blocked" })],
      profiles: [{ session_id: "session-a", status: "current", profile_id: "profile-1", reason: null }],
      processes: [{ session_id: "session-a", status: "active", reason: null }],
      lifecycle: [{ session_id: "session-a", state: "active", physical_state: "healthy", reason: null }],
    }),
    "session-a",
    10,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(Object.keys(result.value).sort(), [
    "blocker",
    "cursor",
    "lifecycle_state",
    "physical_state",
    "process_status",
    "profile_status",
    "runtime_status",
    "session_id",
    "truncated",
  ]);
  assert.equal("src/a.ts" in result.value, false);
  assert.equal("profile-1" in result.value, false);
  assert.equal("argv" in result.value, false);
});

test("truncates agent attention within budget and returns an opaque cursor", () => {
  const result = projectAgentRuntimeStatus(
    snapshot({
      profiles: [{ session_id: "session-a", status: "drift", profile_id: "profile-1", reason: "profile changed" }],
      processes: [{ session_id: "session-a", status: "unknown", reason: "not observed" }],
      filesystem: [{ session_id: "session-a", status: "violation", reason: "outside policy" }],
      lifecycle: [{ session_id: "session-a", state: "unmanaged", physical_state: null, reason: "not owned" }],
    }),
    "session-a",
    2,
  );
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.truncated, true);
  assert.equal(typeof result.value.cursor, "string");
  assert.notEqual(result.value.cursor, "");
  assert.deepEqual(Object.keys(result.value).sort(), [
    "blocker",
    "cursor",
    "lifecycle_state",
    "physical_state",
    "process_status",
    "profile_status",
    "runtime_status",
    "session_id",
    "truncated",
  ]);
  assert.equal("profile-1" in result.value, false);
  assert.equal("argv" in result.value, false);
});

test("invalid available optional observations fail closed", () => {
  const result = projectSessionAttention(
    snapshot({ profiles: [{ session_id: "session-a", status: "drift" }] } as never),
  );
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "INVALID_ARGUMENT");
});

interface FixtureOptions {
  readonly coordinationRows?: readonly Record<string, unknown>[];
  readonly profiles?: readonly Record<string, unknown>[];
  readonly processes?: readonly Record<string, unknown>[];
  readonly filesystem?: readonly Record<string, unknown>[];
  readonly lifecycle?: readonly Record<string, unknown>[];
}

function snapshot(options: FixtureOptions = {}): RepositoryRuntimeSnapshot {
  const input: RepositoryRuntimeSnapshotInput = {
    registry: registry(),
    captured_at: TIMESTAMP,
    coordination: available({
      contract_id: "nawabari.repository-coordination-observation.v1",
      schema_version: 1,
      rows: options.coordinationRows ?? [],
    }),
    profiles: available({
      contract_id: "nawabari.repository-profile-observation.v1",
      schema_version: 1,
      sessions: options.profiles ?? [],
    }),
    processes: available({
      contract_id: "nawabari.repository-process-observation.v1",
      schema_version: 1,
      sessions: options.processes ?? [],
    }),
    filesystem: available({
      contract_id: "nawabari.repository-filesystem-observation.v1",
      schema_version: 1,
      sessions: options.filesystem ?? [],
    }),
    lifecycle: available({
      contract_id: "nawabari.repository-lifecycle-observation.v1",
      schema_version: 1,
      sessions: options.lifecycle ?? [],
    }),
  };
  const result = getNawabariRepositoryRuntimeSnapshot(input);
  assert.equal(result.ok, true);
  if (result.ok) return result.value;
  throw new Error("fixture snapshot projection failed");
}

function available(value: unknown): RepositoryRuntimeObservation<JsonValue> {
  return { status: "available", observed_at: TIMESTAMP, value: value as JsonValue };
}

function coordinationRow(resource: string, session_id: string, overrides: Record<string, unknown> = {}) {
  return {
    resource,
    participants: [participant(session_id)],
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

function participant(session_id: string) {
  return {
    session_id,
    worktree_path: `/tmp/${session_id}`,
    state: "active",
    claim_id: `claim-${session_id}`,
    mode: "write",
    requested_mode: null,
    observed_change: "none",
    integrated: null,
  };
}

function registry(): RepositoryRegistryView {
  return {
    repositoryId: "repo-1",
    registrySchemaVersion: 2,
    registryRevision: 7,
    runtimeEpoch: 3,
    claimSetGeneration: 2,
    sessions: [session("session-a")],
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
