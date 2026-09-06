import { assign, createActor, setup } from "xstate";

import type {
  SessionLifecycleOperation,
  SessionLifecycleState,
  SessionLifecycleTransition,
} from "../../session-lifecycle-classification.js";

import {
  isDestructiveGcAllowed,
  isObservationBlockedRecoverable,
  isObservationCloseReady,
  isObservationClosed,
  isObservationDiscarded,
  isObservationStaleInconsistent,
} from "./guards.js";
import type { SessionMachineContext, SessionMachineEvent, SessionMachineInput } from "./types.js";

/**
 * Canonical semantic metadata retained on every modeled operation transition.
 * `allowed` is the transition definition's default capability; runtime
 * admissibility is always the XState snapshot/guard result.  A guarded
 * transition may therefore be defined as allowed and still be rejected by a
 * pure guard (for example GC without independent authorization).
 */
export type SessionMachineTransitionMetadata = Pick<
  SessionLifecycleTransition,
  "operation" | "allowed" | "target" | "requiresExplicitIntent" | "authority" | "reason"
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
    allowed: true,
    target: null,
    requiresExplicitIntent: false,
    authority: "session-registry",
    reason: "observe",
  },
} as const;

function operationMetadata(
  operation: SessionLifecycleOperation,
  allowed: boolean,
  target: SessionLifecycleState | null,
  requiresExplicitIntent: boolean,
  authority: SessionMachineTransitionMetadata["authority"],
  reason: SessionMachineTransitionMetadata["reason"],
  forbiddenReason?: SessionMachineTransitionMetadata["forbiddenReason"],
): SessionMachineTransitionMetadata {
  return {
    operation,
    allowed,
    target,
    requiresExplicitIntent,
    authority,
    reason,
    ...(forbiddenReason === undefined ? {} : { forbiddenReason }),
  };
}

function allowedTransition(target: SessionLifecycleState, meta: SessionMachineTransitionMetadata) {
  return { target, meta } as const;
}

function selfTransition(meta: SessionMachineTransitionMetadata) {
  return { target: ".", meta } as const;
}

function forbiddenTransition(meta: SessionMachineTransitionMetadata) {
  return { target: ".", guard: "operationIsForbidden", meta } as const;
}

const cleanupRetryTransition = {} as const;
const cleanupFinalizeTransition = {} as const;

function observationTransitions(state: SessionLifecycleState) {
  return {
    "SESSION.OBSERVE": observeTransition,
    "SESSION.DOCTOR.REQUESTED": selfTransition(
      operationMetadata("doctor", true, state, false, "reconciliation", "observe"),
    ),
    "SESSION.RECONCILE.REQUESTED": selfTransition(
      operationMetadata("reconcile", true, state, false, "reconciliation", "observe"),
    ),
  } as const;
}

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
 * Executable authority for the derived operational session lifecycle.
 *
 * The `classify` node is an internal routing node. It is never part of the
 * operational vocabulary and exists only to evaluate a newly supplied,
 * already-authoritative observation through the machine's own guards.
 */
