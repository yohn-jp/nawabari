/**
 * Immutable, test-only oracle for session lifecycle classification.
 *
 * This is a frozen copy of the pre-XState classification logic exactly as it
 * stood at the #252 parity-gate baseline (before #253 routed
 * `classifySessionLifecycle` through the XState projection). It exists
 * solely so the parity suite compares the XState projection against an
 * independent semantic authority instead of comparing the machine to itself.
 *
 * Do not import this from production code, and do not "fix" it to match new
 * XState behavior — a mismatch here means the machine drifted, not that this
 * oracle is wrong. If a deliberate semantic change is required, update this
 * file and the fixed expectations in the same change, with explicit review.
 *
 * Known intentional delta from the raw #252 baseline: blocked-recoverable's
 * GC-forbidden reason is `recoverable-work-must-be-retained-or-discarded`,
 * not the generic `age-is-not-destructive-authority` the original #252
 * implementation emitted for every GC rejection regardless of cause. That
 * blanket rewrite was a #252 bug — canonicalized to the state-specific
 * reason here per explicit review decision on #263.
 */

import type {
  SessionLifecycleBlocker,
  SessionLifecycleCloseReadiness,
  SessionLifecycleObservation,
  SessionLifecycleTransition,
} from "../session-lifecycle-classification.js";
import { SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION } from "../session-lifecycle-classification.js";

type LegacyLifecycleState =
  "active" | "close-ready" | "blocked-recoverable" | "discarded" | "stale-inconsistent" | "closed";
type LegacyLifecycleOperation = "close" | "discard" | "inspect" | "doctor" | "reconcile" | "gc";
type LegacyLifecycleTransition = Omit<SessionLifecycleTransition, "operation" | "target"> & {
  readonly operation: LegacyLifecycleOperation;
  readonly target: LegacyLifecycleState | null;
};
type LegacyLifecycleClassification = {
  readonly schemaVersion: typeof SESSION_LIFECYCLE_CLASSIFICATION_SCHEMA_VERSION;
  readonly state: LegacyLifecycleState;
  readonly sessionState: string;
  readonly physicalState: string | null;
  readonly closeReadiness: SessionLifecycleCloseReadiness;
  readonly blockers: readonly SessionLifecycleBlocker[];
  readonly recoverability: "none" | "recoverable" | "ambiguous";
  readonly ageSuspicious: boolean;
  readonly gcAuthorized: boolean;
  readonly destructiveCleanupEligible: boolean;
  readonly transitions: readonly LegacyLifecycleTransition[];
};

const LEGACY_LIFECYCLE_STATES: readonly LegacyLifecycleState[] = [
  "active",
  "close-ready",
  "blocked-recoverable",
  "discarded",
  "stale-inconsistent",
  "closed",
];

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

function freezeTransitions(transitions: readonly LegacyLifecycleTransition[]): readonly LegacyLifecycleTransition[] {
  return Object.freeze(transitions.map((transition) => Object.freeze({ ...transition })));
}

function transitionTable(state: LegacyLifecycleState): readonly LegacyLifecycleTransition[] {
  const inspect = (operation: "inspect" | "doctor"): LegacyLifecycleTransition => ({
    operation,
    allowed: true,
    target: state,
    requiresExplicitIntent: false,
    authority: operation === "doctor" ? "reconciliation" : "session-registry",
    reason: "observe",
  });
  const reconcile: LegacyLifecycleTransition = {
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
 * Classify one already-observed session using the frozen #252-baseline
 * semantics. Test-only: production classification lives in
 * `classifySessionLifecycle` and must never call back into this file.
 */
export function classifySessionLifecycleLegacyOracle(
  observation: SessionLifecycleObservation,
): LegacyLifecycleClassification {
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

  let state: LegacyLifecycleState;
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

  // The generic "age-is-not-destructive-authority" reason applies only when
  // GC authorization itself is the missing/insufficient authority (active,
  // close-ready without independent authorization or with age-suspicion on
  // an otherwise-healthy session). For blocked-recoverable, GC is refused
  // because recoverable work must be retained or discarded, independent of
  // GC authorization — that state-specific reason is canonical here, matching
  // the intentional #253 correction.
  const transitions = transitionTable(state).map((transition) =>
    transition.operation === "gc" && state !== "blocked-recoverable" && (!gcAuthorized || !destructiveCleanupEligible)
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
export function legacyOracleTransition(
  classification: LegacyLifecycleClassification,
  operation: LegacyLifecycleOperation,
): LegacyLifecycleTransition {
  const transition = classification.transitions.find((candidate) => candidate.operation === operation);
  if (transition === undefined) {
    throw new RangeError(`Unsupported lifecycle operation: ${operation}`);
  }
  return transition;
}

/** The complete #252-baseline state/operation table, for fixture authoring. */
export const SESSION_LIFECYCLE_LEGACY_ORACLE_TRANSITION_TABLE: Readonly<
  Record<LegacyLifecycleState, readonly LegacyLifecycleTransition[]>
> = Object.freeze(
  Object.fromEntries(LEGACY_LIFECYCLE_STATES.map((state) => [state, transitionTable(state)])) as Record<
    LegacyLifecycleState,
    readonly LegacyLifecycleTransition[]
  >,
);
