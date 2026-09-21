/**
 * Pure session parking lifecycle capability.
 *
 * Parking is deliberately a separate capability from the existing close/
 * discard lifecycle.  This module evaluates only evidence supplied by an
 * authoritative adapter; it does not inspect Git, the filesystem, the
 * registry, claims, or protected executions and it never performs a mutation.
 *
 * The module is the B1 producer for the later lifecycle/public-surface
 * integrators.  In particular, a parked session retains its worktree and
 * branch identity, releases or downgrades its mutable claims, and remains a
 * session rather than becoming a closed or discarded record.
 */

import { createActor, setup } from "xstate";

export const SESSION_PARKING_SCHEMA_VERSION = 1 as const;
export const SESSION_PARKING_LIFECYCLE_SCHEMA_ID = "nawabari.session-parking-lifecycle.v1" as const;

/** Operational and persisted parking states. */
export type SessionParkingState = "active" | "parking" | "parked";

export const SESSION_PARKING_STATES: readonly SessionParkingState[] = Object.freeze(["active", "parking", "parked"]);

/** Stable internal-to-public state mapping used by the parking machine. */
export const SESSION_PARKING_STATE_NODE_IDS: Readonly<Record<SessionParkingState, string>> = Object.freeze({
  active: "active",
  parking: "parking",
  parked: "parked",
} satisfies Record<SessionParkingState, string>);

export type SessionParkingOperation = "park" | "park-finalize" | "resume";

export const SESSION_PARKING_EVENT_TYPES = Object.freeze({
  park: "SESSION.PARK.REQUESTED",
  "park-finalize": "SESSION.PARK.FINALIZE",
  resume: "SESSION.RESUME.REQUESTED",
} as const satisfies Record<SessionParkingOperation, string>);

export const SESSION_PARKING_EVENT_TYPE_LIST = Object.freeze([
  SESSION_PARKING_EVENT_TYPES.park,
  SESSION_PARKING_EVENT_TYPES["park-finalize"],
  SESSION_PARKING_EVENT_TYPES.resume,
] as const);

export type SessionParkingDrainStatus = "drained" | "running" | "unknown";
export type SessionParkingClaimStatus = "active" | "released" | "downgraded" | "reacquired" | "conflict" | "unknown";
export type SessionParkingPhysicalPresence = "retained" | "missing" | "unknown";
export type SessionParkingIdentityStatus = "verified" | "mismatch" | "unknown";
export type SessionParkingRuntimeStatus = "known" | "unknown";
export type SessionParkingBooleanEvidence = boolean | "unknown";

/** Evidence that owned protected executions have drained. */
export interface SessionParkingDrainEvidence {
  readonly status: SessionParkingDrainStatus;
  readonly activeExecutionCount: number;
}

/**
 * Evidence about the claim generation being released or reacquired.
 * `allRequiredReacquired` is intentionally explicit: one reacquired claim
 * must never be mistaken for successful reacquisition of the whole claim set.
 */
export interface SessionParkingClaimEvidence {
  readonly generation: number;
  readonly status: SessionParkingClaimStatus;
  readonly allRequiredReacquired?: boolean;
}

/**
 * Physical identity and diagnostic facts supplied by an existing adapter.
 * Dirty and unintegrated are observations, not park rejection reasons.
 */
export interface SessionParkingPhysicalEvidence {
  readonly worktree: SessionParkingPhysicalPresence;
  readonly branch: SessionParkingPhysicalPresence;
  readonly identity: SessionParkingIdentityStatus;
  readonly runtime: SessionParkingRuntimeStatus;
  readonly dirty: SessionParkingBooleanEvidence;
  readonly unintegrated: SessionParkingBooleanEvidence;
}

/**
 * One complete evidence snapshot. `claimGeneration` is the generation held
 * by the persisted session record; `claims.generation` is the generation
 * observed by the claim authority. They must match before a finalize/resume
 * transition can be accepted.
 */
export interface SessionParkingObservation {
  readonly state: SessionParkingState;
  readonly claimGeneration: number;
  readonly drain: SessionParkingDrainEvidence;
  readonly claims: SessionParkingClaimEvidence;
  readonly physical: SessionParkingPhysicalEvidence;
  /** Age is diagnostic only and never triggers parking or finalization. */
  readonly ageSuspicious?: boolean;
}

