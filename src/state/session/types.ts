import type { EventObject } from "xstate";

import type {
  SessionLifecycleBlocker,
  SessionLifecycleCloseReadiness,
  SessionLifecycleObservation,
  SessionLifecyclePhase,
  SessionLifecycleState,
  SessionLifecycleTransition,
} from "../../session-lifecycle-classification.js";

/** Internal schema generation for the session state-module boundary. */
export const SESSION_STATE_MODULE_SCHEMA_VERSION = 1 as const;

/** Durable state stored by the existing session-registry authority. */
export type PersistedSessionState = "new" | "active" | "closing" | "closed" | "stale" | "parked";

/** Derived operational state; it is not the persisted SessionRecord.state value. */
export type SessionOperationalState = SessionLifecycleState;

/** A narrow, read-only view of persisted state supplied by the registry adapter. */
export interface SessionPersistedStateInput {
  readonly sessionId: string;
  readonly state: PersistedSessionState;
  readonly terminalOperation?: "discard";
  readonly cleanupHead?: string;
  readonly discardedHead?: string;
}

/**
 * Evidence produced by an existing authority before a machine evaluates an
 * event. The state module accepts these facts but does not observe or mutate
 * Git, the filesystem, the registry, resources, or the sandbox itself.
 */
export interface SessionEvidenceInput {
  readonly claimSetGeneration?: number;
  readonly integration?: SessionIntegrationEvidence;
  readonly garbageCollection?: SessionGarbageCollectionEvidence;
}

export type SessionIntegrationEvidence =
  | { readonly status: "proven"; readonly revision: string }
  | { readonly status: "not-proven" }
  | { readonly status: "ambiguous"; readonly reason?: string }
  | { readonly status: "unavailable"; readonly reason?: string };

export interface SessionGarbageCollectionEvidence {
  readonly authorized: boolean;
  readonly reason?: string;
}

/**
 * Lifecycle observation boundary retained as a structural input. This
 * extends the existing classifier vocabulary without making the state module
 * an authority for how observations are obtained.
 */
export interface SessionObservationInput extends SessionLifecycleObservation {
  readonly evidence?: SessionEvidenceInput;
}

export type SessionObservationBlocker = SessionLifecycleBlocker;
export type SessionObservationCloseReadiness = SessionLifecycleCloseReadiness;
export type SessionObservationPhase = SessionLifecyclePhase;

export type SessionParkingOperationalState = Extract<SessionLifecycleState, "active" | "parking" | "parked">;

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

export type SessionParkingTransitionRow = Readonly<{
  source: SessionParkingOperationalState;
  event: SessionParkingEvent["type"];
  guarded: boolean;
  allowed: boolean | null;
  target: SessionLifecycleState | null;
  requiresExplicitIntent: boolean;
  authority: SessionLifecycleTransition["authority"];
  reason: SessionLifecycleTransition["reason"];
}>;

/** Input hydrated from authoritative adapters before a machine is evaluated. */
export interface SessionMachineInput {
  /** Optional because lifecycle projection may receive observation only. */
  readonly persisted?: SessionPersistedStateInput;
  readonly observation: SessionObservationInput;
  readonly evidence?: SessionEvidenceInput;
}

/**
 * XState context boundary. Context contains an observed input snapshot; it
 * does not own authoritative facts or mutation capabilities.
 */
export interface SessionMachineContext {
  readonly persisted?: SessionPersistedStateInput;
  readonly observation: SessionObservationInput;
  readonly evidence: SessionEvidenceInput;
}

type SessionEventWithPayload = EventObject;

/** Internal capability-oriented events; CLI command names are adapter concerns. */
export type SessionMachineEvent =
  | (SessionEventWithPayload & {
      readonly type: "SESSION.OBSERVE";
      readonly observation: SessionObservationInput;
      readonly evidence?: SessionEvidenceInput;
    })
  | (SessionEventWithPayload & { readonly type: "SESSION.CLOSE.REQUESTED" })
  | (SessionEventWithPayload & { readonly type: "SESSION.DISCARD.REQUESTED" })
  | (SessionEventWithPayload & { readonly type: "SESSION.DOCTOR.REQUESTED" })
  | (SessionEventWithPayload & { readonly type: "SESSION.RECONCILE.REQUESTED" })
  | (SessionEventWithPayload & { readonly type: "SESSION.GC.REQUESTED" })
  | (SessionEventWithPayload & { readonly type: "SESSION.PARK.REQUESTED" })
  | (SessionEventWithPayload & {
      readonly type: "SESSION.PARK.FINALIZE";
      readonly status: "parked";
      readonly operationId: string;
    })
  | (SessionEventWithPayload & {
      readonly type: "SESSION.RESUME.REQUESTED";
      readonly status: "resumed";
      readonly operationId: string;
    })
  | (SessionEventWithPayload & { readonly type: "SESSION.CLEANUP.RETRY" })
  | (SessionEventWithPayload & { readonly type: "SESSION.CLEANUP.FINALIZE" })
  | (SessionEventWithPayload & { readonly type: "SESSION.MARK_STALE" });

export const SESSION_MACHINE_EVENT_TYPES = Object.freeze([
  "SESSION.OBSERVE",
  "SESSION.CLOSE.REQUESTED",
  "SESSION.DISCARD.REQUESTED",
  "SESSION.DOCTOR.REQUESTED",
  "SESSION.RECONCILE.REQUESTED",
  "SESSION.GC.REQUESTED",
  "SESSION.PARK.REQUESTED",
  "SESSION.PARK.FINALIZE",
  "SESSION.RESUME.REQUESTED",
  "SESSION.CLEANUP.RETRY",
  "SESSION.CLEANUP.FINALIZE",
  "SESSION.MARK_STALE",
] as const);
