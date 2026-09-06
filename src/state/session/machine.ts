import { assign, setup } from "xstate";

import type { SessionLifecycleOperation, SessionLifecycleTransition } from "../../session-lifecycle-classification.js";

import {
  isDestructiveGcAllowed,
  isObservationBlockedRecoverable,
  isObservationCloseReady,
  isObservationClosed,
  isObservationDiscarded,
  isObservationStaleInconsistent,
} from "./guards.js";
import type { SessionMachineContext, SessionMachineEvent, SessionMachineInput } from "./types.js";

/** Semantic metadata retained on every modeled operation transition. */
export type SessionMachineTransitionMetadata = Pick<
  SessionLifecycleTransition,
  "operation" | "requiresExplicitIntent" | "authority" | "reason"
> & {
  /** Reason selected when the transition's guard rejects the event. */
  readonly forbiddenReason?: SessionLifecycleTransition["reason"];
};

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
    operationIsForbidden: () => false,
  },
});

const observeTransition = {
  target: "classify",
  actions: "updateObservation",
  meta: {
    operation: "inspect",
    requiresExplicitIntent: false,
    authority: "session-registry",
    reason: "observe",
  },
} as const;

function operationMetadata(
  operation: SessionLifecycleOperation,
  requiresExplicitIntent: boolean,
  authority: SessionMachineTransitionMetadata["authority"],
  reason: SessionMachineTransitionMetadata["reason"],
  forbiddenReason?: SessionMachineTransitionMetadata["forbiddenReason"],
): SessionMachineTransitionMetadata {
  return {
    operation,
    requiresExplicitIntent,
    authority,
    reason,
    ...(forbiddenReason === undefined ? {} : { forbiddenReason }),
  };
}

function allowedTransition(target: string, meta: SessionMachineTransitionMetadata) {
  return { target, meta } as const;
}

function selfTransition(meta: SessionMachineTransitionMetadata) {
  return allowedTransition(".", meta);
}

function forbiddenTransition(meta: SessionMachineTransitionMetadata) {
  return { target: ".", guard: "operationIsForbidden", meta } as const;
}

const doctorTransition = selfTransition(operationMetadata("doctor", false, "reconciliation", "observe"));
const reconcileTransition = selfTransition(operationMetadata("reconcile", false, "reconciliation", "observe"));
const cleanupRetryTransition = {} as const;
const cleanupFinalizeTransition = {} as const;

/** Stable mapping from domain operations to internal capability events. */
export const SESSION_OPERATION_EVENT_TYPES = Object.freeze({
  close: "SESSION.CLOSE.REQUESTED",
  discard: "SESSION.DISCARD.REQUESTED",
  inspect: "SESSION.OBSERVE",
  doctor: "SESSION.DOCTOR.REQUESTED",
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
        "SESSION.CLOSE.REQUESTED": allowedTransition(
          "close-ready",
          operationMetadata("close", false, "session-registry", "close-proof-required"),
        ),
        "SESSION.DISCARD.REQUESTED": allowedTransition(
          "discarded",
          operationMetadata("discard", true, "caller", "explicit-discard-required"),
        ),
        "SESSION.DOCTOR.REQUESTED": doctorTransition,
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata("gc", false, "gc", "age-is-not-destructive-authority"),
        ),
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
        "SESSION.MARK_STALE": { target: "stale-inconsistent" },
      },
    },
    "close-ready": {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.CLOSE.REQUESTED": allowedTransition(
          "closed",
          operationMetadata("close", false, "session-registry", "close-authorized"),
        ),
        "SESSION.DISCARD.REQUESTED": allowedTransition(
          "discarded",
          operationMetadata("discard", true, "caller", "explicit-discard-required"),
        ),
        "SESSION.DOCTOR.REQUESTED": doctorTransition,
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.GC.REQUESTED": {
          target: "closed",
          guard: "destructiveGcIsAllowed",
          meta: operationMetadata("gc", false, "gc", "close-authorized", "age-is-not-destructive-authority"),
        },
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
        "SESSION.MARK_STALE": { target: "stale-inconsistent" },
      },
    },
    "blocked-recoverable": {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.CLOSE.REQUESTED": forbiddenTransition(
          operationMetadata("close", false, "session-registry", "recoverable-work-must-be-retained-or-discarded"),
        ),
        "SESSION.DISCARD.REQUESTED": allowedTransition(
          "discarded",
          operationMetadata("discard", true, "caller", "explicit-discard-required"),
        ),
        "SESSION.DOCTOR.REQUESTED": doctorTransition,
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata("gc", false, "gc", "age-is-not-destructive-authority"),
        ),
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
        "SESSION.MARK_STALE": { target: "stale-inconsistent" },
      },
    },
    discarded: {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.CLOSE.REQUESTED": forbiddenTransition(
          operationMetadata("close", false, "session-registry", "discarded-terminal"),
        ),
        "SESSION.DISCARD.REQUESTED": selfTransition(operationMetadata("discard", true, "caller", "discarded-terminal")),
        "SESSION.DOCTOR.REQUESTED": doctorTransition,
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata("gc", false, "gc", "discarded-terminal", "age-is-not-destructive-authority"),
        ),
      },
    },
    "stale-inconsistent": {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.CLOSE.REQUESTED": forbiddenTransition(
          operationMetadata("close", false, "reconciliation", "physical-reconciliation-required"),
        ),
        "SESSION.DISCARD.REQUESTED": forbiddenTransition(
          operationMetadata("discard", true, "reconciliation", "physical-reconciliation-required"),
        ),
        "SESSION.DOCTOR.REQUESTED": doctorTransition,
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata(
            "gc",
            false,
            "reconciliation",
            "physical-reconciliation-required",
            "age-is-not-destructive-authority",
          ),
        ),
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
      },
    },
    closed: {
      on: {
        "SESSION.OBSERVE": observeTransition,
        "SESSION.CLOSE.REQUESTED": selfTransition(
          operationMetadata("close", false, "session-registry", "closed-terminal"),
        ),
        "SESSION.DISCARD.REQUESTED": forbiddenTransition(
          operationMetadata("discard", true, "session-registry", "closed-terminal"),
        ),
        "SESSION.DOCTOR.REQUESTED": doctorTransition,
        "SESSION.RECONCILE.REQUESTED": reconcileTransition,
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata("gc", false, "gc", "closed-terminal", "age-is-not-destructive-authority"),
        ),
      },
    },
  },
});

/** Alias using the shorter module vocabulary used by internal callers. */
export const sessionMachine = sessionLifecycleMachine;