/** Narrow persisted view accepted by the pure state machine. */
export interface SessionParkingPersistedState {
  readonly state: SessionParkingState;
  readonly claimGeneration: number;
}

export interface SessionParkingMachineInput {
  readonly observation: SessionParkingObservation;
  readonly persisted?: SessionParkingPersistedState;
}

export type SessionParkingMachineContext = SessionParkingMachineInput;

export type SessionParkingMachineEvent =
  | { readonly type: "SESSION.PARK.REQUESTED" }
  | { readonly type: "SESSION.PARK.FINALIZE" }
  | { readonly type: "SESSION.RESUME.REQUESTED" };

export type SessionParkingTransitionReason =
  | "explicit-park-requested"
  | "park-finalized"
  | "resume-authorized"
  | "park-finalize-requires-parking"
  | "park-requires-active"
  | "resume-requires-parked"
  | "park-drain-required"
  | "park-claims-release-required"
  | "park-physical-identity-required"
  | "resume-claims-reacquisition-required"
  | "resume-generation-conflict"
  | "resume-physical-identity-required"
  | "state-evidence-mismatch";

export type SessionParkingTransitionAuthority = "caller" | "session-registry";

export interface SessionParkingTransition {
  readonly operation: SessionParkingOperation;
  readonly eventType: (typeof SESSION_PARKING_EVENT_TYPES)[SessionParkingOperation];
  readonly allowed: boolean;
  readonly target: SessionParkingState | null;
  readonly requiresExplicitIntent: boolean;
  readonly authority: SessionParkingTransitionAuthority;
  readonly reason: SessionParkingTransitionReason;
  readonly claimGeneration: number;
  readonly nextClaimGeneration: number | null;
}

/** Static metadata for consumers that need discovery without an observation. */
export type SessionParkingTransitionProjection =
  | {
      readonly operation: SessionParkingOperation;
      readonly eventType: (typeof SESSION_PARKING_EVENT_TYPES)[SessionParkingOperation];
      readonly guarded: false;
      readonly allowed: boolean;
      readonly target: SessionParkingState | null;
      readonly requiresExplicitIntent: boolean;
      readonly authority: SessionParkingTransitionAuthority;
      readonly reason: SessionParkingTransitionReason;
    }
  | {
      readonly operation: SessionParkingOperation;
      readonly eventType: (typeof SESSION_PARKING_EVENT_TYPES)[SessionParkingOperation];
      readonly guarded: true;
      readonly requiresExplicitIntent: boolean;
      readonly authority: SessionParkingTransitionAuthority;
      readonly whenGuardAccepts: {
        readonly allowed: true;
        readonly target: SessionParkingState;
        readonly reason: Extract<
          SessionParkingTransitionReason,
          "explicit-park-requested" | "park-finalized" | "resume-authorized"
        >;
      };
      readonly whenGuardRejects: {
        readonly allowed: false;
        readonly target: null;
        readonly reason: SessionParkingTransitionReason;
      };
    };

/*
 * Kept as a named alias for consumers that want to describe a guarded entry
 * without depending on the union's discriminant syntax.
 */
export interface SessionParkingGuardedTransition {
  readonly operation: SessionParkingOperation;
  readonly eventType: (typeof SESSION_PARKING_EVENT_TYPES)[SessionParkingOperation];
  readonly guarded: true;
  readonly requiresExplicitIntent: boolean;
  readonly authority: SessionParkingTransitionAuthority;
  readonly whenGuardAccepts: {
    readonly allowed: true;
    readonly target: SessionParkingState;
    readonly reason: Extract<
      SessionParkingTransitionReason,
      "explicit-park-requested" | "park-finalized" | "resume-authorized"
    >;
  };
  readonly whenGuardRejects: {
    readonly allowed: false;
    readonly target: null;
    readonly reason: SessionParkingTransitionReason;
  };
}

export interface SessionParkingClassification {
  readonly schemaVersion: typeof SESSION_PARKING_SCHEMA_VERSION;
  readonly lifecycleSchema: typeof SESSION_PARKING_LIFECYCLE_SCHEMA_ID;
  readonly state: SessionParkingState;
  readonly admissionAllowed: boolean;
  readonly parked: boolean;
  readonly closed: false;
  readonly drain: SessionParkingDrainEvidence;
  readonly claims: SessionParkingClaimEvidence;
  readonly physical: SessionParkingPhysicalEvidence;
  readonly ageSuspicious: boolean;
  readonly transitions: readonly SessionParkingTransition[];
}

