/**
 * Canonical, read-only session termination/recovery classification.
 *
 * This module deliberately consumes observations produced by the existing
 * session, ownership, cleanup, and integration-proof authorities. It does
 * not inspect or mutate Git, the registry, a worktree, or a branch itself.
 */

import { classifyObservationBlockers } from "./state/session/guards.js";
import { projectSessionLifecycleMachine, projectSessionLifecycleTransitionTable } from "./state/session/machine.js";
import type { SessionObservationInput } from "./state/session/types.js";

export const SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION = 1 as const;

export type SessionLifecycleState =
  "active" | "close-ready" | "blocked-recoverable" | "discarded" | "stale-inconsistent" | "closed";

export const SESSION_LIFECYCLE_STATES: readonly SessionLifecycleState[] = Object.freeze([
  "active",
  "close-ready",
  "blocked-recoverable",
  "discarded",
  "stale-inconsistent",
  "closed",
]);

export type SessionLifecycleOperation = "close" | "discard" | "inspect" | "doctor" | "reconcile" | "gc";

export type SessionLifecyclePhase = "current" | "termination";

export type SessionLifecycleCloseReadiness =
  "ready" | "blocked" | "ambiguous" | "external_evidence_required" | "not-evaluated";

export type SessionLifecycleBlocker = {
  readonly code: string;
  /** Optional explicit authority hint for callers that already classify errors. */
  readonly classification?: "recoverable" | "ambiguous" | "stale";
};

export interface SessionLifecycleObservation {
  /** Persisted Nawabari session state. Kept structural to avoid an import cycle. */
  readonly sessionState: string;
  /** Existing inspect/cleanup physical-state vocabulary. */
  readonly physicalState?: string;
  /** Existing close/diagnostic proof result, when termination was evaluated. */
  readonly closeReadiness?: SessionLifecycleCloseReadiness;
  readonly blockers?: readonly SessionLifecycleBlocker[];
  /** Explicit persisted discard intent; never inferred from age or provider state. */
  readonly terminalOperation?: "discard";
  /** Age is diagnostic suspicion only and never destructive authority. */
  readonly ageSuspicious?: boolean;
  /** Independent GC authority, if one has already positively established it. */
  readonly gcAuthorized?: boolean;
  readonly phase?: SessionLifecyclePhase;
}

export interface SessionLifecycleTransition {
  readonly operation: SessionLifecycleOperation;
  readonly allowed: boolean;
  /** The state reached by the operation, or null when it cannot proceed. */
  readonly target: SessionLifecycleState | null;
  readonly requiresExplicitIntent: boolean;
  readonly authority: "session-registry" | "reconciliation" | "gc" | "caller";
  readonly reason:
    | "observe"
    | "close-proof-required"
    | "close-authorized"
    | "recoverable-work-must-be-retained-or-discarded"
    | "explicit-discard-required"
    | "physical-reconciliation-required"
    | "already-terminal"
    | "age-is-not-destructive-authority"
    | "discarded-terminal"
    | "closed-terminal";
}

export interface SessionLifecycleClassification {
  readonly schemaVersion: typeof SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION;
  readonly state: SessionLifecycleState;
  readonly sessionState: string;
  readonly physicalState: string | null;
  readonly closeReadiness: SessionLifecycleCloseReadiness;
  readonly blockers: readonly SessionLifecycleBlocker[];
  readonly recoverability: "none" | "recoverable" | "ambiguous";
  readonly ageSuspicious: boolean;
  /** True only when an independent GC authority supplied positive evidence. */
  readonly gcAuthorized: boolean;
  readonly destructiveCleanupEligible: boolean;
  readonly transitions: readonly SessionLifecycleTransition[];
}

function freezeBlocker(blocker: SessionLifecycleBlocker): SessionLifecycleBlocker {
  return Object.freeze({
    code: blocker.code,
    ...(blocker.classification === undefined ? {} : { classification: blocker.classification }),
  });
}

function normalizeObservation(
  observation: SessionLifecycleObservation,
  blockers: readonly SessionLifecycleBlocker[],
): SessionObservationInput {
  return Object.freeze({
    ...observation,
    blockers,
    closeReadiness: observation.closeReadiness ?? "not-evaluated",
    ageSuspicious: observation.ageSuspicious === true,
    gcAuthorized: observation.gcAuthorized === true,
    phase: observation.phase ?? "current",
  });
}

/**
 * Classify one already-observed session. The default `current` phase
 * represents ownership as it exists now; `termination` projects the same
 * evidence after close preflight has been evaluated.
 */
export function classifySessionLifecycle(observation: SessionLifecycleObservation): SessionLifecycleClassification {
  const blockers = Object.freeze((observation.blockers ?? []).map(freezeBlocker));
  const physicalState = observation.physicalState ?? null;
  const closeReadiness = observation.closeReadiness ?? "not-evaluated";
  const recoverability = classifyObservationBlockers(blockers);
  const ageSuspicious = observation.ageSuspicious === true;
  const gcAuthorized = observation.gcAuthorized === true;
  const machineProjection = projectSessionLifecycleMachine({
    observation: normalizeObservation(observation, blockers),
  });
  const transitions = Object.freeze(
    Object.values(machineProjection.transitions).map(({ eventType: _eventType, ...transition }) =>
      Object.freeze(transition),
    ),
  );
  const gcTransition = machineProjection.transitions.gc;
  const destructiveCleanupEligible = gcTransition.allowed;

  return Object.freeze({
    schemaVersion: SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION,
    state: machineProjection.state,
    sessionState: observation.sessionState,
    physicalState,
    closeReadiness,
    blockers,
    recoverability,
    ageSuspicious,
    gcAuthorized,
    destructiveCleanupEligible,
    transitions: Object.freeze(transitions),
  });
}

/** Return one transition without exposing a mutable table to callers. */
export function lifecycleTransition(
  classification: SessionLifecycleClassification,
  operation: SessionLifecycleOperation,
): SessionLifecycleTransition {
  const transition = classification.transitions.find((candidate) => candidate.operation === operation);
  if (transition === undefined) {
    throw new RangeError(`Unsupported lifecycle operation: ${operation}`);
  }
  return transition;
}

/**
 * Return the operation names currently admissible by the canonical machine
 * projection. Consumers use this for discovery/availability only; it does not
 * authorize or execute a mutation.
 */
export function availableLifecycleOperations(
  classification: SessionLifecycleClassification,
): readonly SessionLifecycleOperation[] {
  return Object.freeze(
    classification.transitions.filter((transition) => transition.allowed).map((transition) => transition.operation),
  );
}

/** The complete state/operation table, useful to help/discovery consumers. */
export const SESSION_LIFECYCLE_TRANSITION_TABLE: Readonly<
  Record<SessionLifecycleState, readonly SessionLifecycleTransition[]>
> = projectSessionLifecycleTransitionTable();
