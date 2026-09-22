import { DomainError, failure, success, type DomainResult, type JsonObject, type JsonValue } from "../domain/errors.js";
import type {
  ResourceClaim,
  SessionBackend,
  SessionCloseResult,
  SessionContext,
  SessionDiagnostic,
  SessionDiscardPreview,
  SessionDiscardResult,
  SessionDiscardPreviewEvidence,
  SessionLifecycleAction,
  SessionRecord,
  SessionState,
} from "../domain/session.js";

/** The UI action projection is a caller, not a second lifecycle authority. */
export const SESSION_ACTIONS_SCHEMA_VERSION = 1 as const;

const PREVIEW_MAX_TEXT_CODE_POINTS = 4_096;
const SESSION_STATES: readonly SessionState[] = ["new", "active", "closing", "closed", "stale"];
const READINESS_STATES = ["ready", "not_due", "blocked", "external_evidence_required", "ambiguous"] as const;
const RESULT_STATES = ["complete", "ambiguous", "stale", "external_evidence_required"] as const;

type PreviewObject = Record<string, unknown>;

function previewObject(value: unknown, field: string): DomainResult<PreviewObject> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return failure(
      new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}': expected an object.`, { field }),
    );
  }
  return success(value as PreviewObject);
}

function previewField(object: PreviewObject, field: string): unknown {
  return Object.hasOwn(object, field) ? object[field] : undefined;
}

function previewText(value: unknown, field: string, nullable = false): DomainResult<string | null> {
  if (nullable && value === null) return success(null);
  if (typeof value !== "string" || value.length === 0 || [...value].length > PREVIEW_MAX_TEXT_CODE_POINTS) {
    return failure(
      new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}': expected bounded text.`, {
        field,
      }),
    );
  }
  if (/\p{Cc}|\p{Cf}/u.test(value)) {
    return failure(
      new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}': control text is not allowed.`, {
        field,
      }),
    );
  }
  return success(value);
}

function previewInteger(value: unknown, field: string, minimum = 0): DomainResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    return failure(
      new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}': expected an integer.`, { field }),
    );
  }
  return success(value as number);
}

function previewBoolean(value: unknown, field: string): DomainResult<boolean> {
  if (typeof value !== "boolean") {
    return failure(
      new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}': expected a boolean.`, { field }),
    );
  }
  return success(value);
}

function previewNullableBoolean(value: unknown, field: string): DomainResult<boolean | null> {
  if (value === null) return success(null);
  return previewBoolean(value, field);
}

function previewJsonObject(value: unknown, field: string): DomainResult<JsonObject> {
  const object = previewObject(value, field);
  if (!object.ok) return object;
  for (const [key, child] of Object.entries(object.value)) {
    const text = previewText(key, `${field}.${key}`);
    if (!text.ok) return text as DomainResult<never>;
    const valid = previewJson(child, `${field}.${key}`);
    if (!valid.ok) return valid;
  }
  return success(object.value as JsonObject);
}

function previewJson(value: unknown, field: string): DomainResult<JsonValue> {
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      return failure(
        new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}': non-finite number.`, { field }),
      );
    }
    return success(value as JsonValue);
  }
  if (typeof value === "string") return previewText(value, field) as DomainResult<JsonValue>;
  if (Array.isArray(value)) {
    const result: JsonValue[] = [];
    for (const [index, child] of value.entries()) {
      const parsed = previewJson(child, `${field}[${index}]`);
      if (!parsed.ok) return parsed;
      result.push(parsed.value);
    }
    return success(result);
  }
  return previewJsonObject(value, field);
}

function previewEvidence(value: unknown, field: string): DomainResult<SessionDiscardPreviewEvidence> {
  const object = previewObject(value, field);
  if (!object.ok) return object;
  const code = previewText(previewField(object.value, "code"), `${field}.code`);
  if (!code.ok || code.value === null) return code as DomainResult<never>;
  const message = previewText(previewField(object.value, "message"), `${field}.message`);
  if (!message.ok || message.value === null) return message as DomainResult<never>;
  const details = previewJsonObject(previewField(object.value, "details"), `${field}.details`);
  if (!details.ok) return details;
  return success({
    code: code.value as SessionDiscardPreviewEvidence["code"],
    message: message.value,
    details: details.value,
  });
}

