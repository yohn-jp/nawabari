/**
 * Canonical, read-only session termination/recovery classification.
 *
 * This module deliberately consumes observations produced by the existing
 * session, ownership, cleanup, and integration-proof authorities. It does
 * not inspect or mutate Git, the registry, a worktree, or a branch itself.
 */

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

const AMBIGUOUS_CODES = new Set([
  "GIT_STATE_AMBIGUOUS",
  "PHYSICAL_OBSERVATION_UNAVAILABLE",
  "REPOSITORY_IDENTITY_AMBIGUOUS",
  "WORKTREE_IDENTITY_AMBIGUOUS",
  "GIT_COMMAND_FAILED",
  "GIT_SPAWN_FAILED",
  "GIT_TIMEOUT",
  "GIT_OUTPUT_LIMIT",
  "OWNERSHIP_MISMATCH",
  "DUPLICATE_WORKTREE_OWNERSHIP",
  "DUPLICATE_BRANCH_OWNERSHIP",
  "RECONCILIATION_DRIFT",
  "STALE_REGISTRY",
]);

const RECOVERABLE_CODES = new Set([
  "DIRTY_WORKTREE",
  "NESTED_REPOSITORY",
  "RECOVERABLE_COMMITS",
  "RECOVERABLE_STASHES",
  // An explicit bounded integration fetch failed before mutation. The
  // caller may retry the same bounded proof operation; this is not a
  // destructive or ambient fallback.
  "INTEGRATION_FETCH_FAILED",
]);

const STALE_PHYSICAL_STATES = new Set([
  "prunable-missing",
  "prunable-present",
  "registered-missing",
  "unregistered-missing",
  "unregistered-present",
  "invalid",
  "unavailable",
]);

const KNOWN_SESSION_STATES = new Set(["new", "active", "closing", "closed", "stale"]);

const KNOWN_PHYSICAL_STATES = new Set(["healthy", "closed", ...STALE_PHYSICAL_STATES]);

const KNOWN_BLOCKER_CLASSIFICATIONS = new Set(["recoverable", "ambiguous", "stale"]);

function freezeBlocker(blocker: SessionLifecycleBlocker): SessionLifecycleBlocker {
  return Object.freeze({
    code: blocker.code,
    ...(blocker.classification === undefined ? {} : { classification: blocker.classification }),
  });
}

function classifyBlockers(blockers: readonly SessionLifecycleBlocker[]): "none" | "recoverable" | "ambiguous" {
  if (blockers.some((blocker) => blocker.classification === "ambiguous" || AMBIGUOUS_CODES.has(blocker.code))) {
    return "ambiguous";
  }
  if (blockers.some((blocker) => blocker.classification === "recoverable" || RECOVERABLE_CODES.has(blocker.code))) {
    return "recoverable";
  }
  return "none";
}

function isStalePhysicalState(physicalState: string | null): boolean {
  return (
    physicalState === null || !KNOWN_PHYSICAL_STATES.has(physicalState) || STALE_PHYSICAL_STATES.has(physicalState)
  );
}

function freezeTransitions(transitions: readonly SessionLifecycleTransition[]): readonly SessionLifecycleTransition[] {
  return Object.freeze(transitions.map((transition) => Object.freeze({ ...transition })));
}

