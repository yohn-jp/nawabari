import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";
import {
  classifySessionLifecycle,
  lifecycleTransition,
  type SessionLifecycleObservation,
  type SessionLifecycleOperation,
  type SessionLifecycleState,
  type SessionLifecycleTransition,
} from "./session-lifecycle-classification.js";

export const SESSION_PARKING_CONTRACT_ID = "nawabari.session-parking.v1" as const;
export const SESSION_PARKING_SCHEMA_VERSION = 1 as const;

export type SessionParkingPersistedState = "active" | "parked";
export type SessionParkingOperationalState = "active" | "parking" | "parked";

export type SessionParkingEvent =
  | { readonly type: "SESSION.PARK.REQUESTED" }
  | { readonly type: "SESSION.PARK.FINALIZE"; readonly status: "parked"; readonly operationId: string }
  | { readonly type: "SESSION.RESUME.REQUESTED"; readonly status: "resumed"; readonly operationId: string }
  | { readonly type: "SESSION.OBSERVE"; readonly observation: SessionLifecycleObservation }
  | { readonly type: "SESSION.CLOSE.REQUESTED" }
  | { readonly type: "SESSION.DISCARD.REQUESTED" }
  | { readonly type: "SESSION.DOCTOR.REQUESTED" }
  | { readonly type: "SESSION.RECONCILE.REQUESTED" }
  | { readonly type: "SESSION.GC.REQUESTED" };

export type SessionParkingTransitionInput = Readonly<{
  state: SessionParkingOperationalState;
  observation: SessionLifecycleObservation;
}>;

export type SessionParkingProjectedState = SessionLifecycleState | "parking" | "parked";

export type SessionParkingTransition = Readonly<{
  allowed: boolean;
  target: SessionParkingProjectedState | null;
  requiresExplicitIntent: boolean;
  authority: "caller" | "session-registry" | "reconciliation" | "gc";
  reason:
    | SessionLifecycleTransition["reason"]
    | "park-requested"
    | "parked"
    | "resume-authorized"
    | "parking-in-progress"
    | "session-not-parked";
}>;

export type SessionParkingTransitionRow = Readonly<{
  source: SessionParkingOperationalState;
  event: SessionParkingEvent["type"];
  guarded: boolean;
  allowed: boolean | null;
  target: SessionParkingProjectedState | null;
  requiresExplicitIntent: boolean;
  authority: SessionParkingTransition["authority"];
  reason: SessionParkingTransition["reason"];
}>;

const OBSERVE_ROW = {
  guarded: true,
  allowed: null,
  target: null,
  requiresExplicitIntent: false,
  authority: "session-registry",
  reason: "observe",
} as const;

const LIFECYCLE_GUARDS = {
  close: {
    guarded: true,
    allowed: null,
    target: null,
    requiresExplicitIntent: false,
    authority: "session-registry",
    reason: "close-proof-required",
  },
  discard: {
    guarded: true,
    allowed: null,
    target: null,
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "explicit-discard-required",
  },
  gc: {
    guarded: true,
    allowed: null,
    target: null,
    requiresExplicitIntent: false,
    authority: "gc",
    reason: "age-is-not-destructive-authority",
  },
} as const satisfies Record<"close" | "discard" | "gc", Omit<SessionParkingTransitionRow, "source" | "event">>;

function row(
  source: SessionParkingOperationalState,
  event: SessionParkingEvent["type"],
  values: Omit<SessionParkingTransitionRow, "source" | "event">,
): SessionParkingTransitionRow {
  return Object.freeze({ source, event, ...values });
}

