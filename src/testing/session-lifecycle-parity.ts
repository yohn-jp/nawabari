import { createActor } from "xstate";

import {
  SESSION_LIFECYCLE_STATES,
  type SessionLifecycleBlocker,
  type SessionLifecycleCloseReadiness,
  type SessionLifecycleOperation,
  type SessionLifecyclePhase,
  type SessionLifecycleState,
  type SessionLifecycleTransition,
} from "../session-lifecycle-classification.js";
import {
  SESSION_OPERATION_EVENT_TYPES,
  sessionLifecycleMachine,
  type SessionMachineTransitionMetadata,
} from "../state/session/machine.js";
import { classifySessionLifecycleLegacyOracle, legacyOracleTransition } from "./session-lifecycle-legacy-oracle.js";
import type {
  PersistedSessionState,
  SessionEvidenceInput,
  SessionMachineEvent,
  SessionMachineInput,
  SessionObservationInput,
} from "../state/session/types.js";

/** Operations whose public semantics are owned by the lifecycle classifier. */
export const SESSION_PARITY_OPERATIONS = Object.freeze([
  "close",
  "discard",
  "inspect",
  "doctor",
  "reconcile",
  "gc",
] as const satisfies readonly SessionLifecycleOperation[]);

type PhysicalStateClass = {
  readonly id: string;
  readonly value: string;
};

type ReadinessClass = {
  readonly id: string;
  readonly value: SessionLifecycleCloseReadiness;
};

type BlockerClass = {
  readonly id: string;
  readonly blockers: readonly SessionLifecycleBlocker[];
};

type PersistedStateClass = {
  readonly id: string;
  readonly value: PersistedSessionState;
};

/**
 * Equivalence classes used by the deterministic matrix. The matrix is built
 * from semantic slices below rather than an unbounded Cartesian product.
 */
export const SESSION_PARITY_EQUIVALENCE_CLASSES = Object.freeze({
  persistedState: Object.freeze([
    { id: "new", value: "new" },
    { id: "active", value: "active" },
    { id: "closing", value: "closing" },
    { id: "closed", value: "closed" },
    { id: "stale", value: "stale" },
  ] as const satisfies readonly PersistedStateClass[]),
  physicalState: Object.freeze([
    { id: "healthy", value: "healthy" },
    { id: "closed", value: "closed" },
    { id: "stale", value: "prunable-present" },
    { id: "missing", value: "registered-missing" },
    { id: "unavailable", value: "unavailable" },
    { id: "unknown", value: "future-physical" },
  ] as const satisfies readonly PhysicalStateClass[]),
  closeReadiness: Object.freeze([
    { id: "ready", value: "ready" },
    { id: "blocked", value: "blocked" },
    { id: "ambiguous", value: "ambiguous" },
    { id: "external-evidence-required", value: "external_evidence_required" },
    { id: "not-evaluated", value: "not-evaluated" },
  ] as const satisfies readonly ReadinessClass[]),
  blockers: Object.freeze([
    { id: "none", blockers: [] },
    { id: "recoverable", blockers: [{ code: "RECOVERABLE_COMMITS" }] },
    { id: "ambiguous", blockers: [{ code: "OWNERSHIP_MISMATCH" }] },
    { id: "stale", blockers: [{ code: "STALE_REGISTRY", classification: "stale" }] },
    { id: "unknown", blockers: [{ code: "FUTURE_BLOCKER" }] },
  ] as const satisfies readonly BlockerClass[]),
  phase: Object.freeze([
    { id: "current", value: "current" },
    { id: "termination", value: "termination" },
  ] as const satisfies readonly { readonly id: string; readonly value: SessionLifecyclePhase }[]),
  terminalIntent: Object.freeze([
    { id: "none", value: "none" },
    { id: "observation", value: "observation-discard" },
    { id: "persisted-and-observation", value: "persisted-and-observation-discard" },
  ] as const),
  ageSuspicion: Object.freeze([
    { id: "normal", value: false },
    { id: "suspicious", value: true },
  ] as const),
  gcAuthorization: Object.freeze([
    { id: "denied", value: false },
    { id: "authorized", value: true },
  ] as const),
  integrationEvidence: Object.freeze(["proven", "not-proven", "ambiguous", "unavailable"] as const),
} as const);