function transitionTable(state: SessionLifecycleState): readonly SessionLifecycleTransition[] {
  const inspect = (operation: "inspect" | "doctor"): SessionLifecycleTransition => ({
    operation,
    allowed: true,
    target: state,
    requiresExplicitIntent: false,
    authority: operation === "doctor" ? "reconciliation" : "session-registry",
    reason: "observe",
  });
  const reconcile: SessionLifecycleTransition = {
    operation: "reconcile",
    allowed: true,
    target: state,
    requiresExplicitIntent: false,
    authority: "reconciliation",
    reason: "observe",
  };

  switch (state) {
    case "active":
      return freezeTransitions([
        {
          operation: "close",
          allowed: true,
          target: "close-ready",
          requiresExplicitIntent: false,
          authority: "session-registry",
          reason: "close-proof-required",
        },
        {
          operation: "discard",
          allowed: true,
          target: "discarded",
          requiresExplicitIntent: true,
          authority: "caller",
          reason: "explicit-discard-required",
        },
        inspect("inspect"),
        inspect("doctor"),
        reconcile,
        {
          operation: "gc",
          allowed: false,
          target: null,
          requiresExplicitIntent: false,
          authority: "gc",
          reason: "age-is-not-destructive-authority",
        },
      ]);
    case "close-ready":
      return freezeTransitions([
        {
          operation: "close",
          allowed: true,
          target: "closed",
          requiresExplicitIntent: false,
          authority: "session-registry",
          reason: "close-authorized",
        },
        {
          operation: "discard",
          allowed: true,
          target: "discarded",
          requiresExplicitIntent: true,
          authority: "caller",
          reason: "explicit-discard-required",
        },
        inspect("inspect"),
        inspect("doctor"),
        reconcile,
        {
          operation: "gc",
          allowed: true,
          target: "closed",
          requiresExplicitIntent: false,
          authority: "gc",
          reason: "close-authorized",
        },
      ]);
    case "blocked-recoverable":
      return freezeTransitions([
        {
          operation: "close",
          allowed: false,
          target: null,
          requiresExplicitIntent: false,
          authority: "session-registry",
          reason: "recoverable-work-must-be-retained-or-discarded",
        },
        {
          operation: "discard",
          allowed: true,
          target: "discarded",
          requiresExplicitIntent: true,
          authority: "caller",
          reason: "explicit-discard-required",
        },
        inspect("inspect"),
        inspect("doctor"),
        reconcile,
        {
          operation: "gc",
          allowed: false,
          target: null,
          requiresExplicitIntent: false,
          authority: "gc",
          reason: "recoverable-work-must-be-retained-or-discarded",
        },
      ]);
    case "discarded":
      return freezeTransitions([
        {
          operation: "close",
          allowed: false,
          target: null,
          requiresExplicitIntent: false,
          authority: "session-registry",
          reason: "discarded-terminal",
        },
        {
          operation: "discard",
          allowed: true,
          target: "discarded",
          requiresExplicitIntent: true,
          authority: "caller",
          reason: "discarded-terminal",
        },
        inspect("inspect"),
        inspect("doctor"),
        reconcile,
        {
          operation: "gc",
          allowed: false,
          target: null,
          requiresExplicitIntent: false,
          authority: "gc",
          reason: "discarded-terminal",
        },
      ]);
    case "stale-inconsistent":
      return freezeTransitions([
        {
          operation: "close",
          allowed: false,
          target: null,
          requiresExplicitIntent: false,
          authority: "reconciliation",
          reason: "physical-reconciliation-required",
        },
        {
          operation: "discard",
          allowed: false,
          target: null,
          requiresExplicitIntent: true,
          authority: "reconciliation",
          reason: "physical-reconciliation-required",
        },
        inspect("inspect"),
        inspect("doctor"),
        reconcile,
        {
          operation: "gc",
          allowed: false,
          target: null,
          requiresExplicitIntent: false,
          authority: "reconciliation",
          reason: "physical-reconciliation-required",
        },
      ]);
    case "closed":
      return freezeTransitions([
        {
          operation: "close",
          allowed: true,
          target: "closed",
          requiresExplicitIntent: false,
          authority: "session-registry",
          reason: "closed-terminal",
        },
        {
          operation: "discard",
          allowed: false,
          target: null,
          requiresExplicitIntent: true,
          authority: "session-registry",
          reason: "closed-terminal",
        },
        inspect("inspect"),
        inspect("doctor"),
        reconcile,
        {
          operation: "gc",
          allowed: false,
          target: null,
          requiresExplicitIntent: false,
          authority: "gc",
          reason: "closed-terminal",
        },
      ]);
  }
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
  const recoverability = classifyBlockers(blockers);
  const ageSuspicious = observation.ageSuspicious === true;
  const gcAuthorized = observation.gcAuthorized === true;
  const stalePhysical = isStalePhysicalState(physicalState);
  const unknownSessionState = !KNOWN_SESSION_STATES.has(observation.sessionState);
  const unknownBlocker = blockers.some(
    (blocker) =>
      !AMBIGUOUS_CODES.has(blocker.code) &&
      !RECOVERABLE_CODES.has(blocker.code) &&
      (blocker.classification === undefined || !KNOWN_BLOCKER_CLASSIFICATIONS.has(blocker.classification)),
  );
  const staleBlocker = blockers.some((blocker) => blocker.classification === "stale");
  const ambiguousReadiness = closeReadiness === "ambiguous" || (closeReadiness === "blocked" && blockers.length === 0);
  const phase = observation.phase ?? "current";

  let state: SessionLifecycleState;
  const physicalEvidenceRequired = observation.sessionState !== "closed";
  if (
    unknownSessionState ||
    unknownBlocker ||
    staleBlocker ||
    ambiguousReadiness ||
    recoverability === "ambiguous" ||
    (physicalEvidenceRequired && stalePhysical)
  ) {
    state = "stale-inconsistent";
  } else if (observation.sessionState === "closed") {
    state = observation.terminalOperation === "discard" ? "discarded" : "closed";
  } else if (observation.terminalOperation === "discard") {
    state = "discarded";
  } else if (recoverability === "recoverable" || closeReadiness === "external_evidence_required") {
    state = "blocked-recoverable";
  } else if (phase === "termination" && closeReadiness === "ready") {
    state = "close-ready";
  } else {
    state = "active";
  }

  // A positive GC authority must be independent of elapsed age. In
  // particular, old-but-healthy active sessions remain non-destructive.
  const destructiveCleanupEligible =
    gcAuthorized && state === "close-ready" && !(ageSuspicious && physicalState === "healthy");

  const transitions = transitionTable(state).map((transition) =>
    transition.operation === "gc" && (!gcAuthorized || !destructiveCleanupEligible)
      ? Object.freeze({
          ...transition,
          allowed: false,
          target: null,
          reason: "age-is-not-destructive-authority" as const,
        })
      : transition,
  );

  return Object.freeze({
    schemaVersion: SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION,
    state,
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

/** The complete state/operation table, useful to help/discovery consumers. */
export const SESSION_LIFECYCLE_TRANSITION_TABLE: Readonly<
  Record<SessionLifecycleState, readonly SessionLifecycleTransition[]>
> = Object.freeze(
  Object.fromEntries(SESSION_LIFECYCLE_STATES.map((state) => [state, transitionTable(state)])) as Record<
    SessionLifecycleState,
    readonly SessionLifecycleTransition[]
  >,
);