export const sessionLifecycleMachine = machineSetup.createMachine({
  id: "session-lifecycle",
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
        ...observationTransitions("active"),
        "SESSION.CLOSE.REQUESTED": allowedTransition(
          "close-ready",
          operationMetadata("close", true, "close-ready", false, "session-registry", "close-proof-required"),
        ),
        "SESSION.DISCARD.REQUESTED": allowedTransition(
          "discarded",
          operationMetadata("discard", true, "discarded", true, "caller", "explicit-discard-required"),
        ),
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata("gc", false, null, false, "gc", "age-is-not-destructive-authority"),
        ),
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
        "SESSION.MARK_STALE": { target: "stale-inconsistent" },
      },
    },
    "close-ready": {
      on: {
        ...observationTransitions("close-ready"),
        "SESSION.CLOSE.REQUESTED": allowedTransition(
          "closed",
          operationMetadata("close", true, "closed", false, "session-registry", "close-authorized"),
        ),
        "SESSION.DISCARD.REQUESTED": allowedTransition(
          "discarded",
          operationMetadata("discard", true, "discarded", true, "caller", "explicit-discard-required"),
        ),
        "SESSION.GC.REQUESTED": {
          target: "closed",
          guard: "destructiveGcIsAllowed",
          meta: operationMetadata(
            "gc",
            true,
            "closed",
            false,
            "gc",
            "close-authorized",
            "age-is-not-destructive-authority",
          ),
        },
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
        "SESSION.MARK_STALE": { target: "stale-inconsistent" },
      },
    },
    "blocked-recoverable": {
      on: {
        ...observationTransitions("blocked-recoverable"),
        "SESSION.CLOSE.REQUESTED": forbiddenTransition(
          operationMetadata(
            "close",
            false,
            null,
            false,
            "session-registry",
            "recoverable-work-must-be-retained-or-discarded",
          ),
        ),
        "SESSION.DISCARD.REQUESTED": allowedTransition(
          "discarded",
          operationMetadata("discard", true, "discarded", true, "caller", "explicit-discard-required"),
        ),
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata(
            "gc",
            false,
            null,
            false,
            "gc",
            "recoverable-work-must-be-retained-or-discarded",
            "age-is-not-destructive-authority",
          ),
        ),
        "SESSION.CLEANUP.RETRY": cleanupRetryTransition,
        "SESSION.CLEANUP.FINALIZE": cleanupFinalizeTransition,
        "SESSION.MARK_STALE": { target: "stale-inconsistent" },
      },
    },
    discarded: {
      on: {
        ...observationTransitions("discarded"),
        "SESSION.CLOSE.REQUESTED": forbiddenTransition(
          operationMetadata("close", false, null, false, "session-registry", "discarded-terminal"),
        ),
        "SESSION.DISCARD.REQUESTED": selfTransition(
          operationMetadata("discard", true, "discarded", true, "caller", "discarded-terminal"),
        ),
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata("gc", false, null, false, "gc", "discarded-terminal", "age-is-not-destructive-authority"),
        ),
      },
    },
    "stale-inconsistent": {
      on: {
        ...observationTransitions("stale-inconsistent"),
        "SESSION.CLOSE.REQUESTED": forbiddenTransition(
          operationMetadata("close", false, null, false, "reconciliation", "physical-reconciliation-required"),
        ),
        "SESSION.DISCARD.REQUESTED": forbiddenTransition(
          operationMetadata("discard", false, null, true, "reconciliation", "physical-reconciliation-required"),
        ),
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata(
            "gc",
            false,
            null,
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
        ...observationTransitions("closed"),
        "SESSION.CLOSE.REQUESTED": selfTransition(
          operationMetadata("close", true, "closed", false, "session-registry", "closed-terminal"),
        ),
        "SESSION.DISCARD.REQUESTED": forbiddenTransition(
          operationMetadata("discard", false, null, true, "session-registry", "closed-terminal"),
        ),
        "SESSION.GC.REQUESTED": forbiddenTransition(
          operationMetadata("gc", false, null, false, "gc", "closed-terminal", "age-is-not-destructive-authority"),
        ),
      },
    },
  },
});

/** Alias using the shorter module vocabulary used by internal callers. */
export const sessionMachine = sessionLifecycleMachine;

export type SessionMachineTransitionProjection = Pick<
  SessionLifecycleTransition,
  "operation" | "allowed" | "target" | "requiresExplicitIntent" | "authority" | "reason"
> & {
  readonly eventType: string;
};

export interface SessionMachineProjection {
  readonly state: SessionLifecycleState;
  readonly transitions: Readonly<Record<SessionLifecycleOperation, SessionMachineTransitionProjection>>;
}

type TransitionDefinition = {
  readonly target?: readonly { readonly key: string }[];
  readonly meta?: unknown;
};

function operationalState(value: unknown): SessionLifecycleState {
  if (typeof value !== "string" || value === "classify") {
    throw new Error(`Session lifecycle machine exposed an invalid operational state: ${String(value)}`);
  }
  return value as SessionLifecycleState;
}

function transitionMetadata(value: unknown): SessionMachineTransitionMetadata {
  if (typeof value !== "object" || value === null) {
    throw new Error("Session lifecycle machine transition is missing semantic metadata");
  }
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.operation !== "string" ||
    typeof candidate.allowed !== "boolean" ||
    (candidate.target !== null && typeof candidate.target !== "string") ||
    typeof candidate.requiresExplicitIntent !== "boolean" ||
    typeof candidate.authority !== "string" ||
    typeof candidate.reason !== "string"
  ) {
    throw new Error("Session lifecycle machine transition has incomplete semantic metadata");
  }
  return value as SessionMachineTransitionMetadata;
}

