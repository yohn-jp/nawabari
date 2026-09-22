import assert from "node:assert/strict";
import test from "node:test";

import {
  projectSessionParkingTransition,
  SESSION_PARKING_CONTRACT_ID,
  SESSION_PARKING_SCHEMA_VERSION,
  SESSION_PARKING_TRANSITION_TABLE,
  type SessionParkingEvent,
  type SessionParkingOperationalState,
  type SessionParkingTransitionInput,
} from "./session-parking.js";

const EVENT_TYPES: readonly SessionParkingEvent["type"][] = [
  "SESSION.PARK.REQUESTED",
  "SESSION.PARK.FINALIZE",
  "SESSION.RESUME.REQUESTED",
  "SESSION.OBSERVE",
  "SESSION.CLOSE.REQUESTED",
  "SESSION.DISCARD.REQUESTED",
  "SESSION.DOCTOR.REQUESTED",
  "SESSION.RECONCILE.REQUESTED",
  "SESSION.GC.REQUESTED",
];

const STATES: readonly SessionParkingOperationalState[] = ["active", "parking", "parked"];

const observation = Object.freeze({
  sessionState: "active",
  physicalState: "healthy",
} as const);

function input(state: SessionParkingOperationalState, current = observation): SessionParkingTransitionInput {
  return { state, observation: current };
}

function event(type: SessionParkingEvent["type"]): SessionParkingEvent {
  switch (type) {
    case "SESSION.PARK.FINALIZE":
      return { type, status: "parked", operationId: "op-1" };
    case "SESSION.RESUME.REQUESTED":
      return { type, status: "resumed", operationId: "op-1" };
    case "SESSION.OBSERVE":
      return { type, observation };
    default:
      return { type } as SessionParkingEvent;
  }
}

function transition(state: SessionParkingOperationalState, currentEvent: SessionParkingEvent) {
  const result = projectSessionParkingTransition(input(state), currentEvent);
  assert.equal(result.ok, true);
  return result.value;
}

test("publishes the frozen parking contract identity", () => {
  assert.equal(SESSION_PARKING_CONTRACT_ID, "nawabari.session-parking.v1");
  assert.equal(SESSION_PARKING_SCHEMA_VERSION, 1);
});

test("publishes every state/event pair as one immutable declarative row", () => {
  assert.equal(SESSION_PARKING_TRANSITION_TABLE.length, STATES.length * EVENT_TYPES.length);
  assert.equal(Object.isFrozen(SESSION_PARKING_TRANSITION_TABLE), true);

  for (const state of STATES) {
    const rows = SESSION_PARKING_TRANSITION_TABLE.filter((row) => row.source === state);
    assert.equal(rows.length, EVENT_TYPES.length);
    assert.deepEqual(rows.map((row) => row.event).sort(), [...EVENT_TYPES].sort());
    for (const row of rows) assert.equal(Object.isFrozen(row), true);
  }

  assert.equal(
    SESSION_PARKING_TRANSITION_TABLE.some((row) => (row.event as string) === "SESSION.INSPECT.REQUESTED"),
    false,
  );
});

test("projects the explicit park/finalize/resume transitions", () => {
  assert.deepEqual(transition("active", { type: "SESSION.PARK.REQUESTED" }), {
    allowed: true,
    target: "parking",
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "park-requested",
  });
  assert.deepEqual(transition("parking", { type: "SESSION.PARK.FINALIZE", status: "parked", operationId: "op-1" }), {
    allowed: true,
    target: "parked",
    requiresExplicitIntent: false,
    authority: "session-registry",
    reason: "parked",
  });
  assert.deepEqual(transition("parked", { type: "SESSION.RESUME.REQUESTED", status: "resumed", operationId: "op-1" }), {
    allowed: true,
    target: "active",
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "resume-authorized",
  });
});

