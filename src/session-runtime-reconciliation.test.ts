import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSessionRuntimeEvidence } from "./session-runtime-reconciliation.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";

const session = { sessionId: "s1" };
const available = (value: unknown) => ({ status: "available", observed_at: "2026-01-01T00:00:00.000Z", value });
type ObservationValue = {
  [key: string]: unknown;
  sessions?: Array<Record<string, unknown>>;
  unmanaged_worktrees?: Array<Record<string, unknown>>;
};

function snapshot(overrides: Record<string, unknown> = {}): RepositoryRuntimeSnapshot {
  return {
    contract_id: "nawabari.repository-runtime-snapshot.v1",
    schema_version: 1,
    repository_id: "r",
    registry: { schema_version: 1, revision: 4, runtime_epoch: 1, claim_set_generation: 1 },
    captured_at: "2026-01-01T00:00:00.000Z",
    complete: true,
    incomplete_reasons: [],
    sessions: [session],
    claims: [],
    observations: {
      coordination: { status: "unknown", observed_at: null, reason: "unused" },
      profiles: { status: "unknown", observed_at: null, reason: "unused" },
      processes: available({
        contract_id: "nawabari.repository-process-observation.v1",
        schema_version: 1,
        sessions: [{ session_id: "s1", status: "inactive", reason: null }],
      }),
      filesystem: available({
        contract_id: "nawabari.repository-filesystem-observation.v2",
        schema_version: 2,
        sessions: [
          {
            session_id: "s1",
            policy_status: "clean",
            runtime_status: "runtime-residual",
            owner: "proven",
            reason: null,
          },
        ],
        unmanaged_worktrees: [],
      }),
      lifecycle: available({
        contract_id: "nawabari.repository-lifecycle-observation.v2",
        schema_version: 2,
        sessions: [
          {
            session_id: "s1",
            state: "parked",
            physical_state: "present",
            recoverable_work: "absent",
            integration: "proven",
            cleanup: "complete",
            reason: null,
          },
        ],
      }),
    },
    ...overrides,
  } as unknown as RepositoryRuntimeSnapshot;
}

test("requires all five proofs for safe runtime residual cleanup", () => {
  const result = reconcileSessionRuntimeEvidence(snapshot());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.complete, true);
  assert.deepEqual(result.value.findings[0], {
    session_id: "s1",
    code: "safe-runtime-residual",
    disposition: "reconcile-runtime-only",
    proposed_actions: ["remove-owned-runtime-state"],
    reason: null,
  });
});

test("independently missing any cleanup proof prevents destructive reconciliation", () => {
  const cases: readonly [string, (current: RepositoryRuntimeSnapshot) => void][] = [
    [
      "owner",
      (current) => {
        valueAt(current, "filesystem").sessions![0]!.owner = "unknown";
      },
    ],
    [
      "process",
      (current) => {
        valueAt(current, "processes").sessions![0]!.status = "active";
      },
    ],
    [
      "lifecycle state",
      (current) => {
        valueAt(current, "lifecycle").sessions![0]!.state = "active";
      },
    ],
    [
      "recoverable work",
      (current) => {
        valueAt(current, "lifecycle").sessions![0]!.recoverable_work = "present";
      },
    ],
    [
      "integration",
      (current) => {
        valueAt(current, "lifecycle").sessions![0]!.integration = "unproven";
      },
    ],
  ];
  for (const [name, change] of cases) {
    const current = snapshot();
    change(current);
    const result = reconcileSessionRuntimeEvidence(current);
    assert.equal(result.ok, true, name);
    if (!result.ok) continue;
    assert.notEqual(result.value.findings[0]?.code, "safe-runtime-residual", name);
    assert.notEqual(result.value.findings[0]?.proposed_actions.includes("remove-owned-runtime-state"), true, name);
  }
});

test("active and unknown execution block cleanup", () => {
  for (const status of ["active", "unknown"] as const) {
    const current = snapshot();
    valueAt(current, "processes").sessions![0]!.status = status;
    const result = reconcileSessionRuntimeEvidence(current);
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.value.findings[0]?.disposition, "blocked");
  }
});

test("cleanup-incomplete can only propose retry for inactive, proven ownership", () => {
  const current = snapshot();
  valueAt(current, "filesystem").sessions![0]!.runtime_status = "cleanup-incomplete";
  const result = reconcileSessionRuntimeEvidence(current);
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.findings[0]?.proposed_actions, ["retry-runtime-cleanup"]);
  assert.equal(result.value.findings[0]?.disposition, "reconcile-runtime-only");
});

test("incomplete snapshots suppress destructive proposals", () => {
  const result = reconcileSessionRuntimeEvidence(snapshot({ complete: false }));
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.value.complete, false);
  assert.equal(result.value.findings[0]?.disposition, "retain");
  assert.deepEqual(result.value.findings[0]?.proposed_actions, ["retain-runtime-state", "inspect-session"]);
});

test("missing worktree without runtime residue is retained as managed-missing", () => {
  const current = snapshot();
  valueAt(current, "filesystem").sessions![0]!.runtime_status = "clean";
  valueAt(current, "lifecycle").sessions![0]!.physical_state = "missing";
  const result = reconcileSessionRuntimeEvidence(current);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.findings[0]?.code, "managed-missing");
});

test("unmanaged worktrees are observation-only and sorted by code points", () => {
  const current = snapshot();
  valueAt(current, "filesystem").unmanaged_worktrees!.push(
    { worktree_path: "/tmp/z", reason: null },
    { worktree_path: "/tmp/a", reason: null },
  );
  const result = reconcileSessionRuntimeEvidence(current);
  assert.equal(result.ok, true);
  if (result.ok) {
    const findings = result.value.findings.filter((entry) => entry.code === "unmanaged-worktree");
    assert.deepEqual(
      findings.map((entry) => entry.worktree_path),
      ["/tmp/a", "/tmp/z"],
    );
    assert.ok(
      findings.every(
        (entry) => entry.disposition === "observe" && entry.proposed_actions[0] === "inspect-unmanaged-worktree",
      ),
    );
  }
});

test("extended historical v1 shapes are rejected instead of silently accepted", () => {
  const current = snapshot();
  valueAt(current, "filesystem").contract_id = "nawabari.repository-filesystem-observation.v1";
  valueAt(current, "filesystem").schema_version = 1;
  const result = reconcileSessionRuntimeEvidence(current);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
});

function valueAt(
  snapshot: RepositoryRuntimeSnapshot,
  section: "filesystem" | "processes" | "lifecycle",
): ObservationValue {
  return (snapshot.observations[section] as unknown as { value: ObservationValue }).value;
}
