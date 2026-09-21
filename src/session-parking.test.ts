import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";

import {
  availableSessionParkingOperations,
  classifySessionParking,
  isSessionParkingAdmissionAllowed,
  isSessionParkingFinalizeReady,
  isSessionParkingResumeReady,
  primarySessionParkingAction,
  projectSessionParkingActions,
  projectSessionParkingTransition,
  SESSION_PARKING_EVENT_TYPES,
  SESSION_PARKING_STATES,
  SESSION_PARKING_TRANSITION_TABLE,
  sessionParkingMachine,
  type SessionParkingMachineInput,
  type SessionParkingObservation,
} from "./session-parking.js";

function observation(
  state: SessionParkingObservation["state"],
  overrides: Partial<SessionParkingObservation> = {},
): SessionParkingObservation {
  return {
    state,
    claimGeneration: 7,
    drain: { status: "drained", activeExecutionCount: 0 },
    claims: { generation: 7, status: "active" },
    physical: {
      worktree: "retained",
      branch: "retained",
      identity: "verified",
      runtime: "known",
      dirty: false,
      unintegrated: false,
    },
    ...overrides,
  };
}

function input(
  state: SessionParkingObservation["state"],
  overrides: Partial<SessionParkingObservation> = {},
): SessionParkingMachineInput {
  const snapshot = observation(state, overrides);
  return {
    observation: snapshot,
    persisted: { state: snapshot.state, claimGeneration: snapshot.claimGeneration },
  };
}

test("publishes one explicit event vocabulary and the three parking states", () => {
  assert.deepEqual([...SESSION_PARKING_STATES], ["active", "parking", "parked"]);
  assert.deepEqual(SESSION_PARKING_EVENT_TYPES, {
    park: "SESSION.PARK.REQUESTED",
    "park-finalize": "SESSION.PARK.FINALIZE",
    resume: "SESSION.RESUME.REQUESTED",
  });
  assert.equal(SESSION_PARKING_TRANSITION_TABLE.parking.length, 3);
  assert.equal(SESSION_PARKING_TRANSITION_TABLE.parking[1]?.guarded, true);
  assert.equal(SESSION_PARKING_TRANSITION_TABLE.parked[2]?.guarded, true);
});

test("age suspicion does not park a session; explicit park blocks admission", () => {
  const active = input("active", {
    ageSuspicious: true,
    physical: {
      worktree: "retained",
      branch: "retained",
      identity: "verified",
      runtime: "unknown",
      dirty: true,
      unintegrated: true,
    },
  });
  const classification = classifySessionParking(active);

  assert.equal(classification.state, "active");
  assert.equal(classification.ageSuspicious, true);
  assert.equal(classification.admissionAllowed, true);
  assert.equal(isSessionParkingAdmissionAllowed(active), true);
  assert.deepEqual(availableSessionParkingOperations(classification), ["park"]);
  assert.deepEqual(projectSessionParkingTransition(active, "park"), {
    operation: "park",
    eventType: "SESSION.PARK.REQUESTED",
    allowed: true,
    target: "parking",
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "explicit-park-requested",
    claimGeneration: 7,
    nextClaimGeneration: null,
  });
});

test("parking finalize requires drain, claim release, and retained physical identity", () => {
  const draining = input("parking", {
    drain: { status: "running", activeExecutionCount: 1 },
    claims: { generation: 7, status: "active" },
  });
  const blocked = projectSessionParkingTransition(draining, "park-finalize");
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.reason, "park-drain-required");
  assert.equal(isSessionParkingFinalizeReady(draining), false);

  const releasedButUnknown = input("parking", {
    claims: { generation: 7, status: "released" },
    physical: {
      worktree: "retained",
      branch: "unknown",
      identity: "unknown",
      runtime: "unknown",
      dirty: "unknown",
      unintegrated: "unknown",
    },
  });
  const identityBlocked = projectSessionParkingTransition(releasedButUnknown, "park-finalize");
  assert.equal(identityBlocked.allowed, false);
  assert.equal(identityBlocked.reason, "park-physical-identity-required");

  const finalized = input("parking", {
    claims: { generation: 7, status: "downgraded" },
    physical: {
      worktree: "retained",
      branch: "retained",
      identity: "verified",
      runtime: "unknown",
      dirty: "unknown",
      unintegrated: true,
    },
  });
  const transition = projectSessionParkingTransition(finalized, "park-finalize");
  assert.equal(transition.allowed, true);
  assert.equal(transition.target, "parked");
  assert.equal(transition.reason, "park-finalized");
  assert.equal(isSessionParkingFinalizeReady(finalized), true);
});