function previewEvidenceList(value: unknown, field: string): DomainResult<SessionDiscardPreviewEvidence[]> {
  if (!Array.isArray(value)) {
    return failure(
      new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}': expected an array.`, { field }),
    );
  }
  const result: SessionDiscardPreviewEvidence[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = previewEvidence(item, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    result.push(parsed.value);
  }
  return success(result);
}

function previewSession(value: unknown): DomainResult<SessionRecord> {
  const field = "session";
  const object = previewObject(value, field);
  if (!object.ok) return object;
  const requiredText = ["session_id", "repository", "worktree", "branch", "created_at", "updated_at"];
  const textValues: Record<string, string> = {};
  for (const name of requiredText) {
    const parsed = previewText(previewField(object.value, name), `${field}.${name}`);
    if (!parsed.ok || parsed.value === null) return parsed as DomainResult<never>;
    textValues[name] = parsed.value;
  }
  const schema = previewInteger(previewField(object.value, "schema_version"), `${field}.schema_version`);
  if (!schema.ok) return schema;
  const state = previewText(previewField(object.value, "state"), `${field}.state`);
  if (!state.ok || state.value === null || !(SESSION_STATES as readonly string[]).includes(state.value)) {
    return failure(
      new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}.state'.`, {
        field: `${field}.state`,
      }),
    );
  }
  const result: SessionRecord = {
    schema_version: schema.value,
    session_id: textValues.session_id,
    repository: textValues.repository,
    worktree: textValues.worktree,
    branch: textValues.branch,
    state: state.value as SessionState,
    created_at: textValues.created_at,
    updated_at: textValues.updated_at,
  };
  for (const name of ["worktree_root", "base_revision", "label", "discarded_head"] as const) {
    if (Object.hasOwn(object.value, name)) {
      const parsed = previewText(previewField(object.value, name), `${field}.${name}`);
      if (!parsed.ok || parsed.value === null) return parsed as DomainResult<never>;
      (result as Record<string, unknown>)[name] = parsed.value;
    }
  }
  if (Object.hasOwn(object.value, "terminal_operation") && object.value.terminal_operation !== "discard") {
    return failure(
      new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}.terminal_operation'.`, { field }),
    );
  }
  if (Object.hasOwn(object.value, "terminal_operation"))
    (result as Record<string, unknown>).terminal_operation = "discard";
  if (Object.hasOwn(object.value, "working_set")) {
    const workingSet = previewJsonObject(object.value.working_set, `${field}.working_set`);
    if (!workingSet.ok) return workingSet;
    result.working_set = workingSet.value;
  }
  return success(result);
}

function previewClaim(value: unknown, field: string): DomainResult<ResourceClaim> {
  const object = previewObject(value, field);
  if (!object.ok) return object;
  const names = ["claim_id", "session_id", "repository", "worktree", "resource", "created_at", "updated_at"];
  const strings: Record<string, string> = {};
  for (const name of names) {
    const parsed = previewText(previewField(object.value, name), `${field}.${name}`);
    if (!parsed.ok || parsed.value === null) return parsed as DomainResult<never>;
    strings[name] = parsed.value;
  }
  const schema = previewInteger(previewField(object.value, "schema_version"), `${field}.schema_version`);
  if (!schema.ok) return schema;
  const mode = previewText(previewField(object.value, "mode"), `${field}.mode`);
  if (!mode.ok || mode.value === null || !["read", "write", "exclusive-write"].includes(mode.value)) {
    return failure(new DomainError("INVALID_ARGUMENT", `Invalid discard preview field '${field}.mode'.`, { field }));
  }
  return success({
    schema_version: schema.value,
    claim_id: strings.claim_id,
    session_id: strings.session_id,
    repository: strings.repository,
    worktree: strings.worktree,
    resource: strings.resource,
    mode: mode.value as ResourceClaim["mode"],
    created_at: strings.created_at,
    updated_at: strings.updated_at,
  });
}

