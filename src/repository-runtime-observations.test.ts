import assert from "node:assert/strict";
import test from "node:test";
import { parseRepositoryRuntimeObservations } from "./repository-runtime-observations.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";

const timestamp = "2026-01-01T00:00:00.000Z";
const available = (value: unknown) => ({ status: "available", observed_at: timestamp, value });

function snapshot(observations: Record<string, unknown>): RepositoryRuntimeSnapshot {
  return {
    contract_id: "nawabari.repository-runtime-snapshot.v1",
    schema_version: 1,
    repository_id: "repo",
    registry: { schema_version: 1, revision: 1, runtime_epoch: 1, claim_set_generation: 1 },
    captured_at: timestamp,
    complete: true,
    incomplete_reasons: [],
    sessions: [],
    claims: [],
    observations: {
      coordination: { status: "unknown", observed_at: null, reason: "unused" },
      profiles: observations.profiles ?? { status: "unknown", observed_at: null, reason: "unused" },
      processes: observations.processes ?? { status: "unknown", observed_at: null, reason: "unused" },
      filesystem: observations.filesystem ?? { status: "unknown", observed_at: null, reason: "unused" },
      lifecycle: observations.lifecycle ?? { status: "unknown", observed_at: null, reason: "unused" },
    },
  } as unknown as RepositoryRuntimeSnapshot;
}

function v1Observations() {
  return {
    profiles: available({
      contract_id: "nawabari.repository-profile-observation.v1",
      schema_version: 1,
      sessions: [
        { session_id: "b", status: "current", profile_id: null, reason: null },
        { session_id: "a", status: "drift", profile_id: "p", reason: "changed" },
      ],
    }),
    processes: available({
      contract_id: "nawabari.repository-process-observation.v1",
      schema_version: 1,
      sessions: [{ session_id: "a", status: "inactive", reason: null }],
    }),
    filesystem: available({
      contract_id: "nawabari.repository-filesystem-observation.v1",
      schema_version: 1,
      sessions: [{ session_id: "a", status: "clean", reason: null }],
    }),
    lifecycle: available({
      contract_id: "nawabari.repository-lifecycle-observation.v1",
      schema_version: 1,
      sessions: [{ session_id: "a", state: "healthy", physical_state: "present", reason: null }],
    }),
  };
}

test("indexes strict v1 observations and makes absent cleanup proof explicitly unknown", () => {
  const result = parseRepositoryRuntimeObservations(snapshot(v1Observations()));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual([...result.value.profiles.keys()], ["a", "b"]);
  assert.deepEqual(result.value.filesystem.get("a"), {
    session_id: "a",
    policy_status: "clean",
    runtime_status: "unknown",
    owner: "unknown",
    reason: null,
  });
  assert.deepEqual(result.value.lifecycle.get("a"), {
    session_id: "a",
    state: "healthy",
    physical_state: "present",
    recoverable_work: "unknown",
    integration: "unknown",
    cleanup: "unknown",
    reason: null,
  });
  assert.equal(result.value.filesystem_unknown, false);
  assert.equal(result.value.lifecycle_unknown, false);
  assert.deepEqual(result.value.unmanaged_worktrees, []);
});

test("indexes v2 filesystem and lifecycle facts independently and deterministically", () => {
  const observations = v1Observations();
  observations.filesystem = available({
    contract_id: "nawabari.repository-filesystem-observation.v2",
    schema_version: 2,
    sessions: [
      {
        session_id: "a",
        policy_status: "violation",
        runtime_status: "runtime-residual",
        owner: "proven",
        reason: null,
      },
    ],
    unmanaged_worktrees: [
      { worktree_path: "/tmp/z", reason: null },
      { worktree_path: "/tmp/a", reason: "unowned" },
    ],
  });
  observations.lifecycle = available({
    contract_id: "nawabari.repository-lifecycle-observation.v2",
    schema_version: 2,
    sessions: [
      {
        session_id: "a",
        state: "parked",
        physical_state: "present",
        recoverable_work: "absent",
        integration: "proven",
        cleanup: "complete",
        reason: null,
      },
    ],
  });
  const result = parseRepositoryRuntimeObservations(snapshot(observations));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.filesystem.get("a"), {
    session_id: "a",
    policy_status: "violation",
    runtime_status: "runtime-residual",
    owner: "proven",
    reason: null,
  });
  assert.deepEqual(result.value.lifecycle.get("a"), {
    session_id: "a",
    state: "parked",
    physical_state: "present",
    recoverable_work: "absent",
    integration: "proven",
    cleanup: "complete",
    reason: null,
  });
  assert.deepEqual(
    result.value.unmanaged_worktrees.map(({ worktree_path }) => worktree_path),
    ["/tmp/a", "/tmp/z"],
  );
});

