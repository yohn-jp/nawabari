import { claimModeGrantsAccess as resourceClaimModeGrantsAccess, type ResourceClaimMode } from "./resource-claims.js";
import type { RegistryErrorCode } from "./errors.js";

/** Version of the local operation vocabulary and its access policy. */
export const OPERATION_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

/**
 * Operations are intentionally capability-shaped names. They describe the
 * local mutation class only; they do not encode GitHub, Mottainai, or task
 * semantics.
 */
export type OperationAuthorizationEnforcement = "public-execution" | "authorization-vocabulary";

export interface OperationAuthorizationPolicy {
  /** Claim strength required at this operation's local boundary. */
  readonly requiredAccess: ResourceClaimMode;
  /** Why this strength provides the required local isolation. */
  readonly isolationRationale: string;
  /** Which implementation authority currently enforces this declaration. */
  readonly authorityRationale: string;
  /** Whether a public mutating operation currently routes through this entry. */
  readonly enforcement: OperationAuthorizationEnforcement;
}

/**
 * The single implementation-owned policy authority for every governed local
 * operation. Keep these fields local and capability-shaped: they do not
 * describe provider, task, or remote-service semantics.
 */
const OPERATION_AUTHORIZATION_POLICY_RECORD = {
  "source-write": Object.freeze({
    requiredAccess: "write",
    isolationRationale:
      "Source mutation needs ordinary write authority and may coexist with a non-mutating read declaration.",
    authorityRationale:
      "Authorization vocabulary only; the resource-claim authority evaluates ownership and overlap when called.",
    enforcement: "authorization-vocabulary",
  }),
  stage: Object.freeze({
    requiredAccess: "write",
    isolationRationale:
      "Local index staging is an ordinary mutation and needs write authority without an operation-level exclusive lease.",
    authorityRationale:
      "Authorization vocabulary only; the resource-claim authority evaluates ownership and overlap when called.",
    enforcement: "authorization-vocabulary",
  }),
  commit: Object.freeze({
    requiredAccess: "exclusive-write",
    isolationRationale:
      "Local commit changes repository history and the index, so overlapping declared access is excluded at its boundary.",
    authorityRationale:
      "SessionRegistry.commit invokes the shared operation authorization before staging and commit; resource-claims owns conflict evaluation.",
    enforcement: "public-execution",
  }),
  "branch-mutation": Object.freeze({
    requiredAccess: "exclusive-write",
    isolationRationale:
      "Local branch or ref mutation can alter shared repository state, so overlapping declared access is excluded.",
    authorityRationale:
      "Authorization vocabulary only; no public branch-mutation executor currently routes through this entry.",
    enforcement: "authorization-vocabulary",
  }),
  push: Object.freeze({
    requiredAccess: "exclusive-write",
    isolationRationale:
      "The local push operation boundary is an exclusive mutation boundary over its declared resources.",
    authorityRationale:
      "SessionRegistry.push invokes the shared operation authorization before the Git mutation; resource-claims owns conflict evaluation.",
    enforcement: "public-execution",
  }),
  cleanup: Object.freeze({
    requiredAccess: "exclusive-write",
    isolationRationale:
      "Local cleanup removes session-owned worktree or branch state, so overlapping declared access is excluded.",
    authorityRationale:
      "Authorization vocabulary only; cleanup currently uses its physical cleanup authority rather than this entry.",
    enforcement: "authorization-vocabulary",
  }),
} as const satisfies Readonly<Record<string, OperationAuthorizationPolicy>>;

export type OperationName = keyof typeof OPERATION_AUTHORIZATION_POLICY_RECORD;

/** Public projection of the policy's keys; the policy record remains the authority. */
export const OPERATION_VOCABULARY = Object.freeze(
  Object.keys(OPERATION_AUTHORIZATION_POLICY_RECORD) as readonly OperationName[],
);

/** Public operation policy consumed by authorization and machine-facing audits. */
export const OPERATION_AUTHORIZATION_POLICY = Object.freeze(OPERATION_AUTHORIZATION_POLICY_RECORD);

/** Compatibility projection of required access from the policy authority. */
export const OPERATION_REQUIRED_ACCESS: Readonly<Record<OperationName, ResourceClaimMode>> = Object.freeze(
  Object.fromEntries(
    OPERATION_VOCABULARY.map((operation) => [operation, OPERATION_AUTHORIZATION_POLICY[operation].requiredAccess]),
  ) as Record<OperationName, ResourceClaimMode>,
);

/**
 * Complete decision vocabulary: the operation-authorization-specific codes
 * plus every RegistryErrorCode, since any registry error encountered while
 * authorizing an operation is propagated verbatim as the denial code.
 */
export type OperationAuthorizationCode = "ALLOWED" | "OPERATION_REJECTED" | RegistryErrorCode;

export function isOperationName(value: unknown): value is OperationName {
  return typeof value === "string" && (OPERATION_VOCABULARY as readonly string[]).includes(value);
}

export function requiredAccessForOperation(operation: OperationName): ResourceClaimMode {
  return OPERATION_AUTHORIZATION_POLICY[operation].requiredAccess;
}

/**
 * Keep the authorization surface compatible while delegating mode strength to
 * the resource-claim authority.
 */
export function claimModeGrantsAccess(granted: ResourceClaimMode, required: ResourceClaimMode): boolean {
  return resourceClaimModeGrantsAccess(granted, required);
}

export interface OperationAuthorizationOptions {
  readonly operation: string;
  readonly resources: readonly string[];
  readonly sessionId?: string | null;
}

export interface AuthorizedResource {
  readonly resource: string;
  readonly claimIds: readonly string[];
}

export interface OperationAuthorizationDecision {
  readonly schemaVersion: typeof OPERATION_AUTHORIZATION_SCHEMA_VERSION;
  readonly allowed: boolean;
  readonly code: OperationAuthorizationCode;
  readonly operation: string;
  readonly requiredAccess: ResourceClaimMode | null;
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly branchName: string | null;
  readonly sessionId: string | null;
  readonly ownerSessionId: string | null;
  readonly requestedSessionId: string | null;
  readonly state: string | null;
  readonly resources: readonly AuthorizedResource[];
  readonly details: Readonly<Record<string, boolean | number | string | readonly string[]>>;
}

export const CHECKPOINT_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const CHECKPOINT_MAX_PATHS = 4_096 as const;

export interface GitCheckpointPaths {
  readonly changed: readonly string[];
  readonly staged: readonly string[];
  readonly unstaged: readonly string[];
  readonly untracked: readonly string[];
}

export interface CheckpointEvidence {
  readonly schemaVersion: typeof CHECKPOINT_EVIDENCE_SCHEMA_VERSION;
  readonly source: "git";
  readonly guarantee: "git-observable-only";
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly headId: string;
  readonly sessionId: string;
  readonly paths: GitCheckpointPaths;
  readonly inClaim: readonly string[];
  readonly outOfClaim: readonly string[];
  readonly maxPaths: typeof CHECKPOINT_MAX_PATHS;
}

export interface CheckpointOptions {
  readonly sessionId?: string | null;
}
