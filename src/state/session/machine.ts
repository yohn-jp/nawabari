import { assign, setup } from "xstate";

import type { SessionLifecycleOperation } from "../../session-lifecycle-classification.js";

import {
  hasGcAuthorization,
  isDestructiveGcAllowed,
  isObservationBlockedRecoverable,
  isObservationCloseReady,
  isObservationClosed,
  isObservationDiscarded,
  isObservationStaleInconsistent,
} from "./guards.js";
import type { SessionMachineContext, SessionMachineEvent, SessionMachineInput } from "./types.js";

function evidenceForInput(input: SessionMachineInput): SessionMachineContext["evidence"] {
  return {
    ...(input.observation.evidence ?? {}),
    ...(input.evidence ?? {}),
  };
}

function contextForInput(input: SessionMachineInput): SessionMachineContext {
  return {
    persisted: input.persisted,
    observation: input.observation,
    evidence: evidenceForInput(input),
  };
}

const machineSetup = setup({
  types: {
    context: {} as SessionMachineContext,
    events: {} as SessionMachineEvent,
    input: {} as SessionMachineInput,
  },
  actions: {
    updateObservation: assign({
      observation: ({ context, event }) => (event.type === "SESSION.OBSERVE" ? event.observation : context.observation),
      evidence: ({ context, event }) =>
        event.type === "SESSION.OBSERVE"
          ? {
              ...(event.observation.evidence ?? {}),
              ...(event.evidence ?? {}),
            }
          : context.evidence,
    }),
  },
  guards: {
    observationIsStaleInconsistent: ({ context }) => isObservationStaleInconsistent(context),
    observationIsDiscarded: ({ context }) => isObservationDiscarded(context),
    observationIsClosed: ({ context }) => isObservationClosed(context),
    observationIsBlockedRecoverable: ({ context }) => isObservationBlockedRecoverable(context),
    observationIsCloseReady: ({ context }) => isObservationCloseReady(context),
    destructiveGcIsAllowed: ({ context }) => isDestructiveGcAllowed(context),
  },
});

const observeTransition = {
  target: "classify",
  actions: "updateObservation",
} as const;

const reconcileTransition = {} as const;
const cleanupRetryTransition = {} as const;
const cleanupFinalizeTransition = {} as const;

/** Stable mapping from domain operations to internal capability events. */
export const SESSION_OPERATION_EVENT_TYPES = Object.freeze({
  close: "SESSION.CLOSE.REQUESTED",
  discard: "SESSION.DISCARD.REQUESTED",
  inspect: "SESSION.OBSERVE",
  doctor: "SESSION.RECONCILE.REQUESTED",
  reconcile: "SESSION.RECONCILE.REQUESTED",
  gc: "SESSION.GC.REQUESTED",
} as const satisfies Record<SessionLifecycleOperation, string>);

/**
 * Shadow executable for the derived operational session lifecycle.
 *
 * The `classify` node is an internal routing node. It is never part of the
 * operational vocabulary and exists only to evaluate a newly supplied,
 * already-authoritative observation through the machine's own guards.
 */
export const sessionLifecycleMachine = machineSetup.createMachine({
  id: "session-lifecycle-shadow",
  initial: "classify",
  context: ({ input }) => contextForInput(input),
  states: {
    classify: {
      always: [
        { target: "stale-inconsistent", guard: "observationIsStaleInconsistent" },
        { target: "discarded", guard: "observationIsDiscarded" },
        { target: "closed", guard: "observationIsClosed" },
        { target: "blocked-recoverable", guard: "observationIsBlockedRecoverable" },
        { target: "close-ready", guard: "observationIsCloseReady" },
        { target: "active" },
      ],
    },
    active: {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.CLOSE.REQUESTED": { target: "close-ready" },
        "SESSION.DISCARD.REQUESTED": { target: "discarded" },
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
        "SESSION.MARK_STALE": { target: "stale-inconsistent" },
      },
    },
    "close-ready": {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.CLOSE.REQUESTED": { target: "closed" },
        "SESSION.DISCARD.REQUESTED": { target: "discarded" },
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.GC.REQUESTED": { target: "closed", guard: "destructiveGcIsAllowed" },
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
        "SESSION.MARK_STALE": { target: "stale-inconsistent" },
      },
    },
    "blocked-recoverable": {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.DISCARD.REQUESTED": { target: "discarded" },
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
        "SESSION.MARK_STALE": { target: "stale-inconsistent" },
      },
    },
    discarded: {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.DISCARD.REQUESTED": {},
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
      },
    },
    "stale-inconsistent": {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
      },
    },
    closed: {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.CLOSE.REQUESTED": {},
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
      },
    },
  },
});

/** Alias using the shorter module vocabulary used by internal callers. */
export const sessionMachine = sessionLifecycleMachine;
