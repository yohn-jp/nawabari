import type { SessionLifecycleClassification } from "./session-lifecycle-classification.js";

/**
 * The small, public vocabulary for lifecycle recovery.  These values are
 * descriptions of an available caller action; none of them grants mutation
 * authority or performs the action.
 */
export const SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION = 1 as const;

export type SessionLifecycleActionId =
  | "retain-session"
  | "supply-exact-integrated-revision"
  | "retry-close-with-bounded-integration-fetch"
  | "discard-session"
  | "reconcile-physical-state";

/** Naming alias for callers that refer to the projection as a next action. */
export type SessionLifecycleNextActionId = SessionLifecycleActionId;

export type SessionLifecycleAction =
  | {
      readonly schemaVersion: typeof SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION;
      readonly actionId: "retain-session";
      readonly kind: "retain";
      readonly command: "session inspect";
      readonly reason: "no-safe-transition-proven";
    }
  | {
      readonly schemaVersion: typeof SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION;
      readonly actionId: "supply-exact-integrated-revision";
      readonly kind: "integrated-revision";
      readonly command: "session close";
      readonly integratedRevision: string;
    }
  | {
      readonly schemaVersion: typeof SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION;
      readonly actionId: "retry-close-with-bounded-integration-fetch";
      readonly kind: "bounded-integration-fetch";
      readonly command: "session close";
      readonly integratedRevision: string;
      readonly fetchRemote: string;
      readonly fetchBranch: string;
    }
  | {
      readonly schemaVersion: typeof SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION;
      readonly actionId: "discard-session";
      readonly kind: "explicit-discard";
      readonly command: "session discard";
      readonly sessionId: string;
      readonly requiresExplicitIntent: true;
    }
  | {
      readonly schemaVersion: typeof SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION;
      readonly actionId: "reconcile-physical-state";
      readonly kind: "reconcile";
      readonly command: "doctor";
      readonly sessionId: string;
      readonly mutates: false;
    };

export type SessionLifecycleNextAction = SessionLifecycleAction;

export type SessionLifecycleActionProjectionInput = {
  readonly classification: SessionLifecycleClassification;
  readonly sessionId: string;
  readonly blockers?: readonly {
    readonly code: string;
    readonly details?: Readonly<Record<string, unknown>>;
  }[];
};

function stringDetail(details: Readonly<Record<string, unknown>> | undefined, key: string): string | undefined {
  const value = details?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function action(value: SessionLifecycleAction): SessionLifecycleAction {
  return Object.freeze(value);
}

function retainAction(): SessionLifecycleAction {
  return action({
    schemaVersion: SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION,
    actionId: "retain-session",
    kind: "retain",
    command: "session inspect",
    reason: "no-safe-transition-proven",
  });
}

function discardAction(sessionId: string): SessionLifecycleAction {
  return action({
    schemaVersion: SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION,
    actionId: "discard-session",
    kind: "explicit-discard",
    command: "session discard",
    sessionId,
    requiresExplicitIntent: true,
  });
}

function reconcileAction(sessionId: string): SessionLifecycleAction {
  return action({
    schemaVersion: SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION,
    actionId: "reconcile-physical-state",
    kind: "reconcile",
    command: "doctor",
    sessionId,
    mutates: false,
  });
}

/**
 * Project one canonical lifecycle observation into bounded typed caller
 * actions.  The classifier remains the sole owner of lifecycle state; this
 * function only consumes its result and already-authoritative blocker facts.
 */
export function projectSessionLifecycleActions(
  input: SessionLifecycleActionProjectionInput,
): readonly SessionLifecycleAction[] {
  const { classification, sessionId } = input;
  const blocker = input.blockers?.[0];
  const details = blocker?.details;

  if (classification.state === "closed" || classification.state === "discarded") return Object.freeze([]);

  if (classification.state === "stale-inconsistent") {
    return Object.freeze([reconcileAction(sessionId)]);
  }

  if (classification.state !== "blocked-recoverable") return Object.freeze([]);

  const actions: SessionLifecycleAction[] = [];
  if (blocker?.code === "INTEGRATION_FETCH_FAILED") {
    const integratedRevision = stringDetail(details, "integratedRevision");
    const fetchRemote = stringDetail(details, "remote");
    const fetchBranch = stringDetail(details, "branch");
    if (integratedRevision !== undefined && fetchRemote !== undefined && fetchBranch !== undefined) {
      actions.push(
        action({
          schemaVersion: SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION,
          actionId: "retry-close-with-bounded-integration-fetch",
          kind: "bounded-integration-fetch",
          command: "session close",
          integratedRevision,
          fetchRemote,
          fetchBranch,
        }),
      );
    }
  }

  // A supplied revision is only actionable when the authority has positively
  // identified it as an exact revision to retry. Failed tree-equivalence or
  // lineage proof is deliberately not enough to advertise it.
  if (
    blocker?.code === "RECOVERABLE_COMMITS" &&
    stringDetail(details, "nextIntegratedRevision") !== undefined &&
    stringDetail(details, "nextIntegratedRevisionProof") === "authoritative"
  ) {
    actions.push(
      action({
        schemaVersion: SESSION_LIFECYCLE_ACTION_SCHEMA_VERSION,
        actionId: "supply-exact-integrated-revision",
        kind: "integrated-revision",
        command: "session close",
        integratedRevision: stringDetail(details, "nextIntegratedRevision")!,
      }),
    );
  }

  actions.push(retainAction());

  // Discard is offered only after the classifier has established a
  // non-ambiguous physical state. The action itself always carries explicit
  // intent and is never executed by this projection.
  if (
    classification.physicalState === "healthy" &&
    (blocker?.code === "DIRTY_WORKTREE" ||
      blocker?.code === "NESTED_REPOSITORY" ||
      blocker?.code === "RECOVERABLE_COMMITS" ||
      blocker?.code === "RECOVERABLE_STASHES")
  ) {
    actions.push(discardAction(sessionId));
  }

  return Object.freeze(actions);
}

export function primarySessionLifecycleAction(
  input: SessionLifecycleActionProjectionInput,
): SessionLifecycleAction | undefined {
  return projectSessionLifecycleActions(input)[0];
}

export const projectSessionLifecycleNextActions = projectSessionLifecycleActions;
export const primarySessionLifecycleNextAction = primarySessionLifecycleAction;
