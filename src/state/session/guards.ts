import type { SessionLifecycleBlocker, SessionLifecycleObservation } from "../../session-lifecycle-classification.js";

import type { SessionMachineContext } from "./types.js";

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

type BlockerKind = "none" | "recoverable" | "ambiguous";

/**
 * Return the classifier's blocker category without consulting the classifier.
 * This is deliberately kept as machine-local executable guard logic for the
 * shadow phase; the existing classifier remains the production authority.
 */
function blockerKind(blockers: readonly SessionLifecycleBlocker[]): BlockerKind {
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

function hasUnknownBlocker(blockers: readonly SessionLifecycleBlocker[]): boolean {
  return blockers.some(
    (blocker) =>
      !AMBIGUOUS_CODES.has(blocker.code) &&
      !RECOVERABLE_CODES.has(blocker.code) &&
      (blocker.classification === undefined || !KNOWN_BLOCKER_CLASSIFICATIONS.has(blocker.classification)),
  );
}

function hasAmbiguousIntegrationEvidence(context: SessionMachineContext): boolean {
  const integration = context.evidence.integration ?? context.observation.evidence?.integration;
  return integration?.status === "ambiguous" || integration?.status === "unavailable";
}

function observation(context: SessionMachineContext): SessionLifecycleObservation {
  return context.observation;
}

/** True when the observed facts are insufficient or contradictory. */
export function isObservationStaleInconsistent(context: SessionMachineContext): boolean {
  const current = observation(context);
  const blockers = current.blockers ?? [];
  const physicalState = current.physicalState ?? null;
  const closeReadiness = current.closeReadiness ?? "not-evaluated";
  const recoverability = blockerKind(blockers);
  const physicalEvidenceRequired = current.sessionState !== "closed";
  const ambiguousReadiness = closeReadiness === "ambiguous" || (closeReadiness === "blocked" && blockers.length === 0);

  return (
    !KNOWN_SESSION_STATES.has(current.sessionState) ||
    (physicalEvidenceRequired && isStalePhysicalState(physicalState)) ||
    hasUnknownBlocker(blockers) ||
    blockers.some((blocker) => blocker.classification === "stale") ||
    ambiguousReadiness ||
    recoverability === "ambiguous" ||
    hasAmbiguousIntegrationEvidence(context)
  );
}

/** Explicit discard intent is observation data, never an age-derived guess. */
export function hasExplicitDiscardIntent(context: SessionMachineContext): boolean {
  return context.observation.terminalOperation === "discard" || context.persisted.terminalOperation === "discard";
}

export function isObservationDiscarded(context: SessionMachineContext): boolean {
  return hasExplicitDiscardIntent(context);
}

export function isObservationClosed(context: SessionMachineContext): boolean {
  return context.observation.sessionState === "closed";
}

export function isObservationBlockedRecoverable(context: SessionMachineContext): boolean {
  const current = observation(context);
  const recoverability = blockerKind(current.blockers ?? []);
  return recoverability === "recoverable" || current.closeReadiness === "external_evidence_required";
}

export function isObservationCloseReady(context: SessionMachineContext): boolean {
  const current = observation(context);
  return current.phase === "termination" && current.closeReadiness === "ready";
}

/**
 * GC authority is independent evidence. An observation-level value wins over
 * the optional evidence envelope when both are present.
 */
export function hasGcAuthorization(context: SessionMachineContext): boolean {
  const observed = context.observation.gcAuthorized;
  if (observed !== undefined) return observed === true;
  return context.evidence.garbageCollection?.authorized === true;
}

/**
 * Match destructiveCleanupEligible for the close-ready state. Age suspicion
 * alone never grants destructive cleanup, including when a healthy session is
 * old and a caller supplied an otherwise positive GC authorization.
 */
export function isDestructiveGcAllowed(context: SessionMachineContext): boolean {
  const current = observation(context);
  return hasGcAuthorization(context) && !(current.ageSuspicious === true && current.physicalState === "healthy");
}
