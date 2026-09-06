import { assign, createActor, setup } from "xstate";

import type { SessionLifecycleOperation, SessionLifecycleState } from "../../session-lifecycle-classification.js";

import {
  projectSessionLifecycleMachine,
  sessionLifecycleMachine,
  type SessionMachineTransitionProjection,
} from "./machine.js";
import { classifyObservationBlockers } from "./guards.js";
import type { SessionMachineEvent, SessionMachineInput } from "./types.js";

/**
 * Internal protocol used by the production Session actor.  The protocol is
 * deliberately capability-shaped; CLI command names and physical authorities
 * do not belong in this module.
 */
export const SESSION_ACTOR_EVENT_TYPES = Object.freeze([
  "SESSION.REQUESTED",
  "SESSION.OBSERVED",
  "SESSION.TRANSITION.EVALUATED",
  "SESSION.EFFECT.COMPLETED",
  "SESSION.EFFECT.FAILED",
  "SESSION.REOBSERVED",
  "SESSION.REOBSERVATION.FAILED",
  "SESSION.RECONCILED",
  "SESSION.FINALIZED",
] as const);

export const SESSION_ACTOR_SCHEMA_VERSION = 1 as const;

export type SessionActorOperation = Extract<SessionLifecycleOperation, "close" | "discard" | "reconcile" | "gc">;

export type SessionActorPhase = "completed" | "rejected" | "retryable" | "unresolved";

export type SessionActorReconciliationOutcome = "completed" | "retryable" | "unresolved";

/** Bounded, identity-neutral recovery evidence supplied by an existing adapter. */
export interface SessionActorReconciliation {
  readonly outcome: SessionActorReconciliationOutcome;
  readonly retrySafe: boolean;
  readonly reason?: string;
}

/**
 * A transition decision returned by the canonical lifecycle machine.  Retry
 * decisions use the machine's cleanup-retry event while retaining the same
 * public operational state vocabulary.
 */
export interface SessionActorDecision {
  readonly operation: SessionActorOperation;
  readonly eventType: string;
  readonly allowed: boolean;
  readonly target: SessionLifecycleState | null;
  readonly requiresExplicitIntent: boolean;
  readonly authority: "session-registry" | "reconciliation" | "gc" | "caller";
  readonly reason: string;
  readonly mode: "request" | "retry";
}

export interface SessionActorAdapter<TResult> {
  /** Observe an authoritative input before and after the bounded effect. */
  readonly observe: (stage: "before" | "after") => SessionMachineInput;
  /**
   * Positive identity-bound authority for retrying a partial cleanup.  A
   * retry must never be inferred from an operational state alone.
   */
  readonly retryAuthorized?: (input: SessionMachineInput) => boolean;
  /** Execute exactly one bounded effect through the existing authority. */
  readonly effect: (decision: SessionActorDecision) => TResult;
  /** Reconcile an effect failure using the existing authoritative observer. */
  readonly reconcile?: (
    error: unknown,
    after: SessionMachineInput | undefined,
    decision: SessionActorDecision,
  ) => SessionActorReconciliation;
}

export interface SessionActorRequest<TResult> {
  readonly operation: SessionActorOperation;
  /** A retry is only valid after the adapter has positively re-observed ownership. */
  readonly retry?: boolean;
  readonly adapter: SessionActorAdapter<TResult>;
}

export interface SessionActorResult<TResult> {
  readonly schemaVersion: typeof SESSION_ACTOR_SCHEMA_VERSION;
  readonly operation: SessionActorOperation;
  readonly phase: SessionActorPhase;
  readonly decision: SessionActorDecision;
  readonly before: SessionMachineInput;
  readonly after?: SessionMachineInput;
  readonly value?: TResult;
  readonly error?: unknown;
  readonly reconciliation?: SessionActorReconciliation;
}

interface SessionActorContext<TResult> {
  readonly operation: SessionActorOperation;
  readonly retry: boolean;
  readonly before?: SessionMachineInput;
  readonly after?: SessionMachineInput;
  readonly decision?: SessionActorDecision;
  readonly value?: TResult;
  readonly error?: unknown;
  readonly reconciliation?: SessionActorReconciliation;
}

type SessionActorEvent<TResult> =
  | { readonly type: "SESSION.REQUESTED" }
  | { readonly type: "SESSION.OBSERVED"; readonly observation: SessionMachineInput }
  | { readonly type: "SESSION.TRANSITION.EVALUATED"; readonly decision: SessionActorDecision }
  | { readonly type: "SESSION.EFFECT.COMPLETED"; readonly value: TResult }
  | { readonly type: "SESSION.EFFECT.FAILED"; readonly error: unknown }
  | { readonly type: "SESSION.REOBSERVED"; readonly observation: SessionMachineInput }
  | { readonly type: "SESSION.REOBSERVATION.FAILED"; readonly error: unknown }
  | { readonly type: "SESSION.RECONCILED"; readonly reconciliation: SessionActorReconciliation }
  | { readonly type: "SESSION.FINALIZED" };

