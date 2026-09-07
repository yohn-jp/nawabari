import assert from "node:assert/strict";
import test from "node:test";
import { createTestModel, getShortestPaths, toDirectedGraph, type AdjacencyMap } from "xstate/graph";

import {
  classifySessionLifecycle,
  lifecycleTransition,
  SESSION_LIFECYCLE_STATES,
  SESSION_LIFECYCLE_TRANSITION_TABLE,
  type SessionLifecycleOperation,
  type SessionLifecycleObservation,
  type SessionLifecycleState,
  type SessionLifecycleTransition,
} from "./session-lifecycle-classification.js";
import { SESSION_OPERATION_EVENT_TYPES, sessionLifecycleMachine } from "./state/session/machine.js";
import type { SessionMachineEvent, SessionMachineInput } from "./state/session/types.js";

const GRAPH_OPERATION_EVENT_TYPES = new Set([
  "SESSION.OBSERVE",
  "SESSION.CLOSE.REQUESTED",
  "SESSION.DISCARD.REQUESTED",
  "SESSION.DOCTOR.REQUESTED",
  "SESSION.RECONCILE.REQUESTED",
  "SESSION.GC.REQUESTED",
]);

const GRAPH_OBSERVATIONS: readonly SessionLifecycleObservation[] = Object.freeze([
  {
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "not-evaluated",
    blockers: [],
    phase: "current",
    ageSuspicious: false,
    gcAuthorized: false,
  },
  {
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    blockers: [],
    phase: "termination",
    ageSuspicious: false,
    gcAuthorized: true,
  },
  // Same lifecycle state (close-ready) as the fixture above, differing only
  // in the GC authority guard's outcome. Both variants must be observed by
  // the graph traversal so the guarded static projection's two branches are
  // conformance-checked, not inferred from state identity alone (#266).
  {
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    blockers: [],
    phase: "termination",
    ageSuspicious: false,
    gcAuthorized: false,
  },
  {
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "external_evidence_required",
    blockers: [{ code: "RECOVERABLE_COMMITS" }],
    phase: "termination",
    ageSuspicious: false,
    gcAuthorized: false,
  },
  {
    sessionState: "active",
    physicalState: "unavailable",
    closeReadiness: "not-evaluated",
    blockers: [],
    phase: "current",
    ageSuspicious: false,
    gcAuthorized: false,
  },
  {
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "not-evaluated",
    terminalOperation: "discard",
    blockers: [],
    phase: "current",
    ageSuspicious: false,
    gcAuthorized: false,
  },
  {
    sessionState: "closed",
    physicalState: "closed",
    closeReadiness: "ready",
    blockers: [],
    phase: "termination",
    ageSuspicious: false,
    gcAuthorized: false,
  },
]);

const GRAPH_INPUT: SessionMachineInput = {
  persisted: { sessionId: "session-graph-test", state: "active" },
  observation: GRAPH_OBSERVATIONS[0]!,
};

type GraphSnapshot = ReturnType<typeof sessionLifecycleMachine.getInitialSnapshot>;

function graphEvents(_snapshot: GraphSnapshot): readonly SessionMachineEvent[] {
  return [
    ...GRAPH_OBSERVATIONS.map((observation) => ({ type: "SESSION.OBSERVE", observation }) as const),
    { type: "SESSION.CLOSE.REQUESTED" },
    { type: "SESSION.DISCARD.REQUESTED" },
    { type: "SESSION.DOCTOR.REQUESTED" },
    { type: "SESSION.RECONCILE.REQUESTED" },
    { type: "SESSION.GC.REQUESTED" },
  ];
}

function graphOptions() {
  return {
    input: GRAPH_INPUT,
    events: graphEvents,
    filterEvents: (_snapshot: GraphSnapshot, event: SessionMachineEvent) => GRAPH_OPERATION_EVENT_TYPES.has(event.type),
    limit: 2_000,
  } as const;
}

function publicState(value: unknown): SessionLifecycleState {
  assert.equal(typeof value, "string", `non-operational graph state: ${String(value)}`);
  assert.equal((SESSION_LIFECYCLE_STATES as readonly string[]).includes(value as string), true, String(value));
  return value as SessionLifecycleState;
}