function eventFor(input: SessionMachineInput, operation: SessionLifecycleOperation): SessionMachineEvent {
  switch (operation) {
    case "inspect":
      return {
        type: "SESSION.OBSERVE",
        observation: input.observation,
        ...(input.evidence === undefined ? {} : { evidence: input.evidence }),
      };
    case "close":
      return { type: "SESSION.CLOSE.REQUESTED" };
    case "discard":
      return { type: "SESSION.DISCARD.REQUESTED" };
    case "doctor":
      return { type: "SESSION.DOCTOR.REQUESTED" };
    case "reconcile":
      return { type: "SESSION.RECONCILE.REQUESTED" };
    case "gc":
      return { type: "SESSION.GC.REQUESTED" };
  }
}

function transitionDefinitions(state: SessionLifecycleState, eventType: string): readonly TransitionDefinition[] {
  const stateNode = sessionLifecycleMachine.getStateNodeById(`${sessionLifecycleMachine.id}.${state}`);
  return (stateNode.transitions.get(eventType) ?? []) as readonly TransitionDefinition[];
}

function projectMachineTransition(
  input: SessionMachineInput,
  initialState: SessionLifecycleState,
  operation: SessionLifecycleOperation,
): SessionMachineTransitionProjection {
  const actor = createActor(sessionLifecycleMachine, { input }).start();
  const initial = actor.getSnapshot();
  const event = eventFor(input, operation);
  const definitions = transitionDefinitions(initialState, event.type);
  const accepted = initial.can(event);
  const enabledDefinitions = sessionLifecycleMachine.getTransitionData(
    initial,
    event,
  ) as readonly TransitionDefinition[];
  const definition = (accepted ? enabledDefinitions[0] : definitions[0]) as TransitionDefinition | undefined;
  const metadata = transitionMetadata(definition?.meta);

  if (accepted) actor.send(event);
  const target = accepted ? operationalState(actor.getSnapshot().value) : null;
  actor.stop();

  return Object.freeze({
    operation,
    eventType: event.type,
    allowed: accepted,
    target,
    requiresExplicitIntent: metadata.requiresExplicitIntent,
    authority: metadata.authority,
    reason: accepted ? metadata.reason : (metadata.forbiddenReason ?? metadata.reason),
  });
}

/**
 * Project one already-authoritative observation through the executable
 * machine.  No external authority is consulted here; guards only evaluate
 * the input snapshot supplied by the caller.
 */
export function projectSessionLifecycleMachine(input: SessionMachineInput): SessionMachineProjection {
  const actor = createActor(sessionLifecycleMachine, { input }).start();
  const state = operationalState(actor.getSnapshot().value);
  actor.stop();

  const transitions = Object.fromEntries(
    (Object.keys(SESSION_OPERATION_EVENT_TYPES) as SessionLifecycleOperation[]).map((operation) => [
      operation,
      projectMachineTransition(input, state, operation),
    ]),
  ) as Record<SessionLifecycleOperation, SessionMachineTransitionProjection>;

  return Object.freeze({
    state,
    transitions: Object.freeze(transitions),
  });
}

/** Generate the compatibility table directly from machine transition metadata. */
export function projectSessionLifecycleTransitionTable(): Readonly<
  Record<SessionLifecycleState, readonly SessionLifecycleTransition[]>
> {
  const table = Object.fromEntries(
    (Object.keys(sessionLifecycleMachine.states) as SessionLifecycleState[])
      .filter((state) => state !== ("classify" as SessionLifecycleState))
      .map((state) => {
        const transitions = (Object.keys(SESSION_OPERATION_EVENT_TYPES) as SessionLifecycleOperation[]).map(
          (operation) => {
            const eventType = SESSION_OPERATION_EVENT_TYPES[operation];
            const metadata = transitionMetadata(transitionDefinitions(state, eventType)[0]?.meta);
            return Object.freeze({
              operation,
              allowed: metadata.allowed,
              target: metadata.allowed ? (metadata.target ?? state) : null,
              requiresExplicitIntent: metadata.requiresExplicitIntent,
              authority: metadata.authority,
              reason: metadata.reason,
            });
          },
        );
        return [state, Object.freeze(transitions)];
      }),
  ) as Record<SessionLifecycleState, readonly SessionLifecycleTransition[]>;
  return Object.freeze(table);
}