function previewClaims(value: unknown): DomainResult<ResourceClaim[]> {
  if (!Array.isArray(value)) {
    return failure(
      new DomainError("INVALID_ARGUMENT", "Invalid discard preview field 'claims': expected an array.", {
        field: "claims",
      }),
    );
  }
  const claims: ResourceClaim[] = [];
  for (const [index, item] of value.entries()) {
    const claim = previewClaim(item, `claims[${index}]`);
    if (!claim.ok) return claim;
    claims.push(claim.value);
  }
  return success(claims);
}

/** Parse untrusted CLI/UI data as the existing authoritative discard-preview shape. */
export function parseSessionDiscardPreview(input: unknown): DomainResult<SessionDiscardPreview> {
  const object = previewObject(input, "preview");
  if (!object.ok) return object;
  const schema = previewInteger(previewField(object.value, "schema_version"), "schema_version");
  if (!schema.ok) return schema;
  if (object.value.operation !== "discard-preview" || object.value.destructive !== true) {
    return failure(
      new DomainError("INVALID_ARGUMENT", "Discard preview has invalid operation or destructive discriminant.", {
        field: "operation",
      }),
    );
  }
  const warning = previewText(previewField(object.value, "warning"), "warning");
  if (!warning.ok || warning.value === null) return warning as DomainResult<never>;
  const textNames = [
    "session_id",
    "repository",
    "worktree",
    "branch",
    "current_state",
    "persisted_state",
    "physical_state",
  ];
  const text: Record<string, string> = {};
  for (const name of textNames) {
    const parsed = previewText(previewField(object.value, name), name);
    if (!parsed.ok || parsed.value === null) return parsed as DomainResult<never>;
    text[name] = parsed.value;
  }
  if (
    !(SESSION_STATES as readonly string[]).includes(text.current_state) ||
    !(SESSION_STATES as readonly string[]).includes(text.persisted_state)
  ) {
    return failure(
      new DomainError("INVALID_ARGUMENT", "Discard preview session state is invalid.", { field: "current_state" }),
    );
  }
  const session = previewSession(previewField(object.value, "session"));
  if (!session.ok) return session;
  if (
    session.value.session_id !== text.session_id ||
    session.value.repository !== text.repository ||
    session.value.worktree !== text.worktree ||
    session.value.branch !== text.branch
  ) {
    return failure(
      new DomainError("INVALID_ARGUMENT", "Discard preview session identity does not match its nested session.", {
        field: "session",
      }),
    );
  }
  const booleans: Record<string, boolean> = {};
  for (const name of ["worktree_present", "branch_present", "claims_truncated"] as const) {
    const parsed = previewBoolean(previewField(object.value, name), name);
    if (!parsed.ok) return parsed;
    booleans[name] = parsed.value;
  }
  const nullableHashes: Record<string, string | null> = {};
  for (const name of ["head", "worktree_head", "branch_head", "expected_head"] as const) {
    const parsed = previewText(previewField(object.value, name), name, true);
    if (!parsed.ok) return parsed;
    nullableHashes[name] = parsed.value;
  }
  const recoverable = previewObject(previewField(object.value, "recoverable_commits"), "recoverable_commits");
  if (!recoverable.ok) return recoverable;
  const uncommitted = previewObject(previewField(object.value, "uncommitted_work"), "uncommitted_work");
  if (!uncommitted.ok) return uncommitted;
  const evidenceContainer = (
    container: PreviewObject,
    field: string,
  ): DomainResult<SessionDiscardPreview["recoverable_commits"]> => {
    const observable = previewBoolean(container.observable, `${field}.observable`);
    if (!observable.ok) return observable;
    const present = previewNullableBoolean(container.present, `${field}.present`);
    if (!present.ok) return present;
    const evidence = previewEvidenceList(container.evidence, `${field}.evidence`);
    if (!evidence.ok) return evidence;
    return success({ observable: observable.value, present: present.value, evidence: evidence.value });
  };
  const recoverableValue = evidenceContainer(recoverable.value, "recoverable_commits");
  if (!recoverableValue.ok) return recoverableValue;
  const uncommittedValue = evidenceContainer(uncommitted.value, "uncommitted_work");
  if (!uncommittedValue.ok) return uncommittedValue;
  const claims = previewClaims(previewField(object.value, "claims"));
  if (!claims.ok) return claims;
  const claimCount = previewInteger(previewField(object.value, "claim_count"), "claim_count");
  if (!claimCount.ok) return claimCount;
  const scope = previewObject(previewField(object.value, "destructive_scope"), "destructive_scope");
  if (!scope.ok) return scope;
  const scopeValues: Record<string, boolean | number | null> = {};
  for (const name of ["worktree", "branch"] as const) {
    const parsed = previewBoolean(scope.value[name], `destructive_scope.${name}`);
    if (!parsed.ok) return parsed;
    scopeValues[name] = parsed.value;
  }
  for (const name of ["unintegrated_commits", "uncommitted_work"] as const) {
    const parsed = previewNullableBoolean(scope.value[name], `destructive_scope.${name}`);
    if (!parsed.ok) return parsed;
    scopeValues[name] = parsed.value;
  }
  const scopeClaims = previewInteger(scope.value.claims, "destructive_scope.claims");
  if (!scopeClaims.ok) return scopeClaims;
  scopeValues.claims = scopeClaims.value;
  const diagnostic = previewObject(previewField(object.value, "diagnostic"), "diagnostic");
  if (!diagnostic.ok) return diagnostic;
  const close = previewText(diagnostic.value.close_readiness, "diagnostic.close_readiness");
  const cleanup = previewText(diagnostic.value.cleanup_readiness, "diagnostic.cleanup_readiness");
  const resultState = previewText(diagnostic.value.result_state, "diagnostic.result_state");
  if (
    !close.ok ||
    !cleanup.ok ||
    !resultState.ok ||
    close.value === null ||
    cleanup.value === null ||
    resultState.value === null
  ) {
    return failure(
      new DomainError("INVALID_ARGUMENT", "Discard preview diagnostic readiness is invalid.", { field: "diagnostic" }),
    );
  }
  if (
    !(READINESS_STATES as readonly string[]).includes(close.value) ||
    !(READINESS_STATES as readonly string[]).includes(cleanup.value) ||
    !(RESULT_STATES as readonly string[]).includes(resultState.value)
  ) {
    return failure(
      new DomainError("INVALID_ARGUMENT", "Discard preview diagnostic discriminants are invalid.", {
        field: "diagnostic",
      }),
    );
  }
  const blockers = previewEvidenceList(diagnostic.value.blockers, "diagnostic.blockers");
  if (!blockers.ok) return blockers;
  const lifecycleState = Object.hasOwn(diagnostic.value, "lifecycle_state")
    ? previewText(diagnostic.value.lifecycle_state, "diagnostic.lifecycle_state")
    : success(null);
  if (!lifecycleState.ok) return lifecycleState;
  return success({
    schema_version: schema.value,
    operation: "discard-preview",
    destructive: true,
    warning: warning.value,
    session_id: text.session_id,
    repository: text.repository,
    worktree: text.worktree,
    branch: text.branch,
    session: session.value,
    current_state: text.current_state as SessionState,
    persisted_state: text.persisted_state as SessionState,
    physical_state: text.physical_state,
    worktree_present: booleans.worktree_present,
    branch_present: booleans.branch_present,
    head: nullableHashes.head,
    worktree_head: nullableHashes.worktree_head,
    branch_head: nullableHashes.branch_head,
    expected_head: nullableHashes.expected_head,
    recoverable_commits: recoverableValue.value,
    uncommitted_work: uncommittedValue.value,
    claims: claims.value,
    claim_count: claimCount.value,
    claims_truncated: booleans.claims_truncated,
    destructive_scope: {
      worktree: scopeValues.worktree as boolean,
      branch: scopeValues.branch as boolean,
      unintegrated_commits: scopeValues.unintegrated_commits as boolean | null,
      uncommitted_work: scopeValues.uncommitted_work as boolean | null,
      claims: scopeValues.claims as number,
    },
    diagnostic: {
      close_readiness: close.value as SessionDiscardPreview["diagnostic"]["close_readiness"],
      cleanup_readiness: cleanup.value as SessionDiscardPreview["diagnostic"]["cleanup_readiness"],
      result_state: resultState.value as SessionDiscardPreview["diagnostic"]["result_state"],
      blockers: blockers.value,
      ...(lifecycleState.value === null ? {} : { lifecycle_state: lifecycleState.value }),
    },
  });
}

