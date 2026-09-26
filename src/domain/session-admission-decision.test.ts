import assert from "node:assert/strict";
import { test } from "node:test";

import { decideExecutionAdmission, type ExecutionAdmissionFacts } from "./session-admission-decision.js";

const snapshot = {
  lifecycle: "active" as const,
  launch_permitted: true,
  profile_token: "profile-token",
  profile_revision: 3,
  filesystem_token: "filesystem-token",
  filesystem_revision: 7,
  generation: 11,
  epoch: 19,
};

function facts(overrides: Partial<ExecutionAdmissionFacts["current"]> = {}): ExecutionAdmissionFacts {
  return {
    session_id: "session-1",
    execution_id: "execution-1",
    current: { ...snapshot, ...overrides },
    expected: { ...snapshot },
  };
}

test("admission compares lifecycle, profile/filesystem identity, generation, and epoch before reserving starting", () => {
  const result = decideExecutionAdmission(facts());
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.equal(result.value.admitted, true);
  if (!result.value.admitted) return;
  assert.equal(result.value.status, "starting");
  assert.deepEqual(result.value.reservation, {
    contract_id: "nawabari.session-admission.v1",
    schema_version: 1,
    session_id: "session-1",
    execution_id: "execution-1",
    status: "starting",
    profile_token: "profile-token",
    profile_revision: 3,
    filesystem_token: "filesystem-token",
    filesystem_revision: 7,
    generation: 11,
    epoch: 19,
  });
});

for (const [name, override, reason] of [
  ["lifecycle", { lifecycle: "closing" as const }, "lifecycle-not-permitted"],
  ["profile token", { profile_token: "changed" }, "profile-token-changed"],
  ["profile revision", { profile_revision: 4 }, "profile-revision-changed"],
  ["filesystem token", { filesystem_token: "changed" }, "filesystem-token-changed"],
  ["filesystem revision", { filesystem_revision: 8 }, "filesystem-revision-changed"],
  ["generation", { generation: 12 }, "generation-changed"],
  ["epoch", { epoch: 20 }, "epoch-changed"],
] as const) {
  test(`denies a changed ${name} observation`, () => {
    const result = decideExecutionAdmission(facts(override));
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    if (!result.ok) return;
    assert.equal(result.value.admitted, false);
    if (result.value.admitted) return;
    assert.equal(result.value.reason, reason);
  });
}

test("a stale lifecycle epoch fails closed and malformed identity is rejected", () => {
  const stale = decideExecutionAdmission({
    ...facts(),
    current: { ...snapshot, epoch: 18 },
    expected: { ...snapshot, epoch: 19 },
  });
  assert.equal(stale.ok, true);
  if (stale.ok) {
    assert.equal(stale.value.admitted, false);
    if (!stale.value.admitted) assert.equal(stale.value.reason, "stale-epoch");
  }

  const malformed = decideExecutionAdmission({ ...facts(), session_id: "bad\0session" });
  assert.equal(malformed.ok, false);
  if (!malformed.ok) assert.equal(malformed.error.code, "INVALID_ARGUMENT");
});