const actorSetup = setup({
  types: {
    context: {} as SessionActorContext<unknown>,
    events: {} as SessionActorEvent<unknown>,
    input: {} as Pick<SessionActorContext<unknown>, "operation" | "retry">,
  },
  actions: {
    rememberObservation: assign({
      before: ({ event }) => (event.type === "SESSION.OBSERVED" ? event.observation : undefined),
    }),
    rememberAfterObservation: assign({
      after: ({ event }) => (event.type === "SESSION.REOBSERVED" ? event.observation : undefined),
    }),
    rememberDecision: assign({
      decision: ({ event }) => (event.type === "SESSION.TRANSITION.EVALUATED" ? event.decision : undefined),
    }),
    rememberValue: assign({
      value: ({ event }) => (event.type === "SESSION.EFFECT.COMPLETED" ? event.value : undefined),
    }),
    rememberError: assign({
      error: ({ event }) =>
        event.type === "SESSION.EFFECT.FAILED" || event.type === "SESSION.REOBSERVATION.FAILED"
          ? event.error
          : undefined,
    }),
    rememberReconciliation: assign({
      reconciliation: ({ event }) => (event.type === "SESSION.RECONCILED" ? event.reconciliation : undefined),
    }),
  },
  guards: {
    decisionAllowed: ({ event }) => event.type === "SESSION.TRANSITION.EVALUATED" && event.decision.allowed,
    reconciliationCompleted: ({ event }) =>
      event.type === "SESSION.RECONCILED" && event.reconciliation.outcome === "completed",
    reconciliationRetryable: ({ event }) =>
      event.type === "SESSION.RECONCILED" && event.reconciliation.outcome === "retryable",
  },
});

/**
 * Protocol state machine for one lifecycle operation.  It owns sequencing and
 * retry/reconciliation semantics only; it has no mutation or observation
 * capability of its own.
 */
const sessionActorMachine = actorSetup.createMachine({
  id: "session-actor",
  initial: "idle",
  context: ({ input }) => ({ operation: input.operation, retry: input.retry }),
  states: {
    idle: {
      on: { "SESSION.REQUESTED": "observing" },
    },
    observing: {
      on: {
        "SESSION.OBSERVED": { target: "evaluating", actions: "rememberObservation" },
      },
    },
    evaluating: {
      on: {
        "SESSION.TRANSITION.EVALUATED": [
          { target: "executing", guard: "decisionAllowed", actions: "rememberDecision" },
          { target: "rejected", actions: "rememberDecision" },
        ],
      },
    },
    executing: {
      on: {
        "SESSION.EFFECT.COMPLETED": { target: "reobserving", actions: "rememberValue" },
        "SESSION.EFFECT.FAILED": { target: "reconciling", actions: "rememberError" },
      },
    },
    reobserving: {
      on: {
        "SESSION.REOBSERVED": { target: "finalizing", actions: "rememberAfterObservation" },
        "SESSION.REOBSERVATION.FAILED": { target: "reconciling", actions: "rememberError" },
      },
    },
    reconciling: {
      on: {
        "SESSION.RECONCILED": [
          { target: "completed", guard: "reconciliationCompleted", actions: "rememberReconciliation" },
          { target: "retryable", guard: "reconciliationRetryable", actions: "rememberReconciliation" },
          { target: "unresolved", actions: "rememberReconciliation" },
        ],
      },
    },
    finalizing: {
      on: { "SESSION.FINALIZED": "completed" },
    },
    completed: {},
    rejected: {},
    retryable: {},
    unresolved: {},
  },
});

function stateValue(
  value: unknown,
):
  SessionActorPhase | "idle" | "observing" | "evaluating" | "executing" | "reobserving" | "reconciling" | "finalizing" {
  if (typeof value !== "string") throw new Error(`Session actor exposed an invalid state: ${String(value)}`);
  return value as ReturnType<typeof stateValue>;
}

function operationalState(input: SessionMachineInput): SessionLifecycleState {
  const projection = projectSessionLifecycleMachine(input);
  return projection.state;
}

function retryDecision(
  input: SessionMachineInput,
  operation: SessionActorOperation,
  retryAuthorized: boolean,
): SessionActorDecision {
  const actor = createActor(sessionLifecycleMachine, { input }).start();
  const event: SessionMachineEvent = { type: "SESSION.CLEANUP.RETRY" };
  const blockers = input.observation.blockers ?? [];
  const unambiguous =
    input.observation.closeReadiness !== "ambiguous" &&
    classifyObservationBlockers(blockers) !== "ambiguous" &&
    !blockers.some((blocker) => blocker.classification === "stale");
  const allowed = actor.getSnapshot().can(event) && retryAuthorized && unambiguous;
  const state = operationalState(input);
  actor.stop();
  return {
    operation,
    eventType: event.type,
    allowed,
    target: allowed ? state : null,
    requiresExplicitIntent: operation === "discard",
    authority: "reconciliation",
    reason: allowed ? "cleanup-retry" : "physical-reconciliation-required",
    mode: "retry",
  };
}