export type SessionParkingActionId = "request-park" | "finalize-park" | "request-resume";

export type SessionParkingAction =
  | {
      readonly schemaVersion: typeof SESSION_PARKING_SCHEMA_VERSION;
      readonly actionId: "request-park";
      readonly kind: "park-request";
      readonly command: "session park";
      readonly eventType: "SESSION.PARK.REQUESTED";
      readonly sessionId: string;
      readonly requiresExplicitIntent: true;
      readonly mutates: true;
    }
  | {
      readonly schemaVersion: typeof SESSION_PARKING_SCHEMA_VERSION;
      readonly actionId: "finalize-park";
      readonly kind: "park-finalize";
      readonly command: "session park";
      readonly eventType: "SESSION.PARK.FINALIZE";
      readonly sessionId: string;
      readonly requiresExplicitIntent: false;
      readonly mutates: true;
    }
  | {
      readonly schemaVersion: typeof SESSION_PARKING_SCHEMA_VERSION;
      readonly actionId: "request-resume";
      readonly kind: "resume-request";
      readonly command: "session resume";
      readonly eventType: "SESSION.RESUME.REQUESTED";
      readonly sessionId: string;
      readonly requiresExplicitIntent: true;
      readonly mutates: true;
    };

export interface SessionParkingActionProjectionInput {
  readonly classification: SessionParkingClassification;
  readonly sessionId: string;
}

function validNonNegativeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function validState(value: unknown): value is SessionParkingState {
  return typeof value === "string" && (SESSION_PARKING_STATES as readonly string[]).includes(value);
}

function validDrainEvidence(value: SessionParkingDrainEvidence): boolean {
  return (
    (value.status === "drained" || value.status === "running" || value.status === "unknown") &&
    validNonNegativeInteger(value.activeExecutionCount)
  );
}

function validClaimsEvidence(value: SessionParkingClaimEvidence): boolean {
  return (
    validNonNegativeInteger(value.generation) &&
    (value.status === "active" ||
      value.status === "released" ||
      value.status === "downgraded" ||
      value.status === "reacquired" ||
      value.status === "conflict" ||
      value.status === "unknown") &&
    (value.allRequiredReacquired === undefined || typeof value.allRequiredReacquired === "boolean")
  );
}

function validPhysicalEvidence(value: SessionParkingPhysicalEvidence): boolean {
  return (
    (value.worktree === "retained" || value.worktree === "missing" || value.worktree === "unknown") &&
    (value.branch === "retained" || value.branch === "missing" || value.branch === "unknown") &&
    (value.identity === "verified" || value.identity === "mismatch" || value.identity === "unknown") &&
    (value.runtime === "known" || value.runtime === "unknown") &&
    (typeof value.dirty === "boolean" || value.dirty === "unknown") &&
    (typeof value.unintegrated === "boolean" || value.unintegrated === "unknown")
  );
}

function validObservation(value: SessionParkingObservation): boolean {
  return (
    validState(value.state) &&
    validNonNegativeInteger(value.claimGeneration) &&
    validDrainEvidence(value.drain) &&
    validClaimsEvidence(value.claims) &&
    validPhysicalEvidence(value.physical) &&
    (value.ageSuspicious === undefined || typeof value.ageSuspicious === "boolean")
  );
}

function assertInput(input: SessionParkingMachineInput): void {
  if (!validObservation(input.observation)) {
    throw new TypeError("Invalid session parking observation");
  }
  if (
    input.persisted !== undefined &&
    (!validState(input.persisted.state) || !validNonNegativeInteger(input.persisted.claimGeneration))
  ) {
    throw new TypeError("Invalid persisted session parking state");
  }
}

function effectivePersistedState(input: SessionParkingMachineInput): SessionParkingPersistedState {
  return (
    input.persisted ?? {
      state: input.observation.state,
      claimGeneration: input.observation.claimGeneration,
    }
  );
}

function stateEvidenceMatches(input: SessionParkingMachineInput): boolean {
  const persisted = effectivePersistedState(input);
  return persisted.state === input.observation.state && persisted.claimGeneration === input.observation.claimGeneration;
}