export type SessionActionId = SessionLifecycleAction["action_id"];

/** Stable identity carried by a rendered row. Never use a row index as identity. */
export type SessionActionIdentity = {
  readonly session_id: string;
  readonly repository: string;
  readonly worktree: string;
};

/**
 * Read evidence that must still hold when an action is dispatched. The token
 * contains only canonical session/claim/lifecycle observations; it is not a
 * new authority or a caller-controlled permission.
 */
export type SessionActionToken = {
  readonly schema_version: typeof SESSION_ACTIONS_SCHEMA_VERSION;
  readonly session_id: string;
  readonly session_updated_at: string;
  readonly claim_set_generation: number;
  readonly lifecycle_state: string | null;
  readonly physical_state: string;
  readonly working_set_revision: number | null;
};

export type SessionActionConfirmation =
  | {
      readonly confirmed: false;
    }
  | {
      readonly confirmed: true;
      /** Stable caller operation key; repeated delivery of the same request is coalesced. */
      readonly operation_id?: string;
      /** The bounded, authoritative discard preview the caller explicitly reviewed. */
      readonly preview?: SessionDiscardPreview;
    };

export type SessionActionSnapshot = {
  readonly identity: SessionActionIdentity;
  readonly token: SessionActionToken;
  readonly diagnostic: SessionDiagnostic;
};

