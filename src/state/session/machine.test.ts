import assert from "node:assert/strict";
import test from "node:test";
import { createActor } from "xstate";

import { sessionLifecycleMachine } from "./machine.js";
import type { PersistedSessionState, SessionMachineEvent, SessionMachineInput } from "./types.js";

function input(
  observation: Partial<SessionMachineInput["observation"]> & { sessionState?: string } = {},
  persistedState: PersistedSessionState = "active",
): SessionMachineInput {
  return {
    persisted: { sessionId: "session-shadow-test", state: persistedState },
    observation: {
      sessionState: "active",
      physicalState: "healthy",
      ...observation,
    },
  };
}

function actorFor(machineInput: SessionMachineInput) {
  return createActor(sessionLifecycleMachine, { input: machineInput }).start();
}

function stateOf(machineInput: SessionMachineInput) {
  const actor = actorFor(machineInput);
  const state = actor.getSnapshot().value;
  actor.stop();
  return state;
}

function send(actor: ReturnType<typeof actorFor>, event: SessionMachineEvent): string | Record<string, unknown> {
  actor.send(event);
  return actor.getSnapshot().value;
}

test("represents every derived operational lifecycle state", () => {
  assert.equal(stateOf(input()), "active");
  assert.equal(stateOf(input({ closeReadiness: "ready", phase: "termination" })), "close-ready");
  assert.equal(
    stateOf(input({ closeReadiness: "external_evidence_required", phase: "termination" })),
    "blocked-recoverable",
  );
  assert.equal(stateOf(input({ terminalOperation: "discard" })), "discarded");
  assert.equal(stateOf(input({ closeReadiness: "ambiguous" })), "stale-inconsistent");
  assert.equal(stateOf(input({ sessionState: "closed", physicalState: "closed" }, "closed")), "closed");
  assert.equal(stateOf(input({ sessionState: "parked" }, "parked")), "parked");
});

test("park and resume lifecycle changes require the canonical request/result sequence", () => {
  const actor = actorFor(input());
  assert.equal(send(actor, { type: "SESSION.PARK.REQUESTED" }), "parking");
  assert.equal(send(actor, { type: "SESSION.CLOSE.REQUESTED" }), "parking");
  assert.equal(send(actor, { type: "SESSION.DISCARD.REQUESTED" }), "parking");
  assert.equal(send(actor, { type: "SESSION.GC.REQUESTED" }), "parking");
  assert.equal(send(actor, { type: "SESSION.PARK.FINALIZE", status: "parked", operationId: "park-op-1" }), "parked");
  assert.equal(
    send(actor, { type: "SESSION.RESUME.REQUESTED", status: "resumed", operationId: "resume-op-1" }),
    "active",
  );
  actor.stop();

  const invalidFinalize = actorFor(input());
  assert.equal(send(invalidFinalize, { type: "SESSION.PARK.REQUESTED" }), "parking");
  assert.equal(
    send(invalidFinalize, {
      type: "SESSION.PARK.FINALIZE",
      status: "parked",
      operationId: "   ",
    }),
    "parking",
  );
  const nullFinalize = {
    type: "SESSION.PARK.FINALIZE",
    status: "parked",
    operationId: null as unknown as string,
  } satisfies SessionMachineEvent;
  assert.doesNotThrow(() => invalidFinalize.send(nullFinalize));
  assert.equal(invalidFinalize.getSnapshot().status, "active");
  assert.equal(invalidFinalize.getSnapshot().value, "parking");
  invalidFinalize.stop();

  const activeResume = actorFor(input());
  assert.equal(
    send(activeResume, { type: "SESSION.RESUME.REQUESTED", status: "resumed", operationId: "resume-op-2" }),
    "active",
  );
  activeResume.stop();

  const malformedResume = actorFor(input({ sessionState: "parked" }, "parked"));
  const nullResume = {
    type: "SESSION.RESUME.REQUESTED",
    status: "resumed",
    operationId: null as unknown as string,
  } satisfies SessionMachineEvent;
  assert.doesNotThrow(() => malformedResume.send(nullResume));
  assert.equal(malformedResume.getSnapshot().status, "active");
  assert.equal(malformedResume.getSnapshot().value, "parked");
  malformedResume.stop();
});

test("park request requires the persisted session record to remain active", () => {
  const contradictory = actorFor(input({}, "closed"));
  assert.equal(contradictory.getSnapshot().value, "active");
  assert.equal(contradictory.getSnapshot().can({ type: "SESSION.PARK.REQUESTED" }), false);
  assert.equal(send(contradictory, { type: "SESSION.PARK.REQUESTED" }), "active");
  contradictory.stop();

  const closeReady = actorFor(input({ closeReadiness: "ready", phase: "termination" }));
  assert.equal(closeReady.getSnapshot().value, "close-ready");
  assert.equal(send(closeReady, { type: "SESSION.PARK.REQUESTED" }), "close-ready");
  closeReady.stop();

  const blockedRecoverable = actorFor(input({ blockers: [{ code: "RECOVERABLE_COMMITS" }] }));
  assert.equal(blockedRecoverable.getSnapshot().value, "blocked-recoverable");
  assert.equal(send(blockedRecoverable, { type: "SESSION.PARK.REQUESTED" }), "blocked-recoverable");
  blockedRecoverable.stop();
});