export type SessionParityFixture = {
  readonly id: string;
  readonly dimensions: Readonly<Record<string, string>>;
  readonly input: SessionMachineInput;
};

type FixtureOptions = {
  readonly persistedState: PersistedSessionState;
  readonly sessionState?: string;
  readonly physicalState?: string;
  readonly closeReadiness?: SessionLifecycleCloseReadiness;
  readonly blockers?: readonly SessionLifecycleBlocker[];
  readonly terminalOperation?: "discard";
  readonly persistedTerminalOperation?: "discard";
  readonly ageSuspicious?: boolean;
  readonly gcAuthorized?: boolean;
  readonly phase?: SessionLifecyclePhase;
  readonly observationEvidence?: SessionEvidenceInput;
  readonly inputEvidence?: SessionEvidenceInput;
};

function fixture(
  id: string,
  dimensions: Readonly<Record<string, string>>,
  options: FixtureOptions,
): SessionParityFixture {
  const observation: SessionObservationInput = {
    sessionState: options.sessionState ?? options.persistedState,
    ...(options.physicalState === undefined ? {} : { physicalState: options.physicalState }),
    ...(options.closeReadiness === undefined ? {} : { closeReadiness: options.closeReadiness }),
    ...(options.blockers === undefined ? {} : { blockers: options.blockers }),
    ...(options.terminalOperation === undefined ? {} : { terminalOperation: options.terminalOperation }),
    ...(options.ageSuspicious === undefined ? {} : { ageSuspicious: options.ageSuspicious }),
    ...(options.gcAuthorized === undefined ? {} : { gcAuthorized: options.gcAuthorized }),
    ...(options.phase === undefined ? {} : { phase: options.phase }),
    ...(options.observationEvidence === undefined ? {} : { evidence: options.observationEvidence }),
  };
  return {
    id,
    dimensions: Object.freeze({ ...dimensions }),
    input: {
      persisted: {
        sessionId: `session-parity-${id}`,
        state: options.persistedState,
        ...(options.persistedTerminalOperation === undefined
          ? {}
          : { terminalOperation: options.persistedTerminalOperation }),
      },
      observation,
      ...(options.inputEvidence === undefined ? {} : { evidence: options.inputEvidence }),
    },
  };
}

const fixtures: SessionParityFixture[] = [];

function addFixture(id: string, dimensions: Readonly<Record<string, string>>, options: FixtureOptions): void {
  fixtures.push(fixture(id, dimensions, options));
}

const defaultDimensions = {
  phase: "current",
  terminalIntent: "none",
  age: "normal",
  gc: "not-authorized",
};

const defaultObservation = {
  physicalState: "healthy",
  closeReadiness: "not-evaluated" as const,
  blockers: [] as const,
  phase: "current" as const,
  ageSuspicious: false,
  gcAuthorized: false,
};

// State × physical: includes the closed-session exemption from physical
// evidence requirements and all stale/missing/unavailable physical classes.
for (const state of SESSION_PARITY_EQUIVALENCE_CLASSES.persistedState) {
  for (const physical of SESSION_PARITY_EQUIVALENCE_CLASSES.physicalState) {
    addFixture(
      `state-${state.id}-physical-${physical.id}`,
      { persistedState: state.id, physicalState: physical.id, ...defaultDimensions },
      { persistedState: state.value, ...defaultObservation, physicalState: physical.value },
    );
  }
}

// State × readiness: exercises how current/closing/stale records project each
// close-preflight outcome without mixing blocker authority into this slice.
for (const state of SESSION_PARITY_EQUIVALENCE_CLASSES.persistedState) {
  for (const readiness of SESSION_PARITY_EQUIVALENCE_CLASSES.closeReadiness) {
    addFixture(
      `state-${state.id}-readiness-${readiness.id}`,
      {
        persistedState: state.id,
        closeReadiness: readiness.id,
        phase: "termination",
        terminalIntent: "none",
        age: "normal",
        gc: "not-authorized",
      },
      {
        persistedState: state.value,
        physicalState: "healthy",
        closeReadiness: readiness.value,
        blockers: [],
        phase: "termination",
        ageSuspicious: false,
        gcAuthorized: false,
      },
    );
  }
}

