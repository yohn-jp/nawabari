import assert from "node:assert/strict";
import test from "node:test";

import { availableLifecycleOperations, classifySessionLifecycle } from "./session-lifecycle-classification.js";
import {
  primarySessionLifecycleAction,
  projectSessionLifecycleActions,
  projectSessionLifecycleParkResumeActions,
  SESSION_LIFECYCLE_PARK_RESUME_ACTION_SCHEMA_VERSION,
  reconciliationApplyAction,
} from "./session-lifecycle-actions.js";

test("projects recoverable commits into retain plus explicit discard without executing either", () => {
  const classification = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "external_evidence_required",
    blockers: [{ code: "RECOVERABLE_COMMITS" }],
    phase: "termination",
  });

  const actions = projectSessionLifecycleActions({
    classification,
    sessionId: "session-1",
    blockers: [{ code: "RECOVERABLE_COMMITS", details: {} }],
  });
  assert.deepEqual(
    actions.map((candidate) => candidate.actionId),
    ["retain-session", "discard-session"],
  );
  assert.equal(actions[1]?.kind, "explicit-discard");
  assert.equal((actions[1] as { sessionId: string }).sessionId, "session-1");
  assert.equal((actions[1] as { requiresExplicitIntent: boolean }).requiresExplicitIntent, true);
});

test("projects an authoritative exact revision only when its proof is explicitly positive", () => {
  const classification = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "external_evidence_required",
    blockers: [{ code: "RECOVERABLE_COMMITS" }],
    phase: "termination",
  });
  const actions = projectSessionLifecycleActions({
    classification,
    sessionId: "session-2",
    blockers: [
      {
        code: "RECOVERABLE_COMMITS",
        details: {
          nextIntegratedRevision: "a".repeat(40),
          nextIntegratedRevisionProof: "authoritative",
        },
      },
    ],
  });
  assert.equal(actions[0]?.actionId, "supply-exact-integrated-revision");
  assert.equal((actions[0] as { integratedRevision: string }).integratedRevision, "a".repeat(40));
  assert.equal(actions[1]?.actionId, "retain-session");
  assert.equal(actions[2]?.actionId, "discard-session");
});

test("projects the existing bounded fetch retry with only authoritative parameters", () => {
  const classification = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "blocked",
    blockers: [{ code: "INTEGRATION_FETCH_FAILED" }],
    phase: "termination",
  });
  const action = primarySessionLifecycleAction({
    classification,
    sessionId: "session-3",
    blockers: [
      {
        code: "INTEGRATION_FETCH_FAILED",
        details: {
          integratedRevision: "b".repeat(40),
          remote: "origin",
          branch: "main",
        },
      },
    ],
  });
  assert.deepEqual(action, {
    schemaVersion: 1,
    actionId: "retry-close-with-bounded-integration-fetch",
    kind: "bounded-integration-fetch",
    command: "session close",
    integratedRevision: "b".repeat(40),
    fetchRemote: "origin",
    fetchBranch: "main",
  });
});

test("ambiguous and terminal states never advertise destructive recovery", () => {
  const ambiguous = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "ambiguous",
    blockers: [{ code: "OWNERSHIP_MISMATCH" }],
    phase: "termination",
  });
  assert.deepEqual(
    projectSessionLifecycleActions({
      classification: ambiguous,
      sessionId: "session-4",
      blockers: [{ code: "OWNERSHIP_MISMATCH", details: {} }],
    }).map((candidate) => candidate.actionId),
    ["reconcile-physical-state"],
  );

  const closed = classifySessionLifecycle({ sessionState: "closed", physicalState: "closed", phase: "termination" });
  assert.deepEqual(projectSessionLifecycleActions({ classification: closed, sessionId: "session-5" }), []);

  const ready = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "healthy",
    closeReadiness: "ready",
    phase: "termination",
  });
  assert.equal(primarySessionLifecycleAction({ classification: ready, sessionId: "session-6" }), undefined);
});

test("v1 physical reconciliation remains diagnostic-only while apply uses an explicit v2 action", () => {
  const classification = classifySessionLifecycle({
    sessionState: "active",
    physicalState: "unavailable",
    closeReadiness: "ambiguous",
    blockers: [{ code: "GIT_COMMAND_FAILED" }],
    phase: "termination",
  });
  const diagnosticAction = primarySessionLifecycleAction({
    classification,
    sessionId: "session-apply",
  });
  assert.deepEqual(diagnosticAction, {
    schemaVersion: 1,
    actionId: "reconcile-physical-state",
    kind: "reconcile",
    command: "doctor",
    sessionId: "session-apply",
    mutates: false,
  });
  assert.deepEqual(reconciliationApplyAction("session-apply"), {
    schemaVersion: 2,
    actionId: "reconcile-physical-state-apply",
    kind: "reconcile-apply",
    command: "session reconcile",
    sessionId: "session-apply",
    requiredArgs: ["--session", "session-apply", "--apply"],
    requiresExplicitIntent: true,
    mutates: true,
  });
});