test("keeps unknown sections explicit instead of treating empty maps as observed", () => {
  const result = parseRepositoryRuntimeObservations(snapshot({}));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.processes_unknown, true);
  assert.equal(result.value.filesystem_unknown, true);
  assert.equal(result.value.lifecycle_unknown, true);
  assert.equal(result.value.processes.size, 0);
  assert.deepEqual(result.value.unknown_sections, {
    profiles: true,
    processes: true,
    filesystem: true,
    lifecycle: true,
  });
});

test("preserves string-only bounded semantics for v1 and v2 fields", () => {
  const observations = v1Observations();
  observations.profiles = available({
    contract_id: "nawabari.repository-profile-observation.v1",
    schema_version: 1,
    sessions: [{ session_id: "", status: "current", profile_id: "\u0000", reason: "\u0001" }],
  });
  observations.processes = available({
    contract_id: "nawabari.repository-process-observation.v1",
    schema_version: 1,
    sessions: [{ session_id: "", status: "inactive", reason: "\u0002" }],
  });
  observations.filesystem = available({
    contract_id: "nawabari.repository-filesystem-observation.v2",
    schema_version: 2,
    sessions: [{ session_id: "", policy_status: "clean", runtime_status: "clean", owner: "proven", reason: "\u0003" }],
    unmanaged_worktrees: [{ worktree_path: "", reason: "\u0004" }],
  });
  observations.lifecycle = available({
    contract_id: "nawabari.repository-lifecycle-observation.v1",
    schema_version: 1,
    sessions: [{ session_id: "", state: "", physical_state: "\u0005", reason: "\u0006" }],
  });
  const result = parseRepositoryRuntimeObservations(snapshot(observations));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.profiles.has(""), true);
  assert.equal(result.value.filesystem.has(""), true);
  assert.deepEqual(
    result.value.unmanaged_worktrees.map(({ worktree_path }) => worktree_path),
    [""],
  );
});

test("rejects incompatible historical extensions, unknown keys, duplicates and bounds", () => {
  const extended = v1Observations();
  observationValue(extended.filesystem).sessions![0]!.owner = "proven";
  assertInvalid(snapshot(extended));

  const unknownKey = v1Observations();
  observationValue(unknownKey.processes).extra = true;
  assertInvalid(snapshot(unknownKey));

  const duplicate = v1Observations();
  observationValue(duplicate.profiles).sessions!.push({
    session_id: "a",
    status: "current",
    profile_id: null,
    reason: null,
  });
  assertInvalid(snapshot(duplicate));

  const tooLong = v1Observations();
  observationValue(tooLong.profiles).sessions![0]!.session_id = "x".repeat(4_097);
  assertInvalid(snapshot(tooLong));
});

test("rejects wrong version and invalid nullable values", () => {
  const wrongVersion = v1Observations();
  observationValue(wrongVersion.filesystem).contract_id = "nawabari.repository-filesystem-observation.v2";
  assertInvalid(snapshot(wrongVersion));

  const invalidNullable = v1Observations();
  observationValue(invalidNullable.lifecycle).sessions![0]!.physical_state = 4;
  assertInvalid(snapshot(invalidNullable));
});

type ObservationEnvelope = { value: ObservationValue };
type ObservationValue = {
  [key: string]: unknown;
  sessions?: Array<Record<string, unknown>>;
  unmanaged_worktrees?: Array<Record<string, unknown>>;
};

function observationValue(observation: unknown): ObservationValue {
  return (observation as ObservationEnvelope).value;
}

function assertInvalid(value: RepositoryRuntimeSnapshot): void {
  const result = parseRepositoryRuntimeObservations(value);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
}