function claimGenerationMatches(input: SessionParkingMachineInput): boolean {
  return input.observation.claims.generation === input.observation.claimGeneration;
}

function hasRetainedPhysicalIdentity(input: SessionParkingMachineInput): boolean {
  const { physical } = input.observation;
  return physical.worktree === "retained" && physical.branch === "retained" && physical.identity === "verified";
}

function hasDrainedExecutions(input: SessionParkingMachineInput): boolean {
  const { drain } = input.observation;
  return drain.status === "drained" && drain.activeExecutionCount === 0;
}

function hasReleasedClaims(input: SessionParkingMachineInput): boolean {
  const status = input.observation.claims.status;
  return claimGenerationMatches(input) && (status === "released" || status === "downgraded");
}

function hasReacquiredClaims(input: SessionParkingMachineInput): boolean {
  const claims = input.observation.claims;
  return claimGenerationMatches(input) && claims.status === "reacquired" && claims.allRequiredReacquired === true;
}

function parkFinalizeReason(input: SessionParkingMachineInput): SessionParkingTransitionReason {
  if (!stateEvidenceMatches(input)) return "state-evidence-mismatch";
  if (input.observation.state !== "parking") return "park-finalize-requires-parking";
  if (!hasDrainedExecutions(input)) return "park-drain-required";
  if (!hasReleasedClaims(input)) return "park-claims-release-required";
  if (!hasRetainedPhysicalIdentity(input)) return "park-physical-identity-required";
  return "park-finalized";
}

function resumeReason(input: SessionParkingMachineInput): SessionParkingTransitionReason {
  if (!stateEvidenceMatches(input)) return "state-evidence-mismatch";
  if (input.observation.state !== "parked") return "resume-requires-parked";
  if (!hasReacquiredClaims(input)) {
    return input.observation.claims.generation !== input.observation.claimGeneration
      ? "resume-generation-conflict"
      : "resume-claims-reacquisition-required";
  }
  if (!hasRetainedPhysicalIdentity(input)) return "resume-physical-identity-required";
  return "resume-authorized";
}

function transitionReason(
  input: SessionParkingMachineInput,
  operation: SessionParkingOperation,
): SessionParkingTransitionReason {
  switch (operation) {
    case "park":
      if (!stateEvidenceMatches(input)) return "state-evidence-mismatch";
      return input.observation.state === "active" ? "explicit-park-requested" : "park-requires-active";
    case "park-finalize":
      return parkFinalizeReason(input);
    case "resume":
      return resumeReason(input);
  }
}

function transitionAuthority(operation: SessionParkingOperation): SessionParkingTransitionAuthority {
  return operation === "park-finalize" ? "session-registry" : "caller";
}

function transitionTarget(operation: SessionParkingOperation): SessionParkingState {
  switch (operation) {
    case "park":
    case "park-finalize":
      return operation === "park" ? "parking" : "parked";
    case "resume":
      return "active";
  }
}

function transitionRequiresExplicitIntent(operation: SessionParkingOperation): boolean {
  return operation !== "park-finalize";
}

function acceptedReason(reason: SessionParkingTransitionReason): boolean {
  return reason === "explicit-park-requested" || reason === "park-finalized" || reason === "resume-authorized";
}

function transitionFor(
  input: SessionParkingMachineInput,
  operation: SessionParkingOperation,
): SessionParkingTransition {
  assertInput(input);
  const reason = transitionReason(input, operation);
  const allowed = acceptedReason(reason);
  const claimGeneration = input.observation.claimGeneration;
  return Object.freeze({
    operation,
    eventType: SESSION_PARKING_EVENT_TYPES[operation],
    allowed,
    target: allowed ? transitionTarget(operation) : null,
    requiresExplicitIntent: transitionRequiresExplicitIntent(operation),
    authority: transitionAuthority(operation),
    reason,
    claimGeneration,
    nextClaimGeneration: allowed && operation === "resume" ? claimGeneration + 1 : null,
  });
}

function parkingFinalizeGuard(context: SessionParkingMachineContext): boolean {
  return transitionFor(context, "park-finalize").allowed;
}

function resumeGuard(context: SessionParkingMachineContext): boolean {
  return transitionFor(context, "resume").allowed;
}

function parkRequestGuard(context: SessionParkingMachineContext): boolean {
  return transitionFor(context, "park").allowed;
}

