import assert from "node:assert/strict";
import test from "node:test";

import { SESSION_LIFECYCLE_STATES } from "./session-lifecycle-classification.js";
import {
  assertSessionParity,
  parityMismatches,
  projectClassifier,
  projectXState,
  SESSION_PARITY_FIXTURES,
  SESSION_PARITY_OPERATIONS,
} from "./testing/session-lifecycle-parity.js";

function fixture(id: string) {
  const found = SESSION_PARITY_FIXTURES.find((candidate) => candidate.id === id);
  if (found === undefined) throw new Error(`missing parity fixture: ${id}`);
  return found;
}

test("classifier and shadow machine have deterministic parity across the semantic matrix", () => {
  assert.equal(SESSION_PARITY_FIXTURES.length, 105);
  for (const parityFixture of SESSION_PARITY_FIXTURES) {
    assertSessionParity(parityFixture);
  }
});

test("state parity covers every public lifecycle state", () => {
  const classifierStates = new Set(
    SESSION_PARITY_FIXTURES.map((parityFixture) => projectClassifier(parityFixture).state),
  );
  const shadowStates = new Set(SESSION_PARITY_FIXTURES.map((parityFixture) => projectXState(parityFixture).state));
  assert.deepEqual([...classifierStates].sort(), [...SESSION_LIFECYCLE_STATES].sort());
  assert.deepEqual([...shadowStates].sort(), [...SESSION_LIFECYCLE_STATES].sort());
});

test("transition parity compares all operation semantics for every matrix fixture", () => {
  const operationCoverage = new Map<string, Set<string>>();
  for (const parityFixture of SESSION_PARITY_FIXTURES) {
    const classifier = projectClassifier(parityFixture);
    const mismatches = parityMismatches(parityFixture);
    assert.deepEqual(mismatches, [], parityFixture.id);
    const operations = operationCoverage.get(classifier.state) ?? new Set<string>();
    for (const operation of SESSION_PARITY_OPERATIONS) operations.add(operation);
    operationCoverage.set(classifier.state, operations);
  }
  for (const state of SESSION_LIFECYCLE_STATES) {
    assert.deepEqual([...(operationCoverage.get(state) ?? [])].sort(), [...SESSION_PARITY_OPERATIONS].sort(), state);
  }
});

test("fail-closed observations reject every destructive operation in both projections", () => {
  const failClosedFixtures = [
    "fail-closed-insufficient-physical-evidence",
    "fail-closed-ambiguous-physical-observation",
    "fail-closed-ambiguous-blockers",
    "fail-closed-unknown-blocker-semantics",
    "fail-closed-stale-evidence",
    "fail-closed-unknown-session-state",
    "readiness-blocked-blocker-none",
  ];
  for (const id of failClosedFixtures) {
    const parityFixture = fixture(id);
    const classifier = projectClassifier(parityFixture);
    const shadow = projectXState(parityFixture);
    assert.equal(classifier.state, "stale-inconsistent", id);
    assert.equal(shadow.state, "stale-inconsistent", id);
    for (const operation of ["close", "discard", "gc"] as const) {
      assert.equal(classifier.transitions[operation].allowed, false, `${id}: classifier ${operation}`);
      assert.equal(shadow.transitions[operation].accepted, false, `${id}: XState ${operation}`);
    }
  }
});

test("retains the #251 evidence and age/GC invariants", () => {
  for (const status of ["proven", "not-proven", "ambiguous", "unavailable"] as const) {
    const parityFixture = fixture(`evidence-integration-${status}`);
    assert.equal(projectClassifier(parityFixture).state, "active", status);
    assert.equal(projectXState(parityFixture).state, "active", status);
  }

  for (const id of ["evidence-gc-input-only", "evidence-gc-observation-only"]) {
    const parityFixture = fixture(id);
    assert.equal(projectClassifier(parityFixture).transitions.gc.allowed, false, id);
    assert.equal(projectXState(parityFixture).transitions.gc.accepted, false, id);
  }
  const observedAuthority = fixture("evidence-gc-authority-observation");
  assert.equal(projectClassifier(observedAuthority).transitions.gc.allowed, true);
  assert.equal(projectXState(observedAuthority).transitions.gc.accepted, true);

  const normalAuthorized = fixture("gc-age-normal-authorized");
  assert.equal(projectClassifier(normalAuthorized).transitions.gc.target, "closed");
  assert.equal(projectXState(normalAuthorized).transitions.gc.transitionKind, "target");
  for (const id of ["gc-age-normal-denied", "gc-age-suspicious-authorized", "gc-age-suspicious-denied"]) {
    const parityFixture = fixture(id);
    assert.equal(projectClassifier(parityFixture).transitions.gc.allowed, false, id);
    assert.equal(projectXState(parityFixture).transitions.gc.accepted, false, id);
  }
});

test("explicit discard intent and terminal state semantics remain lossless", () => {
  for (const state of ["active", "closing", "closed"] as const) {
    for (const intent of ["observation", "persisted-and-observation"] as const) {
      const parityFixture = fixture(`intent-${intent}-${state}`);
      assert.equal(projectClassifier(parityFixture).state, "discarded");
      assert.equal(projectXState(parityFixture).state, "discarded");
      assert.equal(projectClassifier(parityFixture).transitions.discard.requiresExplicitIntent, true);
      assert.equal(projectXState(parityFixture).transitions.discard.requiresExplicitIntent, true);
    }
  }

  const closed = fixture("state-closed-physical-closed");
  assert.equal(projectClassifier(closed).transitions.close.target, "closed");
  assert.equal(projectXState(closed).transitions.close.transitionKind, "self");
  const discarded = fixture("intent-observation-active");
  assert.equal(projectClassifier(discarded).transitions.close.allowed, false);
  assert.equal(projectXState(discarded).transitions.close.transitionKind, "forbidden");
});