test("claim-generation mismatch fails closed for finalize and resume", () => {
  const finalizeConflict = input("parking", {
    claims: { generation: 8, status: "released" },
  });
  assert.equal(projectSessionParkingTransition(finalizeConflict, "park-finalize").allowed, false);
  assert.equal(
    projectSessionParkingTransition(finalizeConflict, "park-finalize").reason,
    "park-claims-release-required",
  );

  const resumeConflict = input("parked", {
    claims: { generation: 8, status: "reacquired", allRequiredReacquired: true },
  });
  const transition = projectSessionParkingTransition(resumeConflict, "resume");
  assert.equal(transition.allowed, false);
  assert.equal(transition.reason, "resume-generation-conflict");
  assert.equal(isSessionParkingResumeReady(resumeConflict), false);
});

test("resume requires all claims and never closes a parked session", () => {
  const partial = input("parked", {
    claims: { generation: 7, status: "reacquired", allRequiredReacquired: false },
  });
  assert.equal(projectSessionParkingTransition(partial, "resume").reason, "resume-claims-reacquisition-required");

  const resumed = input("parked", {
    claims: { generation: 7, status: "reacquired", allRequiredReacquired: true },
    physical: {
      worktree: "retained",
      branch: "retained",
      identity: "verified",
      runtime: "unknown",
      dirty: true,
      unintegrated: true,
    },
  });
  const classification = classifySessionParking(resumed);
  assert.equal(classification.state, "parked");
  assert.equal(classification.parked, true);
  assert.equal(classification.closed, false);
  assert.equal(classification.admissionAllowed, false);
  assert.equal(isSessionParkingAdmissionAllowed(resumed), false);
  assert.equal(isSessionParkingResumeReady(resumed), true);
  assert.equal(projectSessionParkingTransition(resumed, "resume").target, "active");
  assert.equal(projectSessionParkingTransition(resumed, "resume").nextClaimGeneration, 8);
});

test("machine and public projection agree for request, finalize, and resume", () => {
  const activeActor = createActor(sessionParkingMachine, { input: input("active") }).start();
  assert.equal(activeActor.getSnapshot().can({ type: "SESSION.PARK.REQUESTED" }), true);
  activeActor.send({ type: "SESSION.PARK.REQUESTED" });
  assert.equal(activeActor.getSnapshot().value, "parking");
  activeActor.stop();

  const parkingInput = input("parking", { claims: { generation: 7, status: "released" } });
  const parkingActor = createActor(sessionParkingMachine, { input: parkingInput }).start();
  assert.equal(parkingActor.getSnapshot().can({ type: "SESSION.PARK.FINALIZE" }), true);
  parkingActor.send({ type: "SESSION.PARK.FINALIZE" });
  assert.equal(parkingActor.getSnapshot().value, "parked");
  parkingActor.stop();

  const parkedInput = input("parked", { claims: { generation: 7, status: "reacquired", allRequiredReacquired: true } });
  const parkedActor = createActor(sessionParkingMachine, { input: parkedInput }).start();
  assert.equal(parkedActor.getSnapshot().can({ type: "SESSION.RESUME.REQUESTED" }), true);
  parkedActor.send({ type: "SESSION.RESUME.REQUESTED" });
  assert.equal(parkedActor.getSnapshot().value, "active");
  parkedActor.stop();
});

test("public actions expose only admissible explicit operations", () => {
  const activeClassification = classifySessionParking(input("active"));
  assert.deepEqual(projectSessionParkingActions({ classification: activeClassification, sessionId: "session-1" }), [
    {
      schemaVersion: 1,
      actionId: "request-park",
      kind: "park-request",
      command: "session park",
      eventType: "SESSION.PARK.REQUESTED",
      sessionId: "session-1",
      requiresExplicitIntent: true,
      mutates: true,
    },
  ]);
  assert.equal(
    primarySessionParkingAction({ classification: activeClassification, sessionId: "session-1" })?.actionId,
    "request-park",
  );

  const parkedClassification = classifySessionParking(
    input("parked", { claims: { generation: 7, status: "reacquired", allRequiredReacquired: true } }),
  );
  assert.equal(
    primarySessionParkingAction({ classification: parkedClassification, sessionId: "session-2" })?.actionId,
    "request-resume",
  );
  assert.equal(
    projectSessionParkingActions({ classification: parkedClassification, sessionId: "session-2" }).length,
    1,
  );
});

test("state and persisted evidence disagreement is rejected instead of aliased", () => {
  const mismatched: SessionParkingMachineInput = {
    observation: observation("parking"),
    persisted: { state: "active", claimGeneration: 7 },
  };
  const classification = classifySessionParking(mismatched);
  assert.equal(classification.state, "parking");
  assert.deepEqual(availableSessionParkingOperations(classification), []);
  assert.equal(projectSessionParkingTransition(mismatched, "park-finalize").reason, "state-evidence-mismatch");
});
