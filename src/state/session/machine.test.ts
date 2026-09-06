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
});

test("evaluates close, discard, inspect/doctor/reconcile, and GC capability events", () => {
  const active = actorFor(input());
  assert.equal(send(active, { type: "SESSION.CLOSE.REQUESTED" }), "close-ready");
  assert.equal(send(active, { type: "SESSION.CLOSE.REQUESTED" }), "closed");
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

test("fails closed for ambiguous observation and integration evidence", () => {
  assert.equal(stateOf(input({ closeReadiness: "ambiguous" })), "stale-inconsistent");
  assert.equal(
    stateOf(
      input({
        evidence: { integration: { status: "ambiguous", reason: "identity race" } },
      }),
    ),
    "stale-inconsistent",
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