export type SessionActionResponse =
  | {
      readonly action_id: "retain-session" | "reconcile-physical-state";
      readonly status: "observed";
      readonly token: SessionActionToken;
      readonly diagnostic: SessionDiagnostic;
    }
  | {
      readonly action_id: "supply-exact-integrated-revision" | "retry-close-with-bounded-integration-fetch";
      readonly status: "completed";
      readonly token: SessionActionToken;
      readonly result: SessionCloseResult;
    }
  | {
      readonly action_id: "discard-session";
      readonly status: "confirmation-required";
      readonly token: SessionActionToken;
      readonly preview: SessionDiscardPreview;
    }
  | {
      readonly action_id: "discard-session";
      readonly status: "completed";
      readonly token: SessionActionToken;
      readonly result: SessionDiscardResult;
    };

export type DestructiveSessionActionRequest = {
  readonly identity: SessionActionIdentity;
  readonly expected_token: SessionActionToken;
  readonly confirmation: SessionActionConfirmation;
};

export type SessionActionDispatcher = {
  readSessionActionSnapshot(identity: SessionActionIdentity): Promise<DomainResult<SessionActionSnapshot>>;
  dispatchSessionAction(
    actionId: SessionActionId,
    identity: SessionActionIdentity,
    expectedToken: SessionActionToken,
    confirmation: SessionActionConfirmation,
  ): Promise<DomainResult<SessionActionResponse>>;
  confirmDestructiveSessionAction(
    request: DestructiveSessionActionRequest,
  ): Promise<DomainResult<SessionActionResponse>>;
};

type DispatchableAction = Extract<SessionLifecycleAction, { action_id: SessionActionId }>;

function capabilityUnavailable(operation: string): DomainResult<never> {
  return failure(
    new DomainError("BACKEND_UNAVAILABLE", `The UI action capability is unavailable: ${operation}`, {
      operation,
    }),
  );
}