// Readiness × blocker: explicitly covers recoverable, ambiguous, stale, and
// unknown blocker semantics, including blocked-without-blocker ambiguity.
for (const readiness of SESSION_PARITY_EQUIVALENCE_CLASSES.closeReadiness) {
  for (const blocker of SESSION_PARITY_EQUIVALENCE_CLASSES.blockers) {
    addFixture(
      `readiness-${readiness.id}-blocker-${blocker.id}`,
      {
        persistedState: "active",
        closeReadiness: readiness.id,
        blocker: blocker.id,
        phase: "termination",
        terminalIntent: "none",
        age: "normal",
        gc: "not-authorized",
      },
      {
        persistedState: "active",
        physicalState: "healthy",
        closeReadiness: readiness.value,
        blockers: blocker.blockers,
        phase: "termination",
        ageSuspicious: false,
        gcAuthorized: false,
      },
    );
  }
}

// Phase × ready: current readiness must remain active; termination readiness
// may become close-ready.
for (const phase of SESSION_PARITY_EQUIVALENCE_CLASSES.phase) {
  addFixture(
    `phase-${phase.id}-ready`,
    {
      persistedState: "active",
      closeReadiness: "ready",
      phase: phase.id,
      terminalIntent: "none",
      age: "normal",
      gc: "not-authorized",
    },
    {
      persistedState: "active",
      physicalState: "healthy",
      closeReadiness: "ready",
      blockers: [],
      phase: phase.value,
      ageSuspicious: false,
      gcAuthorized: false,
    },
  );
}

// Explicit discard intent × durable state. The observation and persisted
// intent agree, so the machine is tested against the same authoritative fact.
for (const state of ["active", "closing", "closed"] as const) {
  for (const intent of SESSION_PARITY_EQUIVALENCE_CLASSES.terminalIntent.filter(
    (candidate) => candidate.id !== "none",
  )) {
    const isClosed = state === "closed";
    addFixture(
      `intent-${intent.id}-${state}`,
      {
        persistedState: state,
        terminalIntent: intent.id,
        phase: "current",
        age: "normal",
        gc: "not-authorized",
      },
      {
        persistedState: state,
        physicalState: isClosed ? "closed" : "healthy",
        closeReadiness: "not-evaluated",
        blockers: [],
        terminalOperation: "discard",
        ...(intent.id === "persisted-and-observation" ? { persistedTerminalOperation: "discard" } : {}),
        phase: "current",
        ageSuspicious: false,
        gcAuthorized: false,
      },
    );
  }
}

// Age × explicit GC authority at close-ready. This is the destructive-GC
// invariant matrix, not an age-based candidate detector.
for (const age of SESSION_PARITY_EQUIVALENCE_CLASSES.ageSuspicion) {
  for (const gc of SESSION_PARITY_EQUIVALENCE_CLASSES.gcAuthorization) {
    addFixture(
      `gc-age-${age.id}-${gc.id}`,
      {
        persistedState: "active",
        closeReadiness: "ready",
        phase: "termination",
        terminalIntent: "none",
        age: age.id,
        gc: gc.id,
      },
      {
        persistedState: "active",
        physicalState: "healthy",
        closeReadiness: "ready",
        blockers: [],
        phase: "termination",
        ageSuspicious: age.value,
        gcAuthorized: gc.value,
      },
    );
  }
}

// Evidence regressions: integration evidence is deliberately not part of the
// current classifier input, and the evidence envelope cannot grant GC power.
for (const status of SESSION_PARITY_EQUIVALENCE_CLASSES.integrationEvidence) {
  const integration =
    status === "proven"
      ? { status, revision: "revision-proof" }
      : status === "not-proven"
        ? { status }
        : { status, reason: `integration-${status}` };
  addFixture(
    `evidence-integration-${status}`,
    { persistedState: "active", evidence: `integration-${status}`, ...defaultDimensions },
    {
      persistedState: "active",
      ...defaultObservation,
      observationEvidence: { integration },
    },
  );
}

