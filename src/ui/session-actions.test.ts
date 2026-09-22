import assert from "node:assert/strict";
import { test } from "node:test";

import { failure, success, DomainError } from "../domain/errors.js";
import type {
  SessionBackend,
  SessionContext,
  SessionDiagnostic,
  SessionDiscardPreview,
  SessionDiscardResult,
  SessionLifecycleAction,
  SessionRecord,
} from "../domain/session.js";
import { createSessionActions, parseSessionDiscardPreview, type SessionActionIdentity } from "./session-actions.js";

const context: SessionContext = { cwd: "/repo" };

function session(sessionId: string, updatedAt = `${sessionId}-updated`): SessionRecord {
  return {
    schema_version: 1,
    session_id: sessionId,
    repository: "repo",
    worktree: `/worktrees/${sessionId}`,
    branch: `feature/${sessionId}`,
    state: "active",
    created_at: `${sessionId}-created`,
    updated_at: updatedAt,
  };
}

function identity(record: SessionRecord): SessionActionIdentity {
  return {
    session_id: record.session_id,
    repository: record.repository,
    worktree: record.worktree,
  };
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

function discardPreviewFor(record: SessionRecord): SessionDiscardPreview {
  return {
    schema_version: 1,
    operation: "discard-preview",
    destructive: true,
    warning: "discard is destructive",
    session_id: record.session_id,
    repository: record.repository,
    worktree: record.worktree,
    branch: record.branch,
    session: record,
    current_state: record.state,
    persisted_state: record.state,
    physical_state: "healthy",
    worktree_present: true,
    branch_present: true,
    head: "head",
    worktree_head: "head",
    branch_head: "head",
    expected_head: "head",
    recoverable_commits: { observable: true, present: false, evidence: [] },
    uncommitted_work: { observable: true, present: false, evidence: [] },
    claims: [],
    claim_count: 0,
    claims_truncated: false,
    destructive_scope: {
      worktree: true,
      branch: true,
      unintegrated_commits: false,
      uncommitted_work: false,
      claims: 0,
    },
    diagnostic: {
      close_readiness: "blocked",
      cleanup_readiness: "blocked",
      result_state: "complete",
      blockers: [],
    },
  };
}

function discardPreviewForHead(record: SessionRecord, head: string): SessionDiscardPreview {
  const preview = discardPreviewFor(record);
  return {
    ...preview,
    head,
    worktree_head: head,
    branch_head: head,
    expected_head: head,
  };
}

function discardResultFor(record: SessionRecord): SessionDiscardResult {
  return {
    schema_version: 1,
    operation: "discard",
    session: { ...record, state: "closed" },
    final_state: "closed",
    previous_head: "head",
    worktree_path: record.worktree,
    branch_name: record.branch,
    worktree_removed: true,
    branch_removed: true,
    released_claims: [],
    released_claim_count: 0,
    released_claims_truncated: false,
    idempotent: false,
    claim_set_generation: 2,
  };
}

function backendFor(
  records: Map<string, SessionRecord>,
  actions: Map<string, readonly SessionLifecycleAction[]>,
  calls: { close: string[]; preview: string[]; discard: string[]; diagnostic: string[] },
  physicalEvidence: { head: string } = { head: "head" },
): SessionBackend {
  return {
    createSession: async () => failure(new DomainError("BACKEND_UNAVAILABLE", "unused")),
    resolveCurrentSession: async () => failure(new DomainError("BACKEND_UNAVAILABLE", "unused")),
    getSession: async (_context, sessionId) => {
      const record = records.get(sessionId);
      return record === undefined ? failure(new DomainError("SESSION_NOT_FOUND", "missing")) : success(record);
    },
    guard: async () => failure(new DomainError("BACKEND_UNAVAILABLE", "unused")),
    listSessions: async () => failure(new DomainError("BACKEND_UNAVAILABLE", "unused")),
    status: async () => failure(new DomainError("BACKEND_UNAVAILABLE", "unused")),
    closeSession: async (_context, options) => {
      const sessionId = options.session_id;
      if (sessionId === null) return failure(new DomainError("INVALID_SESSION_ID", "missing"));
      calls.close.push(sessionId);
      const record = records.get(sessionId);
      if (record === undefined) return failure(new DomainError("SESSION_NOT_FOUND", "missing"));
      return success({
        session: record,
        worktree_removed: true,
        branch_removed: true,
        claim_set_generation: 1,
      });
    },
    garbageCollect: async () => failure(new DomainError("BACKEND_UNAVAILABLE", "unused")),
    sessionDiagnostic: async (_context, options) => {
      const sessionId = options.session_id;
      if (sessionId === null) return failure(new DomainError("INVALID_SESSION_ID", "missing"));
      calls.diagnostic.push(sessionId);
      const record = records.get(sessionId);
      const candidateActions = actions.get(sessionId);
      return record === undefined || candidateActions === undefined
        ? failure(new DomainError("SESSION_NOT_FOUND", "missing"))
        : success(diagnosticFor(record, candidateActions));
    },
    listClaims: async (_context, sessionId) =>
      success({ claims: [], claim_set_generation: records.has(sessionId ?? "") ? 1 : 0 }),
    discardPreview: async (_context, sessionId) => {
      calls.preview.push(sessionId);
      const record = records.get(sessionId);
      return record === undefined
        ? failure(new DomainError("SESSION_NOT_FOUND", "missing"))
        : success(discardPreviewForHead(record, physicalEvidence.head));
    },
    discardSession: async (_context, sessionId) => {
      calls.discard.push(sessionId);
      const record = records.get(sessionId);
      return record === undefined
        ? failure(new DomainError("SESSION_NOT_FOUND", "missing"))
        : success(discardResultFor(record));
    },
  } as SessionBackend;
}

const closeAction: SessionLifecycleAction = {
  schema_version: 1,
  action_id: "supply-exact-integrated-revision",
  kind: "integrated-revision",
  command: "session close",
  integrated_revision: "integrated-head",
};

const discardAction: SessionLifecycleAction = {
  schema_version: 1,
  action_id: "discard-session",
  kind: "explicit-discard",
  command: "session discard",
  session_id: "one",
  requires_explicit_intent: true,
};

test("reading the UI action snapshot is read-only and carries a claim CAS token", async () => {
  const record = session("one");
  const calls = { close: [], preview: [], discard: [], diagnostic: [] } as {
    close: string[];
    preview: string[];
    discard: string[];
    diagnostic: string[];
  };
  const actions = createSessionActions(
    backendFor(new Map([[record.session_id, record]]), new Map([[record.session_id, [closeAction]]]), calls),
    context,
  );

  const snapshot = await actions.readSessionActionSnapshot(identity(record));
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;
  assert.equal(snapshot.value.token.claim_set_generation, 1);
  assert.deepEqual(calls.close, []);
  assert.deepEqual(calls.preview, []);
  assert.deepEqual(calls.discard, []);
});

test("a stale snapshot is denied before a close and never follows a reordered row", async () => {
  const first = session("one");
  const second = session("two");
  const records = new Map([
    [first.session_id, first],
    [second.session_id, second],
  ]);
  const actionsBySession = new Map([
    [first.session_id, [closeAction] as const],
    [second.session_id, [closeAction] as const],
  ]);
  const calls = { close: [], preview: [], discard: [], diagnostic: [] };
  const backend = backendFor(records, actionsBySession, calls);
  const controller = createSessionActions(backend, context);
  const firstSnapshot = await controller.readSessionActionSnapshot(identity(first));
  assert.equal(firstSnapshot.ok, true);
  if (!firstSnapshot.ok) return;

  records.set(first.session_id, { ...first, updated_at: "one-newer" });
  const stale = await controller.dispatchSessionAction(
    "supply-exact-integrated-revision",
    identity(first),
    firstSnapshot.value.token,
    { confirmed: false },
  );
  assert.equal(stale.ok, false);
  if (!stale.ok) assert.equal(stale.error.code, "STALE_SESSION");
  assert.deepEqual(calls.close, []);

  records.set(first.session_id, first);
  const secondSnapshot = await controller.readSessionActionSnapshot(identity(second));
  assert.equal(secondSnapshot.ok, true);
  if (!secondSnapshot.ok) return;
  const completed = await controller.dispatchSessionAction(
    "supply-exact-integrated-revision",
    identity(second),
    secondSnapshot.value.token,
    { confirmed: true, operation_id: "close-two" },
  );
  assert.equal(completed.ok, true);
  assert.deepEqual(calls.close, ["two"]);
});

test("discard requires explicit confirmation and repeated delivery does not duplicate mutation", async () => {
  const record = session("one");
  const calls = { close: [], preview: [], discard: [], diagnostic: [] };
  const controller = createSessionActions(
    backendFor(new Map([[record.session_id, record]]), new Map([[record.session_id, [discardAction]]]), calls),
    context,
  );
  const snapshot = await controller.readSessionActionSnapshot(identity(record));
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;

  const preview = await controller.dispatchSessionAction("discard-session", identity(record), snapshot.value.token, {
    confirmed: false,
  });
  assert.equal(preview.ok, true);
  if (!preview.ok) return;
  assert.equal(preview.value.status, "confirmation-required");
  assert.deepEqual(calls.discard, []);

  const confirmed = await controller.dispatchSessionAction("discard-session", identity(record), snapshot.value.token, {
    confirmed: true,
    operation_id: "discard-one",
    preview: preview.value.preview,
  });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(calls.discard, ["one"]);

  const repeated = await controller.dispatchSessionAction("discard-session", identity(record), snapshot.value.token, {
    confirmed: true,
    operation_id: "discard-one",
    preview: preview.value.preview,
  });
  assert.equal(repeated.ok, true);
  assert.deepEqual(calls.discard, ["one"]);
  assert.deepEqual(calls.preview, ["one", "one"]);
});

test("discard rejects a changed physical head even when session metadata is unchanged", async () => {
  const record = session("one");
  const physicalEvidence = { head: "head" };
  const calls = { close: [], preview: [], discard: [], diagnostic: [] };
  const controller = createSessionActions(
    backendFor(
      new Map([[record.session_id, record]]),
      new Map([[record.session_id, [discardAction]]]),
      calls,
      physicalEvidence,
    ),
    context,
  );
  const snapshot = await controller.readSessionActionSnapshot(identity(record));
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;

  const preview = await controller.dispatchSessionAction("discard-session", identity(record), snapshot.value.token, {
    confirmed: false,
  });
  assert.equal(preview.ok, true);
  if (!preview.ok || preview.value.status !== "confirmation-required") return;

  physicalEvidence.head = "changed-head";
  const rejected = await controller.dispatchSessionAction("discard-session", identity(record), snapshot.value.token, {
    confirmed: true,
    operation_id: "discard-one-changed-head",
    preview: preview.value.preview,
  });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) assert.equal(rejected.error.code, "STALE_SESSION");
  assert.deepEqual(calls.discard, []);
});

