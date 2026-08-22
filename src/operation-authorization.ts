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
      "Source-write changes working-tree content path by path; ordinary write permits read declarations while claim conflict checks prevent competing writes.",
    authorityRationale:
      "No standalone public source-write executor exists; authorization reads this policy and resource-claims checks concrete ownership.",
    enforcement: "authorization-vocabulary",
  }),
  stage: Object.freeze({
    requiredAccess: "write",
    isolationRationale:
      "Stage changes local Git index entries for selected paths; write is sufficient because index preparation does not finalize history and read declarations remain non-mutating.",
    authorityRationale:
      "Stage has no standalone public executor; commit's staging phase is authorized as commit while this entry preserves the standalone vocabulary declaration.",
    enforcement: "authorization-vocabulary",
  }),
  commit: Object.freeze({
    requiredAccess: "exclusive-write",
    isolationRationale:
      "Commit records selected staged paths in local history and changes the branch tip; overlapping declarations are excluded while those state changes are finalized.",
    authorityRationale:
      "SessionRegistry.commit invokes the shared operation authorization before staging and commit; resource-claims owns conflict evaluation.",
    enforcement: "public-execution",
  }),
  "branch-mutation": Object.freeze({
    requiredAccess: "exclusive-write",
    isolationRationale:
      "Branch or ref mutation changes a repository pointer shared by worktrees; overlapping declarations are excluded while that pointer ownership changes.",
    authorityRationale:
      "No public branch-mutation executor routes here; branch/worktree lifecycle code retains its dedicated physical ownership checks.",
    enforcement: "authorization-vocabulary",
  }),
  push: Object.freeze({
    requiredAccess: "exclusive-write",
    isolationRationale:
      "Local Git push selects and validates a fixed revision plus explicit resource-scoped input; overlapping declarations are excluded while that basis is checked and sent.",
    authorityRationale:
      "SessionRegistry.push authorizes explicit resources before its Git mutation; resource-claims remains the sole owner of concrete overlap evaluation.",
    enforcement: "public-execution",
  }),
  cleanup: Object.freeze({
    requiredAccess: "exclusive-write",
    isolationRationale:
      "Cleanup removes session-owned worktree and branch state after physical checks; overlapping declarations are excluded for the removal boundary.",
    authorityRationale:
      "Cleanup currently reaches its dedicated physical cleanup authority rather than authorizeOperation, so this entry remains vocabulary-only.",
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