addFixture(
  "evidence-gc-input-only",
  { persistedState: "active", evidence: "gc-input-only", ...defaultDimensions },
  {
    persistedState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    blockers: [],
    phase: "termination",
    ageSuspicious: false,
    inputEvidence: { garbageCollection: { authorized: true } },
  },
);
addFixture(
  "evidence-gc-observation-only",
  { persistedState: "active", evidence: "gc-observation-only", ...defaultDimensions },
  {
    persistedState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    blockers: [],
    phase: "termination",
    ageSuspicious: false,
    observationEvidence: { garbageCollection: { authorized: true } },
  },
);
addFixture(
  "evidence-gc-authority-observation",
  { persistedState: "active", evidence: "gc-observation-authority", ...defaultDimensions },
  {
    persistedState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    blockers: [],
    phase: "termination",
    ageSuspicious: false,
    gcAuthorized: true,
    inputEvidence: { garbageCollection: { authorized: false } },
  },
);

// Dedicated fail-closed cases. Some physical classes are also present in the
// cross-slice matrix; these named cases document the intended safety gates.
addFixture(
  "fail-closed-insufficient-physical-evidence",
  { persistedState: "active", physicalState: "missing", evidence: "insufficient", phase: "termination" },
  {
    persistedState: "active",
    closeReadiness: "ready",
    blockers: [],
    phase: "termination",
    ageSuspicious: false,
    gcAuthorized: true,
  },
);
addFixture(
  "fail-closed-ambiguous-physical-observation",
  { persistedState: "active", physicalState: "ambiguous", evidence: "ambiguous-physical", phase: "termination" },
  {
    persistedState: "active",
    physicalState: "invalid",
    closeReadiness: "ready",
    blockers: [{ code: "GIT_STATE_AMBIGUOUS" }],
    phase: "termination",
    ageSuspicious: true,
    gcAuthorized: true,
  },
);
addFixture(
  "fail-closed-ambiguous-blockers",
  { persistedState: "active", blocker: "ambiguous", evidence: "ambiguous-blockers", phase: "termination" },
  {
    persistedState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    blockers: [{ code: "OWNERSHIP_MISMATCH", classification: "ambiguous" }],
    phase: "termination",
    ageSuspicious: true,
    gcAuthorized: true,
  },
);
addFixture(
  "fail-closed-unknown-blocker-semantics",
  { persistedState: "active", blocker: "unknown", evidence: "unknown-blocker", phase: "termination" },
  {
    persistedState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    blockers: [{ code: "FUTURE_BLOCKER" }],
    phase: "termination",
    ageSuspicious: true,
    gcAuthorized: true,
  },
);
addFixture(
  "fail-closed-stale-evidence",
  { persistedState: "active", blocker: "stale", evidence: "stale", phase: "termination" },
  {
    persistedState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    blockers: [{ code: "STALE_REGISTRY", classification: "stale" }],
    phase: "termination",
    ageSuspicious: true,
    gcAuthorized: true,
  },
);
addFixture(
  "fail-closed-unknown-session-state",
  { persistedState: "active", sessionState: "unknown", evidence: "unknown-session", phase: "termination" },
  {
    persistedState: "active",
    sessionState: "future-session-state",
    physicalState: "healthy",
    closeReadiness: "ready",
    blockers: [],
    phase: "termination",
    ageSuspicious: true,
    gcAuthorized: true,
  },
);

export const SESSION_PARITY_FIXTURES: readonly SessionParityFixture[] = Object.freeze(fixtures);

export type ParityTransitionProjection = {
  readonly operation: SessionLifecycleOperation;
  readonly eventType: string;
  readonly allowed: boolean;
  readonly target: SessionLifecycleState | null;
  readonly requiresExplicitIntent: boolean;
  readonly authority: SessionLifecycleTransition["authority"] | undefined;
  readonly reason: SessionLifecycleTransition["reason"] | undefined;
};

export type ClassifierParityProjection = {
  readonly state: SessionLifecycleState;
  readonly transitions: Readonly<Record<SessionLifecycleOperation, ParityTransitionProjection>>;
};

export type XStateTransitionProjection = ParityTransitionProjection & {
  readonly eventAvailable: boolean;
  readonly accepted: boolean;
  readonly transitionKind: "target" | "self" | "forbidden";
  readonly structuralTarget: string | null;
};

