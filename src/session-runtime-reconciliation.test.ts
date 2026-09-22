import assert from "node:assert/strict";
import test from "node:test";
import { reconcileSessionRuntimeEvidence } from "./session-runtime-reconciliation.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";

const session = { sessionId: "s1" };
const available = (value: unknown) => ({ status: "available", observed_at: "2026-01-01T00:00:00.000Z", value });
function snapshot(overrides: Record<string, unknown> = {}): RepositoryRuntimeSnapshot {
  return {
    contract_id: "nawabari.repository-runtime-snapshot.v1", schema_version: 1, repository_id: "r",
    registry: { schema_version: 1, revision: 4, runtime_epoch: 1, claim_set_generation: 1 },
    captured_at: "2026-01-01T00:00:00.000Z", complete: true, incomplete_reasons: [], sessions: [session], claims: [],
    observations: {
      coordination: { status: "unknown", observed_at: null, reason: "unused" }, profiles: { status: "unknown", observed_at: null, reason: "unused" },
      processes: available({ contract_id: "nawabari.repository-process-observation.v1", schema_version: 1, sessions: [{ session_id: "s1", status: "inactive", reason: null }] }),
      filesystem: available({ contract_id: "nawabari.repository-filesystem-observation.v1", schema_version: 1, sessions: [{ session_id: "s1", status: "runtime-residual", owner: "proven", reason: null }], unmanaged_worktrees: [] }),
      lifecycle: available({ contract_id: "nawabari.repository-lifecycle-observation.v1", schema_version: 1, sessions: [{ session_id: "s1", state: "parked", physical_state: "present", recoverable_work: "absent", integration: "proven", cleanup: "complete", reason: null }] }),
    }, ...overrides,
  } as unknown as RepositoryRuntimeSnapshot;
}

test("requires all five proofs for safe runtime residual cleanup", () => {
  const result = reconcileSessionRuntimeEvidence(snapshot());
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.deepEqual(result.value.findings[0], { session_id: "s1", code: "safe-runtime-residual", disposition: "reconcile-runtime-only", proposed_actions: ["remove-owned-runtime-state"], reason: null });
});

test("active and unknown execution block cleanup", () => {
  const current = snapshot();
  (current.observations.processes as any).value.sessions[0].status = "active";
  const result = reconcileSessionRuntimeEvidence(current);
  assert.equal(result.ok, true);
  if (result.ok) assert.equal(result.value.findings[0].disposition, "blocked");
});

test("unmanaged worktrees are observation-only", () => {
  const current = snapshot();
  (current.observations.filesystem as any).value.unmanaged_worktrees.push({ worktree_path: "/tmp/unmanaged", reason: null });
  const result = reconcileSessionRuntimeEvidence(current);
  assert.equal(result.ok, true);
  if (result.ok) {
    const finding = result.value.findings.find((entry) => entry.code === "unmanaged-worktree");
    assert.equal(finding?.disposition, "observe");
    assert.deepEqual(finding?.proposed_actions, ["inspect-unmanaged-worktree"]);
  }
});

test("malformed available observations fail with INVALID_ARGUMENT", () => {
  const current = snapshot();
  (current.observations.processes as any).value.sessions[0].status = "bogus";
  const result = reconcileSessionRuntimeEvidence(current);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT");
});