test("projects versioned park and resume actions only from their canonical source states", () => {
  assert.equal(SESSION_LIFECYCLE_PARK_RESUME_ACTION_SCHEMA_VERSION, 2);
  const active = classifySessionLifecycle({ sessionState: "active", physicalState: "healthy" });
  assert.deepEqual(projectSessionLifecycleParkResumeActions({ classification: active, sessionId: "session-park" }), [
    {
      schemaVersion: SESSION_LIFECYCLE_PARK_RESUME_ACTION_SCHEMA_VERSION,
      actionId: "park-session",
      kind: "park",
      command: "session action",
      sessionId: "session-park",
      requiresExplicitIntent: true,
      mutates: true,
    },
  ]);
  assert.deepEqual(projectSessionLifecycleActions({ classification: active, sessionId: "session-park" }), []);

  const parked = classifySessionLifecycle({ sessionState: "parked", physicalState: "healthy" });
  assert.deepEqual(projectSessionLifecycleParkResumeActions({ classification: parked, sessionId: "session-resume" }), [
    {
      schemaVersion: SESSION_LIFECYCLE_PARK_RESUME_ACTION_SCHEMA_VERSION,
      actionId: "resume-session",
      kind: "resume",
      command: "session action",
      sessionId: "session-resume",
      requiresExplicitIntent: true,
      mutates: true,
    },
  ]);
  assert.deepEqual(projectSessionLifecycleActions({ classification: parked, sessionId: "session-resume" }), []);

  const unavailable = [
    classifySessionLifecycle({ sessionState: "active", physicalState: "unavailable" }),
    classifySessionLifecycle({ sessionState: "parked", physicalState: "unavailable" }),
    classifySessionLifecycle({
      sessionState: "active",
      physicalState: "healthy",
      phase: "termination",
      closeReadiness: "ready",
    }),
    classifySessionLifecycle({
      sessionState: "active",
      physicalState: "healthy",
      blockers: [{ code: "RECOVERABLE_COMMITS" }],
    }),
    classifySessionLifecycle({ sessionState: "closed", physicalState: "closed" }),
  ];
  for (const classification of unavailable) {
    assert.deepEqual(
      projectSessionLifecycleParkResumeActions({ classification, sessionId: "session-unavailable" }),
      [],
    );
  }
});

test("next-actions and operation availability follow the XState transition projection for every public state", () => {
  const cases = [
    {
      id: "active",
      observation: { sessionState: "active", physicalState: "healthy", phase: "current" as const },
      actions: [],
      available: ["close", "discard", "inspect", "doctor", "reconcile", "park"],
    },
    {
      id: "close-ready",
      observation: {
        sessionState: "active",
        physicalState: "healthy",
        closeReadiness: "ready" as const,
        phase: "termination" as const,
      },
      actions: [],
      available: ["close", "discard", "inspect", "doctor", "reconcile"],
    },
    {
      id: "blocked-recoverable",
      observation: {
        sessionState: "active",
        physicalState: "healthy",
        closeReadiness: "external_evidence_required" as const,
        blockers: [{ code: "RECOVERABLE_COMMITS" }],
        phase: "termination" as const,
      },
      actions: ["retain-session", "discard-session"],
      available: ["discard", "inspect", "doctor", "reconcile"],
    },
    {
      id: "stale-inconsistent",
      observation: {
        sessionState: "active",
        physicalState: "unavailable",
        closeReadiness: "ambiguous" as const,
        blockers: [{ code: "GIT_COMMAND_FAILED" }],
        phase: "termination" as const,
      },
      actions: ["reconcile-physical-state"],
      available: ["inspect", "doctor", "reconcile"],
    },
    {
      id: "discarded",
      observation: {
        sessionState: "closing",
        physicalState: "healthy",
        terminalOperation: "discard" as const,
        phase: "termination" as const,
      },
      actions: [],
      available: ["discard", "inspect", "doctor", "reconcile"],
    },
    {
      id: "closed",
      observation: {
        sessionState: "closed",
        physicalState: "closed",
        closeReadiness: "ready" as const,
        phase: "termination" as const,
      },
      actions: [],
      available: ["close", "inspect", "doctor", "reconcile"],
    },
    {
      id: "parked",
      observation: {
        sessionState: "parked",
        physicalState: "healthy",
        phase: "current" as const,
      },
      actions: [],
      available: ["close", "discard", "inspect", "doctor", "reconcile", "park", "resume"],
    },
    {
      id: "parked",
      observation: {
        sessionState: "parked",
        physicalState: "healthy",
        closeReadiness: "external_evidence_required" as const,
        blockers: [{ code: "RECOVERABLE_COMMITS" }],
        phase: "termination" as const,
      },
      actions: ["retain-session", "discard-session"],
      available: ["discard", "inspect", "doctor", "reconcile", "park", "resume"],
    },
  ] as const;

  for (const candidate of cases) {
    const classification = classifySessionLifecycle(candidate.observation);
    assert.equal(classification.state, candidate.id);
    assert.deepEqual(
      projectSessionLifecycleActions({
        classification,
        sessionId: `session-${candidate.id}`,
        blockers:
          "blockers" in candidate.observation
            ? candidate.observation.blockers.map((blocker) => ({ code: blocker.code, details: {} }))
            : undefined,
      }).map((action) => action.actionId),
      candidate.actions,
    );
    assert.deepEqual(availableLifecycleOperations(classification), candidate.available);
  }
});