function staleAction(
  identity: SessionActionIdentity,
  expected: SessionActionToken,
  observed: SessionActionToken | null,
): DomainResult<never> {
  return failure(
    new DomainError("STALE_SESSION", "The UI action evidence is stale; refresh the session before retrying.", {
      session_id: identity.session_id,
      expected_token: expected as unknown as JsonObject,
      ...(observed === null ? {} : { observed_token: observed as unknown as JsonObject }),
    }),
  );
}

function invalidAction(actionId: string, sessionId: string): DomainResult<never> {
  return failure(
    new DomainError("OPERATION_REJECTED", "The requested UI action is not currently authorised.", {
      action_id: actionId,
      session_id: sessionId,
      reason: "action-not-present-in-current-next-actions",
    }),
  );
}

function explicitIntentRequired(actionId: SessionActionId, sessionId: string): DomainResult<never> {
  return failure(
    new DomainError("OPERATION_REJECTED", "An explicit UI confirmation is required for this mutation.", {
      action_id: actionId,
      session_id: sessionId,
      reason: "confirmation-required",
    }),
  );
}

function confirmationRequired(preview: SessionDiscardPreview, token: SessionActionToken): SessionActionResponse {
  return {
    action_id: "discard-session",
    status: "confirmation-required",
    token,
    preview,
  };
}

/**
 * Bind destructive confirmation to every bounded physical/claim observation
 * that the canonical discard preview exposed. This is evidence binding, not
 * a second cleanup authority; the registry remains the final mutation guard.
 */
function destructivePreviewEvidence(preview: SessionDiscardPreview): string {
  return JSON.stringify({
    schema_version: preview.schema_version,
    operation: preview.operation,
    destructive: preview.destructive,
    session: {
      session_id: preview.session.session_id,
      repository: preview.session.repository,
      worktree: preview.session.worktree,
      branch: preview.session.branch,
      state: preview.session.state,
      updated_at: preview.session.updated_at,
    },
    session_id: preview.session_id,
    repository: preview.repository,
    worktree: preview.worktree,
    branch: preview.branch,
    current_state: preview.current_state,
    persisted_state: preview.persisted_state,
    physical_state: preview.physical_state,
    worktree_present: preview.worktree_present,
    branch_present: preview.branch_present,
    head: preview.head,
    worktree_head: preview.worktree_head,
    branch_head: preview.branch_head,
    expected_head: preview.expected_head,
    recoverable_commits: preview.recoverable_commits,
    uncommitted_work: preview.uncommitted_work,
    claims: preview.claims,
    claim_count: preview.claim_count,
    claims_truncated: preview.claims_truncated,
    destructive_scope: preview.destructive_scope,
    diagnostic: preview.diagnostic,
  });
}

function sameDestructivePreviewEvidence(left: SessionDiscardPreview, right: SessionDiscardPreview): boolean {
  return destructivePreviewEvidence(left) === destructivePreviewEvidence(right);
}

function staleDestructivePreview(
  identity: SessionActionIdentity,
  expected: SessionDiscardPreview,
  observed: SessionDiscardPreview,
): DomainResult<never> {
  return failure(
    new DomainError(
      "STALE_SESSION",
      "The discard preview changed; refresh the session and confirm the new destructive scope.",
      {
        session_id: identity.session_id,
        reason: "discard-preview-changed",
        expected_preview: expected as unknown as JsonObject,
        observed_preview: observed as unknown as JsonObject,
      },
    ),
  );
}

function responseToken(diagnostic: SessionDiagnostic, claimSetGeneration: number): SessionActionToken {
  const workingSetRevision = diagnostic.session.working_set?.revision;
  return Object.freeze({
    schema_version: SESSION_ACTIONS_SCHEMA_VERSION,
    session_id: diagnostic.session_id,
    session_updated_at: diagnostic.session.updated_at,
    claim_set_generation: claimSetGeneration,
    lifecycle_state: diagnostic.lifecycle_state ?? null,
    physical_state: diagnostic.physical_state,
    working_set_revision: typeof workingSetRevision === "number" ? workingSetRevision : null,
  });
}