function requestDecision(input: SessionMachineInput, operation: SessionActorOperation): SessionActorDecision {
  const transition: SessionMachineTransitionProjection = projectSessionLifecycleMachine(input).transitions[
    operation
  ] as SessionMachineTransitionProjection;
  return { ...transition, operation, mode: "request" };
}

function decisionFor(
  input: SessionMachineInput,
  operation: SessionActorOperation,
  retry: boolean,
  retryAuthorized: boolean,
): SessionActorDecision {
  return retry ? retryDecision(input, operation, retryAuthorized) : requestDecision(input, operation);
}

function reconciliationFor<TResult>(
  request: SessionActorRequest<TResult>,
  error: unknown,
  after: SessionMachineInput | undefined,
  decision: SessionActorDecision,
): SessionActorReconciliation {
  return (
    request.adapter.reconcile?.(error, after, decision) ?? {
      outcome: "unresolved",
      retrySafe: false,
      reason: "reconciliation-unavailable",
    }
  );
}

/**
 * Execute one lifecycle request through the Session actor protocol.  The
 * caller supplies all observations and effects through an adapter, keeping
 * Git/filesystem/registry authorities outside this state module.
 */
export function executeSessionLifecycleActor<TResult>(
  request: SessionActorRequest<TResult>,
): SessionActorResult<TResult> {
  const actor = createActor(sessionActorMachine, {
    input: { operation: request.operation, retry: request.retry === true },
  }).start();
  actor.send({ type: "SESSION.REQUESTED" });

  const before = request.adapter.observe("before");
  actor.send({ type: "SESSION.OBSERVED", observation: before });
  const decision = decisionFor(
    before,
    request.operation,
    request.retry === true,
    request.retry !== true || request.adapter.retryAuthorized?.(before) === true,
  );
  actor.send({ type: "SESSION.TRANSITION.EVALUATED", decision });

  if (!decision.allowed) {
    const snapshot = actor.getSnapshot();
    actor.stop();
    if (stateValue(snapshot.value) !== "rejected") {
      throw new Error("Session actor failed to reject a forbidden lifecycle transition");
    }
    return Object.freeze({
      schemaVersion: SESSION_ACTOR_SCHEMA_VERSION,
      operation: request.operation,
      phase: "rejected",
      decision,
      before,
    });
  }

  let value: TResult | undefined;
  try {
    value = request.adapter.effect(decision);
    actor.send({ type: "SESSION.EFFECT.COMPLETED", value });
  } catch (error: unknown) {
    actor.send({ type: "SESSION.EFFECT.FAILED", error });
    let after: SessionMachineInput | undefined;
    try {
      after = request.adapter.observe("after");
    } catch {
      after = undefined;
    }
    const reconciliation = reconciliationFor(request, error, after, decision);
    actor.send({ type: "SESSION.RECONCILED", reconciliation });
    const snapshot = actor.getSnapshot();
    const phase = stateValue(snapshot.value);
    actor.stop();
    if (phase !== "completed" && phase !== "retryable" && phase !== "unresolved") {
      throw new Error("Session actor failed to classify an effect failure");
    }
    return Object.freeze({
      schemaVersion: SESSION_ACTOR_SCHEMA_VERSION,
      operation: request.operation,
      phase,
      decision,
      before,
      ...(after === undefined ? {} : { after }),
      error,
      reconciliation,
    });
  }

  let after: SessionMachineInput;
  try {
    after = request.adapter.observe("after");
    actor.send({ type: "SESSION.REOBSERVED", observation: after });
    actor.send({ type: "SESSION.FINALIZED" });
  } catch (error: unknown) {
    actor.send({ type: "SESSION.REOBSERVATION.FAILED", error });
    const reconciliation = reconciliationFor(request, error, undefined, decision);
    actor.send({ type: "SESSION.RECONCILED", reconciliation });
    const snapshot = actor.getSnapshot();
    const phase = stateValue(snapshot.value);
    actor.stop();
    if (phase !== "completed" && phase !== "retryable" && phase !== "unresolved") {
      throw new Error("Session actor failed to classify a re-observation failure");
    }
    return Object.freeze({
      schemaVersion: SESSION_ACTOR_SCHEMA_VERSION,
      operation: request.operation,
      phase,
      decision,
      before,
      error,
      reconciliation,
    });
  }

  const snapshot = actor.getSnapshot();
  actor.stop();
  if (stateValue(snapshot.value) !== "completed") {
    throw new Error("Session actor failed to finalize a completed lifecycle transition");
  }
  return Object.freeze({
    schemaVersion: SESSION_ACTOR_SCHEMA_VERSION,
    operation: request.operation,
    phase: "completed",
    decision,
    before,
    after,
    value,
  });
}

/** Alias used by callers that describe the actor as a coordinator. */
export const coordinateSessionLifecycle = executeSessionLifecycleActor;
