import { DomainError, failure, success, type DomainResult, type JsonObject } from "../domain/errors.js";
import type {
  SessionBackend,
  SessionCloseResult,
  SessionContext,
  SessionDiagnostic,
  SessionDiscardPreview,
  SessionDiscardResult,
  SessionLifecycleAction,
  SessionRecord,
} from "../domain/session.js";

/** The UI action projection is a caller, not a second lifecycle authority. */
export const SESSION_ACTIONS_SCHEMA_VERSION = 1 as const;

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