function sameToken(left: SessionActionToken, right: SessionActionToken): boolean {
  return (
    left.schema_version === right.schema_version &&
    left.session_id === right.session_id &&
    left.session_updated_at === right.session_updated_at &&
    left.claim_set_generation === right.claim_set_generation &&
    left.lifecycle_state === right.lifecycle_state &&
    left.physical_state === right.physical_state &&
    left.working_set_revision === right.working_set_revision
  );
}

function sameIdentity(left: SessionActionIdentity, right: SessionActionIdentity): boolean {
  return (
    left.session_id === right.session_id && left.repository === right.repository && left.worktree === right.worktree
  );
}

function actionFor(diagnostic: SessionDiagnostic, actionId: SessionActionId): DispatchableAction | undefined {
  return diagnostic.next_actions?.find((candidate) => candidate.action_id === actionId);
}

function operationKey(
  actionId: SessionActionId,
  identity: SessionActionIdentity,
  token: SessionActionToken,
  confirmation: SessionActionConfirmation,
): string {
  return JSON.stringify({
    action_id: actionId,
    identity,
    token,
    confirmation,
  });
}

function asIdentity(record: SessionRecord): SessionActionIdentity {
  return Object.freeze({
    session_id: record.session_id,
    repository: record.repository,
    worktree: record.worktree,
  });
}

/**
 * Build the bounded UI action adapter over an existing domain backend.
 * Construction has no side effects and does not grant write capability.
 */