test("parked sessions retain normal recovery guards and only resume from authoritative parked state", () => {
  const recoverableParked = actorFor(
    input({ sessionState: "parked", blockers: [{ code: "RECOVERABLE_COMMITS" }] }, "parked"),
  );
  assert.equal(recoverableParked.getSnapshot().value, "parked");
  assert.equal(send(recoverableParked, { type: "SESSION.CLOSE.REQUESTED" }), "parked");
  assert.equal(send(recoverableParked, { type: "SESSION.GC.REQUESTED" }), "parked");
  assert.equal(send(recoverableParked, { type: "SESSION.DISCARD.REQUESTED" }), "discarded");
  recoverableParked.stop();

  const unknownParked = actorFor(input({ sessionState: "parked", physicalState: "unavailable" }, "parked"));
  assert.equal(unknownParked.getSnapshot().value, "stale-inconsistent");
  assert.equal(
    send(unknownParked, { type: "SESSION.RESUME.REQUESTED", status: "resumed", operationId: "resume-op-3" }),
    "stale-inconsistent",
  );
  unknownParked.stop();
});

test("evaluates close, discard, inspect/doctor/reconcile, and GC capability events", () => {
  const active = actorFor(input());
  assert.equal(send(active, { type: "SESSION.CLOSE.REQUESTED" }), "close-ready");
  assert.equal(send(active, { type: "SESSION.CLOSE.REQUESTED" }), "closed");
  assert.equal(send(active, { type: "SESSION.DOCTOR.REQUESTED" }), "closed");
  assert.equal(send(active, { type: "SESSION.RECONCILE.REQUESTED" }), "closed");
  active.stop();

  const observed = actorFor(input());
  assert.equal(
    send(observed, {
      type: "SESSION.OBSERVE",
      observation: {
        sessionState: "active",
        physicalState: "healthy",
        closeReadiness: "ready",
        phase: "termination",
      },
    }),
    "close-ready",
  );
  observed.stop();

  const blocked = actorFor(input({ blockers: [{ code: "RECOVERABLE_COMMITS" }] }));
  assert.equal(send(blocked, { type: "SESSION.CLOSE.REQUESTED" }), "blocked-recoverable");
  assert.equal(send(blocked, { type: "SESSION.DISCARD.REQUESTED" }), "discarded");
  blocked.stop();

  const ready = actorFor(input({ closeReadiness: "ready", phase: "termination", gcAuthorized: true }));
  assert.equal(send(ready, { type: "SESSION.GC.REQUESTED" }), "closed");
  ready.stop();
});

test("fails closed for ambiguous observation", () => {
  assert.equal(stateOf(input({ closeReadiness: "ambiguous" })), "stale-inconsistent");
});

test("integration evidence alone does not affect classification", () => {
  assert.equal(
    stateOf(
      input({
        evidence: { integration: { status: "ambiguous", reason: "identity race" } },
      }),
    ),
    "active",
  );
  assert.equal(
    stateOf(
      input({
        evidence: { integration: { status: "unavailable", reason: "network partition" } },
      }),
    ),
    "active",
  );
});

test("age suspicion alone cannot authorize destructive GC", () => {
  const ageOnly = actorFor(
    input({
      ageSuspicious: true,
      closeReadiness: "ready",
      phase: "termination",
    }),
  );
  assert.equal(ageOnly.getSnapshot().value, "close-ready");
  assert.equal(send(ageOnly, { type: "SESSION.GC.REQUESTED" }), "close-ready");
  ageOnly.stop();

  const ageWithAuthorization = actorFor(
    input({
      ageSuspicious: true,
      gcAuthorized: true,
      closeReadiness: "ready",
      phase: "termination",
    }),
  );
  assert.equal(send(ageWithAuthorization, { type: "SESSION.GC.REQUESTED" }), "close-ready");
  ageWithAuthorization.stop();
});

test("requires independent GC authorization", () => {
  const ready = actorFor(input({ closeReadiness: "ready", phase: "termination" }));
  assert.equal(send(ready, { type: "SESSION.GC.REQUESTED" }), "close-ready");
  ready.stop();
});

test("evidence.garbageCollection.authorized alone cannot substitute for observation.gcAuthorized", () => {
  const readyWithEvidenceOnly = actorFor(
    input({
      closeReadiness: "ready",
      phase: "termination",
      evidence: { garbageCollection: { authorized: true } },
    }),
  );
  assert.equal(send(readyWithEvidenceOnly, { type: "SESSION.GC.REQUESTED" }), "close-ready");
  readyWithEvidenceOnly.stop();
});

test("explicit discard intent never enters the normal close path", () => {
  const discarded = actorFor(input({ terminalOperation: "discard" }));
  assert.equal(send(discarded, { type: "SESSION.CLOSE.REQUESTED" }), "discarded");
  assert.equal(send(discarded, { type: "SESSION.DISCARD.REQUESTED" }), "discarded");
  discarded.stop();

  const active = actorFor(input());
  assert.equal(send(active, { type: "SESSION.CLOSE.REQUESTED" }), "close-ready");
  active.stop();
});

test("terminal states reject invalid destructive transitions", () => {
  const closed = actorFor(input({ sessionState: "closed", physicalState: "closed" }, "closed"));
  assert.equal(send(closed, { type: "SESSION.DISCARD.REQUESTED" }), "closed");
  assert.equal(send(closed, { type: "SESSION.GC.REQUESTED" }), "closed");
  closed.stop();

  const discarded = actorFor(input({ terminalOperation: "discard" }));
  assert.equal(send(discarded, { type: "SESSION.CLOSE.REQUESTED" }), "discarded");
  assert.equal(send(discarded, { type: "SESSION.GC.REQUESTED" }), "discarded");
  discarded.stop();
});