function operationForEvent(source: GraphSnapshot, event: SessionMachineEvent): SessionLifecycleOperation | undefined {
  if (event.type === "SESSION.OBSERVE") {
    // The same internal event also carries re-observation fixtures used to
    // reach every state. Only the observation identical to the source is the
    // public inspect operation for this adjacency edge.
    return JSON.stringify(source.context.observation) === JSON.stringify(event.observation) ? "inspect" : undefined;
  }
  const operation = (
    Object.entries(SESSION_OPERATION_EVENT_TYPES) as readonly [SessionLifecycleOperation, string][]
  ).find(([, eventType]) => eventType === event.type)?.[0];
  return operation;
}

type ObservedTransition = {
  readonly accepted: boolean;
  readonly target: SessionLifecycleState;
  readonly reason: SessionLifecycleTransition["reason"];
  readonly authority: SessionLifecycleTransition["authority"];
  readonly requiresExplicitIntent: boolean;
};

function assertReachableStateAndTransitionCoverage(adjacency: AdjacencyMap<GraphSnapshot, SessionMachineEvent>): void {
  const reachableStates = new Set<string>();
  const observed = new Map<string, ObservedTransition>();
  const directed = toDirectedGraph(sessionLifecycleMachine);
  const directedNodes = new Map(directed.children.map((node) => [node.id, node]));

  for (const state of SESSION_LIFECYCLE_STATES) {
    const node = directedNodes.get(`${sessionLifecycleMachine.id}.${state}`);
    if (node === undefined) throw new Error(`graph is missing operational node: ${state}`);
    for (const operation of ["close", "discard", "inspect", "doctor", "reconcile", "gc"] as const) {
      const eventType = SESSION_OPERATION_EVENT_TYPES[operation];
      assert.equal(
        node.edges.some((edge) => edge.label.text === eventType),
        true,
        `directed graph is missing ${state}.${operation}`,
      );
    }
  }

  for (const adjacencyValue of Object.values(adjacency)) {
    const source = adjacencyValue.state;
    const sourceState = publicState(source.value);
    const observedState = classifySessionLifecycle(source.context.observation).state;
    reachableStates.add(sourceState);
    // An operation transition changes the operational machine state before a
    // new authoritative observation is supplied. Do not use such a
    // state/context-drift snapshot as a semantic fixture; canonical observe
    // paths below provide the same state with matching authoritative facts.
    if (observedState !== sourceState) continue;
    const transitions = Object.values(adjacencyValue.transitions) as readonly {
      readonly event: SessionMachineEvent;
      readonly state: GraphSnapshot;
    }[];
    for (const transition of transitions) {
      const operation = operationForEvent(source, transition.event);
      if (operation === undefined) continue;
      const expected = lifecycleTransition(classifySessionLifecycle(source.context.observation), operation);
      const accepted = source.can(transition.event);
      const target = publicState(transition.state.value);
      assert.equal(accepted, expected.allowed, `${sourceState}.${operation} accepted mismatch`);
      if (expected.allowed) {
        assert.equal(target, expected.target, `${sourceState}.${operation} target mismatch`);
      } else {
        // A forbidden event may be structurally available, but it must not
        // produce an operational target. The separate `accepted` assertion
        // above distinguishes this from a valid self transition.
        assert.equal(target, sourceState, `${sourceState}.${operation} changed while forbidden`);
      }
      observed.set(`${sourceState}.${operation}.${accepted ? "accepted" : "forbidden"}`, {
        accepted,
        target,
        reason: expected.reason,
        authority: expected.authority,
        requiresExplicitIntent: expected.requiresExplicitIntent,
      });
    }
  }

  assert.deepEqual([...reachableStates].sort(), [...SESSION_LIFECYCLE_STATES].sort());
  for (const state of SESSION_LIFECYCLE_STATES) {
    const stateNode = sessionLifecycleMachine.getStateNodeById(`${sessionLifecycleMachine.id}.${state}`);
    for (const operation of ["close", "discard", "inspect", "doctor", "reconcile", "gc"] as const) {
      const eventType = SESSION_OPERATION_EVENT_TYPES[operation];
      assert.equal((stateNode.transitions.get(eventType) ?? []).length > 0, true, `${state}.${operation} is unmodeled`);
      const expected = SESSION_LIFECYCLE_TRANSITION_TABLE[state].find(
        (transition) => transition.operation === operation,
      )!;
      if (expected.guarded) {
        // A guard-dependent edge has no single admissibility verdict from
        // state identity alone: the graph traversal must observe both the
        // guard-accepts and guard-rejects branches from distinct
        // observations in the same lifecycle state, and each observed
        // branch must carry the full public transition metadata the static
        // projection promises for it — allowed, target, reason, authority,
        // and requiresExplicitIntent (#266).
        const acceptedKey = `${state}.${operation}.accepted`;
        const forbiddenKey = `${state}.${operation}.forbidden`;
        assert.equal(observed.has(acceptedKey), true, `graph did not cover ${acceptedKey}`);
        assert.equal(observed.has(forbiddenKey), true, `graph did not cover ${forbiddenKey}`);

        const acceptedCoverage = observed.get(acceptedKey)!;
        assert.equal(acceptedCoverage.accepted, true, `${acceptedKey} availability drift`);
        assert.equal(acceptedCoverage.target, expected.whenGuardAccepts.target, `${acceptedKey} target drift`);
        assert.equal(acceptedCoverage.reason, expected.whenGuardAccepts.reason, `${acceptedKey} reason drift`);
        assert.equal(acceptedCoverage.authority, expected.authority, `${acceptedKey} authority drift`);
        assert.equal(
          acceptedCoverage.requiresExplicitIntent,
          expected.requiresExplicitIntent,
          `${acceptedKey} requiresExplicitIntent drift`,
        );

        const forbiddenCoverage = observed.get(forbiddenKey)!;
        assert.equal(forbiddenCoverage.accepted, false, `${forbiddenKey} availability drift`);
        assert.equal(forbiddenCoverage.reason, expected.whenGuardRejects.reason, `${forbiddenKey} reason drift`);
        assert.equal(forbiddenCoverage.authority, expected.authority, `${forbiddenKey} authority drift`);
        assert.equal(
          forbiddenCoverage.requiresExplicitIntent,
          expected.requiresExplicitIntent,
          `${forbiddenKey} requiresExplicitIntent drift`,
        );
        continue;
      }
      const expectedKind = expected.allowed ? "accepted" : "forbidden";
      const key = `${state}.${operation}.${expectedKind}`;
      assert.equal(observed.has(key), true, `graph did not cover ${key}`);
      const coverage = observed.get(key)!;
      assert.equal(coverage.accepted, expected.allowed, `${key} availability drift`);
      assert.equal(coverage.reason, expected.reason, `${key} reason drift`);
      assert.equal(coverage.authority, expected.authority, `${key} authority drift`);
      assert.equal(
        coverage.requiresExplicitIntent,
        expected.requiresExplicitIntent,
        `${key} requiresExplicitIntent drift`,
      );
      if (expected.allowed) assert.equal(coverage.target, expected.target, `${key} target drift`);
    }
  }
}