export function createSessionActions(backend: SessionBackend, context: SessionContext): SessionActionDispatcher {
  const completedOperations = new Map<string, Promise<DomainResult<SessionActionResponse>>>();

  const readSessionActionSnapshot = async (
    identity: SessionActionIdentity,
  ): Promise<DomainResult<SessionActionSnapshot>> => {
    if (backend.sessionDiagnostic === undefined) return capabilityUnavailable("sessionDiagnostic");
    if (backend.listClaims === undefined) return capabilityUnavailable("listClaims");

    const diagnostic = await backend.sessionDiagnostic(context, {
      session_id: identity.session_id,
      integrated_revision: null,
    });
    if (!diagnostic.ok) return diagnostic;
    if (
      diagnostic.value.session_id !== identity.session_id ||
      !sameIdentity(asIdentity(diagnostic.value.session), identity)
    ) {
      return staleAction(
        identity,
        {
          schema_version: SESSION_ACTIONS_SCHEMA_VERSION,
          session_id: identity.session_id,
          session_updated_at: "",
          claim_set_generation: -1,
          lifecycle_state: null,
          physical_state: "",
          working_set_revision: null,
        },
        null,
      );
    }

    const claims = await backend.listClaims(context, identity.session_id);
    if (!claims.ok) return claims;
    const token = responseToken(diagnostic.value, claims.value.claim_set_generation);
    return success({ identity, token, diagnostic: diagnostic.value });
  };

  const requireFreshSnapshot = async (
    identity: SessionActionIdentity,
    expectedToken: SessionActionToken,
  ): Promise<DomainResult<SessionActionSnapshot>> => {
    const current = await readSessionActionSnapshot(identity);
    if (!current.ok) return current;
    if (!sameToken(current.value.token, expectedToken))
      return staleAction(identity, expectedToken, current.value.token);
    return current;
  };

  const confirmDestructiveSessionAction = async (
    request: DestructiveSessionActionRequest,
  ): Promise<DomainResult<SessionActionResponse>> => {
    const fresh = await requireFreshSnapshot(request.identity, request.expected_token);
    if (!fresh.ok) return fresh;
    const action = actionFor(fresh.value.diagnostic, "discard-session");
    if (action === undefined || action.action_id !== "discard-session") {
      return invalidAction("discard-session", request.identity.session_id);
    }
    if (backend.discardPreview === undefined) return capabilityUnavailable("discardPreview");
    if (backend.discardSession === undefined) return capabilityUnavailable("discardSession");

    const preview = await backend.discardPreview(context, request.identity.session_id);
    if (!preview.ok) return preview;
    if (
      preview.value.session_id !== request.identity.session_id ||
      preview.value.session.updated_at !== request.expected_token.session_updated_at
    ) {
      return staleAction(request.identity, request.expected_token, {
        ...fresh.value.token,
        session_updated_at: preview.value.session.updated_at,
      });
    }
    if (!request.confirmation.confirmed) {
      return success(confirmationRequired(preview.value, fresh.value.token));
    }
    if (request.confirmation.preview === undefined) {
      return failure(
        new DomainError(
          "OPERATION_REJECTED",
          "An authoritative discard preview is required for destructive confirmation.",
          {
            session_id: request.identity.session_id,
            reason: "discard-preview-required",
          },
        ),
      );
    }
    if (!sameDestructivePreviewEvidence(request.confirmation.preview, preview.value)) {
      return staleDestructivePreview(request.identity, request.confirmation.preview, preview.value);
    }

    const result = await backend.discardSession(context, request.identity.session_id);
    if (!result.ok) {
      // A failed mutation may have an unknown postcondition. Force the caller
      // back through a fresh read; never retry the backend call implicitly.
      await readSessionActionSnapshot(request.identity);
      return result;
    }
    return success({
      action_id: "discard-session",
      status: "completed",
      token: fresh.value.token,
      result: result.value,
    });
  };

  const dispatchSessionAction = (
    actionId: SessionActionId,
    identity: SessionActionIdentity,
    expectedToken: SessionActionToken,
    confirmation: SessionActionConfirmation,
  ): Promise<DomainResult<SessionActionResponse>> => {
    const key = operationKey(actionId, identity, expectedToken, confirmation);
    const existing = completedOperations.get(key);
    if (existing !== undefined) return existing;

    const operation = (async (): Promise<DomainResult<SessionActionResponse>> => {
      if (actionId === "discard-session") {
        return confirmDestructiveSessionAction({
          identity,
          expected_token: expectedToken,
          confirmation,
        });
      }

      const fresh = await requireFreshSnapshot(identity, expectedToken);
      if (!fresh.ok) return fresh;
      const action = actionFor(fresh.value.diagnostic, actionId);
      if (action === undefined) return invalidAction(actionId, identity.session_id);

      switch (action.action_id) {
        case "retain-session":
        case "reconcile-physical-state":
          return success({
            action_id: action.action_id,
            status: "observed",
            token: fresh.value.token,
            diagnostic: fresh.value.diagnostic,
          });
        case "supply-exact-integrated-revision": {
          if (!confirmation.confirmed) return explicitIntentRequired(action.action_id, identity.session_id);
          const result = await backend.closeSession(context, {
            session_id: identity.session_id,
            integrated_revision: action.integrated_revision,
            fetch_remote: null,
            fetch_branch: null,
          });
          if (!result.ok) {
            await readSessionActionSnapshot(identity);
            return result;
          }
          return success({
            action_id: action.action_id,
            status: "completed",
            token: fresh.value.token,
            result: result.value,
          });
        }
        case "retry-close-with-bounded-integration-fetch": {
          if (!confirmation.confirmed) return explicitIntentRequired(action.action_id, identity.session_id);
          const result = await backend.closeSession(context, {
            session_id: identity.session_id,
            integrated_revision: action.integrated_revision,
            fetch_remote: action.fetch_remote,
            fetch_branch: action.fetch_branch,
          });
          if (!result.ok) {
            await readSessionActionSnapshot(identity);
            return result;
          }
          return success({
            action_id: action.action_id,
            status: "completed",
            token: fresh.value.token,
            result: result.value,
          });
        }
        case "discard-session":
          return invalidAction(actionId, identity.session_id);
      }
    })();

    completedOperations.set(key, operation);
    return operation;
  };

  return Object.freeze({
    readSessionActionSnapshot,
    dispatchSessionAction,
    confirmDestructiveSessionAction,
  });
}
