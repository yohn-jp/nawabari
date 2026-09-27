import assert from "node:assert/strict";
import { test } from "node:test";

import { DomainError, failure, success } from "./errors.js";
import { createSessionActions, type SessionActionIdentity } from "./session-actions.js";
import type {
  SessionBackend,
  SessionContext,
  SessionDiagnostic,
  SessionLifecycleAction,
  SessionRecord,
} from "./session.js";
import type { SessionLifecycleParkResumeAction } from "../session-lifecycle-actions.js";

const context: SessionContext = { cwd: "/repo" };

function session(): SessionRecord {
  return {
    schema_version: 1,
    session_id: "one",
    repository: "/repo",
    worktree: "/worktrees/one",
    branch: "feature/one",
    state: "active",
    created_at: "created",
    updated_at: "one-updated",
  };
}

function identity(record: SessionRecord): SessionActionIdentity {
  return { session_id: record.session_id, repository: record.repository, worktree: record.worktree };
}

function diagnosticFor(record: SessionRecord, nextActions: readonly SessionLifecycleAction[]): SessionDiagnostic {
  return {
    schema_version: 1,
    session_id: record.session_id,
    repository: record.repository,
    worktree: record.worktree,
    branch: record.branch,
    session: record,
    claims: [],
    physical_state: "healthy",
    close_readiness: "blocked",
    cleanup_readiness: "blocked",
    result_state: "complete",
    idempotent: false,
    blockers: [],
    safe_actions: nextActions.map((action) => action.action_id),
    next_actions: [...nextActions],
    integration_evidence: { supplied: false },
  };
}

const closeAction: SessionLifecycleAction = {
  schema_version: 1,
  action_id: "supply-exact-integrated-revision",
  kind: "integrated-revision",
  command: "session close",
  integrated_revision: "integrated-head",
};

const retainAction: SessionLifecycleAction = {
  schema_version: 1,
  action_id: "retain-session",
  kind: "retain",
  command: "session inspect",
  reason: "no-safe-transition-proven",
};

const parkAction: SessionLifecycleParkResumeAction = {
  schemaVersion: 2,
  actionId: "park-session",
  kind: "park",
  command: "session action",
  sessionId: "one",
  requiresExplicitIntent: true,
  mutates: true,
};

test("identical concurrent dispatches coalesce, then later calls recheck current state", async () => {
  let record = session();
  let actions: readonly SessionLifecycleAction[] = [closeAction];
  let closeCalls = 0;
  let announceClose!: () => void;
  let finishClose!: () => void;
  const closeStarted = new Promise<void>((resolve) => {
    announceClose = resolve;
  });
  const closeGate = new Promise<void>((resolve) => {
    finishClose = resolve;
  });

  const backend = {
    sessionDiagnostic: async (_context: SessionContext, options: { session_id: string | null }) => {
      if (options.session_id !== record.session_id) return failure(new DomainError("SESSION_NOT_FOUND", "missing"));
      return success(diagnosticFor(record, actions));
    },
    listClaims: async () => success({ claims: [], claim_set_generation: 1 }),
    closeSession: async () => {
      closeCalls += 1;
      announceClose();
      await closeGate;
      return success({
        session: record,
        worktree_removed: true,
        branch_removed: true,
        claim_set_generation: 1,
      });
    },
  } as unknown as SessionBackend;
  const dispatcher = createSessionActions(backend, context);
  const sessionIdentity = identity(record);
  const snapshot = await dispatcher.readSessionActionSnapshot(sessionIdentity);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;

  const confirmation = { confirmed: true, operation_id: "close-one" } as const;
  const first = dispatcher.dispatchSessionAction(
    closeAction.action_id,
    sessionIdentity,
    snapshot.value.token,
    confirmation,
  );
  const concurrent = dispatcher.dispatchSessionAction(
    closeAction.action_id,
    sessionIdentity,
    snapshot.value.token,
    confirmation,
  );
  await closeStarted;
  assert.equal(closeCalls, 1);
  finishClose();
  const [firstResult, concurrentResult] = await Promise.all([first, concurrent]);
  assert.deepEqual(concurrentResult, firstResult);

  record = { ...record, state: "closed", updated_at: "one-closed" };
  actions = [];
  const later = await dispatcher.dispatchSessionAction(
    closeAction.action_id,
    sessionIdentity,
    snapshot.value.token,
    confirmation,
  );
  assert.equal(later.ok, false);
  if (!later.ok) assert.equal(later.error.code, "STALE_SESSION");
  assert.equal(closeCalls, 1);
});