export type XStateParityProjection = {
  readonly state: SessionLifecycleState;
  readonly transitions: Readonly<Record<SessionLifecycleOperation, XStateTransitionProjection>>;
};

/**
 * Projects the frozen #252-baseline oracle, not the production classifier.
 * Since #253 made XState the canonical authority, `classifySessionLifecycle`
 * itself is a thin XState projection — comparing it against `projectXState`
 * would be XState compared to XState. This oracle is the independent
 * semantic authority the parity gate needs to catch real drift.
 */
export function projectClassifier(fixtureToProject: SessionParityFixture): ClassifierParityProjection {
  const classification = classifySessionLifecycleLegacyOracle(fixtureToProject.input.observation);
  const transitions = Object.fromEntries(
    SESSION_PARITY_OPERATIONS.map((operation) => {
      const transition = legacyOracleTransition(classification, operation);
      return [
        operation,
        {
          operation,
          eventType: SESSION_OPERATION_EVENT_TYPES[operation],
          allowed: transition.allowed,
          target: transition.target,
          requiresExplicitIntent: transition.requiresExplicitIntent,
          authority: transition.authority,
          reason: transition.reason,
        },
      ];
    }),
  ) as Record<SessionLifecycleOperation, ParityTransitionProjection>;
  return { state: classification.state, transitions };
}