const staticRows: readonly SessionParkingTransitionRow[] = [
  row("active", "SESSION.PARK.REQUESTED", {
    guarded: false,
    allowed: true,
    target: "parking",
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "park-requested",
  }),
  row("active", "SESSION.PARK.FINALIZE", {
    guarded: false,
    allowed: false,
    target: null,
    requiresExplicitIntent: false,
    authority: "session-registry",
    reason: "park-requested",
  }),
  row("active", "SESSION.RESUME.REQUESTED", {
    guarded: false,
    allowed: false,
    target: null,
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "session-not-parked",
  }),
  row("active", "SESSION.OBSERVE", OBSERVE_ROW),
  row("active", "SESSION.CLOSE.REQUESTED", LIFECYCLE_GUARDS.close),
  row("active", "SESSION.DISCARD.REQUESTED", LIFECYCLE_GUARDS.discard),
  row("active", "SESSION.DOCTOR.REQUESTED", {
    guarded: false,
    allowed: true,
    target: "active",
    requiresExplicitIntent: false,
    authority: "reconciliation",
    reason: "observe",
  }),
  row("active", "SESSION.RECONCILE.REQUESTED", {
    guarded: false,
    allowed: true,
    target: "active",
    requiresExplicitIntent: false,
    authority: "reconciliation",
    reason: "observe",
  }),
  row("active", "SESSION.GC.REQUESTED", LIFECYCLE_GUARDS.gc),

  row("parking", "SESSION.PARK.REQUESTED", {
    guarded: false,
    allowed: false,
    target: null,
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "parking-in-progress",
  }),
  row("parking", "SESSION.PARK.FINALIZE", {
    guarded: false,
    allowed: true,
    target: "parked",
    requiresExplicitIntent: false,
    authority: "session-registry",
    reason: "parked",
  }),
  row("parking", "SESSION.RESUME.REQUESTED", {
    guarded: false,
    allowed: false,
    target: null,
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "parking-in-progress",
  }),
  row("parking", "SESSION.OBSERVE", OBSERVE_ROW),
  row("parking", "SESSION.CLOSE.REQUESTED", {
    guarded: false,
    allowed: false,
    target: null,
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "parking-in-progress",
  }),
  row("parking", "SESSION.DISCARD.REQUESTED", {
    guarded: false,
    allowed: false,
    target: null,
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "parking-in-progress",
  }),
  row("parking", "SESSION.DOCTOR.REQUESTED", {
    guarded: false,
    allowed: true,
    target: "parking",
    requiresExplicitIntent: false,
    authority: "reconciliation",
    reason: "observe",
  }),
  row("parking", "SESSION.RECONCILE.REQUESTED", {
    guarded: false,
    allowed: true,
    target: "parking",
    requiresExplicitIntent: false,
    authority: "reconciliation",
    reason: "observe",
  }),
  row("parking", "SESSION.GC.REQUESTED", {
    guarded: false,
    allowed: false,
    target: null,
    requiresExplicitIntent: false,
    authority: "gc",
    reason: "parking-in-progress",
  }),

  row("parked", "SESSION.PARK.REQUESTED", {
    guarded: false,
    allowed: true,
    target: "parked",
    requiresExplicitIntent: true,
    authority: "session-registry",
    reason: "parked",
  }),
  row("parked", "SESSION.PARK.FINALIZE", {
    guarded: false,
    allowed: false,
    target: null,
    requiresExplicitIntent: false,
    authority: "session-registry",
    reason: "parked",
  }),
  row("parked", "SESSION.RESUME.REQUESTED", {
    guarded: false,
    allowed: true,
    target: "active",
    requiresExplicitIntent: true,
    authority: "caller",
    reason: "resume-authorized",
  }),
  row("parked", "SESSION.OBSERVE", OBSERVE_ROW),
  row("parked", "SESSION.CLOSE.REQUESTED", LIFECYCLE_GUARDS.close),
  row("parked", "SESSION.DISCARD.REQUESTED", LIFECYCLE_GUARDS.discard),
  row("parked", "SESSION.DOCTOR.REQUESTED", {
    guarded: false,
    allowed: true,
    target: "parked",
    requiresExplicitIntent: false,
    authority: "reconciliation",
    reason: "observe",
  }),
  row("parked", "SESSION.RECONCILE.REQUESTED", {
    guarded: false,
    allowed: true,
    target: "parked",
    requiresExplicitIntent: false,
    authority: "reconciliation",
    reason: "observe",
  }),
  row("parked", "SESSION.GC.REQUESTED", LIFECYCLE_GUARDS.gc),
];