test("XState graph traversal reaches exactly the public operational states", () => {
  const options = graphOptions();
  const model = createTestModel(sessionLifecycleMachine, options);
  const modelPaths = model.getShortestPaths();
  const directPaths = getShortestPaths(sessionLifecycleMachine, options);
  const modelStates = new Set(modelPaths.map((path) => publicState(path.state.value)));
  const directStates = new Set(directPaths.map((path) => publicState(path.state.value)));
  assert.deepEqual([...modelStates].sort(), [...SESSION_LIFECYCLE_STATES].sort());
  assert.deepEqual([...directStates].sort(), [...SESSION_LIFECYCLE_STATES].sort());
  assert.equal(
    modelPaths.some((path) => path.state.value === "classify"),
    false,
  );
  assert.equal(
    directPaths.some((path) => path.state.value === "classify"),
    false,
  );

  const directed = toDirectedGraph(sessionLifecycleMachine);
  const operationalNodeIds = directed.children
    .filter((node) => node.id !== `${sessionLifecycleMachine.id}.classify`)
    .map((node) => node.id.split(".").at(-1));
  assert.deepEqual(operationalNodeIds.sort(), [...SESSION_LIFECYCLE_STATES].sort());
  assert.equal(
    directed.children.some((node) => node.id === `${sessionLifecycleMachine.id}.classify`),
    true,
  );
});

test("graph adjacency covers accepted and forbidden lifecycle transitions", () => {
  const model = createTestModel(sessionLifecycleMachine, graphOptions());
  assertReachableStateAndTransitionCoverage(model.getAdjacencyMap());
});