const parkingMachineSetup = setup({
  types: {
    context: {} as SessionParkingMachineContext,
    events: {} as SessionParkingMachineEvent,
    input: {} as SessionParkingMachineInput,
  },
  guards: {
    parkRequestAllowed: ({ context }) => parkRequestGuard(context),
    parkingFinalizeAllowed: ({ context }) => parkingFinalizeGuard(context),
    resumeAllowed: ({ context }) => resumeGuard(context),
    operationForbidden: () => false,
  },
});

/** Executable pure machine; its context contains evidence only. */
export const sessionParkingMachine = parkingMachineSetup.createMachine({
  id: "session-parking",
  initial: "classify",
  context: ({ input }) => {
    assertInput(input);
    return input;
  },
  states: {
    classify: {
      always: [
        { target: "active", guard: ({ context }) => context.observation.state === "active" },
        { target: "parking", guard: ({ context }) => context.observation.state === "parking" },
        { target: "parked", guard: ({ context }) => context.observation.state === "parked" },
      ],
    },
    active: {
      on: {
        "SESSION.PARK.REQUESTED": {
          target: "parking",
          guard: "parkRequestAllowed",
          meta: { operation: "park", allowed: true, target: "parking", reason: "explicit-park-requested" },
        },
        "SESSION.PARK.FINALIZE": {
          target: ".",
          guard: "operationForbidden",
          meta: { operation: "park-finalize", allowed: false, target: null, reason: "park-finalize-requires-parking" },
        },
        "SESSION.RESUME.REQUESTED": {
          target: ".",
          guard: "operationForbidden",
          meta: { operation: "resume", allowed: false, target: null, reason: "resume-requires-parked" },
        },
      },
    },
    parking: {
      on: {
        "SESSION.PARK.REQUESTED": {
          target: ".",
          guard: "operationForbidden",
          meta: { operation: "park", allowed: false, target: null, reason: "park-requires-active" },
        },
        "SESSION.PARK.FINALIZE": {
          target: "parked",
          guard: "parkingFinalizeAllowed",
          meta: { operation: "park-finalize", allowed: true, target: "parked", reason: "park-finalized" },
        },
        "SESSION.RESUME.REQUESTED": {
          target: ".",
          guard: "operationForbidden",
          meta: { operation: "resume", allowed: false, target: null, reason: "resume-requires-parked" },
        },
      },
    },
    parked: {
      on: {
        "SESSION.PARK.REQUESTED": {
          target: ".",
          guard: "operationForbidden",
          meta: { operation: "park", allowed: false, target: null, reason: "park-requires-active" },
        },
        "SESSION.PARK.FINALIZE": {
          target: ".",
          guard: "operationForbidden",
          meta: { operation: "park-finalize", allowed: false, target: null, reason: "park-finalize-requires-parking" },
        },
        "SESSION.RESUME.REQUESTED": {
          target: "active",
          guard: "resumeAllowed",
          meta: { operation: "resume", allowed: true, target: "active", reason: "resume-authorized" },
        },
      },
    },
  },
});

function eventFor(operation: SessionParkingOperation): SessionParkingMachineEvent {
  switch (operation) {
    case "park":
      return { type: "SESSION.PARK.REQUESTED" };
    case "park-finalize":
      return { type: "SESSION.PARK.FINALIZE" };
    case "resume":
      return { type: "SESSION.RESUME.REQUESTED" };
  }
}

function machineState(input: SessionParkingMachineInput): SessionParkingState {
  const actor = createActor(sessionParkingMachine, { input }).start();
  const value = actor.getSnapshot().value;
  actor.stop();
  if (value !== "active" && value !== "parking" && value !== "parked") {
    throw new Error(`Session parking machine exposed an invalid state: ${String(value)}`);
  }
  return value;
}

/** Project one event through the executable parking machine. */
export function projectSessionParkingTransition(
  input: SessionParkingMachineInput,
  operation: SessionParkingOperation,
): SessionParkingTransition {
  const initialState = machineState(input);
  const actor = createActor(sessionParkingMachine, { input }).start();
  const event = eventFor(operation);
  const allowed = actor.getSnapshot().can(event);
  if (allowed) actor.send(event);
  const targetValue = actor.getSnapshot().value;
  actor.stop();
  const projected = transitionFor(input, operation);
  const target =
    allowed && (targetValue === "active" || targetValue === "parking" || targetValue === "parked") ? targetValue : null;
  if (allowed !== projected.allowed || (allowed && target !== projected.target)) {
    throw new Error(
      `Session parking machine/projection disagreement for ${initialState}.${operation}: ` +
        `machine=${String(allowed)}:${String(target)} projection=${String(projected.allowed)}:${String(projected.target)}`,
    );
  }
  return projected;
}