export const SESSION_PARKING_TRANSITION_TABLE: readonly SessionParkingTransitionRow[] = Object.freeze(staticRows);

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
      return value.status === "parked" && typeof value.operationId === "string" && value.operationId.length > 0;
    case "SESSION.RESUME.REQUESTED":
      return value.status === "resumed" && typeof value.operationId === "string" && value.operationId.length > 0;
    case "SESSION.OBSERVE":
      return validObservation(value.observation);
    default:
      return false;
  }
}

function staticTransition(rowValue: SessionParkingTransitionRow): SessionParkingTransition {
  if (rowValue.allowed === null || rowValue.target === null) {
    return Object.freeze({
      allowed: rowValue.allowed ?? false,
      target: rowValue.target,
      requiresExplicitIntent: rowValue.requiresExplicitIntent,
      authority: rowValue.authority,
      reason: rowValue.reason,
    });
  }
  return Object.freeze({
    allowed: rowValue.allowed,
    target: rowValue.target,
    requiresExplicitIntent: rowValue.requiresExplicitIntent,
    authority: rowValue.authority,
    reason: rowValue.reason,
  });
}

function observationTarget(observation: SessionLifecycleObservation): SessionParkingProjectedState {
  const classification = classifySessionLifecycle(
    observation.sessionState === "parked" ? { ...observation, sessionState: "active" } : observation,
  );
  if (
    observation.sessionState === "parked" &&
    classification.state !== "stale-inconsistent" &&
    classification.state !== "discarded" &&
    classification.state !== "closed"
  ) {
    return "parked";
  }
  return classification.state;
}

function lifecycleOperation(eventType: SessionParkingEvent["type"]): SessionLifecycleOperation | undefined {
  switch (eventType) {
    case "SESSION.CLOSE.REQUESTED":
      return "close";
    case "SESSION.DISCARD.REQUESTED":
      return "discard";
    case "SESSION.GC.REQUESTED":
      return "gc";
    default:
      return undefined;
  }
}

function delegatedTransition(
  input: SessionParkingTransitionInput,
  event: SessionParkingEvent,
): SessionParkingTransition {
  const operation = lifecycleOperation(event.type);
  if (operation === undefined) {
    throw new Error(`Unsupported delegated parking event: ${event.type}`);
  }
  const observation =
    input.state === "parked" && input.observation.sessionState === "parked"
      ? { ...input.observation, sessionState: "active" }
      : input.observation;
  const transition = lifecycleTransition(classifySessionLifecycle(observation), operation);
  const target =
    input.state === "parked" && !transition.allowed && transition.target === "active" ? "parked" : transition.target;
  return Object.freeze({
    allowed: transition.allowed,
    target,
    requiresExplicitIntent: transition.requiresExplicitIntent,
    authority: transition.authority,
    reason: transition.reason,
  });
}

export function projectSessionParkingTransition(
  input: SessionParkingTransitionInput,
  event: SessionParkingEvent,
): DomainResult<SessionParkingTransition> {
  if (!isRecord(input) || !validOperationalState(input.state) || !validObservation(input.observation)) {
    return invalid("Session parking transition input is invalid");
  }
  if (!validEvent(event)) return invalid("Session parking event is invalid");

  try {
    if (event.type === "SESSION.OBSERVE") {
      return success(
        Object.freeze({
          allowed: true,
          target: observationTarget(event.observation),
          requiresExplicitIntent: false,
          authority: "session-registry",
          reason: "observe",
        }),
      );
    }

    if (
      (input.state === "active" || input.state === "parked") &&
      (event.type === "SESSION.CLOSE.REQUESTED" ||
        event.type === "SESSION.DISCARD.REQUESTED" ||
        event.type === "SESSION.GC.REQUESTED")
    ) {
      return success(delegatedTransition(input, event));
    }

    const rowValue = SESSION_PARKING_TRANSITION_TABLE.find(
      (candidate) => candidate.source === input.state && candidate.event === event.type,
    );
    if (rowValue === undefined) return invalid("Session parking transition is not defined");
    return success(staticTransition(rowValue));
  } catch {
    return invalid("Session parking observation is invalid");
  }
}