function eventFor(fixtureToProject: SessionParityFixture, operation: SessionLifecycleOperation): SessionMachineEvent {
  switch (operation) {
    case "inspect":
      return {
        type: "SESSION.OBSERVE",
        observation: fixtureToProject.input.observation,
        ...(fixtureToProject.input.evidence === undefined ? {} : { evidence: fixtureToProject.input.evidence }),
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

function lifecycleState(value: unknown): SessionLifecycleState {
  if (typeof value === "string" && (SESSION_LIFECYCLE_STATES as readonly string[]).includes(value)) {
    return value as SessionLifecycleState;
  }
  throw new Error(`Shadow machine exposed a non-operational state: ${String(value)}`);
}

function metadata(value: unknown): SessionMachineTransitionMetadata | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.operation !== "string" ||
    typeof candidate.requiresExplicitIntent !== "boolean" ||
    typeof candidate.authority !== "string" ||
    typeof candidate.reason !== "string"
  ) {
    return undefined;
  }
  return value as SessionMachineTransitionMetadata;
}

export function projectXState(fixtureToProject: SessionParityFixture): XStateParityProjection {
  const initialActor = createActor(sessionLifecycleMachine, { input: fixtureToProject.input }).start();
  const initialState = lifecycleState(initialActor.getSnapshot().value);
  initialActor.stop();
  const transitions = Object.fromEntries(
    SESSION_PARITY_OPERATIONS.map((operation) => {
      const actor = createActor(sessionLifecycleMachine, { input: fixtureToProject.input }).start();
      const initial = actor.getSnapshot();
      const event = eventFor(fixtureToProject, operation);
      const eventType = event.type;
      const stateNode = sessionLifecycleMachine.getStateNodeById(`${sessionLifecycleMachine.id}.${initialState}`);
      const definitions = stateNode.transitions.get(eventType) ?? [];
      const enabledDefinitions = sessionLifecycleMachine.getTransitionData(initial, event);
      const accepted = initial.can(event);
      const definition = (accepted ? enabledDefinitions[0] : definitions[0]) as
        { readonly target?: readonly { readonly key: string }[]; readonly meta?: unknown } | undefined;
      const transitionMetadata = metadata(definition?.meta);
      const structuralTarget = definition?.target?.map((target) => target.key).join(",") ?? null;
      if (accepted) actor.send(event);
      const finalState = lifecycleState(actor.getSnapshot().value);
      const target = accepted ? finalState : null;
      const transitionKind = !accepted ? "forbidden" : target === initialState ? "self" : "target";
      actor.stop();
      return [
        operation,
        {
          operation,
          eventType,
          allowed: accepted,
          target,
          requiresExplicitIntent: transitionMetadata?.requiresExplicitIntent ?? false,
          authority: transitionMetadata?.authority,
          reason: accepted
            ? transitionMetadata?.reason
            : (transitionMetadata?.forbiddenReason ?? transitionMetadata?.reason),
          eventAvailable: definitions.length > 0,
          accepted,
          transitionKind,
          structuralTarget,
        },
      ];
    }),
  ) as Record<SessionLifecycleOperation, XStateTransitionProjection>;
  return { state: initialState, transitions };
}

function compactObservation(fixtureToFormat: SessionParityFixture): string {
  const observation = fixtureToFormat.input.observation;
  const blockers = (observation.blockers ?? []).map((blocker) => blocker.code).join(",") || "none";
  return [
    `session=${observation.sessionState}`,
    `physical=${observation.physicalState ?? "missing"}`,
    `readiness=${observation.closeReadiness ?? "not-evaluated"}`,
    `blockers=${blockers}`,
    `terminal=${observation.terminalOperation ?? "none"}`,
    `age=${observation.ageSuspicious === true ? "suspicious" : "normal"}`,
    `gc=${observation.gcAuthorized === true ? "authorized" : "denied"}`,
    `phase=${observation.phase ?? "current"}`,
  ].join(",");
}

function compact(value: unknown): string {
  return String(value);
}

export function parityMismatches(fixtureToCompare: SessionParityFixture): readonly string[] {
  const classifier = projectClassifier(fixtureToCompare);
  const shadow = projectXState(fixtureToCompare);
  const mismatches: string[] = [];
  if (classifier.state !== shadow.state) {
    mismatches.push(`state classifier=${classifier.state} xstate=${shadow.state}`);
  }
  for (const operation of SESSION_PARITY_OPERATIONS) {
    const expected = classifier.transitions[operation];
    const actual = shadow.transitions[operation];
    const fields: readonly [string, unknown, unknown][] = [
      ["allowed", expected.allowed, actual.allowed],
      ["target", expected.target, actual.target],
      ["requiresExplicitIntent", expected.requiresExplicitIntent, actual.requiresExplicitIntent],
      ["authority", expected.authority, actual.authority],
      ["reason", expected.reason, actual.reason],
      ["eventType", expected.eventType, actual.eventType],
      ["eventAvailable", true, actual.eventAvailable],
      [
        "transitionKind",
        expected.allowed ? (expected.target === classifier.state ? "self" : "target") : "forbidden",
        actual.transitionKind,
      ],
    ];
    for (const [field, expectedValue, actualValue] of fields) {
      if (expectedValue !== actualValue) {
        mismatches.push(`${operation}.${field} classifier=${compact(expectedValue)} xstate=${compact(actualValue)}`);
      }
    }
  }
  return Object.freeze(mismatches);
}

export function assertSessionParity(fixtureToAssert: SessionParityFixture): void {
  const mismatches = parityMismatches(fixtureToAssert);
  if (mismatches.length === 0) return;
  const classifier = projectClassifier(fixtureToAssert);
  const shadow = projectXState(fixtureToAssert);
  const operation = SESSION_PARITY_OPERATIONS.find((candidate) => mismatches[0]?.startsWith(`${candidate}.`));
  const expected = operation === undefined ? undefined : classifier.transitions[operation];
  const actual = operation === undefined ? undefined : shadow.transitions[operation];
  throw new Error(
    [
      "Session lifecycle parity mismatch",
      `fixture=${fixtureToAssert.id}`,
      `dimensions=${Object.entries(fixtureToAssert.dimensions)
        .map(([key, value]) => `${key}=${value}`)
        .join(",")}`,
      `observation=${compactObservation(fixtureToAssert)}`,
      `classifier: state=${classifier.state}${expected === undefined ? "" : ` operation=${operation} allowed=${expected.allowed} target=${expected.target ?? "null"} reason=${expected.reason ?? "none"} explicit=${expected.requiresExplicitIntent} authority=${expected.authority ?? "none"}`}`,
      `xstate: state=${shadow.state}${actual === undefined ? "" : ` event=${actual.eventType} available=${actual.eventAvailable} accepted=${actual.accepted} kind=${actual.transitionKind} target=${actual.target ?? "null"} reason=${actual.reason ?? "none"} explicit=${actual.requiresExplicitIntent} authority=${actual.authority ?? "none"}`}`,
      `diff=${mismatches.join("; ")}`,
    ].join("\n"),
  );
}