test("unknown action IDs never become shell commands or backend mutations", async () => {
  const record = session("one");
  const calls = { close: [], preview: [], discard: [], diagnostic: [] };
  const controller = createSessionActions(
    backendFor(new Map([[record.session_id, record]]), new Map([[record.session_id, [closeAction]]]), calls),
    context,
  );
  const snapshot = await controller.readSessionActionSnapshot(identity(record));
  assert.equal(snapshot.ok, true);
  if (!snapshot.ok) return;

  const result = await controller.dispatchSessionAction("retain-session", identity(record), snapshot.value.token, {
    confirmed: false,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "OPERATION_REJECTED");
  assert.deepEqual(calls.close, []);
  assert.deepEqual(calls.discard, []);
});

test("discard preview parser preserves the declared shape and rejects forged discriminants", () => {
  const record = session("one");
  const parsed = parseSessionDiscardPreview(discardPreviewFor(record));
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.operation, "discard-preview");
  assert.equal(parsed.value.destructive, true);

  const forged = parseSessionDiscardPreview({ ...discardPreviewFor(record), destructive: false });
  assert.equal(forged.ok, false);
  if (!forged.ok) assert.equal(forged.error.code, "INVALID_ARGUMENT");

  const forgedEvidence = parseSessionDiscardPreview({
    ...discardPreviewFor(record),
    recoverable_commits: {
      ...discardPreviewFor(record).recoverable_commits,
      evidence: [{ code: "NOT_AN_ERROR_CODE", message: "forged", details: {} }],
    },
  });
  assert.equal(forgedEvidence.ok, false);
  if (!forgedEvidence.ok) assert.equal(forgedEvidence.error.code, "INVALID_ARGUMENT");
});

test("discard preview parser preserves empty strings allowed by the declared JSON shape", () => {
  const record = session("one");
  const preview = discardPreviewFor(record);
  const parsed = parseSessionDiscardPreview({
    ...preview,
    warning: "",
    recoverable_commits: {
      ...preview.recoverable_commits,
      evidence: [{ code: "GIT_COMMAND_FAILED", message: "", details: { "": "" } }],
    },
  });
  assert.equal(parsed.ok, true);
  if (!parsed.ok) return;
  assert.equal(parsed.value.warning, "");
  assert.equal(parsed.value.recoverable_commits.evidence[0]?.message, "");
  assert.deepEqual(parsed.value.recoverable_commits.evidence[0]?.details, { "": "" });
});
