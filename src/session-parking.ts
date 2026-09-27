import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";
import { projectSessionLifecycleEvent, projectSessionParkingTransitionTable } from "./state/session/machine.js";
import type { SessionMachineEvent } from "./state/session/types.js";
import type {
  SessionParkingEvent,
  SessionParkingOperationalState,
  SessionParkingTransitionRow,
} from "./state/session/types.js";
import type {
  SessionLifecycleObservation,
  SessionLifecycleState,
  SessionLifecycleTransition,
} from "./session-lifecycle-classification.js";

export type {
  SessionParkingEvent,
  SessionParkingOperationalState,
  SessionParkingTransitionRow,
} from "./state/session/types.js";

export const SESSION_PARKING_CONTRACT_ID = "nawabari.session-parking.v1" as const;
export const SESSION_PARKING_SCHEMA_VERSION = 1 as const;

export type SessionParkingPersistedState = "active" | "parked";
export type SessionParkingProjectedState = SessionLifecycleState;

export type SessionParkingTransitionInput = Readonly<{
  state: SessionParkingOperationalState;
  observation: SessionLifecycleObservation;
}>;

export type SessionParkingTransition = Readonly<{
  allowed: boolean;
  target: SessionParkingProjectedState | null;
  requiresExplicitIntent: boolean;
  authority: SessionLifecycleTransition["authority"];
  reason: SessionLifecycleTransition["reason"];
}>;

/** Frozen v1 compatibility projection, generated from the canonical XState machine. */
export const SESSION_PARKING_TRANSITION_TABLE: readonly SessionParkingTransitionRow[] =
  projectSessionParkingTransitionTable();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function invalid(message: string): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message));
}

function validOperationalState(value: unknown): value is SessionParkingOperationalState {
  return value === "active" || value === "parking" || value === "parked";
}

function validObservation(value: unknown): value is SessionLifecycleObservation {
  if (!isRecord(value) || typeof value.sessionState !== "string") return false;
  if (value.physicalState !== undefined && typeof value.physicalState !== "string") return false;
  if (
    value.closeReadiness !== undefined &&
    value.closeReadiness !== "ready" &&
    value.closeReadiness !== "blocked" &&
    value.closeReadiness !== "ambiguous" &&
    value.closeReadiness !== "external_evidence_required" &&
    value.closeReadiness !== "not-evaluated"
  ) {
    return false;
  }
  if (value.terminalOperation !== undefined && value.terminalOperation !== "discard") return false;
  if (value.ageSuspicious !== undefined && typeof value.ageSuspicious !== "boolean") return false;
  if (value.gcAuthorized !== undefined && typeof value.gcAuthorized !== "boolean") return false;
  if (value.phase !== undefined && value.phase !== "current" && value.phase !== "termination") return false;
  if (value.blockers !== undefined && !Array.isArray(value.blockers)) return false;
  return (
    value.blockers === undefined ||
    value.blockers.every(
      (blocker) =>
        isRecord(blocker) &&
        typeof blocker.code === "string" &&
        (blocker.classification === undefined ||
          blocker.classification === "recoverable" ||
          blocker.classification === "ambiguous" ||
          blocker.classification === "stale"),
    )
  );
}

function validEvent(value: unknown): value is SessionParkingEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "SESSION.PARK.REQUESTED":
    case "SESSION.CLOSE.REQUESTED":
    case "SESSION.DISCARD.REQUESTED":
    case "SESSION.DOCTOR.REQUESTED":
    case "SESSION.RECONCILE.REQUESTED":
    case "SESSION.GC.REQUESTED":
      return true;
    case "SESSION.PARK.FINALIZE":
      return value.status === "parked" && typeof value.operationId === "string" && value.operationId.trim().length > 0;
    case "SESSION.RESUME.REQUESTED":
      return value.status === "resumed" && typeof value.operationId === "string" && value.operationId.trim().length > 0;
    case "SESSION.OBSERVE":
      return validObservation(value.observation);
    default:
      return false;
  }
}

function machineInput(
  input: SessionParkingTransitionInput,
  event: SessionParkingEvent,
): {
  readonly observation: SessionLifecycleObservation;
  readonly initialOperationalState?: SessionParkingOperationalState;
} {
  if (event.type === "SESSION.OBSERVE") {
    return { observation: event.observation };
  }
  if (input.state === "parking") {
    return { observation: input.observation, initialOperationalState: "parking" };
  }
  if (
    input.state === "parked" &&
    (event.type === "SESSION.PARK.REQUESTED" ||
      event.type === "SESSION.RESUME.REQUESTED" ||
      event.type === "SESSION.PARK.FINALIZE" ||
      event.type === "SESSION.DOCTOR.REQUESTED" ||
      event.type === "SESSION.RECONCILE.REQUESTED")
  ) {
    return { observation: { ...input.observation, sessionState: "parked" } };
  }
  if (input.state === "active" && event.type === "SESSION.PARK.REQUESTED") {
    return { observation: { ...input.observation, sessionState: "active" } };
  }
  return { observation: input.observation };
}

/**
 * Project one legacy v1 request by executing the canonical lifecycle machine.
 * The supplied operational state only seeds the transient compatibility path;
 * all admissibility and result metadata come from the XState definition.
 */
export function projectSessionParkingTransition(
  input: SessionParkingTransitionInput,
  event: SessionParkingEvent,
): DomainResult<SessionParkingTransition> {
  if (!isRecord(input) || !validOperationalState(input.state) || !validObservation(input.observation)) {
    return invalid("Session parking transition input is invalid");
  }
  if (!validEvent(event)) return invalid("Session parking event is invalid");

  try {
    const projectionInput = machineInput(input, event);
    const projection = projectSessionLifecycleEvent(
      { observation: projectionInput.observation },
      event as SessionMachineEvent,
      projectionInput.initialOperationalState,
    );
    return success(
      Object.freeze({
        allowed: projection.allowed,
        target: projection.target,
        requiresExplicitIntent: projection.requiresExplicitIntent,
        authority: projection.authority,
        reason: projection.reason,
      }),
    );
  } catch {
    return invalid("Session parking observation is invalid");
  }
}
