import assert from "node:assert/strict";
import { test } from "node:test";

import {
  decideExecutionAdmission,
  validateExecutionAdmissionReservation,
  type ExecutionAdmissionFacts,
} from "./session-admission-decision.js";

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

test("bootstrap admission is explicit, bound to new, and ordinary admission stays active-only", () => {
  const pending = { ...snapshot, lifecycle: "new" as const };
  const ordinary = decideExecutionAdmission({ ...facts(), current: pending, expected: pending });
  assert.equal(ordinary.ok, true);
  if (ordinary.ok) assert.equal(ordinary.value.admitted, false);

  const admitted = decideExecutionAdmission({ ...facts(), purpose: "bootstrap", current: pending, expected: pending });
  assert.equal(admitted.ok, true);
  if (!admitted.ok || !admitted.value.admitted) return;
  assert.equal(admitted.value.reservation.purpose, "bootstrap");
  assert.equal(validateExecutionAdmissionReservation(admitted.value.reservation).ok, true);

  const active = decideExecutionAdmission({ ...facts(), purpose: "bootstrap" });
  assert.equal(active.ok, true);
  if (active.ok) assert.equal(active.value.admitted, false);
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