/** Project every parking operation from one evidence snapshot. */
export function projectSessionParkingMachine(input: SessionParkingMachineInput): Readonly<{
  readonly state: SessionParkingState;
  readonly transitions: Readonly<Record<SessionParkingOperation, SessionParkingTransition>>;
}> {
  const state = machineState(input);
  const transitions = Object.fromEntries(
    (Object.keys(SESSION_PARKING_EVENT_TYPES) as SessionParkingOperation[]).map((operation) => [
      operation,
      projectSessionParkingTransition(input, operation),
    ]),
  ) as Record<SessionParkingOperation, SessionParkingTransition>;
  return Object.freeze({ state, transitions: Object.freeze(transitions) });
}

/** Classify a snapshot into the public parking lifecycle projection. */
export function classifySessionParking(input: SessionParkingMachineInput): SessionParkingClassification {
  assertInput(input);
  const projection = projectSessionParkingMachine(input);
  const { observation } = input;
  return Object.freeze({
    schemaVersion: SESSION_PARKING_SCHEMA_VERSION,
    lifecycleSchema: SESSION_PARKING_LIFECYCLE_SCHEMA_ID,
    state: projection.state,
    admissionAllowed: projection.state === "active",
    parked: projection.state === "parked",
    closed: false,
    drain: Object.freeze({ ...observation.drain }),
    claims: Object.freeze({ ...observation.claims }),
    physical: Object.freeze({ ...observation.physical }),
    ageSuspicious: observation.ageSuspicious === true,
    transitions: Object.freeze(Object.values(projection.transitions)),
  });
}

export function sessionParkingTransition(
  classification: SessionParkingClassification,
  operation: SessionParkingOperation,
): SessionParkingTransition {
  const transition = classification.transitions.find((candidate) => candidate.operation === operation);
  if (transition === undefined) throw new RangeError(`Unsupported session parking operation: ${operation}`);
  return transition;
}

export function availableSessionParkingOperations(
  classification: SessionParkingClassification,
): readonly SessionParkingOperation[] {
  return Object.freeze(
    classification.transitions.filter((transition) => transition.allowed).map((transition) => transition.operation),
  );
}

/** Admission is denied while a session is parking or parked. */
export function isSessionParkingAdmissionAllowed(input: SessionParkingMachineInput): boolean {
  return classifySessionParking(input).admissionAllowed;
}

export function isSessionParkingFinalizeReady(input: SessionParkingMachineInput): boolean {
  return projectSessionParkingTransition(input, "park-finalize").allowed;
}

export function isSessionParkingResumeReady(input: SessionParkingMachineInput): boolean {
  return projectSessionParkingTransition(input, "resume").allowed;
}

function parkingAction(
  classification: SessionParkingClassification,
  sessionId: string,
  operation: SessionParkingOperation,
): SessionParkingAction | undefined {
  const transition = sessionParkingTransition(classification, operation);
  if (!transition.allowed) return undefined;
  switch (operation) {
    case "park":
      return Object.freeze({
        schemaVersion: SESSION_PARKING_SCHEMA_VERSION,
        actionId: "request-park",
        kind: "park-request",
        command: "session park",
        eventType: "SESSION.PARK.REQUESTED",
        sessionId,
        requiresExplicitIntent: true,
        mutates: true,
      });
    case "park-finalize":
      return Object.freeze({
        schemaVersion: SESSION_PARKING_SCHEMA_VERSION,
        actionId: "finalize-park",
        kind: "park-finalize",
        command: "session park",
        eventType: "SESSION.PARK.FINALIZE",
        sessionId,
        requiresExplicitIntent: false,
        mutates: true,
      });
    case "resume":
      return Object.freeze({
        schemaVersion: SESSION_PARKING_SCHEMA_VERSION,
        actionId: "request-resume",
        kind: "resume-request",
        command: "session resume",
        eventType: "SESSION.RESUME.REQUESTED",
        sessionId,
        requiresExplicitIntent: true,
        mutates: true,
      });
  }
}

