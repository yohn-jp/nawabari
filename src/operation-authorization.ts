import { claimModeGrantsAccess as resourceClaimModeGrantsAccess, type ResourceClaimMode } from "./resource-claims.js";
import type { RegistryErrorCode } from "./errors.js";

/** Version of the local operation vocabulary and its access policy. */
export const OPERATION_AUTHORIZATION_SCHEMA_VERSION = 1 as const;

/**
 * Operations are intentionally capability-shaped names. They describe the
 * local mutation class only; they do not encode GitHub, Mottainai, or task
 * semantics.
 */
export const OPERATION_VOCABULARY = Object.freeze([
  "source-write",
  "stage",
  "commit",
  "branch-mutation",
  "push",
  "cleanup",
] as const);

export type OperationName = (typeof OPERATION_VOCABULARY)[number];

/** The one authoritative operation-to-claim-access mapping. */
export const OPERATION_REQUIRED_ACCESS: Readonly<Record<OperationName, ResourceClaimMode>> = Object.freeze({
  "source-write": "write",
  stage: "write",
  commit: "exclusive-write",
  "branch-mutation": "exclusive-write",
  push: "exclusive-write",
  cleanup: "exclusive-write",
});

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
  return OPERATION_REQUIRED_ACCESS[operation];
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