test("a failed action lookup is not cached over a later current decision", async () => {
  const record = session();
  let actions: readonly SessionLifecycleAction[] = [];
  let diagnosticReads = 0;
  const backend = {
    sessionDiagnostic: async () => {
      diagnosticReads += 1;
      return success(diagnosticFor(record, actions));
    },
    listClaims: async () => success({ claims: [], claim_set_generation: 1 }),
  } as unknown as SessionBackend;
  const dispatcher = createSessionActions(backend, context);
  const sessionIdentity = identity(record);
  const snapshot = await dispatcher.readSessionActionSnapshot(sessionIdentity);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;

  const rejected = await dispatcher.dispatchSessionAction("retain-session", sessionIdentity, snapshot.value.token, {
    confirmed: false,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "OPERATION_REJECTED");

  actions = [retainAction];
  const current = await dispatcher.dispatchSessionAction("retain-session", sessionIdentity, snapshot.value.token, {
    confirmed: false,
  });
  assert.equal(current.ok, true);
  if (current.ok) assert.equal(current.value.status, "observed");
  assert.equal(diagnosticReads, 3);
});

test("park dispatch rejects stale tokens and absent lifecycle actions before the backend", async () => {
  let record = session();
  let parkAvailable = true;
  let parkCalls = 0;
  const backend = {
    sessionDiagnostic: async () =>
      success({
        ...diagnosticFor(record, []),
        park_resume_actions: parkAvailable ? [parkAction] : [],
      }),
    listClaims: async () => success({ claims: [], claim_set_generation: 1 }),
    parkSession: async () => {
      parkCalls += 1;
      return success({
        schemaVersion: 1,
        operation: "park",
        operationId: "must-not-run",
        sessionId: record.session_id,
        status: "parked",
        claimSetGeneration: 2,
      });
    },
  } as unknown as SessionBackend;
  const dispatcher = createSessionActions(backend, context);
  const sessionIdentity = identity(record);
  const initial = await dispatcher.readSessionActionSnapshot(sessionIdentity);
  assert.equal(initial.ok, true);
  if (!initial.ok) return;

  record = { ...record, updated_at: "one-updated-again" };
  parkAvailable = false;
  const stale = await dispatcher.dispatchSessionAction("park-session", sessionIdentity, initial.value.token, {
    confirmed: true,
  });
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "STALE_SESSION");
  assert.equal(parkCalls, 0);

  const current = await dispatcher.readSessionActionSnapshot(sessionIdentity);
  assert.equal(current.ok, true);
  if (!current.ok) return;
  const absent = await dispatcher.dispatchSessionAction("park-session", sessionIdentity, current.value.token, {
    confirmed: true,
  });
  assert.equal(absent.ok, false);
  if (!absent.ok) assert.equal(absent.error.code, "OPERATION_REJECTED");
  assert.equal(parkCalls, 0);
});

test("park actions require explicit intent and preserve uncertain retention outcomes without caching completion", async () => {
  const record = session();
  let parkCalls = 0;
  const operationIds: (string | undefined)[] = [];
  const backend = {
    sessionDiagnostic: async () => success({ ...diagnosticFor(record, []), park_resume_actions: [parkAction] }),
    listClaims: async () => success({ claims: [], claim_set_generation: 1 }),
    parkSession: async (_context: unknown, _sessionId: string, operationId?: string) => {
      parkCalls += 1;
      operationIds.push(operationId);
      return success({
        schemaVersion: 1,
        operation: "park",
        operationId: `park-${parkCalls}`,
        sessionId: record.session_id,
        status: "uncertain",
        claimSetGeneration: null,
        reconciliation: {
          status: "unknown",
          operationId: `park-${parkCalls}`,
          reason: "directory durability is not proven",
        },
      });
    },
  } as unknown as SessionBackend;
  const dispatcher = createSessionActions(backend, context);
  const sessionIdentity = identity(record);
  const snapshot = await dispatcher.readSessionActionSnapshot(sessionIdentity);
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;

  const denied = await dispatcher.dispatchSessionAction("park-session", sessionIdentity, snapshot.value.token, {
    confirmed: false,
  });
  assert.equal(denied.ok, false);
  if (!denied.ok) assert.equal(denied.error.code, "OPERATION_REJECTED");
  assert.equal(parkCalls, 0);

  const first = await dispatcher.dispatchSessionAction("park-session", sessionIdentity, snapshot.value.token, {
    confirmed: true,
    operation_id: "park-retry-key",
  });
  assert.equal(first.ok, true);
  if (first.ok) {
    assert.equal(first.value.action_id, "park-session");
    assert.equal(first.value.status, "uncertain");
    if (first.value.status === "uncertain") {
      assert.equal(first.value.result.status, "uncertain");
      assert.equal(first.value.result.reconciliation?.status, "unknown");
    }
  }

  const later = await dispatcher.dispatchSessionAction("park-session", sessionIdentity, snapshot.value.token, {
    confirmed: true,
    operation_id: "park-retry-key",
  });
  assert.equal(later.ok, true);
  assert.equal(parkCalls, 2);
  assert.deepEqual(operationIds, ["park-retry-key", "park-retry-key"]);
});