/** Project only currently admissible caller-facing parking actions. */
export function projectSessionParkingActions(
  input: SessionParkingActionProjectionInput,
): readonly SessionParkingAction[] {
  const actions = (Object.keys(SESSION_PARKING_EVENT_TYPES) as SessionParkingOperation[])
    .map((operation) => parkingAction(input.classification, input.sessionId, operation))
    .filter((action): action is SessionParkingAction => action !== undefined);
  return Object.freeze(actions);
}

export function primarySessionParkingAction(
  input: SessionParkingActionProjectionInput,
): SessionParkingAction | undefined {
  return projectSessionParkingActions(input)[0];
}

/** Static lifecycle metadata for generated-manifest integration. */
export const SESSION_PARKING_TRANSITION_TABLE: Readonly<
  Record<SessionParkingState, readonly SessionParkingTransitionProjection[]>
> = Object.freeze({
  active: Object.freeze([
    Object.freeze({
      operation: "park",
      eventType: SESSION_PARKING_EVENT_TYPES.park,
      guarded: true,
      requiresExplicitIntent: true,
      authority: "caller",
      whenGuardAccepts: { allowed: true, target: "parking", reason: "explicit-park-requested" } as const,
      whenGuardRejects: { allowed: false, target: null, reason: "state-evidence-mismatch" } as const,
    }),
    Object.freeze({
      operation: "park-finalize",
      eventType: SESSION_PARKING_EVENT_TYPES["park-finalize"],
      guarded: false,
      allowed: false,
      target: null,
      requiresExplicitIntent: false,
      authority: "session-registry",
      reason: "park-finalize-requires-parking",
    }),
    Object.freeze({
      operation: "resume",
      eventType: SESSION_PARKING_EVENT_TYPES.resume,
      guarded: false,
      allowed: false,
      target: null,
      requiresExplicitIntent: true,
      authority: "caller",
      reason: "resume-requires-parked",
    }),
  ]),
  parking: Object.freeze([
    Object.freeze({
      operation: "park",
      eventType: SESSION_PARKING_EVENT_TYPES.park,
      guarded: false,
      allowed: false,
      target: null,
      requiresExplicitIntent: true,
      authority: "caller",
      reason: "park-requires-active",
    }),
    Object.freeze({
      operation: "park-finalize",
      eventType: SESSION_PARKING_EVENT_TYPES["park-finalize"],
      guarded: true,
      requiresExplicitIntent: false,
      authority: "session-registry",
      whenGuardAccepts: { allowed: true, target: "parked", reason: "park-finalized" } as const,
      whenGuardRejects: { allowed: false, target: null, reason: "park-drain-required" } as const,
    }),
    Object.freeze({
      operation: "resume",
      eventType: SESSION_PARKING_EVENT_TYPES.resume,
      guarded: false,
      allowed: false,
      target: null,
      requiresExplicitIntent: true,
      authority: "caller",
      reason: "resume-requires-parked",
    }),
  ]),
  parked: Object.freeze([
    Object.freeze({
      operation: "park",
      eventType: SESSION_PARKING_EVENT_TYPES.park,
      guarded: false,
      allowed: false,
      target: null,
      requiresExplicitIntent: true,
      authority: "caller",
      reason: "park-requires-active",
    }),
    Object.freeze({
      operation: "park-finalize",
      eventType: SESSION_PARKING_EVENT_TYPES["park-finalize"],
      guarded: false,
      allowed: false,
      target: null,
      requiresExplicitIntent: false,
      authority: "session-registry",
      reason: "park-finalize-requires-parking",
    }),
    Object.freeze({
      operation: "resume",
      eventType: SESSION_PARKING_EVENT_TYPES.resume,
      guarded: true,
      requiresExplicitIntent: true,
      authority: "caller",
      whenGuardAccepts: { allowed: true, target: "active", reason: "resume-authorized" } as const,
      whenGuardRejects: { allowed: false, target: null, reason: "resume-claims-reacquisition-required" } as const,
    }),
  ]),
} as const);

export const SESSION_PARKING_SERIALIZATION_KEYS = Object.freeze(["lifecycle", "generated-manifest"] as const);