test("keeps parking transient and allows only observation/diagnostics during it", () => {
  assert.deepEqual(transition("parking", { type: "SESSION.PARK.REQUESTED" }), {
    allowed: false,
    target: null,
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "parking-in-progress",
  });
  assert.deepEqual(
    transition("parking", { type: "SESSION.RESUME.REQUESTED", status: "resumed", operationId: "op-1" }),
    {
      allowed: false,
      target: null,
      requiresExplicitIntent: true,
      authority: "caller",
      reason: "parking-in-progress",
    },
  );
  assert.deepEqual(transition("parking", { type: "SESSION.DOCTOR.REQUESTED" }), {
    allowed: true,
    target: "parking",
    requiresExplicitIntent: false,
    authority: "reconciliation",
    reason: "observe",
  });
  assert.deepEqual(transition("parking", { type: "SESSION.RECONCILE.REQUESTED" }), {
    allowed: true,
    target: "parking",
    requiresExplicitIntent: false,
    authority: "reconciliation",
    reason: "observe",
  });
});

test("observation classifies parked only after stale, discarded, and closed precedence", () => {
  const parked = projectSessionParkingTransition(input("parking"), {
    type: "SESSION.OBSERVE",
    observation: { sessionState: "parked", physicalState: "healthy" },
  });
  assert.equal(parked.ok, true);
  assert.equal(parked.value.target, "parked");

  const stale = projectSessionParkingTransition(input("parking"), {
    type: "SESSION.OBSERVE",
    observation: { sessionState: "parked", physicalState: "unavailable" },
  });
  assert.equal(stale.ok, true);
  assert.equal(stale.value.target, "stale-inconsistent");

  const discarded = projectSessionParkingTransition(input("parking"), {
    type: "SESSION.OBSERVE",
    observation: { sessionState: "parked", physicalState: "healthy", terminalOperation: "discard" },
  });
  assert.equal(discarded.ok, true);
  assert.equal(discarded.value.target, "discarded");

  const closed = projectSessionParkingTransition(input("active"), {
    type: "SESSION.OBSERVE",
    observation: { sessionState: "closed", physicalState: "closed" },
  });
  assert.equal(closed.ok, true);
  assert.equal(closed.value.target, "closed");
});

test("delegates parked termination operations to the existing lifecycle classifier", () => {
  const close = transition("parked", { type: "SESSION.CLOSE.REQUESTED" });
  assert.deepEqual(close, {
    allowed: true,
    target: "close-ready",
    requiresExplicitIntent: false,
    authority: "session-registry",
    reason: "close-proof-required",
  });

  const discard = transition("parked", { type: "SESSION.DISCARD.REQUESTED" });
  assert.deepEqual(discard, {
    allowed: true,
    target: "discarded",
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "explicit-discard-required",
  });

  const gc = transition("parked", { type: "SESSION.GC.REQUESTED" });
  assert.deepEqual(gc, {
    allowed: false,
    target: null,
    requiresExplicitIntent: false,
    authority: "gc",
    reason: "age-is-not-destructive-authority",
  });
});

test("rejects malformed states, events, and operation payloads with INVALID_ARGUMENT", () => {
  const cases: readonly [unknown, unknown][] = [
    [{ state: "unknown", observation }, { type: "SESSION.PARK.REQUESTED" }],
    [input("active"), { type: "SESSION.UNKNOWN" }],
    [input("parking"), { type: "SESSION.PARK.FINALIZE", status: "parked", operationId: "" }],
    [input("parked"), { type: "SESSION.RESUME.REQUESTED", status: "resumed", operationId: "" }],
    [input("active"), { type: "SESSION.OBSERVE", observation: null }],
  ];

  for (const [candidateInput, candidateEvent] of cases) {
    const result = projectSessionParkingTransition(
      candidateInput as SessionParkingTransitionInput,
      candidateEvent as SessionParkingEvent,
    );
    assert.equal(result.ok, false);
    assert.equal(result.error.code, "INVALID_ARGUMENT");
  }
});
