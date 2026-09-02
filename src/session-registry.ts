import fs from "node:fs";
import path from "node:path";

import {
  defaultGit,
  captureGitCheckpoint,
  listGitWorktrees,
  normalizeBranchId,
  observeGitCheckpoint,
  observeGitMutationPaths,
  readBoundedGitDiff,
  readCanonicalCommitChangedPaths,
  readChangedPathNames,
  readGitPathStats,
  readCurrentHead,
  readTreePathStates,
  resolveRepositoryContext,
  treeEntriesEqual,
  verifyPhysicalExecutionContext,
  type GitCommandRunner,
  type GitWorktreeInfo,
  type PhysicalExecutionContext,
  type RepositoryContext,
} from "./git.js";
import { SessionRegistryError, type RegistryErrorCode, type RegistryErrorDetails } from "./errors.js";
import { generateSessionId, isSessionId } from "./session-id.js";
import { isPostRenameFailure, writeJsonAtomicallySync } from "./registry/atomic.js";
import { RegistryLockError, RepositoryLock } from "./registry/lock.js";
import {
  assertCanonicalClaimResource,
  canonicalClaimId,
  canonicalizeClaimInput,
  canonicalizeClaimResource,
  canonicalizeConcretePath,
  claimError,
  classifyResourceClaimTransition,
  claimsConflict,
  claimsOverlap,
  cloneResourceClaim,
  compareCodePointStrings,
  createResourceClaim,
  isResourceClaimMode,
  LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION,
  resourceClaimConflictsWithAccess,
  resourceMatchesClaim,
  RESOURCE_CLAIM_SCHEMA_VERSION,
  sortResourceClaims,
  type ClaimOwnerContext,
  type ResourceClaim,
  type ResourceClaimRecoveryAction,
  type ResourceClaimInput,
  type ResourceClaimMode,
  RESOURCE_CLAIM_RECOVERY_ACTION_ID,
} from "./resource-claims.js";
import {
  CHECKPOINT_EVIDENCE_SCHEMA_VERSION,
  CHECKPOINT_MAX_PATHS,
  OPERATION_AUTHORIZATION_SCHEMA_VERSION,
  claimModeGrantsAccess,
  isOperationName,
  requiredAccessForOperation,
  type CheckpointEvidence,
  type CheckpointOptions,
  type AuthorizedResource,
  type OperationAuthorizationDecision,
  type OperationAuthorizationCode,
  type OperationAuthorizationOptions,
} from "./operation-authorization.js";
import {
  EVIDENCE_MAX_DIFF_BYTES,
  EVIDENCE_MAX_DIFF_HUNKS,
  EVIDENCE_MAX_DIFF_PATHS,
  evidenceHash,
  type RepositoryDiffEvidence,
  type RepositoryDiffOptions,
  type RepositoryEvidenceOptions,
  type RepositoryEvidenceSnapshot,
} from "./repository-evidence.js";

export type { ResourceClaim, ResourceClaimRecoveryAction } from "./resource-claims.js";
export type {
  RepositoryDiffEvidence,
  RepositoryDiffOptions,
  RepositoryEvidenceBounds,
  RepositoryEvidenceOptions,
  RepositoryEvidencePaths,
  RepositoryEvidenceSnapshot,
} from "./repository-evidence.js";
export {
  DIFF_EVIDENCE_SCHEMA_VERSION,
  EVIDENCE_MAX_DIFF_BYTES,
  EVIDENCE_MAX_DIFF_HUNKS,
  EVIDENCE_MAX_DIFF_PATHS,
  REPOSITORY_EVIDENCE_SCHEMA_VERSION,
} from "./repository-evidence.js";

export const REGISTRY_SCHEMA_VERSION = 1 as const;
export { RESOURCE_CLAIM_SCHEMA_VERSION };
export const REGISTRY_DIRECTORY_NAME = "nawabari";
export const REGISTRY_FILE_NAME = "session-registry.json";
export const REGISTRY_LOCK_FILE_NAME = "session-registry.lock";
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
export const CLEANUP_DECISION_SCHEMA_VERSION = 1 as const;
export const RECONCILIATION_SCHEMA_VERSION = 1 as const;
export const SESSION_DIAGNOSTIC_SCHEMA_VERSION = 1 as const;
export const DISCARD_RESULT_SCHEMA_VERSION = 1 as const;
const DEFAULT_LOCK_METADATA_GRACE_MS = 1_000;
/** Bounds a caller-declared commit-message pattern before it is compiled. */
export const MAX_MESSAGE_PATTERN_LENGTH = 512 as const;
const MIGRATION_RECOVERY_HINTS = Object.freeze([
  "Resolve the reported legacy registry ambiguity or corruption before retrying migration.",
  "Do not hand-edit or delete the registry; retry `nawabari migrate --json` after authoritative state is restored.",
]);

export type RegistrySchemaVersion = typeof REGISTRY_SCHEMA_VERSION;
export type SessionState = "new" | "active" | "closing" | "closed" | "stale";

export interface SessionRecord {
  readonly schemaVersion: RegistrySchemaVersion;
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly state: SessionState;
  readonly createdAt: string;
  readonly updatedAt: string;
  /** Exact revision observed at session creation, when the registry can prove it. */
  readonly baseRevision?: string;
  readonly label?: string;
  /** Terminal lifecycle intent for an explicitly discarded session. */
  readonly terminalOperation?: "discard";
  /** HEAD captured before an explicit discard began; retained for retry/audit. */
  readonly discardedHead?: string;
}

export interface CreateSessionOptions {
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly label?: string;
}

export interface ProvisionSessionOptions {
  readonly worktreePath?: string;
  readonly worktreeRoot?: string;
  readonly branchName?: string;
  readonly baseRef?: string;
  readonly label?: string;
  readonly defaultBranchName?: string;
  readonly protectedBranchNames?: readonly string[];
  readonly protectedWorktreePaths?: readonly string[];
}

export interface CloseSessionResult {
  readonly session: SessionRecord;
  readonly worktreeRemoved: boolean;
  readonly branchRemoved: boolean;
  readonly idempotent: boolean;
  readonly claimSetGeneration: number;
  readonly integrationProof?: IntegrationProof;
}

export interface DiscardSessionResult {
  readonly schemaVersion: typeof DISCARD_RESULT_SCHEMA_VERSION;
  readonly operation: "discard";
  readonly session: SessionRecord;
  readonly finalState: SessionState;
  readonly previousHead: string | null;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly worktreeRemoved: boolean;
  readonly branchRemoved: boolean;
  readonly releasedClaims: readonly ResourceClaim[];
  readonly releasedClaimCount: number;
  readonly releasedClaimsTruncated: boolean;
  readonly idempotent: boolean;
  readonly claimSetGeneration: number;
}

export interface CloseSessionOptions {
  readonly sessionId?: string | null;
  readonly session_id?: string | null;
  /** Caller-supplied authoritative revision proving non-ancestry integration (e.g. a squash-merge commit). Independently re-verified by exact Git tree-object equivalence; never trusted blindly. */
  readonly integratedRevision?: string | null;
  readonly integrated_revision?: string | null;
  /** Explicit opt-in remote used only to obtain missing integration-proof objects. */
  readonly fetchRemote?: string | null;
  readonly fetch_remote?: string | null;
  /** Explicit opt-in integration branch used only to obtain missing proof objects. */
  readonly fetchBranch?: string | null;
  readonly fetch_branch?: string | null;
}

export interface DiscardSessionOptions {
  readonly sessionId?: string | null;
  readonly session_id?: string | null;
}

function isCloseSessionOptions(value: unknown): value is CloseSessionOptions {
  return typeof value === "object" && value !== null;
}

function closeIntegrationEvidence(
  sessionIdOrOptions: string | null | CloseSessionOptions,
): IntegrationEvidenceInput | undefined {
  if (!isCloseSessionOptions(sessionIdOrOptions)) return undefined;

  const integratedRevision = sessionIdOrOptions.integratedRevision ?? sessionIdOrOptions.integrated_revision ?? null;
  const fetchRemote = sessionIdOrOptions.fetchRemote ?? sessionIdOrOptions.fetch_remote ?? null;
  const fetchBranch = sessionIdOrOptions.fetchBranch ?? sessionIdOrOptions.fetch_branch ?? null;
  const fetchRequested = fetchRemote !== null || fetchBranch !== null;
  if (!fetchRequested) {
    return integratedRevision === null || integratedRevision === undefined ? undefined : { integratedRevision };
  }

  if (typeof integratedRevision !== "string" || !isFullRevision(integratedRevision)) {
    throw new SessionRegistryError(
      "INVALID_BASE_REF",
      "Explicit integration fetch requires a full lowercase commit SHA",
      {
        baseRef: typeof integratedRevision === "string" ? integratedRevision : "<missing>",
        reason: "fetch-requires-full-sha",
      },
    );
  }

  return {
    integratedRevision,
    fetchRemote: explicitIntegrationRemote(fetchRemote),
    fetchBranch: explicitIntegrationBranch(fetchBranch),
  };
}

/** Caller-supplied non-ancestry integration evidence, already normalized to camelCase. */
export interface IntegrationEvidenceInput {
  readonly integratedRevision: string;
  readonly fetchRemote?: string;
  readonly fetchBranch?: string;
}

/** Git-native proof that the supplied revision belongs to authoritative integration history. */
export interface IntegrationLineageProof {
  readonly method: "integration-branch-ancestor";
  readonly integrationBranch: string;
  readonly integratedRevision: string;
}

/** Exact content proof performed only after the supplied revision is authoritative. */
export interface IntegrationContentProof {
  readonly method: "tree-equivalence";
}

/** Deterministic Git-native evidence proving a branch is safely reclaimable. */
export interface IntegrationProof {
  readonly method: "ancestor" | "tree-equivalence";
  readonly integratedRevision?: string;
  /** Additive proof detail for non-ancestry integration evidence. */
  readonly lineage?: IntegrationLineageProof;
  /** Additive proof detail for the exact changed-path comparison. */
  readonly content?: IntegrationContentProof;
}

export interface GarbageCollectOptions {
  readonly apply?: boolean;
  readonly staleAfterMs?: number;
}

export interface GarbageCollectBlocked {
  readonly sessionId: string;
  readonly code: RegistryErrorCode;
  readonly message: string;
  readonly details: RegistryErrorDetails;
  readonly recoveryHints: readonly string[];
}

export interface GarbageCollectResult {
  readonly apply: boolean;
  readonly candidates: readonly SessionRecord[];
  readonly cleaned: readonly SessionRecord[];
  readonly blocked: readonly GarbageCollectBlocked[];
}

export interface CleanupBlocker {
  readonly code: RegistryErrorCode;
  readonly message: string;
  readonly details: RegistryErrorDetails;
  readonly recoveryHints: readonly string[];
}

export interface CleanupDecision {
  readonly schemaVersion: typeof CLEANUP_DECISION_SCHEMA_VERSION;
  readonly operation: "cleanup";
  readonly allowed: boolean;
  readonly code: "ALLOWED" | RegistryErrorCode;
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly session: SessionRecord;
  readonly claims: readonly ResourceClaim[];
  readonly physicalState: string;
  readonly blockers: readonly CleanupBlocker[];
  readonly recoveryHints: readonly string[];
}

/**
 * Explicit close/cleanup readiness states. `external_evidence_required`
 * marks the #123 non-ancestry-integration case: ancestry alone could not
 * prove the branch safe to reclaim, and a caller-supplied integration
 * revision (independently re-verified, never trusted blindly) may resolve
 * it. `not_due` only applies to cleanup readiness: the session is otherwise
 * safely closable but has not yet met the garbage-collection staleness
 * threshold.
 */
export type ReadinessState = "ready" | "not_due" | "blocked" | "external_evidence_required" | "ambiguous";

/** How complete/certain this diagnostic snapshot is, independent of readiness. */
export type DiagnosticCompleteness = "complete" | "ambiguous" | "stale" | "external_evidence_required";

export interface SessionDiagnosticBlocker extends CleanupBlocker {
  /** Stable, kebab-case next-action identifiers; reusable by orchestrators. */
  readonly safeActions: readonly string[];
}

export interface SessionDiagnosticIntegrationEvidence {
  readonly supplied: boolean;
  readonly integratedRevision?: string;
  readonly proof?: IntegrationProof;
}

export interface SessionDiagnostic {
  readonly schemaVersion: typeof SESSION_DIAGNOSTIC_SCHEMA_VERSION;
  readonly operation: "diagnostic";
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly branchName: string;
  readonly session: SessionRecord;
  readonly claims: readonly ResourceClaim[];
  readonly physicalState: string;
  readonly closeReadiness: ReadinessState;
  readonly cleanupReadiness: ReadinessState;
  readonly resultState: DiagnosticCompleteness;
  readonly idempotent: boolean;
  readonly blockers: readonly SessionDiagnosticBlocker[];
  readonly safeActions: readonly string[];
  readonly integrationEvidence: SessionDiagnosticIntegrationEvidence;
}

export type ReconciliationSessionStatus = "healthy" | "candidate" | "drift" | "closed";

export interface ReconciliationSession {
  readonly session: SessionRecord;
  readonly status: ReconciliationSessionStatus;
  readonly physicalState: string;
  readonly blockers: readonly CleanupBlocker[];
}

export interface ReconciliationIssue {
  readonly code: RegistryErrorCode;
  readonly message: string;
  readonly sessionId: string | null;
  readonly worktreePath: string | null;
  readonly branchName: string | null;
  readonly details: RegistryErrorDetails;
  readonly recoveryHints: readonly string[];
}

export interface ReconciliationResult {
  readonly schemaVersion: typeof RECONCILIATION_SCHEMA_VERSION;
  readonly repositoryId: string;
  readonly worktrees: readonly GitWorktreeInfo[];
  readonly sessions: readonly ReconciliationSession[];
  readonly issues: readonly ReconciliationIssue[];
  readonly clean: boolean;
}

export interface ClaimResourcesOptions {
  readonly sessionId?: string | null;
  readonly session_id?: string | null;
  readonly claims: readonly ResourceClaimInput[];
  readonly repositoryId?: string;
  readonly repository_id?: string;
}

export interface UpdateClaimsOptions extends ClaimResourcesOptions {
  readonly expectedClaimSetGeneration?: number | null;
  readonly expected_claim_set_generation?: number | null;
  readonly force?: boolean;
}

/** One exact-resource mutation in an atomic claim delta batch. */
export type ResourceClaimDelta =
  | { readonly kind: "upsert"; readonly resource: string; readonly mode: ResourceClaimMode }
  | { readonly kind: "release"; readonly resource: string };

/** An exact-resource delta batch. The whole batch is validated before one write. */
export interface ClaimDeltasOptions {
  readonly sessionId?: string | null;
  readonly session_id?: string | null;
  readonly repositoryId?: string;
  readonly repository_id?: string;
  readonly deltas: readonly ResourceClaimDelta[];
  readonly expectedClaimSetGeneration?: number | null;
  readonly expected_claim_set_generation?: number | null;
  readonly force?: boolean;
}

export interface ClaimModeChange {
  readonly resource: string;
  readonly before: ResourceClaim;
  readonly after: ResourceClaim;
}

export type UnchangedClaimDelta =
  | { readonly kind: "upsert"; readonly resource: string; readonly claim: ResourceClaim }
  | { readonly kind: "release"; readonly resource: string };

export interface ClaimDeltasResult {
  readonly session: SessionRecord;
  /** The authoritative complete claim set for the target session after the batch. */
  readonly claims: readonly ResourceClaim[];
  readonly previousClaimSetGeneration: number;
  readonly claimSetGeneration: number;
  readonly added: readonly ResourceClaim[];
  /** Mode changes expose both the removed and replacement claim in one result. */
  readonly changed: readonly ClaimModeChange[];
  readonly released: readonly ResourceClaim[];
  readonly unchanged: readonly UnchangedClaimDelta[];
  readonly idempotent: boolean;
}

export interface ReleaseClaimsOptions {
  readonly sessionId?: string | null;
  readonly session_id?: string | null;
  /** Exact canonical resources to release through the atomic delta authority. */
  readonly resources?: readonly string[] | null;
  readonly claimIds?: readonly string[];
  readonly claim_ids?: readonly string[];
  /** Explicitly release every claim owned by the target session. */
  readonly all?: boolean;
  readonly expectedClaimSetGeneration?: number | null;
  readonly expected_claim_set_generation?: number | null;
  readonly force?: boolean;
}

export interface ClaimResourcesResult {
  readonly session: SessionRecord;
  readonly claims: readonly ResourceClaim[];
  readonly added: readonly ResourceClaim[];
  readonly released: readonly ResourceClaim[];
  readonly idempotent: boolean;
  readonly claimSetGeneration: number;
}

export interface ReleaseClaimsResult {
  readonly sessionId: string;
  readonly released: readonly ResourceClaim[];
  readonly remaining: readonly ResourceClaim[];
  readonly idempotent: boolean;
  readonly claimSetGeneration: number;
}

export interface ClaimSetSnapshot {
  readonly claims: readonly ResourceClaim[];
  readonly claimSetGeneration: number;
}

export interface RegistryMigrationResult {
  readonly migrated: boolean;
  readonly registrySchemaVersion: typeof REGISTRY_SCHEMA_VERSION;
  readonly claimSchemaVersion: typeof RESOURCE_CLAIM_SCHEMA_VERSION;
}

export interface GuardOptions {
  readonly sessionId?: string | null;
}

export type GuardReasonCode = "ALLOWED" | RegistryErrorCode;

export interface GuardDecision {
  readonly allowed: boolean;
  readonly code: GuardReasonCode;
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly branchName: string | null;
  readonly sessionId: string | null;
  readonly ownerSessionId: string | null;
  readonly requestedSessionId: string | null;
  readonly state: SessionState | null;
  readonly details: RegistryErrorDetails;
}

export type {
  CheckpointEvidence,
  CheckpointOptions,
  OperationAuthorizationDecision,
  OperationAuthorizationEnforcement,
  OperationAuthorizationOptions,
  OperationAuthorizationPolicy,
} from "./operation-authorization.js";
export {
  CHECKPOINT_EVIDENCE_SCHEMA_VERSION,
  CHECKPOINT_MAX_PATHS,
  OPERATION_AUTHORIZATION_SCHEMA_VERSION,
  OPERATION_AUTHORIZATION_POLICY,
  OPERATION_REQUIRED_ACCESS,
  OPERATION_VOCABULARY,
} from "./operation-authorization.js";

export interface VerifiedExecutionContext extends PhysicalExecutionContext {
  readonly session: SessionRecord;
}

export const GOVERNED_GIT_OPERATION_SCHEMA_VERSION = 1 as const;

export interface CommitOptions {
  readonly sessionId?: string | null;
  readonly session_id?: string | null;
  readonly message: string;
  /** Concrete repository-relative paths. Globs are never accepted here. */
  readonly resources?: readonly string[];
  /** Alias for callers that name the same explicit paths as paths. */
  readonly paths?: readonly string[];
  /**
   * Caller-declared commit-message rule (a RegExp source the final message
   * must match). Nawabari does not own or infer commit-message conventions;
   * it validates this pattern only when the caller explicitly supplies one.
   */
  readonly messagePattern?: string | null;
  readonly message_pattern?: string | null;
}

export interface CommitResult {
  readonly schemaVersion: typeof GOVERNED_GIT_OPERATION_SCHEMA_VERSION;
  readonly commitSha: string;
  readonly message: string;
  /** The commit's actual changed paths, read back from Git and proven to be within the authorized/staged set. */
  readonly resources: readonly string[];
  /** Present only when Git reported a transport failure after the commit may have taken effect. */
  readonly reconciliation?: CommitReconciliation;
}

export type CommitOutcome = "proven-absent" | "proven-committed" | "unresolved";

/** Bounded local evidence used to classify a commit transport failure. */
export interface CommitReconciliation {
  readonly outcome: CommitOutcome;
  /** A retry is safe only when the pre-commit HEAD is proven unchanged. */
  readonly retrySafe: boolean;
  readonly expectedHead: string;
  readonly observedHead: string | null;
  readonly expectedResources: readonly string[];
  readonly observedResources: readonly string[];
}

export type PushRelation = "no-upstream" | "up-to-date" | "ahead" | "behind" | "diverged";

export interface PushOptions {
  readonly sessionId?: string | null;
  readonly session_id?: string | null;
  /** Explicit claim-covered resources; push never infers these from the registry. */
  readonly resources?: readonly string[];
  readonly remote?: string | null;
  readonly branch?: string | null;
  readonly remoteBranch?: string | null;
  readonly remote_branch?: string | null;
  readonly force?: boolean;
  readonly createUpstream?: boolean;
  readonly create_upstream?: boolean;
}

export interface PushResult {
  readonly schemaVersion: typeof GOVERNED_GIT_OPERATION_SCHEMA_VERSION;
  /** The immutable local commit SHA used as the push source. */
  readonly sourceSha: string;
  readonly remote: string;
  readonly branch: string;
  readonly target: string;
  /** The explicit remote ref targeted by the push. */
  readonly targetRef: string;
  /** The remote branch SHA observed before ancestry inspection and mutation. */
  readonly observedRemoteSha: string | null;
  readonly relation: PushRelation;
  readonly force: boolean;
  readonly upstreamCreated: boolean;
}

export interface SessionRegistryOptions {
  readonly cwd?: string;
  readonly repository?: RepositoryContext;
  readonly git?: GitCommandRunner;
  readonly clock?: () => Date;
  readonly idGenerator?: () => string;
  readonly lockTimeoutMs?: number;
  readonly lockStaleAfterMs?: number;
  readonly lockMetadataGraceMs?: number;
  readonly defaultBranchName?: string;
  readonly protectedBranchNames?: readonly string[];
  readonly protectedWorktreePaths?: readonly string[];
  readonly worktreeRoot?: string;
  readonly staleAfterMs?: number;
}

export interface RegistryPaths {
  readonly directory: string;
  readonly registry: string;
  readonly lock: string;
}

export interface PersistedSessionRecord {
  readonly schema_version: RegistrySchemaVersion;
  readonly session_id: string;
  readonly repository_id: string;
  readonly worktree_id: string;
  readonly worktree_path: string;
  readonly branch_id: string;
  readonly branch_name: string;
  readonly state: SessionState;
  readonly created_at: string;
  readonly updated_at: string;
  readonly base_revision?: string;
  readonly label?: string;
  readonly terminal_operation?: "discard";
  readonly discarded_head?: string;
}

export interface PersistedResourceClaim {
  readonly schema_version: typeof RESOURCE_CLAIM_SCHEMA_VERSION | typeof LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION;
  readonly claim_id: string;
  readonly session_id: string;
  readonly repository_id: string;
  readonly worktree_path: string;
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly created_at: string;
  readonly updated_at: string;
}

export interface PersistedRegistry {
  readonly schema_version: RegistrySchemaVersion;
  readonly repository_id: string;
  readonly sessions: readonly PersistedSessionRecord[];
  /** Optional in the TypeScript shape so pre-claim fixtures remain readable. */
  readonly claims_schema_version?: typeof RESOURCE_CLAIM_SCHEMA_VERSION | typeof LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION;
  /** Optional in the TypeScript shape so pre-claim fixtures remain readable. */
  readonly claims?: readonly PersistedResourceClaim[];
  /** Monotonic authoritative claim-set generation; absent in pre-generation registries. */
  readonly claim_set_generation?: number;
}

interface RegistryState {
  readonly sessions: readonly SessionRecord[];
  readonly claims: readonly ResourceClaim[];
  readonly claimSetGeneration: number;
  readonly legacyClaimsAbsent: boolean;
  readonly legacyClaimsSchemaVersion?: typeof LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION;
}

interface ClaimOwner extends ClaimOwnerContext {
  readonly record: SessionRecord;
}

interface ClaimMutationResult {
  readonly sessions: readonly SessionRecord[];
  readonly claims: readonly ResourceClaim[];
  readonly sessionClaims: readonly ResourceClaim[];
  readonly added: readonly ResourceClaim[];
}

const ACTIVE_STATES: ReadonlySet<SessionState> = new Set(["new", "active", "closing", "stale"]);
const CURRENT_SESSION_STATES: ReadonlySet<SessionState> = new Set(["new", "active", "closing"]);
const SESSION_STATES: ReadonlySet<SessionState> = new Set(["new", "active", "closing", "closed", "stale"]);
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const MAX_ID_GENERATION_ATTEMPTS = 8;

export class SessionRegistry {
  readonly repository: RepositoryContext;
  readonly paths: RegistryPaths;

  private readonly git: GitCommandRunner;
  private readonly clock: () => Date;
  private readonly idGenerator: () => string;
  private readonly lockTimeoutMs: number;
  private readonly defaultBranchName: string | undefined;
  private readonly protectedBranchNames: readonly string[];
  private readonly protectedWorktreePaths: readonly string[];
  private readonly worktreeRoot: string;
  private readonly staleAfterMs: number;
  private readonly lockStaleAfterMs: number;
  private readonly lockMetadataGraceMs: number;
  private readonly lock: RepositoryLock;

  constructor(options: SessionRegistryOptions = {}) {
    this.repository = options.repository ?? resolveRepositoryContext({ cwd: options.cwd, git: options.git });
    this.git = options.git ?? defaultGit;
    this.clock = options.clock ?? (() => new Date());
    this.idGenerator = options.idGenerator ?? generateSessionId;
    this.lockTimeoutMs = options.lockTimeoutMs ?? 5_000;
    this.defaultBranchName = options.defaultBranchName;
    this.protectedBranchNames = Object.freeze([...(options.protectedBranchNames ?? [])]);
    this.protectedWorktreePaths = Object.freeze([...(options.protectedWorktreePaths ?? [])]);
    this.worktreeRoot = resolveManagedWorktreeRoot(options.worktreeRoot ?? path.dirname(this.repository.worktreePath));
    this.staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    this.lockStaleAfterMs = options.lockStaleAfterMs ?? this.lockTimeoutMs;
    this.lockMetadataGraceMs = options.lockMetadataGraceMs ?? DEFAULT_LOCK_METADATA_GRACE_MS;

    if (!Number.isSafeInteger(this.lockTimeoutMs) || this.lockTimeoutMs < 0) {
      throw new RangeError("lockTimeoutMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.staleAfterMs) || this.staleAfterMs < 0) {
      throw new RangeError("staleAfterMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.lockStaleAfterMs) || this.lockStaleAfterMs < 0) {
      throw new RangeError("lockStaleAfterMs must be a non-negative safe integer");
    }
    if (!Number.isSafeInteger(this.lockMetadataGraceMs) || this.lockMetadataGraceMs < 0) {
      throw new RangeError("lockMetadataGraceMs must be a non-negative safe integer");
    }

    const directory = path.join(this.repository.commonGitDirectory, REGISTRY_DIRECTORY_NAME);
    this.paths = Object.freeze({
      directory,
      registry: path.join(directory, REGISTRY_FILE_NAME),
      lock: path.join(directory, REGISTRY_LOCK_FILE_NAME),
    });
    this.lock = new RepositoryLock({
      lockPath: this.paths.lock,
      staleAfterMs: this.lockStaleAfterMs,
      acquireTimeoutMs: this.lockTimeoutMs,
      metadataGraceMs: this.lockMetadataGraceMs,
    });
  }

  /** Resolved repository-local root used for default managed session worktrees. */
  get managedWorktreeRoot(): string {
    return this.worktreeRoot;
  }

  read(): readonly SessionRecord[] {
    return this.readUnsafe().map(cloneSessionRecord);
  }

  list(): readonly SessionRecord[] {
    return this.read();
  }

  get(sessionId: string): SessionRecord | undefined {
    assertSessionId(sessionId);
    const record = this.readUnsafe().find((candidate) => candidate.sessionId === sessionId);
    return record === undefined ? undefined : cloneSessionRecord(record);
  }

  /** Return the single authoritative claim set, optionally scoped to a session. */
  listClaims(sessionId?: string | null): readonly ResourceClaim[] {
    const claims = this.readStateUnsafe().claims;
    if (sessionId === undefined || sessionId === null) return claims.map(cloneResourceClaim);
    assertSessionId(sessionId);
    return claims.filter((claim) => claim.sessionId === sessionId).map(cloneResourceClaim);
  }

  /** Return claims plus the registry-wide generation used for CAS mutations. */
  listClaimsSnapshot(sessionId?: string | null): ClaimSetSnapshot {
    const state = this.readStateUnsafe();
    if (sessionId === undefined || sessionId === null) {
      return { claims: state.claims.map(cloneResourceClaim), claimSetGeneration: state.claimSetGeneration };
    }
    assertSessionId(sessionId);
    return {
      claims: state.claims.filter((claim) => claim.sessionId === sessionId).map(cloneResourceClaim),
      claimSetGeneration: state.claimSetGeneration,
    };
  }

  getClaimSetGeneration(): number {
    return this.readStateUnsafe().claimSetGeneration;
  }

  claimSetGeneration(): number {
    return this.getClaimSetGeneration();
  }

  claims(sessionId?: string | null): readonly ResourceClaim[] {
    return this.listClaims(sessionId);
  }

  getClaim(claimId: string): ResourceClaim | undefined {
    if (typeof claimId !== "string" || claimId.length === 0) {
      throw claimError("CLAIM_NOT_FOUND", "Claim ID must be a non-empty string", { claimId: stringifyDetail(claimId) });
    }
    const claim = this.readStateUnsafe().claims.find((candidate) => candidate.claimId === claimId);
    return claim === undefined ? undefined : cloneResourceClaim(claim);
  }

  /**
   * Explicitly materialize a claim section or upgrade its semantics. A v1
   * claim registry is intentionally unreadable through ordinary operations;
   * only this locked, explicit migration rewrites it as v2.
   */
  migrate(): RegistryMigrationResult {
    return this.withLock(() => {
      let state: RegistryState;
      try {
        state = this.readStateUnsafe(true);
      } catch (error: unknown) {
        throw migrationReadError(error);
      }
      const migrated = state.legacyClaimsAbsent || state.legacyClaimsSchemaVersion !== undefined;
      if (migrated) this.writeUnsafe(state.sessions, state.claims, state.claimSetGeneration);
      return {
        migrated,
        registrySchemaVersion: REGISTRY_SCHEMA_VERSION,
        claimSchemaVersion: RESOURCE_CLAIM_SCHEMA_VERSION,
      };
    });
  }

  claim(
    sessionIdOrOptions: string | ClaimResourcesOptions,
    inputs?: readonly ResourceClaimInput[],
  ): ClaimResourcesResult {
    const options: ClaimResourcesOptions =
      typeof sessionIdOrOptions === "string"
        ? { sessionId: sessionIdOrOptions, claims: inputs ?? [] }
        : sessionIdOrOptions;
    return this.claimResources(options);
  }

  acquireClaims(
    sessionIdOrOptions: string | ClaimResourcesOptions,
    inputs?: readonly ResourceClaimInput[],
  ): ClaimResourcesResult {
    return this.claim(sessionIdOrOptions, inputs);
  }

  /** Add claims atomically. Repeating an equivalent operation is idempotent. */
  claimResources(options: ClaimResourcesOptions): ClaimResourcesResult {
    return this.withLock(() => {
      const state = this.readStateUnsafe();
      const sessionId = this.selectSessionId(options.sessionId ?? options.session_id, state.sessions);
      const owner = this.claimOwner(state.sessions, sessionId, options.repositoryId ?? options.repository_id);
      const requested = this.canonicalClaimInputs(options.claims, owner);
      const result = this.addClaimsUnsafe(state, owner, requested);
      const claimSetGeneration = nextClaimSetGeneration(state, result.claims);
      this.writeUnsafe(result.sessions, result.claims, claimSetGeneration);
      return {
        session: cloneSessionRecord(owner.record),
        claims: result.sessionClaims.map(cloneResourceClaim),
        added: result.added.map(cloneResourceClaim),
        released: [],
        idempotent: result.added.length === 0,
        claimSetGeneration,
      };
    });
  }

  updateClaims(options: UpdateClaimsOptions): ClaimResourcesResult {
    return this.withLock(() => {
      const state = this.readStateUnsafe();
      this.assertClaimSetMutationIntent(options, state.claimSetGeneration);
      const sessionId = this.selectSessionId(options.sessionId ?? options.session_id, state.sessions);
      const owner = this.claimOwner(state.sessions, sessionId, options.repositoryId ?? options.repository_id);
      const requested = this.canonicalClaimInputs(options.claims, owner, true);
      const current = state.claims.filter((claim) => claim.sessionId === sessionId);
      const currentById = new Map(current.map((claim) => [claim.claimId, claim]));
      const timestamp = toTimestamp(this.clock());
      const next = this.validateRequestedClaims(
        requested.map((input) => createResourceClaim(input, owner, timestamp)),
        owner,
        state.claims.filter((claim) => claim.sessionId !== sessionId),
        state.sessions,
      );
      const nextIds = new Set(next.map((claim) => claim.claimId));
      const released = current.filter((claim) => !nextIds.has(claim.claimId));
      const added = next.filter((claim) => !currentById.has(claim.claimId));
      const unchanged = released.length === 0 && added.length === 0 && next.length === current.length;
      const materialized = next.map((claim) => {
        const prior = currentById.get(claim.claimId);
        return prior === undefined
          ? claim
          : cloneResourceClaim({ ...claim, createdAt: prior.createdAt, updatedAt: prior.updatedAt });
      });
      const nextClaims = sortResourceClaims([
        ...state.claims.filter((claim) => claim.sessionId !== sessionId),
        ...materialized,
      ]);
      const claimSetGeneration = nextClaimSetGeneration(state, nextClaims);
      this.writeUnsafe(state.sessions, nextClaims, claimSetGeneration);
      return {
        session: cloneSessionRecord(owner.record),
        claims: materialized.map(cloneResourceClaim),
        added: added.map(cloneResourceClaim),
        released: released.map(cloneResourceClaim),
        idempotent: unchanged,
        claimSetGeneration,
      };
    });
  }

  /**
   * Apply exact-resource upserts and releases as one claim-set transaction.
   * The CAS precondition is checked before any delta-specific validation while
   * the repository lock is held. A mode change replaces the old claim and
   * creates the new claim in the same persisted complete set.
   */
  applyClaimDeltas(options: ClaimDeltasOptions): ClaimDeltasResult {
    return this.withLock(() => {
      const state = this.readStateUnsafe();
      this.assertClaimSetMutationIntent(options, state.claimSetGeneration);
      const sessionId = this.selectSessionId(options.sessionId ?? options.session_id, state.sessions);
      const owner = this.claimOwner(state.sessions, sessionId, options.repositoryId ?? options.repository_id);
      const deltas = this.canonicalClaimDeltas(options.deltas, owner);
      const current = state.claims.filter((claim) => claim.sessionId === sessionId);
      const currentByResource = new Map(current.map((claim) => [claim.resource, claim]));
      const nextByResource = new Map(currentByResource);
      const added: ResourceClaim[] = [];
      const released: ResourceClaim[] = [];
      const changed: ClaimModeChange[] = [];
      const unchanged: UnchangedClaimDelta[] = [];
      const timestamp = toTimestamp(this.clock());

      for (const delta of deltas) {
        const before = currentByResource.get(delta.resource);
        if (delta.kind === "release") {
          classifyResourceClaimTransition(before?.mode ?? "none", "none");
          if (before === undefined) {
            unchanged.push({ kind: "release", resource: delta.resource });
            continue;
          }
          nextByResource.delete(delta.resource);
          released.push(before);
          continue;
        }

        const transition = classifyResourceClaimTransition(before?.mode ?? "none", delta.mode);
        if (transition === "no-op") {
          // `before` is necessarily present for an upsert no-op.
          if (before === undefined) {
            throw new SessionRegistryError("OPERATION_REJECTED", "Claim transition classification was inconsistent");
          }
          unchanged.push({ kind: "upsert", resource: delta.resource, claim: cloneResourceClaim(before) });
          continue;
        }

        const after = createResourceClaim({ resource: delta.resource, mode: delta.mode }, owner, timestamp);
        nextByResource.set(delta.resource, after);
        if (transition === "change") {
          if (before === undefined) {
            throw new SessionRegistryError("OPERATION_REJECTED", "Claim transition classification was inconsistent");
          }
          changed.push({
            resource: delta.resource,
            before: cloneResourceClaim(before),
            after: cloneResourceClaim(after),
          });
        } else {
          added.push(after);
        }
      }

      const nextSessionClaims = sortResourceClaims([...nextByResource.values()]);
      const externalClaims = state.claims.filter((claim) => claim.sessionId !== sessionId);
      // Validate the resulting complete set, including pairwise ownership
      // invariants, before exposing any persistence side effect.
      this.assertCompleteClaimSet(nextSessionClaims, owner, externalClaims, state.sessions);
      const nextClaims = sortResourceClaims([...externalClaims, ...nextSessionClaims]);
      const claimSetGeneration = nextClaimSetGeneration(state, nextClaims);
      if (claimSetGeneration !== state.claimSetGeneration) {
        this.writeUnsafe(state.sessions, nextClaims, claimSetGeneration);
      }

      const idempotent = claimSetGeneration === state.claimSetGeneration;
      return {
        session: cloneSessionRecord(owner.record),
        claims: nextSessionClaims.map(cloneResourceClaim),
        previousClaimSetGeneration: state.claimSetGeneration,
        claimSetGeneration,
        added: added.map(cloneResourceClaim),
        changed: changed.map((entry) => ({
          resource: entry.resource,
          before: cloneResourceClaim(entry.before),
          after: cloneResourceClaim(entry.after),
        })),
        released: released.map(cloneResourceClaim),
        unchanged: unchanged.map((entry) =>
          entry.kind === "upsert"
            ? { kind: entry.kind, resource: entry.resource, claim: cloneResourceClaim(entry.claim) }
            : { kind: entry.kind, resource: entry.resource },
        ),
        idempotent,
      };
    });
  }

  releaseClaims(sessionIdOrOptions: string | ReleaseClaimsOptions, claimIds?: readonly string[]): ReleaseClaimsResult {
    const options: ReleaseClaimsOptions =
      typeof sessionIdOrOptions === "string" ? { sessionId: sessionIdOrOptions, claimIds } : sessionIdOrOptions;

    // Exact-resource release is deliberately projected through the canonical
    // delta authority. That keeps resource canonicalization, duplicate
    // detection, conflict validation, CAS ordering, and one-write atomicity
    // in the same implementation as session mutate/transition.
    const selectedResources = options.resources;
    if (selectedResources !== undefined && selectedResources !== null) {
      if (selectedResources.length === 0) {
        throw claimError("INVALID_CLAIM", "At least one exact resource is required for selected release");
      }
      const selectedClaimIds = options.claimIds ?? options.claim_ids;
      if (selectedClaimIds !== undefined && selectedClaimIds !== null) {
        throw new SessionRegistryError(
          "INVALID_OPERATION",
          "Release selector families are mutually exclusive: resources, claim IDs, or all",
        );
      }
      if (options.all === true) {
        throw new SessionRegistryError(
          "INVALID_OPERATION",
          "Release selector families are mutually exclusive: resources, claim IDs, or all",
        );
      }
      const result = this.applyClaimDeltas({
        sessionId: options.sessionId ?? options.session_id,
        deltas: selectedResources.map((resource) => ({ kind: "release", resource })),
        expectedClaimSetGeneration: options.expectedClaimSetGeneration,
        expected_claim_set_generation: options.expected_claim_set_generation,
        force: options.force,
      });
      return {
        sessionId: result.session.sessionId,
        released: result.released.map(cloneResourceClaim),
        remaining: result.claims.map(cloneResourceClaim),
        idempotent: result.idempotent,
        claimSetGeneration: result.claimSetGeneration,
      };
    }

    return this.withLock(() => {
      const state = this.readStateUnsafe();
      this.assertClaimSetMutationIntent(options, state.claimSetGeneration);
      const sessionId = this.selectSessionId(options.sessionId ?? options.session_id, state.sessions);
      const record = state.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (record === undefined) {
        throw new SessionRegistryError("SESSION_NOT_FOUND", `Session was not found: ${sessionId}`, { sessionId });
      }
      const selectedIds = options.claimIds ?? options.claim_ids;
      if (options.all === true && selectedIds !== undefined && selectedIds !== null) {
        throw new SessionRegistryError(
          "INVALID_OPERATION",
          "Release selector families are mutually exclusive: resources, claim IDs, or all",
        );
      }
      if (selectedIds !== undefined && selectedIds !== null) {
        for (const claimId of selectedIds) {
          if (typeof claimId !== "string" || claimId.length === 0) {
            throw claimError("CLAIM_NOT_FOUND", "Claim ID must be a non-empty string", {
              claimId: stringifyDetail(claimId),
            });
          }
        }
      }
      const sessionClaims = state.claims.filter((claim) => claim.sessionId === sessionId);
      const wanted =
        selectedIds === undefined || selectedIds === null || options.all === true
          ? new Set(sessionClaims.map((claim) => claim.claimId))
          : new Set(selectedIds);
      if (selectedIds !== undefined && selectedIds !== null) {
        for (const claimId of wanted) {
          const existing = state.claims.find((claim) => claim.claimId === claimId);
          if (existing !== undefined && existing.sessionId !== sessionId) {
            throw claimError("CLAIM_SESSION_MISMATCH", "Claim is owned by another session", {
              claimId,
              ownerSessionId: existing.sessionId,
              sessionId,
            });
          }
        }
      }
      const released = sessionClaims.filter((claim) => wanted.has(claim.claimId));
      const remaining = sessionClaims.filter((claim) => !wanted.has(claim.claimId));
      const nextClaims = state.claims.filter((claim) => claim.sessionId !== sessionId || !wanted.has(claim.claimId));
      const claimSetGeneration = nextClaimSetGeneration(state, nextClaims);
      if (claimSetGeneration !== state.claimSetGeneration) {
        this.writeUnsafe(state.sessions, nextClaims, claimSetGeneration);
      }
      return {
        sessionId,
        released: released.map(cloneResourceClaim),
        remaining: remaining.map(cloneResourceClaim),
        // Release is a delete-style operation: an already absent claim is an
        // explicitly stable no-op, which makes a retried release safe after a
        // process crash or timeout.
        idempotent: released.length === 0,
        claimSetGeneration,
      };
    });
  }

  releaseSessionClaims(sessionId: string): ReleaseClaimsResult {
    return this.releaseClaims({ sessionId, all: true, force: true });
  }

  create(options: CreateSessionOptions = {}): SessionRecord {
    return this.mutate((records) => {
      const resources = this.resolveCreationResources(options);
      for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
        const sessionId = this.idGenerator();
        assertSessionId(sessionId);
        if (records.some((record) => record.sessionId === sessionId)) {
          continue;
        }

        const timestamp = toTimestamp(this.clock());
        const record = freezeSessionRecord({
          schemaVersion: REGISTRY_SCHEMA_VERSION,
          sessionId,
          repositoryId: this.repository.repositoryId,
          worktreeId: resources.worktreeId,
          worktreePath: resources.worktreePath,
          branchId: resources.branchId,
          branchName: resources.branchName,
          state: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          baseRevision: resources.baseRevision,
          ...(options.label === undefined ? {} : { label: validateLabel(options.label) }),
        });

        assertNoOwnershipConflict(records, record);
        return { records: [...records, record], result: cloneSessionRecord(record) };
      }

      throw new SessionRegistryError(
        "SESSION_ID_COLLISION",
        `Could not generate a unique session ID after ${MAX_ID_GENERATION_ATTEMPTS} attempts`,
        { attempts: MAX_ID_GENERATION_ATTEMPTS },
      );
    });
  }

  createSession(options: CreateSessionOptions = {}): SessionRecord {
    return this.create(options);
  }

  /** Provision one isolated Git worktree and commit its ownership atomically. */
  provision(options: ProvisionSessionOptions = {}): SessionRecord {
    return this.withLock(() => {
      verifyPhysicalExecutionContext({
        repository: this.repository,
        worktreePath: this.repository.worktreePath,
        git: this.git,
      });
      const state = this.readStateUnsafe();
      const sessionId = generateUniqueSessionId(state.sessions, this.idGenerator);
      const resources = this.resolveProvisioningResources(options, sessionId);
      const timestamp = toTimestamp(this.clock());
      const record = freezeSessionRecord({
        schemaVersion: REGISTRY_SCHEMA_VERSION,
        sessionId,
        repositoryId: this.repository.repositoryId,
        worktreeId: resources.worktreePath,
        worktreePath: resources.worktreePath,
        branchId: resources.branchId,
        branchName: resources.branchName,
        state: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        baseRevision: resources.baseRevision,
        ...(options.label === undefined ? {} : { label: validateLabel(options.label) }),
      });

      assertNoOwnershipConflict(state.sessions, record);
      assertGitResourcesAvailable(this.git, this.repository.worktreePath, resources);

      let gitProvisioned = false;
      try {
        this.git.run(
          ["worktree", "add", "--quiet", "-b", resources.branchName, resources.worktreePath, resources.baseRevision],
          this.repository.worktreePath,
        );
        gitProvisioned = true;
        verifyPhysicalExecutionContext({
          repository: this.repository,
          worktreePath: resources.worktreePath,
          branchName: resources.branchName,
          git: this.git,
        });
        this.writeUnsafe([...state.sessions, record], state.claims, state.claimSetGeneration);
        return cloneSessionRecord(record);
      } catch (error: unknown) {
        if (gitProvisioned && this.absenceProvenAfterProvisioningFailure(error, sessionId)) {
          rollbackProvisionedResources(this.git, this.repository.worktreePath, resources);
        }
        throw classifyProvisioningFailure(error, this.git, this.repository.worktreePath, resources);
      }
    });
  }

  /**
   * Decide whether it is safe to destroy the just-created worktree/branch
   * after a provisioning failure. Only an ordinary (non-durability-uncertain)
   * failure, or a durability-uncertain failure whose registry re-read
   * positively proves the session record absent, licenses a rollback.
   *
   * A durability-uncertain write means the rename may have already
   * committed this session as the registry's visible ownership record:
   * rolling back the worktree/branch would then strand a registry entry
   * pointing at resources we just deleted. Absence must be *proven*, not
   * merely unconfirmed — if the reconciliation read itself cannot complete
   * (I/O failure, corrupt registry state, or any other exception), that is
   * not proof of absence, so no rollback happens and the original
   * durability-uncertain outcome propagates unchanged.
   */
  private absenceProvenAfterProvisioningFailure(error: unknown, sessionId: string): boolean {
    const durabilityUncertain = error instanceof SessionRegistryError && error.code === "REGISTRY_DURABILITY_UNCERTAIN";
    if (!durabilityUncertain) {
      return true;
    }
    try {
      return !this.readUnsafe().some((candidate) => candidate.sessionId === sessionId);
    } catch {
      return false;
    }
  }

  provisionSession(options: ProvisionSessionOptions = {}): SessionRecord {
    return this.provision(options);
  }

  createProvisionedSession(options: ProvisionSessionOptions = {}): SessionRecord {
    return this.provision(options);
  }

  register(record: SessionRecord): SessionRecord {
    const validated = validateSessionRecord(record, this.repository.repositoryId);
    return this.mutate((records) => {
      const physical = verifyPhysicalExecutionContext({
        repository: this.repository,
        worktreePath: validated.worktreePath,
        branchName: validated.branchName,
        git: this.git,
      });
      if (validated.worktreeId !== physical.worktreePath) {
        throw new SessionRegistryError("WORKTREE_MISMATCH", "Registered worktree identity does not match Git", {
          expectedWorktree: validated.worktreePath,
          actualWorktree: physical.worktreePath,
        });
      }
      if (records.some((candidate) => candidate.sessionId === validated.sessionId)) {
        throw new SessionRegistryError("DUPLICATE_SESSION_ID", `Session ID already exists: ${validated.sessionId}`, {
          sessionId: validated.sessionId,
        });
      }
      assertNoOwnershipConflict(records, validated);
      return { records: [...records, validated], result: cloneSessionRecord(validated) };
    });
  }

  registerSession(record: SessionRecord): SessionRecord {
    return this.register(record);
  }

  resolveCurrentSession(): SessionRecord {
    return cloneSessionRecord(this.verifyExecutionContext().session);
  }

  currentSession(): SessionRecord {
    return this.resolveCurrentSession();
  }

  /**
   * Resolve Git's physical facts and the registry's active owner as one
   * fail-closed observation for governed operations.
   */
  verifyExecutionContext(options: GuardOptions = {}): VerifiedExecutionContext {
    const physical = verifyPhysicalExecutionContext({
      repository: this.repository,
      worktreePath: this.repository.worktreePath,
      git: this.git,
    });
    const session = this.resolveSessionOwnership(physical, options.sessionId ?? null);
    return Object.freeze({ ...physical, session: cloneSessionRecord(session) });
  }

  /** Resolve and physically verify an explicitly addressed active session. */
  private verifyEvidenceSession(sessionId: string): {
    readonly session: SessionRecord;
    readonly physical: PhysicalExecutionContext;
  } {
    assertSessionId(sessionId);
    const record = this.readUnsafe().find((candidate) => candidate.sessionId === sessionId);
    if (record === undefined || record.state === "closed") {
      throw new SessionRegistryError("SESSION_NOT_FOUND", `Session was not found: ${sessionId}`, { sessionId });
    }
    if (record.state !== "active") {
      throw new SessionRegistryError("STALE_REGISTRY", `Session is not active: ${sessionId}`, {
        sessionId,
        state: record.state,
      });
    }

    const physical = verifyPhysicalExecutionContext({
      repository: this.repository,
      worktreePath: record.worktreePath,
      branchName: record.branchName,
      git: this.git,
    });
    if (physical.worktreeId !== record.worktreeId || physical.branchId !== record.branchId) {
      throw new SessionRegistryError("OWNERSHIP_MISMATCH", "The selected session does not own the observed worktree", {
        sessionId,
        expectedWorktree: record.worktreePath,
        actualWorktree: physical.worktreePath,
        expectedBranch: record.branchName,
        actualBranch: physical.branchName,
      });
    }
    return Object.freeze({ session: cloneSessionRecord(record), physical });
  }

  /** Shared physical/protected/ownership path for every governed decision. */
  private verifyGovernedExecutionContext(
    requestedSessionId: string | null,
    observedPhysical?: PhysicalExecutionContext,
  ): VerifiedExecutionContext {
    const physical =
      observedPhysical ??
      verifyPhysicalExecutionContext({
        repository: this.repository,
        worktreePath: this.repository.worktreePath,
        git: this.git,
      });
    if (this.protectedWorktree(this.repository.worktreePath, physical.worktrees)) {
      throw this.protectedExecutionContextError(
        "PROTECTED_WORKTREE",
        "The current worktree is protected",
        { worktree: this.repository.worktreePath },
        requestedSessionId,
      );
    }
    if (this.protectedBranch(physical.branchName, physical.worktrees)) {
      throw this.protectedExecutionContextError(
        "PROTECTED_BRANCH",
        "The current branch is protected",
        { branch: physical.branchName },
        requestedSessionId,
      );
    }
    const session = this.resolveSessionOwnership(physical, requestedSessionId);
    return Object.freeze({ ...physical, session: cloneSessionRecord(session) });
  }

  /**
   * Distinguish the current (protected) command execution context from the
   * referenced/target session, so a caller does not have to separately
   * re-discover where the operation should actually run. `phase: "execution"`
   * marks this live-command rejection distinctly from the cleanup-time
   * PROTECTED_WORKTREE/PROTECTED_BRANCH block, which `safeActionsForCode`
   * and `recoveryHintsForCode` key on for a different, non-mutating safe
   * action set.
   */
  private protectedExecutionContextError(
    code: "PROTECTED_WORKTREE" | "PROTECTED_BRANCH",
    message: string,
    contextDetails: RegistryErrorDetails,
    requestedSessionId: string | null,
  ): SessionRegistryError {
    const target =
      requestedSessionId === null
        ? undefined
        : this.readUnsafe().find((record) => record.sessionId === requestedSessionId);
    const details: RegistryErrorDetails = {
      ...contextDetails,
      phase: "execution",
      ...(requestedSessionId === null ? {} : { requestedSessionId }),
      ...(target === undefined
        ? {}
        : {
            targetWorktree: target.worktreePath,
            targetBranch: target.branchName,
            targetState: target.state,
            ...(target.label === undefined ? {} : { targetLabel: target.label }),
          }),
    };
    return new SessionRegistryError(code, message, {
      ...details,
      safeActions: [...safeActionsForCode(code, details)],
      recoveryHints: recoveryHintsForCode(code, details),
    });
  }

  private resolveSessionOwnership(
    physical: PhysicalExecutionContext,
    requestedSessionId: string | null,
  ): SessionRecord {
    const records = this.readUnsafe();
    const currentRecords = records.filter(
      (record) => ACTIVE_STATES.has(record.state) && samePath(record.worktreeId, physical.worktreePath),
    );
    if (currentRecords.length > 1) {
      throw new SessionRegistryError(
        "DUPLICATE_WORKTREE_OWNERSHIP",
        `Multiple sessions claim the current worktree: ${physical.worktreePath}`,
        {
          worktree: physical.worktreePath,
          sessionId: requestedSessionId ?? "<unspecified>",
          ownerSessionId: currentRecords[0].sessionId,
        },
      );
    }
    const currentRecord = currentRecords[0];
    if (currentRecord === undefined) {
      const branchRecord = records.find(
        (record) => ACTIVE_STATES.has(record.state) && record.branchId === physical.branchId,
      );
      if (branchRecord !== undefined) {
        throw new SessionRegistryError(
          "WORKTREE_MISMATCH",
          "The current worktree is not the worktree owned by the current branch session",
          {
            sessionId: branchRecord.sessionId,
            expectedWorktree: branchRecord.worktreePath,
            actualWorktree: physical.worktreePath,
          },
        );
      }
      const requestedRecord =
        requestedSessionId === null ? undefined : records.find((record) => record.sessionId === requestedSessionId);
      throw new SessionRegistryError(
        "SESSION_NOT_FOUND",
        `No active session owns the current worktree: ${physical.worktreePath}`,
        {
          worktree: physical.worktreePath,
          ...(requestedRecord === undefined ? {} : { state: requestedRecord.state }),
        },
      );
    }
    if (currentRecord.state !== "active") {
      throw new SessionRegistryError(
        "STALE_REGISTRY",
        `The current worktree is recorded in non-active state: ${currentRecord.state}`,
        {
          sessionId: currentRecord.sessionId,
          ownerSessionId: currentRecord.sessionId,
          state: currentRecord.state,
          worktree: physical.worktreePath,
        },
      );
    }
    if (currentRecord.repositoryId !== physical.repositoryId) {
      throw new SessionRegistryError("REPOSITORY_MISMATCH", "The session repository identity does not match Git", {
        expectedRepositoryId: currentRecord.repositoryId,
        actualRepositoryId: physical.repositoryId,
      });
    }
    if (!samePath(currentRecord.worktreePath, physical.worktreePath)) {
      throw new SessionRegistryError("WORKTREE_MISMATCH", "The session worktree identity does not match Git", {
        expectedWorktree: currentRecord.worktreePath,
        actualWorktree: physical.worktreePath,
      });
    }
    if (currentRecord.branchId !== physical.branchId || currentRecord.branchName !== physical.branchName) {
      throw new SessionRegistryError("BRANCH_MISMATCH", "The session branch identity does not match Git", {
        expectedBranch: currentRecord.branchName,
        actualBranch: physical.branchName,
      });
    }

    if (requestedSessionId !== null) {
      const requestedRecord = records.find((record) => record.sessionId === requestedSessionId);
      if (requestedRecord === undefined || requestedRecord.state === "closed") {
        throw new SessionRegistryError("SESSION_NOT_FOUND", `Session was not found: ${requestedSessionId}`, {
          sessionId: requestedSessionId,
        });
      }
      if (requestedRecord.state !== "active") {
        throw new SessionRegistryError("STALE_REGISTRY", `Session is not active: ${requestedSessionId}`, {
          sessionId: requestedSessionId,
          state: requestedRecord.state,
        });
      }
      if (requestedRecord.sessionId !== currentRecord.sessionId) {
        throw new SessionRegistryError(
          "DUPLICATE_WORKTREE_OWNERSHIP",
          "The requested session does not own the current worktree",
          {
            worktree: physical.worktreePath,
            sessionId: requestedSessionId,
            ownerSessionId: currentRecord.sessionId,
          },
        );
      }
    }
    return currentRecord;
  }

  /**
   * Evaluate the current worktree as a Nawabari mutation context without taking
   * the registry lock or changing Git or registry state.
   */
  guard(options: GuardOptions = {}): GuardDecision {
    const requestedSessionId = options.sessionId ?? null;
    const base = {
      repositoryId: this.repository.repositoryId,
      worktreePath: this.repository.worktreePath,
      branchName: null as string | null,
      sessionId: null as string | null,
      ownerSessionId: null as string | null,
      requestedSessionId,
      state: null as SessionState | null,
    };
    let verifiedIdentity = base;

    try {
      if (requestedSessionId !== null && !isSessionId(requestedSessionId)) {
        return deniedGuard("INVALID_SESSION_ID", verifiedIdentity, { sessionId: requestedSessionId });
      }

      const physical = verifyPhysicalExecutionContext({
        repository: this.repository,
        worktreePath: this.repository.worktreePath,
        git: this.git,
      });
      const identityBase = { ...base, branchName: physical.branchName };
      verifiedIdentity = identityBase;

      let currentRecord: SessionRecord;
      try {
        currentRecord = this.verifyGovernedExecutionContext(requestedSessionId, physical).session;
      } catch (error: unknown) {
        if (
          error instanceof SessionRegistryError &&
          (error.code === "DUPLICATE_WORKTREE_OWNERSHIP" || error.code === "STALE_REGISTRY")
        ) {
          const ownerSessionId = typeof error.details.ownerSessionId === "string" ? error.details.ownerSessionId : null;
          const owner =
            ownerSessionId === null
              ? undefined
              : this.readUnsafe().find((record) => record.sessionId === ownerSessionId);
          return deniedGuard(
            error.code,
            {
              ...identityBase,
              sessionId: owner?.sessionId ?? null,
              ownerSessionId: owner?.sessionId ?? null,
              state: owner?.state ?? null,
            },
            error.details,
            owner?.sessionId ?? null,
            owner?.state ?? null,
          );
        }
        throw error;
      }
      identityBase.sessionId = currentRecord.sessionId;
      identityBase.ownerSessionId = currentRecord.sessionId;
      identityBase.state = currentRecord.state;

      return Object.freeze({
        allowed: true,
        code: "ALLOWED" as const,
        ...identityBase,
        details: {},
      });
    } catch (error: unknown) {
      if (error instanceof SessionRegistryError) {
        return deniedGuard(
          error.code,
          verifiedIdentity,
          error.details,
          verifiedIdentity.ownerSessionId,
          verifiedIdentity.state,
        );
      }
      throw error;
    }
  }

  /**
   * The single claim-aware authorization decision for every governed local
   * operation. Ownership is observed first; caller labels never substitute for
   * the physical repository/worktree/branch facts or persisted claims.
   */
  authorizeOperation(options: OperationAuthorizationOptions): OperationAuthorizationDecision {
    const requestedSessionId = options.sessionId ?? null;
    const base: OperationDecisionBase = {
      schemaVersion: OPERATION_AUTHORIZATION_SCHEMA_VERSION,
      allowed: false,
      code: "OPERATION_REJECTED",
      operation: typeof options.operation === "string" ? options.operation : "<invalid>",
      requiredAccess: null,
      repositoryId: this.repository.repositoryId,
      worktreePath: this.repository.worktreePath,
      branchName: null,
      sessionId: null,
      ownerSessionId: null,
      requestedSessionId,
      state: null,
      resources: [],
    };
    let verified = base;

    try {
      if (requestedSessionId !== null && !isSessionId(requestedSessionId)) {
        return deniedOperation("INVALID_SESSION_ID", verified, { sessionId: requestedSessionId });
      }
      if (!isOperationName(options.operation)) {
        return deniedOperation("INVALID_OPERATION", verified, { operation: stringifyDetail(options.operation) });
      }
      const requiredAccess = requiredAccessForOperation(options.operation);
      verified = { ...base, operation: options.operation, requiredAccess };

      if (!Array.isArray(options.resources) || options.resources.length === 0) {
        return deniedOperation("INVALID_RESOURCE", verified, { reason: "at-least-one-concrete-resource-required" });
      }
      if (options.resources.length > CHECKPOINT_MAX_PATHS) {
        return deniedOperation("INVALID_RESOURCE", verified, {
          reason: "too-many-resources",
          maxResources: CHECKPOINT_MAX_PATHS,
        });
      }

      const execution = this.verifyGovernedExecutionContext(requestedSessionId);
      const physical = execution;
      verified = { ...verified, branchName: physical.branchName };
      const currentRecord = execution.session;
      verified = {
        ...verified,
        sessionId: currentRecord.sessionId,
        ownerSessionId: currentRecord.sessionId,
        state: currentRecord.state,
      };

      const resources = canonicalOperationResources(options.resources, physical.worktreePath);
      // Authorization decision is advisory only. Claims may change between this
      // read and actual commit/push execution. Stale-decision handling is deferred
      // to future commit/push execution path; this PR adds no locking, revalidation,
      // claim-version tokens, or mutation logic.
      const state = this.readStateUnsafe();
      const activeSessionIds = new Set(
        state.sessions.filter((record) => record.state === "active").map((record) => record.sessionId),
      );
      const activeClaims = state.claims.filter((claim) => activeSessionIds.has(claim.sessionId));
      const authorized: AuthorizedResource[] = [];

      for (const resource of resources) {
        const ownClaims = activeClaims.filter(
          (claim) => claim.sessionId === currentRecord.sessionId && resourceMatchesClaim(claim, resource),
        );
        const grantingClaims = ownClaims.filter((claim) => claimModeGrantsAccess(claim.mode, requiredAccess));
        if (grantingClaims.length === 0) {
          const conflictingClaim = activeClaims.find(
            (claim) =>
              claim.sessionId !== currentRecord.sessionId &&
              resourceClaimConflictsWithAccess(claim, resource, requiredAccess),
          );
          if (conflictingClaim !== undefined) {
            const conflictDetails = resourceClaimConflictDetails(
              { resource, mode: requiredAccess },
              conflictingClaim,
              state.sessions,
            );
            return deniedOperation("RESOURCE_CLAIM_CONFLICT", verified, {
              ...conflictDetails,
              safeActions: [...safeActionsForCode("RESOURCE_CLAIM_CONFLICT", conflictDetails)],
              recoveryHints: recoveryHintsForCode("RESOURCE_CLAIM_CONFLICT", conflictDetails),
            });
          }
          if (ownClaims.length > 0) {
            return deniedOperation("INSUFFICIENT_CLAIM_MODE", verified, {
              resource,
              requiredAccess,
              grantedModes: sortStrings(new Set(ownClaims.map((claim) => claim.mode))),
              sessionId: currentRecord.sessionId,
            });
          }
          return deniedOperation("MISSING_RESOURCE_CLAIM", verified, {
            resource,
            requiredAccess,
            sessionId: currentRecord.sessionId,
          });
        }
        authorized.push({
          resource,
          claimIds: sortStrings(grantingClaims.map((claim) => claim.claimId)),
        });
      }

      return Object.freeze({
        ...verified,
        allowed: true,
        code: "ALLOWED" as const,
        resources: Object.freeze(authorized),
        details: {},
      });
    } catch (error: unknown) {
      if (error instanceof SessionRegistryError) {
        const ownerSessionId =
          typeof error.details.ownerSessionId === "string" ? error.details.ownerSessionId : verified.ownerSessionId;
        const state = typeof error.details.state === "string" ? error.details.state : verified.state;
        return deniedOperation(
          error.code,
          {
            ...verified,
            sessionId: ownerSessionId,
            ownerSessionId,
            state,
          },
          error.details,
        );
      }
      throw error;
    }
  }

  /**
   * Stage and commit only caller-declared, claim-authorized resources.
   * Authorization, physical observations, and Git mutation are serialized by
   * the existing repository lock; this method does not introduce another
   * ownership or mutation authority.
   */
  commit(options: CommitOptions): CommitResult {
    // Validated before the repository lock is acquired: a pathological
    // caller-declared pattern must not hold the cross-session repository
    // lock hostage while it backtracks.
    const messagePattern = options.messagePattern ?? options.message_pattern ?? null;
    assertFinalCommitMessage(options.message, messagePattern);

    return this.withLock(() => {
      const sessionId = operationSessionId(options.sessionId, options.session_id);
      const requestedResources = operationResources(options.resources ?? options.paths);
      const authorization = this.requireMutationAuthorization("commit", requestedResources, sessionId);
      const initial = this.verifyGovernedExecutionContext(sessionId);

      const before = observeGitMutationPaths(this.git, initial.worktreePath);
      assertNoUnexpectedMutationPaths(
        before.changed,
        authorization.resources.map((resource) => resource.resource),
      );
      const stageResources = authorization.resources
        .map((resource) => resource.resource)
        .filter((resource) => before.changed.includes(resource));
      if (stageResources.length === 0) {
        throw new SessionRegistryError(
          "COMMIT_EMPTY_DIFF",
          "None of the authorized resources has a Git-visible change",
          {
            resources: authorization.resources.map((resource) => resource.resource),
          },
        );
      }

      reverifyMutationContext(this, initial, sessionId, "stage");
      runMutationGit(
        this.git,
        ["add", "--", ...stageResources],
        initial.worktreePath,
        "stage",
        "COMMIT_STAGING_FAILED",
      );

      const afterStage = observeGitMutationPaths(this.git, initial.worktreePath);
      assertNoUnexpectedMutationPaths(afterStage.changed, stageResources);
      if (!afterStage.staged.some((resource) => stageResources.includes(resource))) {
        throw new SessionRegistryError("COMMIT_STAGING_FAILED", "Git staging produced no authorized staged paths", {
          resources: stageResources,
        });
      }

      reverifyMutationContext(this, initial, sessionId, "commit");
      const beforeCommit = observeGitMutationPaths(this.git, initial.worktreePath);
      assertNoUnexpectedMutationPaths(beforeCommit.changed, stageResources);
      if (!beforeCommit.staged.some((resource) => stageResources.includes(resource))) {
        throw new SessionRegistryError("COMMIT_STAGING_FAILED", "Authorized staged paths disappeared before commit", {
          resources: stageResources,
        });
      }

      try {
        runMutationGit(this.git, ["commit", "-m", options.message], initial.worktreePath, "commit", "COMMIT_FAILED");
      } catch (error: unknown) {
        if (
          error instanceof SessionRegistryError &&
          (isBoundedGitFailure(error.code) || error.code === "COMMIT_FAILED")
        ) {
          return reconcileCommitTransportFailure(
            this.git,
            initial.worktreePath,
            initial.headId,
            stageResources,
            options.message,
            error,
          );
        }
        throw error;
      }

      let commitSha: string;
      try {
        commitSha = readCurrentHead(this.git, initial.worktreePath);
      } catch (error: unknown) {
        if (error instanceof SessionRegistryError && isBoundedGitFailure(error.code)) throw error;
        throw new SessionRegistryError(
          "COMMIT_RESULT_UNAVAILABLE",
          "Git committed the operation but the resulting commit SHA could not be resolved",
          { phase: "resolve-commit-result" },
          error,
        );
      }

      // The Git commit succeeded and its SHA is known; every failure from here
      // must retain commitSha so the caller can recover/reconcile the result
      // instead of losing track of a commit that actually happened.
      let committedPaths: readonly string[];
      try {
        committedPaths = readCanonicalCommitChangedPaths(this.git, initial.worktreePath, commitSha);
      } catch (error: unknown) {
        if (error instanceof SessionRegistryError && isBoundedGitFailure(error.code)) {
          throw new SessionRegistryError(error.code, error.message, { ...error.details, commitSha }, error);
        }
        throw new SessionRegistryError(
          "COMMIT_RESULT_UNAVAILABLE",
          "Git committed the operation but its actual changed paths could not be resolved",
          { commitSha, phase: "resolve-commit-paths" },
          error,
        );
      }

      const authorizedSet = new Set(stageResources);
      const divergentResources = committedPaths.filter((resource) => !authorizedSet.has(resource));
      if (divergentResources.length > 0) {
        throw new SessionRegistryError(
          "COMMIT_RESULT_DIVERGED",
          "The resulting commit contains paths outside the authorized/staged resource set",
          {
            commitSha,
            authorizedResources: [...stageResources],
            committedResources: [...committedPaths],
            divergentResources,
          },
        );
      }

      return Object.freeze({
        schemaVersion: GOVERNED_GIT_OPERATION_SCHEMA_VERSION,
        commitSha,
        message: options.message,
        resources: committedPaths,
      });
    });
  }

  commitSession(options: CommitOptions): CommitResult {
    return this.commit(options);
  }

  /** Push the currently owned branch to an explicit remote/branch target. */
  push(options: PushOptions): PushResult {
    return this.withLock(() => {
      const sessionId = operationSessionId(options.sessionId, options.session_id);
      const requestedResources = operationResources(options.resources);
      this.requireMutationAuthorization("push", requestedResources, sessionId);
      const initial = this.verifyGovernedExecutionContext(sessionId);
      const remote = explicitRemote(options.remote);
      const branch = explicitRemoteBranch(options.branch, options.remoteBranch ?? options.remote_branch);
      const force = options.force === true;
      const createUpstream = options.createUpstream === true || options.create_upstream === true;

      if (branch !== initial.session.branchName) {
        throw new SessionRegistryError(
          "PUSH_TARGET_MISMATCH",
          "The explicit push branch must match the session-owned branch",
          {
            sessionBranch: initial.session.branchName,
            pushBranch: branch,
          },
        );
      }

      const inspection = inspectPushTarget(this.git, initial.worktreePath, remote, branch, initial.headId);
      if (inspection.upstream !== undefined && inspection.upstream !== `${remote}/${branch}`) {
        throw new SessionRegistryError(
          "PUSH_TARGET_MISMATCH",
          "The explicit push target does not match the currently configured upstream",
          { upstream: inspection.upstream, remote, branch },
        );
      }
      if (inspection.relation === "no-upstream" && !createUpstream) {
        throw new SessionRegistryError(
          "PUSH_NO_UPSTREAM",
          "The current branch has no upstream; upstream creation must be explicitly requested",
          { remote, branch, relation: "no-upstream", upstreamCreated: false },
        );
      }
      if (inspection.relation !== "no-upstream" && createUpstream) {
        throw new SessionRegistryError(
          "PUSH_TARGET_MISMATCH",
          "Upstream creation was requested for a branch that already has an upstream",
          { upstream: inspection.upstream ?? `${remote}/${branch}`, remote, branch },
        );
      }
      if ((inspection.relation === "behind" || inspection.relation === "diverged") && !force) {
        const code = inspection.relation === "behind" ? "PUSH_BEHIND" : "PUSH_DIVERGED";
        throw new SessionRegistryError(
          code,
          `The local and remote branches are ${inspection.relation}; explicit force intent is required`,
          { remote, branch, relation: inspection.relation, forceRequired: true },
        );
      }

      const dirtyBefore = observeGitMutationPaths(this.git, initial.worktreePath);
      if (dirtyBefore.changed.length > 0) {
        throw new SessionRegistryError("PUSH_DIRTY_WORKTREE", "Push requires a clean Git worktree", {
          paths: [...dirtyBefore.changed],
        });
      }

      const finalContext = reverifyMutationContext(this, initial, sessionId, "push");
      const dirtyBeforePush = observeGitMutationPaths(this.git, initial.worktreePath);
      if (dirtyBeforePush.changed.length > 0) {
        throw new SessionRegistryError("PUSH_DIRTY_WORKTREE", "The worktree changed before push mutation", {
          paths: [...dirtyBeforePush.changed],
        });
      }

      const targetRef = `refs/heads/${branch}`;
      const leaseValue = inspection.observedRemoteSha ?? "";
      const pushArguments = [
        "push",
        // Exact-generation CAS is required for every push mutation. The
        // force authorization check above remains independent: force is only
        // allowed for the behind/diverged relations, while the lease binds
        // either kind of push to the generation observed during inspection.
        `--force-with-lease=${targetRef}:${leaseValue}`,
        ...(createUpstream ? ["--set-upstream"] : []),
        remote,
        `${finalContext.headId}:${targetRef}`,
      ];
      runMutationGit(this.git, pushArguments, initial.worktreePath, "push", "PUSH_FAILED");
      if (createUpstream) {
        // A SHA:ref refspec is intentional: it cannot be redirected by a
        // mutable symbolic HEAD. Git does not consistently infer the current
        // branch's tracking configuration from a raw SHA source, so complete
        // the explicitly requested local upstream setup after the push.
        runMutationGit(
          this.git,
          ["branch", "--set-upstream-to", `${remote}/${branch}`, branch],
          initial.worktreePath,
          "set-upstream",
          "PUSH_FAILED",
        );
      }

      return Object.freeze({
        schemaVersion: GOVERNED_GIT_OPERATION_SCHEMA_VERSION,
        sourceSha: finalContext.headId,
        remote,
        branch,
        target: `${remote}/${branch}`,
        targetRef,
        observedRemoteSha: inspection.observedRemoteSha,
        relation: inspection.relation,
        force,
        upstreamCreated: createUpstream,
      });
    });
  }

  pushSession(options: PushOptions): PushResult {
    return this.push(options);
  }

  private requireMutationAuthorization(
    operation: "commit" | "push",
    resources: readonly string[],
    sessionId: string | null,
  ): OperationAuthorizationDecision {
    const decision = this.authorizeOperation({ operation, resources, sessionId });
    if (decision.allowed) return decision;
    const code = decision.code === "ALLOWED" ? "OPERATION_REJECTED" : decision.code;
    throw new SessionRegistryError(code, `Operation ${operation} was denied: ${code}`, {
      ...decision.details,
      operation,
      resources: decision.resources.map((resource) => resource.resource),
    });
  }

  /** Capture bounded Git evidence for the current owned session's declaration. */
  checkpoint(options: CheckpointOptions = {}): CheckpointEvidence {
    const requestedSessionId = options.sessionId ?? null;
    if (requestedSessionId !== null && !isSessionId(requestedSessionId)) {
      throw new SessionRegistryError("INVALID_SESSION_ID", `Invalid session ID: ${requestedSessionId}`, {
        sessionId: requestedSessionId,
      });
    }

    const execution = this.verifyGovernedExecutionContext(requestedSessionId);
    const physical = execution;
    const session = execution.session;
    const paths = observeGitCheckpoint(this.git, physical.worktreePath);
    const state = this.readStateUnsafe();
    const activeClaims = state.claims.filter(
      (claim) =>
        claim.sessionId === session.sessionId &&
        state.sessions.some((record) => record.sessionId === claim.sessionId && record.state === "active"),
    );
    const inClaim = new Set<string>();
    for (const resource of paths.changed) {
      if (activeClaims.some((claim) => resourceMatchesClaim(claim, resource))) inClaim.add(resource);
    }
    const outOfClaim = paths.changed.filter((resource) => !inClaim.has(resource));

    return Object.freeze({
      schemaVersion: CHECKPOINT_EVIDENCE_SCHEMA_VERSION,
      source: "git" as const,
      guarantee: "git-observable-only" as const,
      repositoryId: physical.repositoryId,
      worktreePath: physical.worktreePath,
      branchName: physical.branchName,
      headId: physical.headId,
      sessionId: session.sessionId,
      paths: Object.freeze(paths),
      inClaim: Object.freeze(sortStrings(inClaim)),
      outOfClaim: Object.freeze(outOfClaim),
      maxPaths: CHECKPOINT_MAX_PATHS,
    });
  }

  captureCheckpoint(options: CheckpointOptions = {}): CheckpointEvidence {
    return this.checkpoint(options);
  }

  /**
   * Capture one deterministic, read-only physical repository generation for
   * an explicitly addressed owned session.
   */
  repositoryEvidence(options: RepositoryEvidenceOptions): RepositoryEvidenceSnapshot {
    return this.withLock(() => {
      const initial = this.verifyEvidenceSession(options.sessionId);
      const paths = observeGitCheckpoint(this.git, initial.physical.worktreePath);
      const stats =
        paths.changed.length === 0
          ? []
          : readGitPathStats(this.git, initial.physical.worktreePath, paths.changed, initial.physical.headId);
      const final = this.verifyEvidenceSession(options.sessionId);
      if (
        final.physical.branchName !== initial.physical.branchName ||
        final.physical.headId !== initial.physical.headId ||
        !sameCheckpointPaths(paths, observeGitCheckpoint(this.git, final.physical.worktreePath))
      ) {
        throw new SessionRegistryError(
          "GIT_STATE_AMBIGUOUS",
          "Repository evidence changed during physical observation",
          {
            sessionId: options.sessionId,
            worktree: initial.physical.worktreePath,
          },
        );
      }

      const baseRevision = initial.session.baseRevision ?? null;
      const incompleteReasons = stats.some((stat) => !stat.available) ? ["STAT_UNAVAILABLE"] : [];
      const pathsEvidence = Object.freeze({
        changed: paths.changed,
        staged: paths.staged,
        unstaged: paths.unstaged,
        untracked: paths.untracked,
        stats: Object.freeze([...stats]),
      });
      const snapshotWithoutHash = {
        schemaVersion: 1 as const,
        source: "git" as const,
        guarantee: "git-observable-only" as const,
        repositoryId: initial.physical.repositoryId,
        worktreePath: initial.physical.worktreePath,
        branchId: initial.physical.branchId,
        branchName: initial.physical.branchName,
        sessionId: initial.session.sessionId,
        sessionState: initial.session.state,
        sessionCreatedAt: initial.session.createdAt,
        sessionUpdatedAt: initial.session.updatedAt,
        baseRevision,
        baseRevisionProven: baseRevision !== null,
        headId: initial.physical.headId,
        clean: paths.changed.length === 0,
        complete: incompleteReasons.length === 0,
        incompleteReasons: Object.freeze(incompleteReasons),
        paths: pathsEvidence,
        bounds: Object.freeze({
          maxPaths: CHECKPOINT_MAX_PATHS,
          maxDiffPaths: EVIDENCE_MAX_DIFF_PATHS,
          maxDiffBytes: EVIDENCE_MAX_DIFF_BYTES,
          maxDiffHunks: EVIDENCE_MAX_DIFF_HUNKS,
        }),
      };
      return Object.freeze({
        ...snapshotWithoutHash,
        evidenceHash: evidenceHash(snapshotWithoutHash),
      });
    });
  }

  evidenceSnapshot(options: RepositoryEvidenceOptions): RepositoryEvidenceSnapshot {
    return this.repositoryEvidence(options);
  }

  /** Inspect only explicitly selected paths with bounded stat/patch output. */
  repositoryDiff(options: RepositoryDiffOptions): RepositoryDiffEvidence {
    return this.withLock(() => {
      const initial = this.verifyEvidenceSession(options.sessionId);
      const diff = readBoundedGitDiff(this.git, initial.physical.worktreePath, {
        paths: options.paths,
        from: options.from,
        to: options.to,
        includePatch: options.includePatch,
        maxBytes: options.maxBytes,
        maxHunks: options.maxHunks,
      });
      const final = this.verifyEvidenceSession(options.sessionId);
      if (
        final.physical.branchName !== initial.physical.branchName ||
        final.physical.headId !== initial.physical.headId
      ) {
        throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Repository diff changed during physical observation", {
          sessionId: options.sessionId,
          worktree: initial.physical.worktreePath,
        });
      }

      const diffWithoutHash = {
        schemaVersion: diff.schemaVersion,
        source: "git" as const,
        guarantee: "git-observable-only" as const,
        repositoryId: initial.physical.repositoryId,
        worktreePath: initial.physical.worktreePath,
        branchId: initial.physical.branchId,
        branchName: initial.physical.branchName,
        sessionId: initial.session.sessionId,
        sessionState: initial.session.state,
        headId: initial.physical.headId,
        fromRevision: diff.fromRevision,
        toRevision: diff.toRevision,
        paths: diff.paths,
        stats: diff.stats,
        complete: diff.stats.every((stat) => stat.available),
        incompleteReasons: Object.freeze(diff.stats.some((stat) => !stat.available) ? ["STAT_UNAVAILABLE"] : []),
        patch: diff.patch,
        patchBytes: diff.patchBytes,
        hunkCount: diff.hunkCount,
        maxBytes: options.maxBytes ?? EVIDENCE_MAX_DIFF_BYTES,
        maxHunks: options.maxHunks ?? EVIDENCE_MAX_DIFF_HUNKS,
      };
      return Object.freeze({
        ...diffWithoutHash,
        evidenceHash: evidenceHash(diffWithoutHash),
      });
    });
  }

  diff(options: RepositoryDiffOptions): RepositoryDiffEvidence {
    return this.repositoryDiff(options);
  }

  /**
   * Produce the authoritative, non-mutating cleanup decision for one session.
   * The decision observes registry claims and current Git/filesystem state in
   * one repository-locked read; it never repairs drift or removes resources.
   */
  cleanupDecision(sessionIdOrOptions?: string | null | CloseSessionOptions): CleanupDecision {
    return this.withLock(() => {
      const state = this.readStateUnsafe();
      const requestedSessionId =
        typeof sessionIdOrOptions === "object" && sessionIdOrOptions !== null
          ? (sessionIdOrOptions.sessionId ?? sessionIdOrOptions.session_id)
          : sessionIdOrOptions;
      const sessionId = requestedSessionId ?? this.resolveOwnerSession(state.sessions).sessionId;
      assertSessionId(sessionId);
      const record = state.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (record === undefined) {
        throw new SessionRegistryError("SESSION_NOT_FOUND", `Session was not found: ${sessionId}`, { sessionId });
      }
      return this.cleanupDecisionUnsafe(record, state);
    });
  }

  /** Compatibility alias for callers that name the same authority an assessment. */
  assessCleanup(sessionIdOrOptions?: string | null | CloseSessionOptions): CleanupDecision {
    return this.cleanupDecision(sessionIdOrOptions);
  }

  /**
   * Side-effect-free close/cleanup readiness diagnostic for one session. This
   * observes the exact same authoritative Git/session/claim truth `close()`
   * uses (including the #123 non-ancestry integration proof contract when
   * `integratedRevision` evidence is supplied) without mutating any session,
   * claim, Git, or registry state.
   */
  diagnose(sessionIdOrOptions?: string | null | CloseSessionOptions): SessionDiagnostic {
    return this.withLock(() => {
      const state = this.readStateUnsafe();
      const requestedSessionId = isCloseSessionOptions(sessionIdOrOptions)
        ? (sessionIdOrOptions.sessionId ?? sessionIdOrOptions.session_id)
        : sessionIdOrOptions;
      const sessionId = requestedSessionId ?? this.resolveOwnerSession(state.sessions).sessionId;
      assertSessionId(sessionId);
      const record = state.sessions.find((candidate) => candidate.sessionId === sessionId);
      if (record === undefined) {
        throw new SessionRegistryError("SESSION_NOT_FOUND", `Session was not found: ${sessionId}`, { sessionId });
      }
      const integratedRevision = isCloseSessionOptions(sessionIdOrOptions)
        ? (sessionIdOrOptions.integratedRevision ?? sessionIdOrOptions.integrated_revision ?? null)
        : null;
      const evidence: IntegrationEvidenceInput | undefined =
        integratedRevision === null || integratedRevision === undefined ? undefined : { integratedRevision };
      return this.diagnoseUnsafe(record, state, evidence);
    });
  }

  /**
   * Reconcile registry ownership with Git's physical worktree inventory.
   * This is deliberately diagnostic-only: no stale metadata is repaired and
   * no physical resource is removed by this method.
   */
  reconcile(): ReconciliationResult {
    return this.withLock(() => {
      const state = this.readStateUnsafe();
      const worktrees = listGitWorktrees(this.git, this.repository.worktreePath);
      const now = toTimestamp(this.clock());
      const sessions = state.sessions.map((record) => this.reconcileSessionUnsafe(record, worktrees, now));
      const issues: ReconciliationIssue[] = [];
      for (const item of sessions) {
        for (const blocker of item.blockers) {
          issues.push({
            code: blocker.code,
            message: blocker.message,
            sessionId: item.session.sessionId,
            worktreePath: item.session.worktreePath,
            branchName: item.session.branchName,
            details: blocker.details,
            recoveryHints: blocker.recoveryHints,
          });
        }
      }

      const recordedPaths = new Set(
        state.sessions.filter((record) => ACTIVE_STATES.has(record.state)).map((record) => record.worktreePath),
      );
      const recordedBranches = new Set(
        state.sessions.filter((record) => ACTIVE_STATES.has(record.state)).map((record) => record.branchName),
      );
      for (const worktree of worktrees) {
        if (recordedPaths.has(worktree.worktreePath) || recordedBranches.has(worktree.branchName ?? "")) continue;
        if (this.protectedWorktree(worktree.worktreePath, worktrees)) continue;
        issues.push({
          code: "OWNERSHIP_MISMATCH",
          message: "Git reports a worktree with no active Nawabari owner",
          sessionId: null,
          worktreePath: worktree.worktreePath,
          branchName: worktree.branchName,
          details: {
            worktree: worktree.worktreePath,
            branch: worktree.branchName ?? "<detached>",
            prunable: worktree.prunable,
          },
          recoveryHints: recoveryHintsForCode("OWNERSHIP_MISMATCH"),
        });
      }

      return Object.freeze({
        schemaVersion: RECONCILIATION_SCHEMA_VERSION,
        repositoryId: this.repository.repositoryId,
        worktrees: Object.freeze(worktrees.map((worktree) => Object.freeze({ ...worktree }))),
        sessions: Object.freeze(sessions),
        issues: Object.freeze(issues),
        clean: issues.length === 0,
      });
    });
  }

  reconcileState(): ReconciliationResult {
    return this.reconcile();
  }

  /** Close one session only after its ownership and recoverability are proven safe. */
  close(sessionIdOrOptions?: string | null | CloseSessionOptions): CloseSessionResult {
    return this.withLock(() => {
      const sessionId = isCloseSessionOptions(sessionIdOrOptions)
        ? (sessionIdOrOptions.sessionId ?? sessionIdOrOptions.session_id)
        : sessionIdOrOptions;
      const selectedSessionId = sessionId ?? this.resolveCurrentSession().sessionId;
      assertSessionId(selectedSessionId);
      const evidence = closeIntegrationEvidence(sessionIdOrOptions ?? null);
      return this.closeUnsafe(selectedSessionId, evidence);
    });
  }

  closeSession(sessionIdOrOptions?: string | null | CloseSessionOptions): CloseSessionResult {
    return this.close(sessionIdOrOptions);
  }

  /** Explicitly discard exactly one selected session; never resolves the current owner implicitly. */
  discard(sessionIdOrOptions: string | DiscardSessionOptions): DiscardSessionResult {
    return this.withLock(() => {
      const requestedSessionId =
        typeof sessionIdOrOptions === "string"
          ? sessionIdOrOptions
          : (sessionIdOrOptions.sessionId ?? sessionIdOrOptions.session_id ?? null);
      if (requestedSessionId === null) {
        throw new SessionRegistryError(
          "SESSION_NOT_FOUND",
          "Explicit session identity is required for discard; the current session is never inferred",
        );
      }
      assertSessionId(requestedSessionId);
      return this.discardUnsafe(requestedSessionId);
    });
  }

  discardSession(sessionIdOrOptions: string | DiscardSessionOptions): DiscardSessionResult {
    return this.discard(sessionIdOrOptions);
  }

  /** Detect stale sessions, optionally applying only cleanup that passes close preflight. */
  garbageCollect(options: GarbageCollectOptions = {}): GarbageCollectResult {
    const apply = options.apply ?? false;
    const staleAfterMs = options.staleAfterMs ?? this.staleAfterMs;
    assertStaleAfterMs(staleAfterMs);

    return this.withLock(() => {
      const state = this.readStateUnsafe();
      let records = [...state.sessions];
      let claims = state.claims;
      let claimSetGeneration = state.claimSetGeneration;
      const now = toTimestamp(this.clock());
      const worktrees = listGitWorktrees(this.git, this.repository.worktreePath);
      const candidates = records
        .filter((record) => isStaleCandidate(record, now, staleAfterMs, worktrees))
        .map(cloneSessionRecord);

      const blocked: GarbageCollectBlocked[] = [];
      if (!apply) {
        for (const candidate of candidates) {
          const current = records.find((record) => record.sessionId === candidate.sessionId);
          if (current === undefined || current.state === "closed") continue;
          try {
            this.assertCleanupAllowed(current, state);
          } catch (error: unknown) {
            blocked.push(toGarbageCollectBlocked(candidate.sessionId, error));
          }
        }
        return {
          apply,
          candidates,
          cleaned: [],
          blocked,
        };
      }

      const cleaned: SessionRecord[] = [];
      for (const candidate of candidates) {
        const current = records.find((record) => record.sessionId === candidate.sessionId);
        if (current === undefined || current.state === "closed") continue;

        if (current.state !== "stale" && current.state !== "closing") {
          const staleRecord = transitionSessionState(current, "stale", this.clock);
          records = replaceRecord(records, staleRecord);
          validateRecords(records, this.repository.repositoryId);
          this.writeUnsafe(records, claims, claimSetGeneration);
        }

        try {
          const result = this.closeUnsafe(candidate.sessionId);
          cleaned.push(result.session);
        } catch (error: unknown) {
          blocked.push(toGarbageCollectBlocked(candidate.sessionId, error));
        }
        const updatedState = this.readStateUnsafe();
        records = [...updatedState.sessions];
        claims = updatedState.claims;
        claimSetGeneration = updatedState.claimSetGeneration;
      }

      return {
        apply,
        candidates,
        cleaned: cleaned.map(cloneSessionRecord),
        blocked,
      };
    });
  }

  gc(options: GarbageCollectOptions = {}): GarbageCollectResult {
    return this.garbageCollect(options);
  }

  private resolveOwnerSession(records: readonly SessionRecord[]): SessionRecord {
    const matches = records.filter(
      (record) => CURRENT_SESSION_STATES.has(record.state) && record.worktreeId === this.repository.worktreePath,
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) {
      throw new SessionRegistryError(
        "DUPLICATE_WORKTREE_OWNERSHIP",
        `Multiple active sessions own the current worktree: ${this.repository.worktreePath}`,
        { worktree: this.repository.worktreePath },
      );
    }
    throw new SessionRegistryError(
      "SESSION_NOT_FOUND",
      `No active session owns the current worktree: ${this.repository.worktreePath}`,
      { worktree: this.repository.worktreePath },
    );
  }

  private selectSessionId(requested: string | null | undefined, records: readonly SessionRecord[]): string {
    if (requested !== undefined && requested !== null) {
      assertSessionId(requested);
      return requested;
    }
    return this.resolveOwnerSession(records).sessionId;
  }

  private claimOwner(records: readonly SessionRecord[], sessionId: string, requestedRepositoryId?: string): ClaimOwner {
    if (requestedRepositoryId !== undefined && requestedRepositoryId !== this.repository.repositoryId) {
      throw claimError("CLAIM_REPOSITORY_MISMATCH", "Resource claim repository does not match the current repository", {
        expectedRepositoryId: this.repository.repositoryId,
        actualRepositoryId: requestedRepositoryId,
      });
    }
    const record = records.find((candidate) => candidate.sessionId === sessionId);
    if (record === undefined) {
      throw new SessionRegistryError("SESSION_NOT_FOUND", `Session was not found: ${sessionId}`, { sessionId });
    }
    if (record.repositoryId !== this.repository.repositoryId) {
      throw claimError("CLAIM_REPOSITORY_MISMATCH", "Session repository does not match the current repository", {
        expectedRepositoryId: this.repository.repositoryId,
        actualRepositoryId: record.repositoryId,
        sessionId,
      });
    }
    if (record.state !== "active") {
      throw claimError("SESSION_NOT_ACTIVE", `Session cannot acquire resource claims while ${record.state}`, {
        sessionId,
        state: record.state,
      });
    }
    return {
      ...record,
      record,
    };
  }

  private assertClaimSetMutationIntent(
    options: UpdateClaimsOptions | ReleaseClaimsOptions | ClaimDeltasOptions,
    actualGeneration: number,
  ): void {
    const expected = options.expectedClaimSetGeneration ?? options.expected_claim_set_generation;
    const forced = options.force === true;
    if (expected !== undefined && expected !== null && forced) {
      throw new SessionRegistryError(
        "INVALID_OPERATION",
        "Claim-set mutation requires exactly one of expectedClaimSetGeneration or force",
      );
    }
    if (expected === undefined || expected === null) {
      if (forced) return;
      throw new SessionRegistryError(
        "INVALID_OPERATION",
        "Claim-set mutation requires expectedClaimSetGeneration or force",
      );
    }
    if (!Number.isSafeInteger(expected) || expected < 0) {
      throw new SessionRegistryError(
        "INVALID_OPERATION",
        "expectedClaimSetGeneration must be a non-negative safe integer",
        { expectedClaimSetGeneration: typeof expected === "number" ? expected : String(expected) },
      );
    }
    if (expected !== actualGeneration) {
      throw new SessionRegistryError(
        "STALE_CLAIM_SET",
        "Claim-set generation does not match the current registry state",
        {
          expectedClaimSetGeneration: expected,
          actualClaimSetGeneration: actualGeneration,
        },
      );
    }
  }

  private canonicalClaimDeltas(
    deltas: readonly ResourceClaimDelta[],
    owner: ClaimOwner,
  ): readonly ResourceClaimDelta[] {
    if (!Array.isArray(deltas) || deltas.length === 0) {
      throw claimError("INVALID_CLAIM", "At least one claim delta is required");
    }

    const seen = new Map<string, ResourceClaimDelta>();
    const canonical: ResourceClaimDelta[] = [];
    for (const delta of deltas) {
      if (typeof delta !== "object" || delta === null) {
        throw claimError("INVALID_CLAIM", "A claim delta must be an object");
      }
      if (delta.kind !== "upsert" && delta.kind !== "release") {
        throw claimError("INVALID_CLAIM", "Claim delta kind is unsupported", {
          kind: typeof delta.kind === "string" ? delta.kind : String(delta.kind),
        });
      }
      if (delta.kind === "upsert" && !isResourceClaimMode(delta.mode)) {
        throw claimError("INVALID_CLAIM", "Claim delta mode is unsupported", {
          mode: typeof delta.mode === "string" ? delta.mode : String(delta.mode),
        });
      }
      const normalized: ResourceClaimDelta =
        delta.kind === "upsert"
          ? { kind: "upsert", ...canonicalizeClaimInput({ resource: delta.resource, mode: delta.mode }, owner) }
          : { kind: "release", resource: canonicalizeClaimResource(delta.resource, owner.worktreePath) };
      const prior = seen.get(normalized.resource);
      if (prior !== undefined) {
        const contradictory =
          prior.kind !== normalized.kind ||
          (prior.kind === "upsert" && normalized.kind === "upsert" && prior.mode !== normalized.mode);
        throw claimError(
          contradictory ? "CONTRADICTORY_CLAIM" : "DUPLICATE_CLAIM",
          contradictory
            ? "Request contains contradictory deltas for one exact resource"
            : "Request contains duplicate deltas for one exact resource",
          {
            resource: normalized.resource,
            kind: normalized.kind,
            ...(normalized.kind === "upsert" ? { mode: normalized.mode } : {}),
            otherKind: prior.kind,
            ...(prior.kind === "upsert" ? { otherMode: prior.mode } : {}),
          },
        );
      }
      seen.set(normalized.resource, normalized);
      canonical.push(normalized);
    }
    return canonical.sort((left, right) =>
      compareCodePointStrings(
        `${left.resource}\u0000${left.kind}\u0000${left.kind === "upsert" ? left.mode : ""}`,
        `${right.resource}\u0000${right.kind}\u0000${right.kind === "upsert" ? right.mode : ""}`,
      ),
    );
  }

  private assertCompleteClaimSet(
    candidates: readonly ResourceClaim[],
    owner: ClaimOwner,
    externalClaims: readonly ResourceClaim[],
    sessions: readonly SessionRecord[],
  ): void {
    this.assertNoOverlappingClaims(candidates);
    this.validateRequestedClaims(candidates, owner, externalClaims, sessions);
  }

  /** Single same-session overlap authority shared by additive and delta paths. */
  private assertNoOverlappingClaims(claims: readonly ResourceClaim[], context: "request" | "result" = "result"): void {
    for (let index = 0; index < claims.length; index += 1) {
      const current = claims[index];
      if (current === undefined) continue;
      for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
        const prior = claims[priorIndex];
        if (prior === undefined || !claimsOverlap(current, prior)) continue;
        const requestContext = context === "request";
        throw claimError(
          current.mode === prior.mode ? "DUPLICATE_CLAIM" : "CONTRADICTORY_CLAIM",
          current.mode === prior.mode
            ? requestContext
              ? "Request contains overlapping equivalent claims"
              : "Claim set contains overlapping claims for one session"
            : requestContext
              ? "Request contains overlapping claims with different modes"
              : "Claim set contains overlapping claims for one session",
          requestContext
            ? current.mode === prior.mode
              ? { resource: current.resource, mode: current.mode }
              : {
                  resource: current.resource,
                  mode: current.mode,
                  otherResource: prior.resource,
                  otherMode: prior.mode,
                }
            : {
                claimId: current.claimId,
                ownerClaimId: prior.claimId,
                resource: current.resource,
                mode: current.mode,
                otherResource: prior.resource,
                otherMode: prior.mode,
              },
        );
      }
    }
  }

  private canonicalClaimInputs(
    inputs: readonly ResourceClaimInput[],
    owner: ClaimOwner,
    allowEmpty = false,
  ): readonly { resource: string; mode: ResourceClaimMode }[] {
    if (!Array.isArray(inputs) || (!allowEmpty && inputs.length === 0)) {
      throw claimError("INVALID_CLAIM", "At least one resource claim is required");
    }
    const canonical = inputs
      .map((input) => canonicalizeClaimInput(input, owner))
      .sort((left, right) =>
        compareCodePointStrings(`${left.resource}\u0000${left.mode}`, `${right.resource}\u0000${right.mode}`),
      );
    const timestamp = toTimestamp(this.clock());
    const claims = canonical.map((input) => createResourceClaim(input, owner, timestamp));
    this.assertNoOverlappingClaims(claims, "request");
    return canonical;
  }

  private addClaimsUnsafe(
    state: RegistryState,
    owner: ClaimOwner,
    requested: readonly { resource: string; mode: ResourceClaimMode }[],
  ): ClaimMutationResult {
    const timestamp = toTimestamp(this.clock());
    const candidates = requested.map((input) => createResourceClaim(input, owner, timestamp));
    const existing = state.claims.filter((claim) => claim.sessionId !== owner.sessionId);
    const current = state.claims.filter((claim) => claim.sessionId === owner.sessionId);
    const added = this.validateRequestedClaims(
      candidates,
      owner,
      [...existing, ...current],
      state.sessions,
      state.claimSetGeneration,
    );
    const nextClaims = sortResourceClaims([
      ...state.claims,
      ...added.filter((candidate) => !current.some((claim) => claim.claimId === candidate.claimId)),
    ]);
    return {
      sessions: state.sessions,
      claims: nextClaims,
      sessionClaims: nextClaims.filter((claim) => claim.sessionId === owner.sessionId),
      added: added.filter((candidate) => !current.some((claim) => claim.claimId === candidate.claimId)),
    };
  }

  private validateRequestedClaims(
    candidates: readonly ResourceClaim[],
    owner: ClaimOwner,
    existing: readonly ResourceClaim[],
    sessions: readonly SessionRecord[] = [],
    additiveClaimSetGeneration?: number,
  ): readonly ResourceClaim[] {
    for (const candidate of candidates) {
      const exact = existing.find((claim) => claim.claimId === candidate.claimId);
      if (exact !== undefined) {
        if (
          exact.sessionId !== owner.sessionId ||
          exact.repositoryId !== owner.repositoryId ||
          exact.worktreePath !== owner.worktreePath ||
          exact.resource !== candidate.resource ||
          exact.mode !== candidate.mode
        ) {
          throw claimError("CONTRADICTORY_CLAIM", "Claim identity is already bound to different canonical data", {
            claimId: candidate.claimId,
          });
        }
        continue;
      }
      const overlapping = existing.filter((current) => claimsOverlap(candidate, current));
      for (const current of overlapping) {
        if (current.sessionId === owner.sessionId) {
          if (current.mode === candidate.mode) {
            throw claimError("DUPLICATE_CLAIM", "Session already owns an overlapping claim", {
              claimId: current.claimId,
              resource: current.resource,
              mode: current.mode,
            });
          }
          const recoveryAction =
            additiveClaimSetGeneration !== undefined &&
            candidates.length === 1 &&
            overlapping.length === 1 &&
            current.resource === candidate.resource &&
            isExactCanonicalClaimResource(candidate.resource)
              ? claimTransitionRecoveryAction(
                  owner.sessionId,
                  candidate.resource,
                  candidate.mode,
                  additiveClaimSetGeneration,
                )
              : undefined;
          throw claimError("CONTRADICTORY_CLAIM", "Session already owns an overlapping claim with another mode", {
            claimId: current.claimId,
            resource: current.resource,
            mode: current.mode,
            ...(recoveryAction === undefined
              ? {}
              : {
                  recoveryAction,
                  safeActions: [recoveryAction.actionId],
                }),
          });
        }
        if (claimsConflict(candidate, current)) {
          const conflictDetails = resourceClaimConflictDetails(candidate, current, sessions);
          throw claimError("RESOURCE_CLAIM_CONFLICT", "Resource claim conflicts with an active session claim", {
            claimId: candidate.claimId,
            ...conflictDetails,
            safeActions: [...safeActionsForCode("RESOURCE_CLAIM_CONFLICT", conflictDetails)],
            recoveryHints: recoveryHintsForCode("RESOURCE_CLAIM_CONFLICT", conflictDetails),
          });
        }
      }
    }
    return candidates;
  }

  private closeUnsafe(sessionId: string, evidence?: IntegrationEvidenceInput): CloseSessionResult {
    const state = this.readStateUnsafe();
    const records = state.sessions;
    const record = records.find((candidate) => candidate.sessionId === sessionId);
    if (record === undefined) {
      throw new SessionRegistryError("SESSION_NOT_FOUND", `Session was not found: ${sessionId}`, {
        sessionId,
      });
    }
    if (record.state === "closed") {
      return {
        session: cloneSessionRecord(record),
        worktreeRemoved: false,
        branchRemoved: false,
        idempotent: true,
        claimSetGeneration: state.claimSetGeneration,
      };
    }
    if (record.terminalOperation === "discard") {
      throw new SessionRegistryError(
        "OPERATION_REJECTED",
        "An explicit discard is already in progress; retry session discard to complete it",
        { sessionId, state: record.state, terminalOperation: "discard", safeActions: ["retry-discard"] },
      );
    }

    let resources: CleanupResources;
    try {
      resources = this.inspectCleanupResources(record, undefined, evidence);
    } catch (error: unknown) {
      throw enrichCloseBlockerError(error);
    }
    const closingRecord = record.state === "closing" ? record : transitionSessionState(record, "closing", this.clock);
    let closingRecords = replaceRecord(records, closingRecord);
    validateRecords(closingRecords, this.repository.repositoryId);
    this.writeUnsafe(closingRecords, state.claims, state.claimSetGeneration);

    let worktreeRemoved = false;
    let branchRemoved = false;
    let integrationProof: IntegrationProof | undefined;

    if (resources.removeWorktree) {
      const revalidated = this.inspectCleanupResources(record, undefined, evidence);
      assertSameCleanupObservation(resources, revalidated, "worktree-remove");
      if (revalidated.removeWorktree) {
        removeSessionWorktree(this.git, revalidated.gitCwd, record.worktreePath);
        worktreeRemoved = revalidated.worktreePresent;
      }
    }

    // Once the owned worktree has been removed, the original registry cwd may
    // no longer exist. Reobserve Git from the stable integration/peer cwd that
    // was selected during the authoritative preflight.
    const branchWorktrees = listGitWorktrees(this.git, resources.gitCwd);
    const branchResources = this.inspectCleanupResources(record, branchWorktrees, evidence);
    if (branchResources.branchPresent && branchResources.removeBranch) {
      const branchRevalidated = this.inspectCleanupResources(
        record,
        listGitWorktrees(this.git, branchResources.gitCwd),
        evidence,
      );
      assertSameCleanupObservation(branchResources, branchRevalidated, "branch-remove");
      if (branchRevalidated.branchPresent && branchRevalidated.removeBranch) {
        // Git's own "-d" safety check is ancestry-only and cannot see a
        // tree-equivalence proof. Force deletion is only ever selected after
        // Nawabari has independently re-derived that proof itself.
        const forceDelete = branchRevalidated.integrationProof?.method === "tree-equivalence";
        removeSessionBranch(this.git, branchRevalidated.gitCwd, record.branchName, forceDelete);
        branchRemoved = true;
        integrationProof = branchRevalidated.integrationProof;
      }
    }

    const closedRecord = transitionSessionState(closingRecord, "closed", this.clock);
    closingRecords = replaceRecord(closingRecords, closedRecord);
    validateRecords(closingRecords, this.repository.repositoryId);
    const nextClaims = state.claims.filter((claim) => claim.sessionId !== sessionId);
    const claimSetGeneration = nextClaimSetGeneration(state, nextClaims);
    this.writeUnsafe(closingRecords, nextClaims, claimSetGeneration);

    return {
      session: cloneSessionRecord(closedRecord),
      worktreeRemoved,
      branchRemoved,
      idempotent: false,
      claimSetGeneration,
      ...(integrationProof === undefined ? {} : { integrationProof }),
    };
  }

  private discardUnsafe(sessionId: string): DiscardSessionResult {
    const state = this.readStateUnsafe();
    const record = state.sessions.find((candidate) => candidate.sessionId === sessionId);
    if (record === undefined) {
      throw new SessionRegistryError("SESSION_NOT_FOUND", `Session was not found: ${sessionId}`, { sessionId });
    }
    if (record.state === "closed") {
      if (record.terminalOperation !== "discard") {
        throw new SessionRegistryError(
          "OPERATION_REJECTED",
          "The selected session was already closed normally; discard cannot be retroactively applied",
          { sessionId, state: record.state, terminalOperation: "close" },
        );
      }
      return discardResult(record, record.discardedHead ?? null, [], false, false, true, state.claimSetGeneration);
    }
    if (record.state === "closing" && record.terminalOperation !== "discard") {
      throw new SessionRegistryError(
        "OPERATION_REJECTED",
        "The selected session has an ordinary close in progress; retry close before choosing discard",
        { sessionId, state: record.state, safeActions: ["retry-close", "retain-session"] },
      );
    }
    if (record.state !== "active" && record.state !== "stale" && record.state !== "closing") {
      throw new SessionRegistryError("STALE_REGISTRY", `Session cannot be discarded while ${record.state}`, {
        sessionId,
        state: record.state,
      });
    }

    const resuming = record.state === "closing" && record.terminalOperation === "discard";
    let resources: CleanupResources;
    try {
      resources = this.inspectCleanupResources(record, undefined, undefined, "discard");
    } catch (error: unknown) {
      throw enrichCloseBlockerError(error);
    }
    if (
      !resuming &&
      (resources.physicalState !== "healthy" || !resources.worktreePresent || !resources.branchPresent)
    ) {
      throw ownershipMismatch(record, "Discard requires an unambiguous, currently owned worktree and branch", {
        physicalState: resources.physicalState,
        worktreePresent: resources.worktreePresent,
        branchPresent: resources.branchPresent,
        phase: "discard-preflight",
      });
    }

    const previousHead = record.discardedHead ?? resources.worktreeHead ?? resources.branchHead;
    if (previousHead === null || previousHead === undefined) {
      throw ownershipMismatch(record, "Discard could not capture the selected session HEAD before mutation", {
        physicalState: resources.physicalState,
        phase: "discard-preflight",
      });
    }

    const closingRecord = resuming
      ? record
      : transitionSessionState(
          freezeSessionRecord({ ...record, terminalOperation: "discard", discardedHead: previousHead }),
          "closing",
          this.clock,
        );
    let closingRecords = resuming ? state.sessions : replaceRecord(state.sessions, closingRecord);
    validateRecords(closingRecords, this.repository.repositoryId);
    if (!resuming) this.writeUnsafe(closingRecords, state.claims, state.claimSetGeneration);

    let worktreeRemoved = resuming && !resources.worktreePresent;
    let branchRemoved = resuming && !resources.branchPresent;
    if (resources.removeWorktree) {
      const revalidated = this.inspectCleanupResources(record, undefined, undefined, "discard");
      assertSameCleanupObservation(resources, revalidated, "worktree-remove");
      if (revalidated.removeWorktree) {
        removeSessionWorktree(this.git, revalidated.gitCwd, record.worktreePath, true);
        worktreeRemoved = revalidated.worktreePresent;
      }
    }

    const branchWorktrees = listGitWorktrees(this.git, resources.gitCwd);
    const branchResources = this.inspectCleanupResources(record, branchWorktrees, undefined, "discard");
    if (branchResources.branchPresent && branchResources.removeBranch) {
      const branchRevalidated = this.inspectCleanupResources(
        record,
        listGitWorktrees(this.git, branchResources.gitCwd),
        undefined,
        "discard",
      );
      assertSameCleanupObservation(branchResources, branchRevalidated, "branch-remove");
      if (branchRevalidated.branchPresent && branchRevalidated.removeBranch) {
        removeSessionBranch(this.git, branchRevalidated.gitCwd, record.branchName, true);
        branchRemoved = true;
      }
    }

    const closedRecord = transitionSessionState(closingRecord, "closed", this.clock);
    closingRecords = replaceRecord(closingRecords, closedRecord);
    validateRecords(closingRecords, this.repository.repositoryId);
    const releasedClaims = state.claims.filter((claim) => claim.sessionId === sessionId).map(cloneResourceClaim);
    const nextClaims = state.claims.filter((claim) => claim.sessionId !== sessionId);
    const claimSetGeneration = nextClaimSetGeneration(state, nextClaims);
    this.writeUnsafe(closingRecords, nextClaims, claimSetGeneration);

    return discardResult(
      closedRecord,
      previousHead,
      releasedClaims,
      worktreeRemoved,
      branchRemoved,
      false,
      claimSetGeneration,
    );
  }

  private inspectCleanupResources(
    record: SessionRecord,
    observedWorktrees: readonly GitWorktreeInfo[] = listGitWorktrees(this.git, this.repository.worktreePath),
    evidence?: IntegrationEvidenceInput,
    intent: "close" | "discard" = "close",
  ): CleanupResources {
    if (intent === "close" && record.terminalOperation === "discard") {
      throw new SessionRegistryError(
        "OPERATION_REJECTED",
        "An explicit discard is already in progress; retry session discard to complete it",
        {
          sessionId: record.sessionId,
          state: record.state,
          terminalOperation: "discard",
          safeActions: ["retry-discard"],
        },
      );
    }
    const git = this.git;
    const worktrees = observedWorktrees;
    const gitCwd =
      worktrees.find((worktree) => !worktree.prunable && !samePath(worktree.worktreePath, record.worktreePath))
        ?.worktreePath ?? this.repository.worktreePath;
    const registeredWorktree = worktrees.find((worktree) => samePath(worktree.worktreePath, record.worktreePath));
    const branchWorktree = worktrees.find((worktree) => worktree.branchName === record.branchName);

    if (registeredWorktree !== undefined && registeredWorktree.branchName !== record.branchName) {
      throw ownershipMismatch(record, "The registered worktree branch does not match the session branch", {
        actualBranch: registeredWorktree.branchName ?? "<detached>",
      });
    }
    if (branchWorktree !== undefined && !samePath(branchWorktree.worktreePath, record.worktreePath)) {
      throw ownershipMismatch(record, "The session branch is checked out by another worktree", {
        actualWorktree: branchWorktree.worktreePath,
      });
    }

    const worktreeState = inspectWorktreeState(record.worktreePath, worktrees);
    if (worktreeState.kind === "unregistered-present") {
      throw ownershipMismatch(record, "The session worktree path exists but is not a Git worktree");
    }
    if (worktreeState.kind === "invalid") {
      throw ownershipMismatch(record, "The session worktree path is not a directory worktree");
    }
    if (worktreeState.kind === "registered-missing") {
      throw ownershipMismatch(record, "The registered worktree path is missing without a prunable Git entry");
    }
    if (worktreeState.kind === "prunable-present") {
      throw ownershipMismatch(record, "Git marks the worktree prunable but its physical path still exists");
    }

    const worktreePresent = worktreeState.kind === "healthy";
    const branchPresent = localBranchExists(git, gitCwd, record.branchId);
    if (worktreePresent) {
      if (!branchPresent || registeredWorktree?.branchName !== record.branchName) {
        throw ownershipMismatch(record, "The registered worktree no longer has the owned local branch");
      }
      if (intent === "close") assertWorktreeClean(git, record.worktreePath);
    }

    assertNoRecoverableStashes(git, gitCwd, record.branchName);

    const worktreeProtection = this.protectedWorktree(record.worktreePath, worktrees);
    const branchProtection = this.protectedBranch(record.branchName, worktrees, gitCwd);
    let removeBranch = false;
    let integrationProof: IntegrationProof | undefined;
    if (branchPresent && !branchProtection) {
      if (intent === "discard") {
        removeBranch = true;
      } else {
        integrationProof = this.branchIsReachableFromIntegration(record, gitCwd, evidence);
        removeBranch = true;
      }
    }

    return {
      gitCwd,
      physicalState: worktreeState.kind,
      registeredBranch: registeredWorktree?.branchName ?? null,
      branchWorktree: branchWorktree?.worktreePath ?? null,
      worktreeHead: worktreePresent ? readCurrentHead(git, record.worktreePath) : null,
      branchHead: branchPresent ? readLocalBranchHead(git, gitCwd, record.branchId) : null,
      worktreePresent,
      branchPresent,
      removeWorktree: registeredWorktree !== undefined && !worktreeProtection,
      removeBranch,
      integrationProof,
    };
  }

  private cleanupDecisionUnsafe(record: SessionRecord, state: RegistryState): CleanupDecision {
    let physicalState = "unavailable";
    let blockers: readonly CleanupBlocker[] = [];
    try {
      const worktrees = listGitWorktrees(this.git, this.repository.worktreePath);
      physicalState = inspectWorktreeState(record.worktreePath, worktrees).kind;
      this.inspectCleanupResources(record, worktrees);
    } catch (error: unknown) {
      blockers = [toCleanupBlocker(error)];
    }
    const claims = state.claims.filter((claim) => claim.sessionId === record.sessionId).map(cloneResourceClaim);
    const recoveryHints = sortStrings(blockers.flatMap((blocker) => blocker.recoveryHints));
    return Object.freeze({
      schemaVersion: CLEANUP_DECISION_SCHEMA_VERSION,
      operation: "cleanup" as const,
      allowed: blockers.length === 0,
      code: blockers[0]?.code ?? ("ALLOWED" as const),
      repositoryId: this.repository.repositoryId,
      worktreePath: record.worktreePath,
      branchName: record.branchName,
      session: cloneSessionRecord(record),
      claims: Object.freeze(claims),
      physicalState,
      blockers: Object.freeze(blockers),
      recoveryHints: Object.freeze(recoveryHints),
    });
  }

  private diagnoseUnsafe(
    record: SessionRecord,
    state: RegistryState,
    evidence?: IntegrationEvidenceInput,
  ): SessionDiagnostic {
    const claims = state.claims.filter((claim) => claim.sessionId === record.sessionId).map(cloneResourceClaim);
    // Used only to evaluate staleness below; deliberately not part of the
    // returned diagnostic so repeated inspection of unchanged state is
    // byte-identical, not just semantically equivalent.
    const now = toTimestamp(this.clock());
    const integrationEvidence: SessionDiagnosticIntegrationEvidence = {
      supplied: evidence !== undefined,
      ...(evidence === undefined ? {} : { integratedRevision: evidence.integratedRevision }),
    };

    if (record.state === "closed") {
      return Object.freeze({
        schemaVersion: SESSION_DIAGNOSTIC_SCHEMA_VERSION,
        operation: "diagnostic" as const,
        repositoryId: this.repository.repositoryId,
        worktreePath: record.worktreePath,
        branchName: record.branchName,
        session: cloneSessionRecord(record),
        claims: Object.freeze(claims),
        physicalState: "closed",
        closeReadiness: "ready" as const,
        cleanupReadiness: "ready" as const,
        resultState: "complete" as const,
        idempotent: true,
        blockers: Object.freeze([]),
        safeActions: Object.freeze([]),
        integrationEvidence: Object.freeze(integrationEvidence),
      });
    }

    let physicalState = "unavailable";
    let blockers: readonly SessionDiagnosticBlocker[] = [];
    let integrationProof: IntegrationProof | undefined;
    let staleCandidate = false;
    try {
      const worktrees = listGitWorktrees(this.git, this.repository.worktreePath);
      physicalState = inspectWorktreeState(record.worktreePath, worktrees).kind;
      staleCandidate = isStaleCandidate(record, now, this.staleAfterMs, worktrees);
      const resources = this.inspectCleanupResources(record, worktrees, evidence);
      integrationProof = resources.integrationProof;
    } catch (error: unknown) {
      blockers = [toDiagnosticBlocker(error)];
    }

    const closeReadiness = closeReadinessForBlockers(blockers);
    const cleanupReadiness: ReadinessState =
      closeReadiness !== "ready" ? closeReadiness : staleCandidate ? "ready" : "not_due";
    const resultState = resultStateForDiagnostic(closeReadiness, blockers);
    const safeActions =
      blockers.length > 0
        ? sortStrings(Array.from(new Set(blockers.flatMap((blocker) => blocker.safeActions))))
        : closeReadiness === "ready"
          ? cleanupReadiness === "ready"
            ? ["close-session", "run-garbage-collect"]
            : ["close-session"]
          : [];

    return Object.freeze({
      schemaVersion: SESSION_DIAGNOSTIC_SCHEMA_VERSION,
      operation: "diagnostic" as const,
      repositoryId: this.repository.repositoryId,
      worktreePath: record.worktreePath,
      branchName: record.branchName,
      session: cloneSessionRecord(record),
      claims: Object.freeze(claims),
      physicalState,
      closeReadiness,
      cleanupReadiness,
      resultState,
      idempotent: false,
      blockers: Object.freeze(blockers),
      safeActions: Object.freeze(safeActions),
      integrationEvidence: Object.freeze({
        ...integrationEvidence,
        ...(integrationProof === undefined ? {} : { proof: integrationProof }),
      }),
    });
  }

  private assertCleanupAllowed(record: SessionRecord, state: RegistryState): void {
    const decision = this.cleanupDecisionUnsafe(record, state);
    if (decision.allowed) return;
    const blocker = decision.blockers[0];
    if (blocker === undefined) {
      throw new SessionRegistryError("OPERATION_REJECTED", "Cleanup was denied without a blocker");
    }
    throw new SessionRegistryError(blocker.code, blocker.message, blocker.details);
  }

  private reconcileSessionUnsafe(
    record: SessionRecord,
    worktrees: readonly GitWorktreeInfo[],
    now: string,
  ): ReconciliationSession {
    const physical = inspectWorktreeState(record.worktreePath, worktrees);
    if (record.state === "closed") {
      try {
        const branchPresent = localBranchExists(this.git, this.repository.worktreePath, record.branchId);
        if (physical.entry !== undefined || physical.pathEntry !== undefined || branchPresent) {
          const error = ownershipMismatch(record, "A closed session still has a physical Git resource", {
            physicalState: physical.kind,
            branchPresent,
          });
          return {
            session: cloneSessionRecord(record),
            status: "drift",
            physicalState: physical.kind,
            blockers: [toCleanupBlocker(error)],
          };
        }
      } catch (error: unknown) {
        return {
          session: cloneSessionRecord(record),
          status: "drift",
          physicalState: physical.kind,
          blockers: [toCleanupBlocker(error)],
        };
      }
      return {
        session: cloneSessionRecord(record),
        status: "closed",
        physicalState: physical.kind,
        blockers: [],
      };
    }

    try {
      this.inspectCleanupResources(record, worktrees);
      if (physical.kind === "prunable-missing") {
        const error = new SessionRegistryError(
          "MISSING_WORKTREE",
          "Git has a prunable entry for a missing session worktree",
          {
            sessionId: record.sessionId,
            worktree: record.worktreePath,
            prunable: true,
          },
        );
        return {
          session: cloneSessionRecord(record),
          status: "candidate",
          physicalState: physical.kind,
          blockers: [toCleanupBlocker(error)],
        };
      }
      return {
        session: cloneSessionRecord(record),
        status: isStaleCandidate(record, now, this.staleAfterMs, worktrees) ? "candidate" : "healthy",
        physicalState: physical.kind,
        blockers: [],
      };
    } catch (error: unknown) {
      return {
        session: cloneSessionRecord(record),
        status: "drift",
        physicalState: physical.kind,
        blockers: [toCleanupBlocker(error)],
      };
    }
  }

  private protectedWorktree(worktreePath: string, worktrees: readonly GitWorktreeInfo[]): boolean {
    const defaultWorktreePath =
      worktrees.find((worktree) => !worktree.prunable)?.worktreePath ?? this.repository.worktreePath;
    const configured = this.protectedWorktreePaths.map((candidate) =>
      resolvePotentialWorktreePath(candidate, this.repository.worktreePath),
    );
    return (
      samePath(worktreePath, defaultWorktreePath) || configured.some((candidate) => samePath(worktreePath, candidate))
    );
  }

  private protectedBranch(
    branchName: string,
    worktrees: readonly GitWorktreeInfo[],
    gitCwd = this.repository.worktreePath,
  ): boolean {
    const defaultBranchName = resolveDefaultBranchName(this.git, gitCwd, worktrees, this.defaultBranchName);
    const protectedBranchIds = [
      ...(defaultBranchName === undefined ? [] : [normalizeBranchId(defaultBranchName)]),
      ...this.protectedBranchNames.map((candidate) => normalizeBranchId(candidate)),
    ];
    return protectedBranchIds.includes(normalizeBranchId(branchName));
  }

  /**
   * Prove a session branch is safe to reclaim. Ordinary ancestry is the
   * cheap/default path. When ancestry fails, a caller may supply bounded
   * non-ancestry integration evidence (e.g. a squash/rebase-merge commit).
   * Nawabari first anchors that revision to authoritative local integration
   * history, then independently re-derives a deterministic, byte-exact Git
   * tree-object equivalence proof before treating the branch as integrated.
   */
  private branchIsReachableFromIntegration(
    record: SessionRecord,
    gitCwd = this.repository.worktreePath,
    evidence?: IntegrationEvidenceInput,
  ): IntegrationProof {
    const git = this.git;
    const worktrees = listGitWorktrees(git, gitCwd);
    const defaultBranchName = resolveDefaultBranchName(git, gitCwd, worktrees, this.defaultBranchName);
    if (defaultBranchName === undefined) {
      throw new SessionRegistryError(
        "RECOVERABLE_COMMITS",
        `Cannot prove that commits on ${record.branchName} are safely retained: no integration branch is known`,
        {
          branch: record.branchName,
          currentSessionHead: readSessionHeadForProof(git, gitCwd, record),
          suppliedIntegratedRevision: evidence?.integratedRevision ?? "<none>",
          resolvedIntegrationSha: "<none>",
          lineageProof: "unproven",
          authorityProof: "unproven",
          contentProof: "not-attempted",
          proofMethod: "integration-lineage",
          proofStage: "lineage",
          proofResult: "unproven",
          recoveryHints: recoveryHintsForCode("RECOVERABLE_COMMITS"),
        },
      );
    }
    if (normalizeBranchId(defaultBranchName) === record.branchId) return { method: "ancestor" };
    try {
      git.run(["merge-base", "--is-ancestor", record.branchId, normalizeBranchId(defaultBranchName)], gitCwd);
      return { method: "ancestor" };
    } catch (error: unknown) {
      if (!isExpectedGitLookupFailure(error)) throw error;
      if (evidence !== undefined) {
        const proof = this.proveNonAncestryIntegration(record, gitCwd, defaultBranchName, evidence);
        if (proof !== undefined) return proof;
        throw new SessionRegistryError(
          "RECOVERABLE_COMMITS",
          `Commits on ${record.branchName} could not be proven integrated via the supplied non-ancestry evidence`,
          {
            branch: record.branchName,
            integrationBranch: defaultBranchName,
            ...proofObservationDetails(git, gitCwd, record, defaultBranchName, evidence),
            proofMethod: "tree-equivalence",
            proofStage: "content",
            lineageProof: "proven",
            authorityProof: "proven",
            contentProof: "unproven",
            proofResult: "unproven",
            proofFailure: "tree-equivalence-unproven",
            integratedRevision: evidence.integratedRevision,
            recoveryHints: recoveryHintsForCode("RECOVERABLE_COMMITS"),
          },
          error,
        );
      }
      throw new SessionRegistryError(
        "RECOVERABLE_COMMITS",
        `Commits on ${record.branchName} are not proven reachable from ${defaultBranchName}`,
        {
          branch: record.branchName,
          integrationBranch: defaultBranchName,
          ...proofObservationDetails(git, gitCwd, record, defaultBranchName),
          proofMethod: "ancestry",
          proofStage: "lineage",
          lineageProof: "unproven",
          authorityProof: "unproven",
          contentProof: "not-attempted",
          proofResult: "unproven",
          recoveryHints: recoveryHintsForCode("RECOVERABLE_COMMITS"),
        },
        error,
      );
    }
  }

  /**
   * Independently verify caller-supplied non-ancestry integration evidence.
   * The caller's assertion only selects which revision to compare; the
   * proof itself is re-derived from local Git truth in two independent
   * stages: the revision must first be an ancestor of the authoritative
   * integration branch, then every path the session branch touched relative
   * to its own base must match by exact tree-object identity (file mode,
   * object type, and content-addressed blob/tree SHA) at the supplied
   * integrated revision — both absent, or byte-identical. Blob SHAs are
   * content hashes, so this can never mistake a whitespace-only or other
   * textual difference for equivalence the way a patch/diff comparison
   * could; it is exact Git tree semantics, not textual normalization.
   * Returns undefined, never false, so a missing proof always falls through
   * to a fail-closed RECOVERABLE_COMMITS at the call site.
   */
  private proveNonAncestryIntegration(
    record: SessionRecord,
    gitCwd: string,
    defaultBranchName: string,
    evidence: IntegrationEvidenceInput,
  ): IntegrationProof | undefined {
    if (evidence.fetchRemote !== undefined || evidence.fetchBranch !== undefined) {
      if (evidence.fetchRemote === undefined || evidence.fetchBranch === undefined) {
        throw new SessionRegistryError(
          "OPERATION_REJECTED",
          "Explicit integration fetch requires both a remote and an integration branch",
          {
            sessionId: record.sessionId,
            fetchRemote: evidence.fetchRemote ?? "<missing>",
            fetchBranch: evidence.fetchBranch ?? "<missing>",
          },
        );
      }
      if (normalizeBranchId(evidence.fetchBranch) === record.branchId) {
        throw new SessionRegistryError(
          "RECOVERABLE_COMMITS",
          "The explicit integration branch cannot be the session branch",
          {
            branch: record.branchName,
            integrationBranch: evidence.fetchBranch,
            currentSessionHead: readSessionHeadForProof(this.git, gitCwd, record),
            suppliedIntegratedRevision: evidence.integratedRevision,
            resolvedIntegrationSha: "<unavailable>",
            proofMethod: "integration-lineage",
            proofStage: "lineage",
            lineageProof: "unproven",
            authorityProof: "unproven",
            contentProof: "not-attempted",
            proofResult: "unproven",
            proofFailure: "integration-branch-self-reference",
            recoveryHints: recoveryHintsForCode("RECOVERABLE_COMMITS"),
          },
        );
      }
      return withFetchedIntegrationRef(this.git, gitCwd, record, evidence, (fetchedSha) =>
        this.proveNonAncestryIntegrationAtRef(record, gitCwd, defaultBranchName, evidence, fetchedSha),
      );
    }

    return this.proveNonAncestryIntegrationAtRef(record, gitCwd, defaultBranchName, evidence);
  }

  private proveNonAncestryIntegrationAtRef(
    record: SessionRecord,
    gitCwd: string,
    defaultBranchName: string,
    evidence: IntegrationEvidenceInput,
    integrationRevision?: string,
  ): IntegrationProof | undefined {
    const git = this.git;
    const resolvedEvidence = resolveBaseRef(git, gitCwd, evidence.integratedRevision);
    if (
      (evidence.fetchRemote !== undefined || evidence.fetchBranch !== undefined) &&
      (!isFullRevision(resolvedEvidence.revision) || resolvedEvidence.revision !== evidence.integratedRevision)
    ) {
      throw new SessionRegistryError(
        "INVALID_BASE_REF",
        "Explicit integration fetch requires Git's canonical full lowercase commit SHA",
        {
          baseRef: evidence.integratedRevision,
          revision: resolvedEvidence.revision,
          reason: "non-canonical-full-sha",
        },
      );
    }
    const integratedRevision = resolvedEvidence.revision;
    const authoritativeIntegrationBranch = evidence.fetchBranch ?? defaultBranchName;
    const lineage = proveIntegrationRevisionLineage(
      git,
      gitCwd,
      authoritativeIntegrationBranch,
      integratedRevision,
      integrationRevision,
    );
    if (lineage === undefined) {
      throw new SessionRegistryError(
        "RECOVERABLE_COMMITS",
        `The supplied integration revision is not part of authoritative ${authoritativeIntegrationBranch} history`,
        {
          branch: record.branchName,
          integrationBranch: authoritativeIntegrationBranch,
          ...proofObservationDetails(git, gitCwd, record, defaultBranchName, evidence, integratedRevision),
          integratedRevision,
          proofMethod: "integration-lineage",
          proofStage: "lineage",
          lineageProof: "unproven",
          authorityProof: "unproven",
          contentProof: "not-attempted",
          proofResult: "unproven",
          proofFailure: "integration-revision-not-authoritative",
          recoveryHints: recoveryHintsForCode("RECOVERABLE_COMMITS"),
        },
      );
    }

    let branchBase: string;
    try {
      branchBase = git.run(
        ["merge-base", record.branchId, integrationRevision ?? normalizeBranchId(defaultBranchName)],
        gitCwd,
      );
    } catch (error: unknown) {
      if (isExpectedGitLookupFailure(error)) return undefined;
      throw error;
    }

    const changedPaths = readChangedPathNames(git, gitCwd, branchBase, record.branchId);
    if (changedPaths.length === 0) return undefined;

    const branchStates = readTreePathStates(git, gitCwd, record.branchId, changedPaths);
    const integratedStates = readTreePathStates(git, gitCwd, integratedRevision, changedPaths);
    const proven = changedPaths.every((changedPath) =>
      treeEntriesEqual(branchStates.get(changedPath), integratedStates.get(changedPath)),
    );

    return proven
      ? {
          method: "tree-equivalence",
          integratedRevision,
          lineage,
          content: { method: "tree-equivalence" },
        }
      : undefined;
  }

  private resolveProvisioningResources(options: ProvisionSessionOptions, sessionId: string): ProvisioningResources {
    const git = this.git;
    const worktrees = listGitWorktrees(git, this.repository.worktreePath);
    const effectiveRoot =
      options.worktreePath !== undefined
        ? this.worktreeRoot
        : options.worktreeRoot !== undefined
          ? resolveManagedWorktreeRoot(options.worktreeRoot)
          : this.worktreeRoot;
    const requestedWorktreePath = resolveProvisionedWorktreePath(
      options.worktreePath ?? path.join(effectiveRoot, `${path.basename(this.repository.worktreePath)}-${sessionId}`),
      effectiveRoot,
    );
    const defaultWorktreePath =
      worktrees.find((worktree) => !worktree.prunable)?.worktreePath ?? this.repository.worktreePath;
    const configuredProtectedWorktrees = [
      ...this.protectedWorktreePaths,
      ...(options.protectedWorktreePaths ?? []),
    ].map((candidate) => resolvePotentialWorktreePath(candidate, this.repository.worktreePath));

    if (
      samePath(requestedWorktreePath, defaultWorktreePath) ||
      samePath(requestedWorktreePath, this.repository.worktreePath) ||
      configuredProtectedWorktrees.some((candidate) => samePath(requestedWorktreePath, candidate))
    ) {
      throw new SessionRegistryError(
        "PROTECTED_WORKTREE",
        `The integration worktree cannot be used as a session worktree: ${requestedWorktreePath}`,
        { worktree: requestedWorktreePath },
      );
    }

    const branchName = options.branchName ?? `nawabari/session/${sessionId}`;
    const branchId = normalizeBranchId(branchName);
    const shortBranchName = branchId.slice("refs/heads/".length);
    const defaultBranchName = resolveDefaultBranchName(
      git,
      this.repository.worktreePath,
      worktrees,
      options.defaultBranchName ?? this.defaultBranchName,
    );
    const protectedBranchIds = new Set<string>();
    if (defaultBranchName !== undefined) protectedBranchIds.add(normalizeBranchId(defaultBranchName));
    for (const protectedBranch of [...this.protectedBranchNames, ...(options.protectedBranchNames ?? [])]) {
      protectedBranchIds.add(normalizeBranchId(protectedBranch));
    }
    if (protectedBranchIds.has(branchId)) {
      throw new SessionRegistryError(
        "PROTECTED_BRANCH",
        `Protected branch cannot be used by a session: ${shortBranchName}`,
        {
          branch: shortBranchName,
        },
      );
    }
    const base = resolveBaseRef(git, this.repository.worktreePath, options.baseRef ?? "HEAD");
    return {
      worktreePath: requestedWorktreePath,
      branchId,
      branchName: shortBranchName,
      baseRef: base.ref,
      baseRevision: base.revision,
    };
  }

  private resolveCreationResources(options: CreateSessionOptions): CreationResources {
    const physical = verifyPhysicalExecutionContext({
      repository: this.repository,
      worktreePath: options.worktreePath ?? this.repository.worktreePath,
      branchName: options.branchName ?? undefined,
      git: this.git,
    });
    return {
      worktreeId: physical.worktreeId,
      worktreePath: physical.worktreePath,
      branchId: physical.branchId,
      branchName: physical.branchName,
      baseRevision: physical.headId,
    };
  }

  private readStateUnsafe(allowLegacyClaimSchema = false): RegistryState {
    let contents: string;
    try {
      contents = fs.readFileSync(this.paths.registry, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return { sessions: [], claims: [], claimSetGeneration: 0, legacyClaimsAbsent: false };
      }
      throw new SessionRegistryError(
        "REGISTRY_IO_FAILURE",
        `Could not read ${this.paths.registry}`,
        {
          path: this.paths.registry,
        },
        error,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch (error: unknown) {
      throw new SessionRegistryError(
        "REGISTRY_CORRUPT",
        `Registry is not valid JSON: ${this.paths.registry}`,
        {
          path: this.paths.registry,
        },
        error,
      );
    }

    return parseRegistry(parsed, this.repository.repositoryId, allowLegacyClaimSchema);
  }

  private readUnsafe(): readonly SessionRecord[] {
    return this.readStateUnsafe().sessions;
  }

  /**
   * The single authoritative persistence path for session/claim registry
   * state, sharing its durability policy with `registry/atomic.ts`: the
   * temporary file and target directory are fsynced around an atomic
   * rename, and only known unsupported-directory-fsync conditions are
   * tolerated. A failure observed after rename is reported as a distinct
   * durability-uncertain outcome rather than an ordinary write failure,
   * since the renamed document may already be the one readers observe.
   */
  private writeUnsafe(
    records: readonly SessionRecord[],
    claims: readonly ResourceClaim[],
    claimSetGeneration: number,
  ): void {
    const registry: PersistedRegistry = {
      schema_version: REGISTRY_SCHEMA_VERSION,
      repository_id: this.repository.repositoryId,
      sessions: records.map((record) => toPersistedSessionRecord(record, this.repository.repositoryId)),
      claims_schema_version: RESOURCE_CLAIM_SCHEMA_VERSION,
      claims: sortResourceClaims(claims).map((claim) => toPersistedResourceClaim(claim, this.repository.repositoryId)),
      claim_set_generation: claimSetGeneration,
    };

    try {
      writeJsonAtomicallySync(this.paths.registry, registry);
    } catch (error: unknown) {
      if (isPostRenameFailure(error)) {
        throw new SessionRegistryError(
          "REGISTRY_DURABILITY_UNCERTAIN",
          `Registry rename to ${this.paths.registry} may have already committed, but durable persistence could not be proven`,
          {
            path: this.paths.registry,
            recoveryHints: [
              "Re-read the registry to check whether the mutation is already visible before retrying.",
              "Do not assume this operation did not happen.",
            ],
          },
          error,
        );
      }
      throw new SessionRegistryError(
        "REGISTRY_IO_FAILURE",
        `Could not atomically write ${this.paths.registry}`,
        {
          path: this.paths.registry,
        },
        error,
      );
    }
  }

  private mutate<T>(mutation: (records: readonly SessionRecord[]) => MutationResult<T>): T {
    return this.withLock(() => {
      const state = this.readStateUnsafe();
      const { records: nextRecords, result } = mutation(state.sessions);
      validateRecords(nextRecords, this.repository.repositoryId);
      this.writeUnsafe(nextRecords, state.claims, state.claimSetGeneration);
      return result;
    });
  }

  private withLock<T>(operation: () => T): T {
    let lease;
    try {
      lease = this.lock.acquireSync();
    } catch (error: unknown) {
      throw toSessionRegistryLockError(error, this.paths.lock);
    }

    let result!: T;
    let operationFailed = false;
    let operationError: unknown;
    try {
      result = operation();
    } catch (error: unknown) {
      operationFailed = true;
      operationError = error;
    }

    let releaseError: unknown;
    try {
      lease.release();
    } catch (error: unknown) {
      releaseError = toSessionRegistryLockError(error, this.paths.lock);
    }

    if (operationFailed) {
      throw operationError;
    }
    if (releaseError !== undefined) {
      throw releaseError;
    }
    return result;
  }
}

interface CreationResources {
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly baseRevision: string;
}

interface ProvisioningResources {
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly baseRef: string;
  readonly baseRevision: string;
}

interface MutationResult<T> {
  readonly records: readonly SessionRecord[];
  readonly result: T;
}

interface CleanupResources {
  readonly gitCwd: string;
  readonly physicalState: WorktreePhysicalState;
  readonly registeredBranch: string | null;
  readonly branchWorktree: string | null;
  readonly worktreeHead: string | null;
  readonly branchHead: string | null;
  readonly worktreePresent: boolean;
  readonly branchPresent: boolean;
  readonly removeWorktree: boolean;
  readonly removeBranch: boolean;
  readonly integrationProof?: IntegrationProof;
}

/**
 * Physical session identity observed around an explicit integration-proof
 * fetch.  The proof may only be used when the session still points at the
 * same worktree/branch and the same HEAD after all remote Git I/O.
 */
interface SessionProofIdentity {
  readonly worktreePath: string | null;
  readonly worktreeBranch: string | null;
  readonly worktreePrunable: boolean | null;
  readonly branchWorktreePath: string | null;
  readonly head: string;
}

function readSessionHeadForProof(git: GitCommandRunner, gitCwd: string, record: SessionRecord): string {
  const pathEntry = lstatIfPresent(record.worktreePath);
  if (pathEntry !== undefined && pathEntry.isDirectory() && !pathEntry.isSymbolicLink()) {
    return readCurrentHead(git, record.worktreePath);
  }
  return readLocalBranchHead(git, gitCwd, record.branchId);
}

function observeSessionProofIdentity(
  git: GitCommandRunner,
  gitCwd: string,
  record: SessionRecord,
): SessionProofIdentity {
  const worktrees = listGitWorktrees(git, gitCwd);
  const registeredWorktree = worktrees.find((worktree) => samePath(worktree.worktreePath, record.worktreePath));
  const branchWorktree = worktrees.find((worktree) => worktree.branchName === record.branchName);
  return {
    worktreePath: registeredWorktree?.worktreePath ?? null,
    worktreeBranch: registeredWorktree?.branchName ?? null,
    worktreePrunable: registeredWorktree?.prunable ?? null,
    branchWorktreePath: branchWorktree?.worktreePath ?? null,
    head: readSessionHeadForProof(git, gitCwd, record),
  };
}

function assertSameSessionProofIdentity(
  expected: SessionProofIdentity,
  actual: SessionProofIdentity,
  record: SessionRecord,
): void {
  if (
    expected.worktreePath !== actual.worktreePath ||
    expected.worktreeBranch !== actual.worktreeBranch ||
    expected.worktreePrunable !== actual.worktreePrunable ||
    expected.branchWorktreePath !== actual.branchWorktreePath ||
    expected.head !== actual.head
  ) {
    throw new SessionRegistryError(
      "GIT_STATE_AMBIGUOUS",
      "Session identity or HEAD changed while integration proof was being fetched",
      {
        phase: "integration-proof-reobserve",
        sessionId: record.sessionId,
        expectedWorktree: expected.worktreePath ?? "<none>",
        actualWorktree: actual.worktreePath ?? "<none>",
        expectedWorktreeBranch: expected.worktreeBranch ?? "<none>",
        actualWorktreeBranch: actual.worktreeBranch ?? "<none>",
        expectedWorktreePrunable: expected.worktreePrunable ?? "<none>",
        actualWorktreePrunable: actual.worktreePrunable ?? "<none>",
        expectedBranchWorktree: expected.branchWorktreePath ?? "<none>",
        actualBranchWorktree: actual.branchWorktreePath ?? "<none>",
        expectedHead: expected.head,
        actualHead: actual.head,
        recoveryHints: recoveryHintsForCode("GIT_STATE_AMBIGUOUS"),
      },
    );
  }
}

function proofObservationDetails(
  git: GitCommandRunner,
  gitCwd: string,
  record: SessionRecord,
  defaultBranchName: string,
  evidence?: IntegrationEvidenceInput,
  resolvedIntegratedRevision?: string,
): RegistryErrorDetails {
  return {
    currentSessionHead: readSessionHeadForProof(git, gitCwd, record),
    suppliedIntegratedRevision: evidence?.integratedRevision ?? "<none>",
    resolvedIntegrationSha:
      resolvedIntegratedRevision ??
      (evidence === undefined
        ? readLocalBranchHead(git, gitCwd, normalizeBranchId(defaultBranchName))
        : resolveBaseRef(git, gitCwd, evidence.integratedRevision).revision),
  };
}

const MAX_DISCARD_CLAIMS = 4_096 as const;

function discardResult(
  session: SessionRecord,
  previousHead: string | null,
  releasedClaims: readonly ResourceClaim[],
  worktreeRemoved: boolean,
  branchRemoved: boolean,
  idempotent: boolean,
  claimSetGeneration: number,
): DiscardSessionResult {
  const boundedClaims = releasedClaims.slice(0, MAX_DISCARD_CLAIMS).map(cloneResourceClaim);
  return {
    schemaVersion: DISCARD_RESULT_SCHEMA_VERSION,
    operation: "discard",
    session: cloneSessionRecord(session),
    finalState: session.state,
    previousHead,
    worktreePath: session.worktreePath,
    branchName: session.branchName,
    worktreeRemoved,
    branchRemoved,
    releasedClaims: Object.freeze(boundedClaims),
    releasedClaimCount: releasedClaims.length,
    releasedClaimsTruncated: releasedClaims.length > boundedClaims.length,
    idempotent,
    claimSetGeneration,
  };
}

function assertStaleAfterMs(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("staleAfterMs must be a non-negative safe integer");
  }
}

function isStaleCandidate(
  record: SessionRecord,
  now: string,
  staleAfterMs: number,
  worktrees: readonly GitWorktreeInfo[],
): boolean {
  if (record.state === "closed") return false;
  if (record.state === "stale" || record.state === "closing") return true;
  const age = Date.parse(now) - Date.parse(record.updatedAt);
  const worktreeState = inspectWorktreeState(record.worktreePath, worktrees);
  const physicallyMissing =
    worktreeState.kind === "prunable-missing" ||
    worktreeState.kind === "registered-missing" ||
    worktreeState.kind === "unregistered-missing";
  return age >= staleAfterMs || physicallyMissing;
}

type WorktreePhysicalState =
  | "healthy"
  | "prunable-missing"
  | "unregistered-missing"
  | "registered-missing"
  | "prunable-present"
  | "unregistered-present"
  | "invalid";

interface WorktreeInspection {
  readonly kind: WorktreePhysicalState;
  readonly entry: GitWorktreeInfo | undefined;
  readonly pathEntry: fs.Stats | undefined;
}

function inspectWorktreeState(worktreePath: string, worktrees: readonly GitWorktreeInfo[]): WorktreeInspection {
  const entry = worktrees.find((worktree) => samePath(worktree.worktreePath, worktreePath));
  const pathEntry = lstatIfPresent(worktreePath);

  if (pathEntry !== undefined && (pathEntry.isSymbolicLink() || !pathEntry.isDirectory())) {
    return { kind: "invalid", entry, pathEntry };
  }
  if (entry === undefined) {
    return {
      kind: pathEntry === undefined ? "unregistered-missing" : "unregistered-present",
      entry,
      pathEntry,
    };
  }
  if (entry.prunable) {
    return {
      kind: pathEntry === undefined ? "prunable-missing" : "prunable-present",
      entry,
      pathEntry,
    };
  }
  return {
    kind: pathEntry === undefined ? "registered-missing" : "healthy",
    entry,
    pathEntry,
  };
}

function replaceRecord(records: readonly SessionRecord[], replacement: SessionRecord): SessionRecord[] {
  return records.map((record) => (record.sessionId === replacement.sessionId ? replacement : record));
}

/**
 * Bounded, deterministic RESOURCE_CLAIM_CONFLICT evidence: the blocking
 * session's canonical identity plus the exact conflicting claim/overlap.
 * Every RESOURCE_CLAIM_CONFLICT throw site builds its details through this
 * one function so a caller never has to run a second repository-wide scan
 * just to identify the owner.
 */
function resourceClaimConflictDetails(
  requested: { resource: string; mode: ResourceClaimMode },
  owner: { claimId: string; sessionId: string; resource: string; mode: ResourceClaimMode },
  sessions: readonly SessionRecord[],
): RegistryErrorDetails {
  const ownerSession = sessions.find((record) => record.sessionId === owner.sessionId);
  return {
    resource: requested.resource,
    mode: requested.mode,
    ownerSessionId: owner.sessionId,
    ownerClaimId: owner.claimId,
    ownerResource: owner.resource,
    ownerMode: owner.mode,
    ...(ownerSession === undefined
      ? {}
      : {
          ownerWorktree: ownerSession.worktreePath,
          ownerBranch: ownerSession.branchName,
          ownerState: ownerSession.state,
          ...(ownerSession.label === undefined ? {} : { ownerLabel: ownerSession.label }),
        }),
  };
}

/** A wildcard claim does not identify one deterministic transition target. */
function isExactCanonicalClaimResource(resource: string): boolean {
  return !/[?*]/u.test(resource);
}

/**
 * Build the sole safe recovery action for an additive exact-resource
 * contradiction. The command is shell-executable while quoting all
 * caller-derived values, and its generation is the pre-rejection CAS token.
 */
function claimTransitionRecoveryAction(
  sessionId: string,
  resource: string,
  mode: ResourceClaimMode,
  claimSetGeneration: number,
): ResourceClaimRecoveryAction {
  const shellQuote = (value: string): string => `'${value.replaceAll("'", "'\"'\"'")}'`;
  return Object.freeze({
    actionId: RESOURCE_CLAIM_RECOVERY_ACTION_ID,
    command: `nawabari session transition --session ${shellQuote(sessionId)} --resource ${shellQuote(resource)} --mode ${shellQuote(mode)} --if-generation ${claimSetGeneration}`,
    resource,
    mode,
    claimSetGeneration,
  });
}

function transitionSessionState(record: SessionRecord, state: SessionState, clock: () => Date): SessionRecord {
  const clockTimestamp = toTimestamp(clock());
  const updatedAt = new Date(Math.max(Date.parse(record.updatedAt), Date.parse(clockTimestamp))).toISOString();
  return freezeSessionRecord({ ...record, state, updatedAt });
}

function ownershipMismatch(
  record: SessionRecord,
  message: string,
  details: RegistryErrorDetails = {},
): SessionRegistryError {
  return new SessionRegistryError("OWNERSHIP_MISMATCH", message, {
    sessionId: record.sessionId,
    worktree: record.worktreePath,
    branch: record.branchName,
    ...details,
    ...(details.recoveryHints === undefined ? { recoveryHints: recoveryHintsForCode("OWNERSHIP_MISMATCH") } : {}),
  });
}

function recoveryHintsForCode(code: RegistryErrorCode, details: RegistryErrorDetails = {}): string[] {
  switch (code) {
    case "DIRTY_WORKTREE":
      return ["Preserve, commit, or explicitly recover tracked and untracked changes, then retry cleanup."];
    case "NESTED_REPOSITORY":
      return ["Inspect and explicitly preserve or remove the nested repository before retrying cleanup."];
    case "RECOVERABLE_COMMITS":
      return [
        "Retain or merge the session branch commits into an authoritative local branch before retrying cleanup.",
        "If the branch was integrated via squash/rebase merge, retry close with an --integrated-revision proof instead.",
        "If the selected session is intentionally disposable, use the explicit session discard operation with its exact session ID.",
      ];
    case "RECOVERABLE_STASHES":
      return ["Inspect and explicitly apply, export, or drop the session stash before retrying cleanup."];
    case "INTEGRATION_FETCH_FAILED":
      return ["Retry the same explicit integration-proof close; fetch failure leaves session ownership intact."];
    case "MISSING_WORKTREE":
      return ["Run the authoritative GC apply path after confirming the Git worktree entry is prunable and missing."];
    case "OWNERSHIP_MISMATCH":
      return ["Reconcile registry and Git ownership, then retry only after the physical owner is unambiguous."];
    case "GIT_STATE_AMBIGUOUS":
    case "PHYSICAL_OBSERVATION_UNAVAILABLE":
      return ["Restore a stable, observable Git/worktree state and rerun reconciliation before cleanup."];
    case "PROTECTED_WORKTREE":
    case "PROTECTED_BRANCH":
      return details.phase === "execution"
        ? [
            "Run this command from the managed session worktree it targets, or pass --session to select it explicitly.",
            "Use `session list` or `status` to find the managed worktree for the intended session.",
          ]
        : ["Use the owner of the protected integration resource; do not delete it as a session resource."];
    case "RESOURCE_CLAIM_CONFLICT":
      return [
        "Inspect the blocking session's conflicting claim, then either wait for its release or coordinate with its owner.",
        "Do not force-release another session's claim; claim release is scoped to the owning session only.",
      ];
    case "STALE_REGISTRY":
      return ["Reconcile the lifecycle record under the repository mutation lock before retrying cleanup."];
    default:
      return ["Resolve the reported blocker and retry the same Nawabari cleanup operation."];
  }
}

function toCleanupBlocker(error: unknown): CleanupBlocker {
  if (!(error instanceof SessionRegistryError)) throw error;
  const supplied = error.details.recoveryHints;
  const recoveryHints = Array.isArray(supplied)
    ? supplied.filter((hint): hint is string => typeof hint === "string")
    : recoveryHintsForCode(error.code);
  return Object.freeze({
    code: error.code,
    message: error.message,
    details: error.details,
    recoveryHints: Object.freeze(recoveryHints),
  });
}

function toDiagnosticBlocker(error: unknown): SessionDiagnosticBlocker {
  const blocker = toCleanupBlocker(error);
  return Object.freeze({
    ...blocker,
    safeActions: Object.freeze(safeActionsForCode(blocker.code, blocker.details)),
  });
}

/**
 * Stable, kebab-case next-action identifiers per blocker code. This is the
 * one place that maps a registry blocker to actionable next steps, so a
 * later actionable-error surface (e.g. for RESOURCE_CLAIM_CONFLICT) can
 * extend the same table instead of diverging from it.
 */
function safeActionsForCode(code: RegistryErrorCode, details: RegistryErrorDetails): readonly string[] {
  switch (code) {
    case "DIRTY_WORKTREE":
      return ["commit-or-discard-changes", "retain-session"];
    case "NESTED_REPOSITORY":
      return ["resolve-nested-repository", "retain-session"];
    case "RECOVERABLE_COMMITS":
      return details.proofMethod === "tree-equivalence"
        ? ["retain-session", "supply-different-integrated-revision", "discard-session"]
        : ["provide-integration-evidence", "merge-or-retain-branch", "retain-session", "discard-session"];
    case "RECOVERABLE_STASHES":
      return ["apply-or-export-stash", "retain-session"];
    case "MISSING_WORKTREE":
      return ["run-garbage-collect"];
    case "OWNERSHIP_MISMATCH":
    case "DUPLICATE_WORKTREE_OWNERSHIP":
    case "DUPLICATE_BRANCH_OWNERSHIP":
      return ["reconcile-ownership", "retain-session"];
    case "PROTECTED_WORKTREE":
    case "PROTECTED_BRANCH":
      return details.phase === "execution"
        ? ["run-from-managed-session-worktree", "select-target-session-explicitly"]
        : ["retain-session"];
    case "RESOURCE_CLAIM_CONFLICT":
      return ["inspect-blocking-session", "wait-for-conflicting-claim-release", "retain-session"];
    case "INTEGRATION_FETCH_FAILED":
      return ["retry-close", "retain-session"];
    case "GIT_STATE_AMBIGUOUS":
    case "PHYSICAL_OBSERVATION_UNAVAILABLE":
    case "REPOSITORY_IDENTITY_AMBIGUOUS":
    case "WORKTREE_IDENTITY_AMBIGUOUS":
    case "GIT_COMMAND_FAILED":
    case "GIT_SPAWN_FAILED":
    case "GIT_TIMEOUT":
    case "GIT_OUTPUT_LIMIT":
      return ["stabilize-repository-state", "retry-diagnostic"];
    case "STALE_REGISTRY":
    case "RECONCILIATION_DRIFT":
      return ["retry-diagnostic"];
    case "OPERATION_REJECTED":
      return details.terminalOperation === "discard" ? ["retry-discard"] : ["retry-diagnostic"];
    default:
      return ["retry-diagnostic"];
  }
}

function isAmbiguousObservationCode(code: RegistryErrorCode): boolean {
  return (
    code === "GIT_STATE_AMBIGUOUS" ||
    code === "PHYSICAL_OBSERVATION_UNAVAILABLE" ||
    code === "REPOSITORY_IDENTITY_AMBIGUOUS" ||
    code === "WORKTREE_IDENTITY_AMBIGUOUS" ||
    code === "GIT_COMMAND_FAILED" ||
    code === "GIT_SPAWN_FAILED" ||
    code === "GIT_TIMEOUT" ||
    code === "GIT_OUTPUT_LIMIT"
  );
}

/** #123 non-ancestry integration: RECOVERABLE_COMMITS with no ancestry proof and no evidence attempted yet. */
function isExternalEvidenceEligible(blocker: SessionDiagnosticBlocker): boolean {
  return blocker.code === "RECOVERABLE_COMMITS" && blocker.details.proofMethod === "ancestry";
}

function closeReadinessForBlockers(blockers: readonly SessionDiagnosticBlocker[]): ReadinessState {
  const blocker = blockers[0];
  if (blocker === undefined) return "ready";
  if (isAmbiguousObservationCode(blocker.code)) return "ambiguous";
  if (isExternalEvidenceEligible(blocker)) return "external_evidence_required";
  return "blocked";
}

function resultStateForDiagnostic(
  closeReadiness: ReadinessState,
  blockers: readonly SessionDiagnosticBlocker[],
): DiagnosticCompleteness {
  if (closeReadiness === "ambiguous") return "ambiguous";
  if (closeReadiness === "external_evidence_required") return "external_evidence_required";
  const blocker = blockers[0];
  if (blocker !== undefined && (blocker.code === "STALE_REGISTRY" || blocker.code === "RECONCILIATION_DRIFT")) {
    return "stale";
  }
  return "complete";
}

/**
 * Enrich a direct `close()` rejection with the exact same #124 diagnostic
 * classification `session inspect` would report for the identical blocked
 * state (readiness, result state, stable safe actions), so a raw close
 * failure and the diagnostic authority can never drift apart. This never
 * mutates session/claim/Git/worktree state; it only reclassifies an error
 * that `inspectCleanupResources` already raised before any mutation ran.
 */
function enrichCloseBlockerError(error: unknown): SessionRegistryError {
  if (!(error instanceof SessionRegistryError)) throw error;
  const blocker = toDiagnosticBlocker(error);
  const closeReadiness = closeReadinessForBlockers([blocker]);
  const resultState = resultStateForDiagnostic(closeReadiness, [blocker]);
  return new SessionRegistryError(
    error.code,
    error.message,
    {
      ...blocker.details,
      safeActions: [...blocker.safeActions],
      recoveryHints: [...blocker.recoveryHints],
      closeReadiness,
      resultState,
    },
    error.cause,
  );
}

function toGarbageCollectBlocked(sessionId: string, error: unknown): GarbageCollectBlocked {
  const blocker = toCleanupBlocker(error);
  return Object.freeze({
    sessionId,
    code: blocker.code,
    message: blocker.message,
    details: blocker.details,
    recoveryHints: blocker.recoveryHints,
  });
}

function assertSameCleanupObservation(
  expected: CleanupResources,
  actual: CleanupResources,
  phase: "worktree-remove" | "branch-remove",
): void {
  if (
    expected.physicalState !== actual.physicalState ||
    expected.registeredBranch !== actual.registeredBranch ||
    expected.branchWorktree !== actual.branchWorktree ||
    expected.worktreeHead !== actual.worktreeHead ||
    expected.branchHead !== actual.branchHead ||
    expected.worktreePresent !== actual.worktreePresent ||
    expected.branchPresent !== actual.branchPresent ||
    expected.removeWorktree !== actual.removeWorktree ||
    expected.removeBranch !== actual.removeBranch
  ) {
    throw new SessionRegistryError(
      "GIT_STATE_AMBIGUOUS",
      "Cleanup physical observations changed before destructive mutation",
      {
        phase,
        expectedPhysicalState: expected.physicalState,
        actualPhysicalState: actual.physicalState,
        expectedWorktree: expected.branchWorktree ?? "<none>",
        actualWorktree: actual.branchWorktree ?? "<none>",
        expectedHead: expected.worktreeHead ?? "<none>",
        actualHead: actual.worktreeHead ?? "<none>",
        expectedBranchHead: expected.branchHead ?? "<none>",
        actualBranchHead: actual.branchHead ?? "<none>",
        recoveryHints: recoveryHintsForCode("GIT_STATE_AMBIGUOUS"),
      },
    );
  }
}

type GuardDecisionBase = Omit<GuardDecision, "allowed" | "code" | "details">;

function deniedGuard(
  code: RegistryErrorCode,
  base: GuardDecisionBase,
  details: RegistryErrorDetails,
  ownerSessionId: string | null = base.ownerSessionId,
  state: SessionState | null = base.state,
): GuardDecision {
  return Object.freeze({
    allowed: false,
    code,
    ...base,
    sessionId: ownerSessionId,
    ownerSessionId,
    state,
    details: { ...details },
  });
}

type OperationDecisionBase = Omit<OperationAuthorizationDecision, "details">;

function deniedOperation(
  code: OperationAuthorizationCode,
  base: OperationDecisionBase,
  details: RegistryErrorDetails,
): OperationAuthorizationDecision {
  return Object.freeze({
    ...base,
    allowed: false,
    code,
    resources: Object.freeze([...base.resources]),
    details: { ...details },
  });
}

function canonicalOperationResources(resources: readonly string[], worktreePath: string): readonly string[] {
  const canonical = new Set<string>();
  for (const resource of resources) {
    if (typeof resource !== "string" || resource.length === 0 || resource.includes("*") || resource.includes("?")) {
      throw new SessionRegistryError("INVALID_RESOURCE", "Operation resources must be concrete repository paths", {
        resource: stringifyDetail(resource),
      });
    }
    try {
      canonical.add(canonicalizeConcretePath(resource, worktreePath));
    } catch (error: unknown) {
      if (
        error instanceof SessionRegistryError &&
        [
          "INVALID_CLAIM_RESOURCE",
          "CLAIM_PATH_TRAVERSAL",
          "CLAIM_SYMLINK_ESCAPE",
          "CLAIM_AMBIGUOUS_PATH",
          "UNSUPPORTED_CLAIM_GLOB",
        ].includes(error.code)
      ) {
        throw new SessionRegistryError("INVALID_RESOURCE", "Operation resource is invalid", error.details, error);
      }
      throw error;
    }
  }
  return Object.freeze(sortStrings(canonical));
}

interface PushInspection {
  readonly sourceSha: string;
  readonly relation: PushRelation;
  readonly upstream: string | undefined;
  readonly targetRef: string;
  readonly observedRemoteSha: string | null;
}

function operationSessionId(first: string | null | undefined, second: string | null | undefined): string | null {
  if (first !== undefined) return first;
  return second ?? null;
}

function operationResources(resources: readonly string[] | undefined): readonly string[] {
  return resources === undefined ? [] : [...resources];
}

function assertFinalCommitMessage(message: string, messagePattern: string | null): void {
  if (
    typeof message !== "string" ||
    message.length === 0 ||
    message.trim().length === 0 ||
    message.includes("\u0000")
  ) {
    throw new SessionRegistryError(
      "INVALID_COMMIT_MESSAGE",
      "Commit message must be a non-empty final message without NUL bytes",
    );
  }
  if (messagePattern === null) return;

  if (messagePattern.length > MAX_MESSAGE_PATTERN_LENGTH) {
    throw new SessionRegistryError(
      "INVALID_COMMIT_MESSAGE",
      "The caller-declared commit-message pattern exceeds the maximum bounded length",
      { reason: "message-pattern-too-long", maxMessagePatternLength: MAX_MESSAGE_PATTERN_LENGTH },
    );
  }

  let pattern: RegExp;
  try {
    pattern = new RegExp(messagePattern, "u");
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "INVALID_COMMIT_MESSAGE",
      "The caller-declared commit-message pattern is not a valid regular expression",
      { reason: "invalid-message-pattern", messagePattern },
      error,
    );
  }
  if (!pattern.test(message)) {
    throw new SessionRegistryError(
      "INVALID_COMMIT_MESSAGE",
      "Commit message does not match the caller-declared commit-message pattern",
      { reason: "message-pattern-mismatch", messagePattern, message },
    );
  }
}

function explicitRemote(remote: string | null | undefined): string {
  if (typeof remote !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote)) {
    throw new SessionRegistryError("INVALID_REMOTE", "Push requires an explicit local Git remote name", {
      remote: typeof remote === "string" ? remote : "<missing>",
    });
  }
  return remote;
}

function explicitIntegrationRemote(remote: string | null | undefined): string {
  if (
    typeof remote !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(remote) ||
    remote.includes("..") ||
    remote.endsWith(".") ||
    remote.endsWith(".lock") ||
    remote.includes("@{")
  ) {
    throw new SessionRegistryError(
      "INVALID_REMOTE",
      "Integration proof fetch requires a strict local Git remote name",
      {
        remote: typeof remote === "string" ? remote : "<missing>",
      },
    );
  }
  return explicitRemote(remote);
}

function explicitIntegrationBranch(branch: string | null | undefined): string {
  if (typeof branch !== "string" || branch.length === 0) {
    throw new SessionRegistryError(
      "INVALID_REMOTE_BRANCH",
      "Integration proof fetch requires an explicit integration branch name",
      { branch: "<missing>" },
    );
  }
  try {
    return normalizeBranchId(branch).slice("refs/heads/".length);
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "INVALID_REMOTE_BRANCH",
      "Git rejected the explicit integration branch name",
      { branch },
      error,
    );
  }
}

function explicitRemoteBranch(branch: string | null | undefined, alias: string | null | undefined): string {
  if (branch !== undefined && branch !== null && alias !== undefined && alias !== null && branch !== alias) {
    throw new SessionRegistryError("INVALID_REMOTE_BRANCH", "Conflicting remote branch targets were supplied", {
      branch,
      remoteBranch: alias,
    });
  }
  const candidate = branch ?? alias;
  if (typeof candidate !== "string" || candidate.length === 0) {
    throw new SessionRegistryError("INVALID_REMOTE_BRANCH", "Push requires an explicit remote branch name", {
      branch: "<missing>",
    });
  }
  try {
    return normalizeBranchId(candidate).slice("refs/heads/".length);
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "INVALID_REMOTE_BRANCH",
      "Git rejected the explicit remote branch name",
      {
        branch: candidate,
      },
      error,
    );
  }
}

function assertNoUnexpectedMutationPaths(paths: readonly string[], authorized: readonly string[]): void {
  const authorizedSet = new Set(authorized);
  const unexpected = paths.filter((resource) => !authorizedSet.has(resource));
  if (unexpected.length > 0) {
    throw new SessionRegistryError(
      "UNEXPECTED_CHANGED_PATHS",
      "Git reports changed or staged paths outside the explicit authorized resource set",
      {
        paths: sortStrings(unexpected),
        authorizedResources: sortStrings(authorized),
      },
    );
  }
}

function reverifyMutationContext(
  registry: SessionRegistry,
  expected: VerifiedExecutionContext,
  sessionId: string | null,
  phase: "stage" | "commit" | "push",
): VerifiedExecutionContext {
  const actual = registry.verifyExecutionContext({ sessionId });
  if (
    actual.repositoryId !== expected.repositoryId ||
    actual.worktreePath !== expected.worktreePath ||
    actual.branchId !== expected.branchId ||
    actual.headId !== expected.headId
  ) {
    throw new SessionRegistryError(
      "GIT_STATE_AMBIGUOUS",
      "Repository, worktree, branch, or HEAD changed before Git mutation",
      {
        phase,
        expectedRepository: expected.repositoryId,
        actualRepository: actual.repositoryId,
        expectedWorktree: expected.worktreePath,
        actualWorktree: actual.worktreePath,
        expectedBranch: expected.branchName,
        actualBranch: actual.branchName,
        expectedHead: expected.headId,
        actualHead: actual.headId,
      },
    );
  }
  return actual;
}

function isBoundedGitFailure(code: RegistryErrorCode): boolean {
  return code === "GIT_SPAWN_FAILED" || code === "GIT_TIMEOUT" || code === "GIT_OUTPUT_LIMIT";
}

function readCommitParent(git: GitCommandRunner, cwd: string, commitSha: string): string {
  let output: string;
  try {
    output = git.run(["rev-list", "--parents", "-n", "1", commitSha], cwd).trim();
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not observe the resulting commit's parent",
      { cwd, commitSha },
      error,
    );
  }
  const fields = output.split(/\s+/u).filter((field) => field.length > 0);
  if (fields.length < 2 || fields.some((field) => !/^[0-9a-f]{40,64}$/u.test(field))) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid resulting commit parent", {
      cwd,
      commitSha,
    });
  }
  return fields[1];
}

function runMutationGit(
  git: GitCommandRunner,
  args: readonly string[],
  cwd: string,
  phase: string,
  failureCode: RegistryErrorCode,
): void {
  try {
    git.run(args, cwd);
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError && isBoundedGitFailure(error.code)) {
      throw new SessionRegistryError(
        error.code,
        `${phase} Git operation did not complete`,
        {
          ...error.details,
          phase,
        },
        error,
      );
    }
    const details: RegistryErrorDetails = {
      phase,
      command: args.join(" "),
      ...(error instanceof SessionRegistryError ? error.details : {}),
      ...(error instanceof SessionRegistryError ? { gitCode: error.code } : {}),
    };
    throw new SessionRegistryError(failureCode, `${phase} Git operation failed`, details, error);
  }
}

/**
 * Reconcile a bounded commit transport failure against the only authoritative
 * local commit evidence: HEAD and the paths recorded by that HEAD.  A
 * transport failure is deliberately not treated as a normal commit failure
 * until this bounded read has classified its effect.
 */
function reconcileCommitTransportFailure(
  git: GitCommandRunner,
  cwd: string,
  expectedHead: string,
  expectedResources: readonly string[],
  message: string,
  failure: SessionRegistryError,
): CommitResult {
  let observedHead: string;
  try {
    observedHead = readCurrentHead(git, cwd);
  } catch (error: unknown) {
    throw commitReconciliationFailure(failure, {
      outcome: "unresolved",
      retrySafe: false,
      expectedHead,
      expectedResources,
      observedResources: [],
      reconciliationError: error,
    });
  }

  if (observedHead === expectedHead) {
    throw commitReconciliationFailure(failure, {
      outcome: "proven-absent",
      retrySafe: true,
      expectedHead,
      observedHead,
      expectedResources,
      observedResources: [],
    });
  }

  let parentHead: string;
  try {
    parentHead = readCommitParent(git, cwd, observedHead);
  } catch (error: unknown) {
    throw commitReconciliationFailure(failure, {
      outcome: "unresolved",
      retrySafe: false,
      expectedHead,
      observedHead,
      expectedResources,
      observedResources: [],
      reconciliationError: error,
    });
  }

  let observedResources: readonly string[];
  try {
    observedResources = readCanonicalCommitChangedPaths(git, cwd, observedHead);
  } catch (error: unknown) {
    throw commitReconciliationFailure(failure, {
      outcome: "unresolved",
      retrySafe: false,
      expectedHead,
      observedHead,
      expectedResources,
      observedResources: [],
      reconciliationError: error,
    });
  }

  if (parentHead !== expectedHead) {
    throw commitReconciliationFailure(failure, {
      outcome: "unresolved",
      retrySafe: false,
      expectedHead,
      observedHead,
      expectedResources,
      observedResources,
      reconciliationReason: "observed-head-parent-mismatch",
    });
  }

  const expectedSet = new Set(expectedResources);
  const divergentResources = observedResources.filter((resource) => !expectedSet.has(resource));
  if (observedResources.length === 0 || divergentResources.length > 0) {
    throw commitReconciliationFailure(failure, {
      outcome: "unresolved",
      retrySafe: false,
      expectedHead,
      observedHead,
      expectedResources,
      observedResources,
      divergentResources,
    });
  }

  const reconciliation: CommitReconciliation = Object.freeze({
    outcome: "proven-committed",
    retrySafe: false,
    expectedHead,
    observedHead,
    expectedResources: Object.freeze([...expectedResources]),
    observedResources: Object.freeze([...observedResources]),
  });
  return Object.freeze({
    schemaVersion: GOVERNED_GIT_OPERATION_SCHEMA_VERSION,
    commitSha: observedHead,
    message,
    resources: observedResources,
    reconciliation,
  });
}

type CommitReconciliationEvidence = Omit<CommitReconciliation, "observedHead"> & {
  readonly observedHead?: string;
  readonly reconciliationError?: unknown;
  readonly divergentResources?: readonly string[];
  readonly reconciliationReason?: string;
};

function commitReconciliationFailure(
  failure: SessionRegistryError,
  evidence: CommitReconciliationEvidence,
): SessionRegistryError {
  const details: RegistryErrorDetails = {
    ...failure.details,
    outcome: evidence.outcome,
    retrySafe: evidence.retrySafe,
    expectedHead: evidence.expectedHead,
    expectedResources: [...evidence.expectedResources],
    observedResources: [...evidence.observedResources],
    ...(evidence.observedHead === undefined ? {} : { observedHead: evidence.observedHead }),
    reconciliation: {
      outcome: evidence.outcome,
      retrySafe: evidence.retrySafe,
      expectedHead: evidence.expectedHead,
      expectedResources: [...evidence.expectedResources],
      observedResources: [...evidence.observedResources],
      ...(evidence.observedHead === undefined ? {} : { observedHead: evidence.observedHead }),
    },
    ...(evidence.divergentResources === undefined ? {} : { divergentResources: [...evidence.divergentResources] }),
    ...(evidence.reconciliationReason === undefined ? {} : { reconciliationReason: evidence.reconciliationReason }),
    ...(evidence.reconciliationError instanceof SessionRegistryError
      ? {
          reconciliationErrorCode: evidence.reconciliationError.code,
        }
      : {}),
  };
  return new SessionRegistryError(failure.code, failure.message, details, failure);
}

function inspectPushTarget(
  git: GitCommandRunner,
  cwd: string,
  remote: string,
  branch: string,
  sourceSha: string,
): PushInspection {
  const targetRef = `refs/heads/${branch}`;
  try {
    git.run(["remote", "get-url", remote], cwd);
  } catch (error: unknown) {
    throwRemoteInspectionFailure(error, "remote");
  }

  let remoteTargetOutput: string;
  try {
    remoteTargetOutput = git.run(["ls-remote", "--heads", remote, targetRef], cwd);
  } catch (error: unknown) {
    throwRemoteInspectionFailure(error, "ls-remote");
  }
  const remoteTargetExists = remoteTargetOutput.trim().length > 0;
  if (remoteTargetExists && !/^[0-9a-f]{40,64}\s+refs\/heads\//u.test(remoteTargetOutput.trim())) {
    throw new SessionRegistryError(
      "PUSH_REMOTE_INSPECTION_FAILED",
      "Remote branch inspection returned an invalid record",
      {
        remote,
        branch,
      },
    );
  }

  let upstream: string | undefined;
  try {
    upstream = git.run(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], cwd).trim();
  } catch (error: unknown) {
    if (!isExpectedMissingRef(error)) throwRemoteInspectionFailure(error, "upstream");
    upstream = undefined;
  }
  if (upstream === "") upstream = undefined;
  if (upstream === undefined) {
    // The absence of an upstream is itself a first-class relation. A remote
    // branch may exist, but it must not silently become tracking state.
    return {
      sourceSha,
      relation: "no-upstream",
      upstream: undefined,
      targetRef,
      observedRemoteSha: remoteTargetExists ? extractRemoteSha(remoteTargetOutput, remote, branch) : null,
    };
  }

  const separator = upstream.indexOf("/");
  if (separator <= 0 || separator === upstream.length - 1) {
    throw new SessionRegistryError("PUSH_REMOTE_INSPECTION_FAILED", "Configured upstream has an invalid format", {
      upstream,
    });
  }
  if (!remoteTargetExists) {
    throw new SessionRegistryError(
      "PUSH_REMOTE_INSPECTION_FAILED",
      "Configured upstream target is absent on the remote",
      {
        upstream,
        remote,
        branch,
      },
    );
  }

  const remoteShaMatch = remoteTargetOutput.trim().match(/^([0-9a-f]{40,64})\s+/u);
  if (remoteShaMatch === null) {
    throw new SessionRegistryError(
      "PUSH_REMOTE_INSPECTION_FAILED",
      "Could not extract remote SHA from ls-remote output",
      {
        remote,
        branch,
      },
    );
  }
  const remoteSha = remoteShaMatch[1];

  const temporaryRef = `refs/nawabari/push-inspection/${remoteSha}`;
  let relationOutput: string | undefined;
  let inspectionError: unknown;
  try {
    try {
      // Fetch only the explicitly inspected remote branch into a disposable
      // ref. This obtains missing ancestry without mutating tracking refs or
      // fetching unrelated branches/tags.
      // Requires Git 2.29 or later for --no-write-fetch-head support.
      // Unsupported Git versions will fail here and surface as
      // PUSH_REMOTE_INSPECTION_FAILED via throwRemoteInspectionFailure.
      git.run(
        ["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", remote, `+${targetRef}:${temporaryRef}`],
        cwd,
      );
      const fetchedSha = git.run(["rev-parse", "--verify", temporaryRef], cwd).trim();
      if (fetchedSha !== remoteSha) {
        throw new SessionRegistryError(
          "PUSH_REMOTE_INSPECTION_FAILED",
          "The remote branch changed while its observed generation was being fetched",
          {
            remote,
            branch,
            observedRemoteSha: remoteSha,
            fetchedRemoteSha: fetchedSha,
          },
        );
      }
    } catch (error: unknown) {
      if (error instanceof SessionRegistryError && error.code === "PUSH_REMOTE_INSPECTION_FAILED") throw error;
      throwRemoteInspectionFailure(error, "remote-generation");
    }

    try {
      relationOutput = git.run(["rev-list", "--left-right", "--count", `${sourceSha}...${temporaryRef}`], cwd);
    } catch (error: unknown) {
      throwRemoteInspectionFailure(error, "relation");
    }
  } catch (error: unknown) {
    inspectionError = error;
  }

  try {
    git.run(["update-ref", "-d", temporaryRef], cwd);
  } catch (error: unknown) {
    if (inspectionError === undefined) throwRemoteInspectionFailure(error, "remote-generation-cleanup");
  }
  if (inspectionError !== undefined) throw inspectionError;
  if (relationOutput === undefined) {
    throw new SessionRegistryError("PUSH_REMOTE_INSPECTION_FAILED", "Remote ancestry relation was unavailable", {
      remote,
      branch,
    });
  }
  const counts = relationOutput
    .trim()
    .split(/\s+/u)
    .map((value) => Number(value));
  if (counts.length !== 2 || counts.some((value) => !Number.isSafeInteger(value) || value < 0)) {
    throw new SessionRegistryError("PUSH_REMOTE_INSPECTION_FAILED", "Remote ancestry relation was not numeric", {
      remote,
      branch,
    });
  }
  const [ahead, behind] = counts as [number, number];
  const relation: PushRelation =
    ahead > 0 && behind > 0 ? "diverged" : behind > 0 ? "behind" : ahead > 0 ? "ahead" : "up-to-date";
  return { sourceSha, relation, upstream, targetRef, observedRemoteSha: remoteSha };
}

function extractRemoteSha(remoteTargetOutput: string, remote: string, branch: string): string {
  const remoteShaMatch = remoteTargetOutput.trim().match(/^([0-9a-f]{40,64})\s+/u);
  if (remoteShaMatch === null) {
    throw new SessionRegistryError(
      "PUSH_REMOTE_INSPECTION_FAILED",
      "Could not extract remote SHA from ls-remote output",
      { remote, branch },
    );
  }
  return remoteShaMatch[1];
}

function isExpectedMissingRef(error: unknown): boolean {
  return (
    error instanceof SessionRegistryError &&
    error.code === "GIT_COMMAND_FAILED" &&
    (error.details.exitCode === 1 || error.details.exitCode === 128)
  );
}

function throwRemoteInspectionFailure(error: unknown, phase: string): never {
  if (error instanceof SessionRegistryError && isBoundedGitFailure(error.code)) {
    throw new SessionRegistryError(
      error.code,
      "Remote inspection did not complete",
      { ...error.details, phase },
      error,
    );
  }
  throw new SessionRegistryError(
    "PUSH_REMOTE_INSPECTION_FAILED",
    "Remote/upstream inspection failed before push mutation",
    {
      phase,
      ...(error instanceof SessionRegistryError ? error.details : {}),
      ...(error instanceof SessionRegistryError ? { gitCode: error.code } : {}),
    },
    error,
  );
}

function sortStrings(values: Iterable<string>): string[] {
  return [...new Set(values)].sort(compareCodePointStrings);
}

function sameCheckpointPaths(
  left: Pick<CheckpointEvidence, "paths">["paths"],
  right: Pick<CheckpointEvidence, "paths">["paths"],
): boolean {
  return (
    sameStringArray(left.changed, right.changed) &&
    sameStringArray(left.staged, right.staged) &&
    sameStringArray(left.unstaged, right.unstaged) &&
    sameStringArray(left.untracked, right.untracked)
  );
}

function sameStringArray(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertWorktreeClean(git: GitCommandRunner, worktreePath: string): void {
  // Git is authoritative for this decision. --ignored=no means ignored or
  // generated artifacts alone are intentionally absent from the blocker set.
  const checkpoint = captureGitCheckpoint(git, worktreePath);
  if (checkpoint.changed.length === 0) return;

  const nested = nestedRepositoryPaths(worktreePath, checkpoint.changed);
  if (nested.length > 0) {
    throw new SessionRegistryError(
      "NESTED_REPOSITORY",
      `Worktree contains nested repositories that require explicit recovery: ${worktreePath}`,
      {
        worktree: worktreePath,
        paths: [...checkpoint.changed],
        nestedRepositories: nested,
        recoveryHints: recoveryHintsForCode("NESTED_REPOSITORY"),
      },
    );
  }

  const untracked = new Set(checkpoint.untracked);
  const tracked = checkpoint.changed.filter((resource) => !untracked.has(resource));
  throw new SessionRegistryError("DIRTY_WORKTREE", `Worktree contains recoverable changes: ${worktreePath}`, {
    worktree: worktreePath,
    paths: [...checkpoint.changed],
    trackedPaths: tracked,
    untrackedPaths: [...checkpoint.untracked],
    stagedPaths: [...checkpoint.staged],
    unstagedPaths: [...checkpoint.unstaged],
    recoveryHints: recoveryHintsForCode("DIRTY_WORKTREE"),
  });
}

function nestedRepositoryPaths(worktreePath: string, untracked: readonly string[]): string[] {
  const nested = new Set<string>();
  for (const resource of untracked) {
    const absolute = path.resolve(worktreePath, resource);
    const relative = path.relative(worktreePath, absolute);
    if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) continue;
    const components = relative.split(path.sep).filter((component) => component.length > 0);
    let current = worktreePath;
    for (const component of components) {
      current = path.join(current, component);
      const stat = lstatIfPresent(current);
      if (stat?.isDirectory() !== true) continue;
      if (lstatIfPresent(path.join(current, ".git")) !== undefined) {
        nested.add(components.join("/"));
        break;
      }
    }
  }
  return sortStrings(nested);
}

function assertNoRecoverableStashes(git: GitCommandRunner, cwd: string, branchName: string): void {
  const output = git.run(["stash", "list", "--format=%H%x00%gs"], cwd);
  const matching = output
    .split(/\r?\n/u)
    .filter((line) => {
      const separator = line.indexOf("\u0000");
      const subject = separator === -1 ? line : line.slice(separator + 1);
      return subject.includes(`on ${branchName}:`) || subject.includes(`On ${branchName}:`);
    })
    .map((line) => line.split("\u0000", 1)[0])
    .filter((hash) => hash.length > 0);
  if (matching.length === 0) return;
  throw new SessionRegistryError("RECOVERABLE_STASHES", `Session branch has recoverable stashes: ${branchName}`, {
    branch: branchName,
    stashes: matching,
    recoveryHints: recoveryHintsForCode("RECOVERABLE_STASHES"),
  });
}

function readLocalBranchHead(git: GitCommandRunner, cwd: string, branchId: string): string {
  const head = git.run(["rev-parse", "--verify", `${branchId}^{commit}`], cwd);
  if (!isRevision(head)) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid owned branch HEAD", {
      branch: branchId,
      head,
    });
  }
  return head;
}

function removeSessionWorktree(git: GitCommandRunner, cwd: string, worktreePath: string, force = false): void {
  force ||= !fs.existsSync(worktreePath);
  git.run(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], cwd);
}

function removeSessionBranch(git: GitCommandRunner, cwd: string, branchName: string, force = false): void {
  git.run(["branch", force ? "-D" : "-d", "--", branchName], cwd);
}

function generateUniqueSessionId(records: readonly SessionRecord[], idGenerator: () => string): string {
  for (let attempt = 0; attempt < MAX_ID_GENERATION_ATTEMPTS; attempt += 1) {
    const sessionId = idGenerator();
    assertSessionId(sessionId);
    if (!records.some((record) => record.sessionId === sessionId)) return sessionId;
  }
  throw new SessionRegistryError(
    "SESSION_ID_COLLISION",
    `Could not generate a unique session ID after ${MAX_ID_GENERATION_ATTEMPTS} attempts`,
    { attempts: MAX_ID_GENERATION_ATTEMPTS },
  );
}

function resolveManagedWorktreeRoot(candidate: string): string {
  if (candidate.includes("\u0000") || candidate.trim().length === 0) {
    throw new SessionRegistryError("INVALID_WORKTREE_PATH", `Invalid managed worktree root: ${candidate}`, {
      worktree: candidate,
    });
  }
  const resolved = path.resolve(candidate);
  assertNoSymlinkPath(resolved);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) throw new Error("managed worktree root is not a directory");
    const canonical = fs.realpathSync.native(resolved);
    if (canonical !== resolved) {
      throw new Error("managed worktree root is a symbolic-link path");
    }
    return canonical;
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "INVALID_WORKTREE_PATH",
      `Could not resolve managed worktree root: ${resolved}`,
      { worktree: resolved },
      error,
    );
  }
}

function resolveProvisionedWorktreePath(candidate: string, managedRoot: string): string {
  if (candidate.includes("\u0000") || candidate.trim().length === 0) {
    throw new SessionRegistryError("INVALID_WORKTREE_PATH", `Invalid worktree path: ${candidate}`, {
      worktree: candidate,
    });
  }
  const resolved = path.isAbsolute(candidate) ? path.resolve(candidate) : path.resolve(managedRoot, candidate);
  if (!samePath(resolved, managedRoot) && !isPathInside(managedRoot, resolved)) {
    throw new SessionRegistryError("INVALID_WORKTREE_PATH", `Worktree path escapes the managed root: ${resolved}`, {
      worktree: resolved,
      managedRoot,
    });
  }
  assertNoSymlinkPath(resolved);
  if (resolved === path.parse(resolved).root) {
    throw new SessionRegistryError(
      "INVALID_WORKTREE_PATH",
      `A filesystem root cannot be a session worktree: ${resolved}`,
      {
        worktree: resolved,
      },
    );
  }
  const entry = lstatIfPresent(resolved);
  if (entry !== undefined) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new SessionRegistryError("INVALID_WORKTREE_PATH", `Worktree path is not a directory: ${resolved}`, {
        worktree: resolved,
      });
    }
    return resolved;
  }
  const parent = path.dirname(resolved);
  try {
    if (!fs.statSync(parent).isDirectory()) throw new Error("worktree parent is not a directory");
    return resolved;
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "INVALID_WORKTREE_PATH",
      `Worktree parent does not exist: ${parent}`,
      { worktree: resolved },
      error,
    );
  }
}

function resolvePotentialWorktreePath(candidate: string, baseDirectory: string): string {
  if (candidate.includes("\u0000") || candidate.trim().length === 0) {
    throw new SessionRegistryError("INVALID_WORKTREE_PATH", `Invalid worktree path: ${candidate}`, {
      worktree: candidate,
    });
  }
  const resolved = path.resolve(baseDirectory, candidate);
  assertNoSymlinkPath(resolved);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    const parent = path.dirname(resolved);
    try {
      return path.join(fs.realpathSync.native(parent), path.basename(resolved));
    } catch {
      return resolved;
    }
  }
}

function isPathInside(root: string, candidate: string): boolean {
  const resolvedRoot = path.resolve(root);
  const resolvedCandidate = path.resolve(candidate);
  return resolvedCandidate === resolvedRoot || resolvedCandidate.startsWith(`${resolvedRoot}${path.sep}`);
}

function assertNoSymlinkPath(candidate: string): void {
  const root = path.parse(candidate).root;
  let current = root;
  for (const component of path.relative(root, candidate).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    let entry: fs.Stats;
    try {
      entry = fs.lstatSync(current);
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") break;
      throw new SessionRegistryError(
        "INVALID_WORKTREE_PATH",
        `Could not inspect worktree path: ${candidate}`,
        { worktree: candidate },
        error,
      );
    }
    if (entry.isSymbolicLink()) {
      throw new SessionRegistryError("INVALID_WORKTREE_PATH", `Worktree path contains a symbolic link: ${candidate}`, {
        worktree: candidate,
      });
    }
  }
}

function samePath(left: string, right: string): boolean {
  return path.resolve(left) === path.resolve(right);
}

function resolveDefaultBranchName(
  git: GitCommandRunner,
  cwd: string,
  worktrees: readonly GitWorktreeInfo[],
  configured: string | undefined,
): string | undefined {
  if (configured !== undefined) return configured;
  const integrationBranch = worktrees.find((worktree) => !worktree.prunable)?.branchName;
  if (integrationBranch !== null && integrationBranch !== undefined) return integrationBranch;

  try {
    const configuredDefault = git.run(["config", "--get", "init.defaultBranch"], cwd);
    if (configuredDefault.length > 0) return configuredDefault;
  } catch (error: unknown) {
    if (!isExpectedGitLookupFailure(error)) throw error;
    // A repository without init.defaultBranch is valid; continue to the local HEAD fallback.
  }

  try {
    const remoteHead = git.run(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], cwd);
    if (remoteHead.startsWith("origin/")) return remoteHead.slice("origin/".length);
  } catch (error: unknown) {
    if (!isExpectedGitLookupFailure(error)) throw error;
    // A local repository may not have an origin or a symbolic remote HEAD.
  }
  return undefined;
}

/**
 * Prove that a caller-selected revision is in the configured integration
 * branch's local commit history. This is deliberately separate from the
 * later changed-path tree comparison: matching content cannot establish
 * integration authority by itself.
 */
function proveIntegrationRevisionLineage(
  git: GitCommandRunner,
  cwd: string,
  integrationBranch: string,
  integratedRevision: string,
  integrationRevision?: string,
): IntegrationLineageProof | undefined {
  try {
    git.run(
      ["merge-base", "--is-ancestor", integratedRevision, integrationRevision ?? normalizeBranchId(integrationBranch)],
      cwd,
    );
    return {
      method: "integration-branch-ancestor",
      integrationBranch,
      integratedRevision,
    };
  } catch (error: unknown) {
    if (isExpectedGitLookupFailure(error)) return undefined;
    throw error;
  }
}

function withFetchedIntegrationRef<T>(
  git: GitCommandRunner,
  cwd: string,
  record: SessionRecord,
  evidence: IntegrationEvidenceInput,
  prove: (fetchedSha: string) => T,
): T {
  const remote = evidence.fetchRemote;
  const branch = evidence.fetchBranch;
  if (remote === undefined || branch === undefined) {
    throw new SessionRegistryError(
      "OPERATION_REJECTED",
      "Explicit integration fetch requires both a remote and an integration branch",
      { sessionId: record.sessionId },
    );
  }

  const targetRef = normalizeBranchId(branch);
  const temporaryRef = `refs/nawabari/session-close/${record.sessionId}/${generateSessionId()}`;
  let fetchAttempted = false;
  let result!: T;
  let operationError: unknown;
  let cleanupError: unknown;

  try {
    const sessionIdentityBeforeFetch = observeSessionProofIdentity(git, cwd, record);
    const observedRemoteSha = observeIntegrationRemoteTip(git, cwd, remote, branch, targetRef);

    fetchAttempted = true;
    try {
      git.run(
        ["fetch", "--no-tags", "--no-write-fetch-head", "--refmap=", remote, `+${targetRef}:${temporaryRef}`],
        cwd,
      );
    } catch (error: unknown) {
      throw integrationFetchFailure(
        "Integration proof fetch failed",
        {
          phase: "fetch",
          remote,
          branch,
          temporaryRef,
          ...(error instanceof SessionRegistryError ? { gitCode: error.code, ...error.details } : {}),
        },
        error,
      );
    }

    let fetchedSha: string;
    try {
      fetchedSha = git.run(["rev-parse", "--verify", `${temporaryRef}^{commit}`], cwd);
    } catch (error: unknown) {
      throw integrationFetchFailure(
        "Fetched integration branch did not produce a verifiable commit",
        {
          phase: "resolve-fetched-ref",
          remote,
          branch,
          temporaryRef,
          ...(error instanceof SessionRegistryError ? { gitCode: error.code, ...error.details } : {}),
        },
        error,
      );
    }
    if (!isFullRevision(fetchedSha)) {
      throw integrationFetchFailure("Fetched integration branch returned an invalid commit SHA", {
        phase: "resolve-fetched-ref",
        remote,
        branch,
        temporaryRef,
        fetchedSha,
      });
    }

    const fetchedRemoteSha = observeIntegrationRemoteTip(git, cwd, remote, branch, targetRef);
    if (observedRemoteSha !== fetchedRemoteSha || fetchedSha !== observedRemoteSha) {
      throw integrationFetchFailure("The remote integration branch changed during the proof fetch", {
        phase: "remote-race-check",
        remote,
        branch,
        temporaryRef,
        observedRemoteSha,
        fetchedRemoteSha,
        fetchedSha,
      });
    }

    result = prove(fetchedSha);
    const sessionIdentityAfterProof = observeSessionProofIdentity(git, cwd, record);
    assertSameSessionProofIdentity(sessionIdentityBeforeFetch, sessionIdentityAfterProof, record);
  } catch (error: unknown) {
    operationError = error;
  } finally {
    if (fetchAttempted) {
      try {
        git.run(["update-ref", "-d", temporaryRef], cwd);
      } catch (error: unknown) {
        cleanupError = error;
      }
    }
  }

  if (cleanupError !== undefined) {
    const cleanupFailure = integrationFetchFailure(
      "Could not remove the temporary integration proof ref",
      {
        phase: "temporary-ref-cleanup",
        remote,
        branch,
        temporaryRef,
        ...(cleanupError instanceof SessionRegistryError
          ? { gitCode: cleanupError.code, ...cleanupError.details }
          : {}),
      },
      cleanupError,
    );
    if (operationError === undefined) throw cleanupFailure;
    if (operationError instanceof SessionRegistryError) {
      throw new SessionRegistryError(
        operationError.code,
        operationError.message,
        {
          ...operationError.details,
          temporaryRefCleanupFailed: true,
          temporaryRef,
          cleanupErrorCode: cleanupFailure.code,
        },
        operationError,
      );
    }
    throw cleanupFailure;
  }

  if (operationError !== undefined) throw operationError;
  return result;
}

function observeIntegrationRemoteTip(
  git: GitCommandRunner,
  cwd: string,
  remote: string,
  branch: string,
  targetRef: string,
): string {
  let output: string;
  try {
    output = git.run(["ls-remote", "--heads", remote, targetRef], cwd);
  } catch (error: unknown) {
    throw integrationFetchFailure(
      "Could not observe the remote integration branch tip",
      {
        phase: "remote-tip-observation",
        remote,
        branch,
        ...(error instanceof SessionRegistryError ? { gitCode: error.code, ...error.details } : {}),
      },
      error,
    );
  }

  const records = output
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (records.length !== 1) {
    throw integrationFetchFailure("The remote integration branch tip was absent or ambiguous", {
      phase: "remote-tip-observation",
      remote,
      branch,
      targetRef,
      recordCount: records.length,
    });
  }
  const fields = records[0]?.split(/\s+/u) ?? [];
  if (fields.length !== 2 || fields[1] !== targetRef || !isFullRevision(fields[0] ?? "")) {
    throw integrationFetchFailure("The remote integration branch tip was invalid", {
      phase: "remote-tip-observation",
      remote,
      branch,
      targetRef,
    });
  }
  return fields[0] as string;
}

function integrationFetchFailure(
  message: string,
  details: RegistryErrorDetails,
  cause?: unknown,
): SessionRegistryError {
  return new SessionRegistryError("INTEGRATION_FETCH_FAILED", message, details, cause);
}

function localBranchExists(git: GitCommandRunner, cwd: string, branchId: string): boolean {
  try {
    git.run(["show-ref", "--verify", "--quiet", branchId], cwd);
    return true;
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError && error.code === "GIT_COMMAND_FAILED" && error.details.exitCode === 1) {
      return false;
    }
    throw error;
  }
}

function localBranchCollision(git: GitCommandRunner, cwd: string, branchId: string): boolean {
  if (localBranchExists(git, cwd, branchId)) return true;

  const output = git.run(["for-each-ref", "--format=%(refname)", "refs/heads"], cwd);
  return output
    .split(/\r?\n/u)
    .filter((candidate) => candidate.length > 0)
    .some(
      (candidate) =>
        candidate === branchId || candidate.startsWith(`${branchId}/`) || branchId.startsWith(`${candidate}/`),
    );
}

function assertGitResourcesAvailable(git: GitCommandRunner, cwd: string, resources: ProvisioningResources): void {
  assertNoSymlinkPath(resources.worktreePath);
  const parent = path.dirname(resources.worktreePath);
  try {
    if (!fs.statSync(parent).isDirectory() || fs.realpathSync.native(parent) !== parent) {
      throw new Error("worktree parent is not canonical");
    }
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "INVALID_WORKTREE_PATH",
      `Could not safely resolve worktree parent: ${parent}`,
      { worktree: resources.worktreePath },
      error,
    );
  }
  assertGitBranchName(git, cwd, resources.branchName);
  const worktrees = listGitWorktrees(git, cwd);
  if (worktrees.some((worktree) => samePath(worktree.worktreePath, resources.worktreePath))) {
    throw new SessionRegistryError(
      "WORKTREE_ALREADY_EXISTS",
      `Worktree path already exists: ${resources.worktreePath}`,
      {
        worktree: resources.worktreePath,
      },
    );
  }
  const worktreeEntry = lstatIfPresent(resources.worktreePath);
  if (worktreeEntry?.isSymbolicLink()) {
    throw new SessionRegistryError(
      "INVALID_WORKTREE_PATH",
      `Worktree path is a symbolic link: ${resources.worktreePath}`,
      {
        worktree: resources.worktreePath,
      },
    );
  }
  if (worktreeEntry !== undefined) {
    throw new SessionRegistryError(
      "WORKTREE_ALREADY_EXISTS",
      `Worktree path already exists: ${resources.worktreePath}`,
      {
        worktree: resources.worktreePath,
      },
    );
  }
  if (localBranchCollision(git, cwd, resources.branchId)) {
    throw new SessionRegistryError("BRANCH_ALREADY_EXISTS", `Local branch already exists: ${resources.branchName}`, {
      branch: resources.branchName,
    });
  }
}

function assertGitBranchName(git: GitCommandRunner, cwd: string, branchName: string): void {
  try {
    git.run(["check-ref-format", "--branch", branchName], cwd);
  } catch (error: unknown) {
    if (
      error instanceof SessionRegistryError &&
      error.code === "GIT_COMMAND_FAILED" &&
      (error.details.exitCode === 1 || error.details.exitCode === 128)
    ) {
      throw new SessionRegistryError(
        "INVALID_BRANCH_ID",
        `Invalid branch identity: ${branchName}`,
        {
          branchName,
        },
        error,
      );
    }
    throw error;
  }
}

function classifyProvisioningFailure(
  error: unknown,
  git: GitCommandRunner,
  cwd: string,
  resources: ProvisioningResources,
): unknown {
  if (
    !(error instanceof SessionRegistryError) ||
    error.code !== "GIT_COMMAND_FAILED" ||
    typeof error.details.exitCode !== "number"
  ) {
    return error;
  }
  try {
    const worktrees = listGitWorktrees(git, cwd);
    if (
      worktrees.some((worktree) => samePath(worktree.worktreePath, resources.worktreePath)) ||
      lstatIfPresent(resources.worktreePath) !== undefined
    ) {
      return new SessionRegistryError(
        "WORKTREE_ALREADY_EXISTS",
        `Worktree path already exists: ${resources.worktreePath}`,
        { worktree: resources.worktreePath },
        error,
      );
    }
    if (localBranchCollision(git, cwd, resources.branchId)) {
      return new SessionRegistryError(
        "BRANCH_ALREADY_EXISTS",
        `Local branch already exists: ${resources.branchName}`,
        {
          branch: resources.branchName,
        },
        error,
      );
    }
  } catch {
    // Preserve the original bounded Git failure when collision observation is unavailable.
  }
  return error;
}

interface ResolvedBaseRef {
  readonly ref: string;
  readonly revision: string;
}

function resolveBaseRef(git: GitCommandRunner, cwd: string, candidate: string): ResolvedBaseRef {
  if (
    candidate.trim().length === 0 ||
    candidate !== candidate.trim() ||
    candidate.startsWith("-") ||
    candidate.includes("\u0000")
  ) {
    throw invalidBaseRef(candidate, "invalid-format");
  }
  try {
    const revision = git.run(["rev-parse", "--verify", `${candidate}^{commit}`], cwd);
    if (!isRevision(revision)) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid base revision", {
        baseRef: candidate,
        revision,
      });
    }
    return { ref: candidate, revision };
  } catch (error: unknown) {
    if (isExpectedGitLookupFailure(error)) {
      throw invalidBaseRef(candidate, "does-not-resolve-to-commit");
    }
    throw error;
  }
}

function invalidBaseRef(candidate: string, reason: string): SessionRegistryError {
  return new SessionRegistryError(
    "INVALID_BASE_REF",
    reason === "invalid-format"
      ? `Invalid base ref: ${candidate}`
      : `Base ref does not resolve to a commit: ${candidate}`,
    {
      baseRef: candidate,
      reason,
      defaultBaseRef: "HEAD",
      recoveryHints: ["Omit --base to use HEAD, then retry session create."],
    },
  );
}

function isExpectedGitLookupFailure(error: unknown): boolean {
  return (
    error instanceof SessionRegistryError &&
    error.code === "GIT_COMMAND_FAILED" &&
    (error.details.exitCode === 1 || error.details.exitCode === 128)
  );
}

function rollbackProvisionedResources(git: GitCommandRunner, cwd: string, resources: ProvisioningResources): void {
  try {
    git.run(["worktree", "remove", "--force", "--", resources.worktreePath], cwd);
  } catch {
    // Best effort: the registry must remain unclaimed even if Git cleanup fails.
  }
  try {
    git.run(["branch", "-D", "--", resources.branchName], cwd);
  } catch {
    // Best effort: never replace the original provisioning or registry error.
  }
}

function lstatIfPresent(candidate: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw new SessionRegistryError(
      "INVALID_WORKTREE_PATH",
      `Could not inspect worktree path: ${candidate}`,
      { worktree: candidate },
      error,
    );
  }
}

export function toPersistedSessionRecord(
  record: SessionRecord,
  expectedRepositoryId: string = record.repositoryId,
): PersistedSessionRecord {
  const validated = validateSessionRecord(record, expectedRepositoryId);
  return {
    schema_version: validated.schemaVersion,
    session_id: validated.sessionId,
    repository_id: validated.repositoryId,
    worktree_id: validated.worktreeId,
    worktree_path: validated.worktreePath,
    branch_id: validated.branchId,
    branch_name: validated.branchName,
    state: validated.state,
    created_at: validated.createdAt,
    updated_at: validated.updatedAt,
    ...(validated.baseRevision === undefined ? {} : { base_revision: validated.baseRevision }),
    ...(validated.label === undefined ? {} : { label: validated.label }),
    ...(validated.terminalOperation === undefined ? {} : { terminal_operation: validated.terminalOperation }),
    ...(validated.discardedHead === undefined ? {} : { discarded_head: validated.discardedHead }),
  };
}

export function toPersistedResourceClaim(
  claim: ResourceClaim,
  expectedRepositoryId: string = claim.repositoryId,
): PersistedResourceClaim {
  const validated = validateResourceClaim(claim, expectedRepositoryId);
  return {
    schema_version: validated.schemaVersion,
    claim_id: validated.claimId,
    session_id: validated.sessionId,
    repository_id: validated.repositoryId,
    worktree_path: validated.worktreePath,
    resource: validated.resource,
    mode: validated.mode,
    created_at: validated.createdAt,
    updated_at: validated.updatedAt,
  };
}

function parseRegistry(value: unknown, expectedRepositoryId: string, allowLegacyClaimSchema = false): RegistryState {
  if (!isRecord(value)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry root must be an object");
  }
  if (value.schema_version !== REGISTRY_SCHEMA_VERSION) {
    if (typeof value.schema_version === "number") {
      throw new SessionRegistryError(
        "UNSUPPORTED_SCHEMA_VERSION",
        `Unsupported registry schema version: ${value.schema_version}`,
        {
          schemaVersion: value.schema_version,
        },
      );
    }
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry schema_version must be a number");
  }
  assertExactKeys(
    value,
    ["schema_version", "repository_id", "sessions"],
    ["claims_schema_version", "claims", "claim_set_generation"],
  );

  if (typeof value.repository_id !== "string" || value.repository_id !== expectedRepositoryId) {
    throw new SessionRegistryError(
      "REGISTRY_REPOSITORY_MISMATCH",
      "Registry repository identity does not match the current repository",
      { expectedRepositoryId, actualRepositoryId: stringifyDetail(value.repository_id) },
    );
  }
  if (!Array.isArray(value.sessions)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry sessions must be an array");
  }

  const claimSetGeneration = parseClaimSetGeneration(value.claim_set_generation);

  const records = value.sessions.map((candidate, index) => parseSessionRecord(candidate, index, expectedRepositoryId));
  validateRecords(records, expectedRepositoryId);
  const hasClaimsSchema = Object.hasOwn(value, "claims_schema_version");
  const hasClaims = Object.hasOwn(value, "claims");
  if (hasClaimsSchema !== hasClaims) {
    throw new SessionRegistryError(
      "REGISTRY_CORRUPT",
      "Registry claim schema metadata and claims must be migrated together",
    );
  }
  if (!hasClaimsSchema) {
    // v0.1.0 had no claim section. It is a deterministic empty claim set,
    // materialized on the next locked mutation or via migrate().
    return { sessions: records, claims: [], claimSetGeneration, legacyClaimsAbsent: true };
  }
  const claimSchemaVersion = value.claims_schema_version;
  const isLegacyClaimSchema = claimSchemaVersion === LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION;
  if (claimSchemaVersion !== RESOURCE_CLAIM_SCHEMA_VERSION && !isLegacyClaimSchema) {
    throw new SessionRegistryError(
      "UNSUPPORTED_CLAIM_SCHEMA_VERSION",
      `Unsupported resource claim schema version: ${stringifyDetail(claimSchemaVersion)}`,
      { schemaVersion: claimSchemaVersion as number },
    );
  }
  if (isLegacyClaimSchema && !allowLegacyClaimSchema) {
    throw new SessionRegistryError(
      "UNSUPPORTED_CLAIM_SCHEMA_VERSION",
      "Resource claim schema v1 requires explicit migration before use",
      {
        schemaVersion: LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION,
        migrationRequired: true,
        recoveryHints: [...MIGRATION_RECOVERY_HINTS],
      },
    );
  }
  if (!Array.isArray(value.claims)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry claims must be an array");
  }
  const claims = value.claims.map((candidate, index) =>
    parseResourceClaim(
      candidate,
      index,
      expectedRepositoryId,
      isLegacyClaimSchema ? LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION : undefined,
    ),
  );
  validateRegistryClaims(records, claims, expectedRepositoryId, isLegacyClaimSchema);
  return {
    sessions: records,
    claims: sortResourceClaims(claims),
    claimSetGeneration,
    legacyClaimsAbsent: false,
    ...(isLegacyClaimSchema ? { legacyClaimsSchemaVersion: LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION } : {}),
  };
}

function parseClaimSetGeneration(value: unknown): number {
  if (value === undefined) return 0;
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new SessionRegistryError(
      "REGISTRY_CORRUPT",
      "Registry claim_set_generation must be a non-negative safe integer",
      { claimSetGeneration: typeof value === "number" ? value : stringifyDetail(value) },
    );
  }
  return value as number;
}

function migrationReadError(error: unknown): SessionRegistryError {
  if (!(error instanceof SessionRegistryError)) throw error;
  const suppliedHints = error.details.recoveryHints;
  const recoveryHints = Array.isArray(suppliedHints)
    ? suppliedHints.filter((hint): hint is string => typeof hint === "string")
    : [...MIGRATION_RECOVERY_HINTS];
  return new SessionRegistryError(
    error.code,
    error.message,
    {
      ...error.details,
      migrationRequired: true,
      recoveryHints,
    },
    error,
  );
}

function nextClaimSetGeneration(state: RegistryState, nextClaims: readonly ResourceClaim[]): number {
  if (sameClaimSet(state.claims, nextClaims)) return state.claimSetGeneration;
  if (state.claimSetGeneration >= Number.MAX_SAFE_INTEGER) {
    throw new SessionRegistryError("OPERATION_REJECTED", "Claim-set generation exhausted");
  }
  return state.claimSetGeneration + 1;
}

function sameClaimSet(left: readonly ResourceClaim[], right: readonly ResourceClaim[]): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const a = left[index];
    const b = right[index];
    if (
      a === undefined ||
      b === undefined ||
      a.schemaVersion !== b.schemaVersion ||
      a.claimId !== b.claimId ||
      a.sessionId !== b.sessionId ||
      a.repositoryId !== b.repositoryId ||
      a.worktreePath !== b.worktreePath ||
      a.resource !== b.resource ||
      a.mode !== b.mode ||
      a.createdAt !== b.createdAt ||
      a.updatedAt !== b.updatedAt
    ) {
      return false;
    }
  }
  return true;
}

function parseResourceClaim(
  value: unknown,
  index: number,
  expectedRepositoryId: string,
  expectedSchemaVersion:
    typeof RESOURCE_CLAIM_SCHEMA_VERSION | typeof LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION = RESOURCE_CLAIM_SCHEMA_VERSION,
): ResourceClaim {
  if (!isRecord(value)) throw invalidRecord(index, "claim must be an object");
  assertExactKeys(
    value,
    [
      "schema_version",
      "claim_id",
      "session_id",
      "repository_id",
      "worktree_path",
      "resource",
      "mode",
      "created_at",
      "updated_at",
    ],
    [],
    index,
  );
  if (value.schema_version !== expectedSchemaVersion) {
    throw new SessionRegistryError(
      "UNSUPPORTED_CLAIM_SCHEMA_VERSION",
      `Unsupported resource claim schema version at index ${index}: ${stringifyDetail(value.schema_version)}`,
      { schemaVersion: value.schema_version as number, index, expectedSchemaVersion },
    );
  }
  const claim: ResourceClaim = {
    schemaVersion: RESOURCE_CLAIM_SCHEMA_VERSION,
    claimId: requireString(value.claim_id, index, "claim_id"),
    sessionId: requireString(value.session_id, index, "session_id"),
    repositoryId: requireString(value.repository_id, index, "repository_id"),
    worktreePath: requireString(value.worktree_path, index, "worktree_path"),
    resource: requireString(value.resource, index, "resource"),
    mode: requireClaimMode(value.mode, index),
    createdAt: requireString(value.created_at, index, "created_at"),
    updatedAt: requireString(value.updated_at, index, "updated_at"),
  };
  return validateResourceClaim(claim, expectedRepositoryId, index);
}

function validateResourceClaim(claim: ResourceClaim, expectedRepositoryId: string, index?: number): ResourceClaim {
  const position = index === undefined ? "" : ` at index ${index}`;
  if (claim.schemaVersion !== RESOURCE_CLAIM_SCHEMA_VERSION) {
    throw new SessionRegistryError("UNSUPPORTED_CLAIM_SCHEMA_VERSION", `Unsupported claim schema version${position}`, {
      schemaVersion: claim.schemaVersion,
    });
  }
  if (!isSessionId(claim.sessionId)) {
    throw invalidRecord(index, `claim session_id is invalid${position}`);
  }
  if (claim.repositoryId !== expectedRepositoryId) {
    throw claimError("CLAIM_REPOSITORY_MISMATCH", "Claim repository identity does not match the registry", {
      expectedRepositoryId,
      actualRepositoryId: claim.repositoryId,
      claimId: claim.claimId,
    });
  }
  if (!isAbsolutePath(claim.worktreePath)) {
    throw invalidRecord(index, `claim worktree_path must be an absolute canonical path${position}`);
  }
  assertCanonicalClaimResource(claim.resource);
  if (claim.claimId !== canonicalClaimId(claim.sessionId, claim.resource, claim.mode)) {
    throw invalidRecord(index, `claim_id is not the canonical claim identity${position}`);
  }
  if (!isTimestamp(claim.createdAt) || !isTimestamp(claim.updatedAt)) {
    throw invalidRecord(index, `claim timestamps must be canonical UTC timestamps${position}`);
  }
  if (Date.parse(claim.updatedAt) < Date.parse(claim.createdAt)) {
    throw invalidRecord(index, `claim updated_at cannot precede created_at${position}`);
  }
  return Object.freeze({ ...claim });
}

function validateRegistryClaims(
  records: readonly SessionRecord[],
  claims: readonly ResourceClaim[],
  expectedRepositoryId: string,
  legacySemantics = false,
): void {
  const sessions = new Map(records.map((record) => [record.sessionId, record]));
  const claimIds = new Set<string>();
  for (const claim of claims) {
    if (claimIds.has(claim.claimId)) {
      throw claimError("DUPLICATE_CLAIM", `Duplicate resource claim: ${claim.claimId}`, {
        claimId: claim.claimId,
      });
    }
    claimIds.add(claim.claimId);
    const owner = sessions.get(claim.sessionId);
    if (owner === undefined) {
      throw claimError("CLAIM_SESSION_MISMATCH", "Claim references an unknown session", {
        claimId: claim.claimId,
        sessionId: claim.sessionId,
      });
    }
    if (owner.repositoryId !== claim.repositoryId || owner.worktreePath !== claim.worktreePath) {
      throw claimError("CLAIM_SESSION_MISMATCH", "Claim does not match its session worktree identity", {
        claimId: claim.claimId,
        sessionId: claim.sessionId,
      });
    }
    if (owner.state === "closed") {
      throw claimError("CLAIM_SESSION_MISMATCH", "Closed sessions cannot retain resource claims", {
        claimId: claim.claimId,
        sessionId: claim.sessionId,
      });
    }
  }
  const sorted = sortResourceClaims(claims);
  for (let index = 0; index < sorted.length; index += 1) {
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      const current = sorted[index];
      const prior = sorted[priorIndex];
      if (!claimsOverlap(current, prior)) continue;
      if (current.sessionId === prior.sessionId) {
        throw claimError(
          current.mode === prior.mode ? "DUPLICATE_CLAIM" : "CONTRADICTORY_CLAIM",
          "Persisted claims contain overlapping claims for one session",
          { claimId: current.claimId, ownerClaimId: prior.claimId },
        );
      }
      if (!(legacySemantics ? legacyClaimsConflict(current, prior) : claimsConflict(current, prior))) continue;
      const conflictDetails = resourceClaimConflictDetails(current, prior, records);
      throw claimError("RESOURCE_CLAIM_CONFLICT", "Persisted claims contain an unresolved conflict", {
        claimId: current.claimId,
        ...conflictDetails,
        safeActions: [...safeActionsForCode("RESOURCE_CLAIM_CONFLICT", conflictDetails)],
        recoveryHints: recoveryHintsForCode("RESOURCE_CLAIM_CONFLICT", conflictDetails),
      });
    }
  }
}

/**
 * Schema-v1 claims used the conservative overlap rule where every
 * overlapping pair except read/read conflicted. Validate that rule before
 * converting a legacy registry to v2 so migration never silently changes the
 * authority represented by an otherwise invalid legacy state.
 */
function legacyClaimsConflict(left: ResourceClaim, right: ResourceClaim): boolean {
  if (!claimsOverlap(left, right)) return false;
  return left.mode !== "read" || right.mode !== "read";
}

function parseSessionRecord(value: unknown, index: number, expectedRepositoryId: string): SessionRecord {
  if (!isRecord(value)) {
    throw invalidRecord(index, "record must be an object");
  }
  assertExactKeys(
    value,
    [
      "schema_version",
      "session_id",
      "repository_id",
      "worktree_id",
      "worktree_path",
      "branch_id",
      "branch_name",
      "state",
      "created_at",
      "updated_at",
    ],
    ["base_revision", "label", "terminal_operation", "discarded_head"],
    index,
  );

  if (value.schema_version !== REGISTRY_SCHEMA_VERSION) {
    if (typeof value.schema_version === "number") {
      throw new SessionRegistryError(
        "UNSUPPORTED_SCHEMA_VERSION",
        `Unsupported session schema version: ${value.schema_version}`,
        {
          schemaVersion: value.schema_version,
          index,
        },
      );
    }
    throw invalidRecord(index, "schema_version must be a number");
  }

  const record: SessionRecord = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    sessionId: requireString(value.session_id, index, "session_id"),
    repositoryId: requireString(value.repository_id, index, "repository_id"),
    worktreeId: requireString(value.worktree_id, index, "worktree_id"),
    worktreePath: requireString(value.worktree_path, index, "worktree_path"),
    branchId: requireString(value.branch_id, index, "branch_id"),
    branchName: requireString(value.branch_name, index, "branch_name"),
    state: requireState(value.state, index),
    createdAt: requireString(value.created_at, index, "created_at"),
    updatedAt: requireString(value.updated_at, index, "updated_at"),
    ...(value.base_revision === undefined
      ? {}
      : { baseRevision: requireRevision(value.base_revision, index, "base_revision") }),
    ...(value.label === undefined ? {} : { label: requireString(value.label, index, "label") }),
    ...(value.terminal_operation === undefined
      ? {}
      : { terminalOperation: requireTerminalOperation(value.terminal_operation, index) }),
    ...(value.discarded_head === undefined
      ? {}
      : { discardedHead: requireRevision(value.discarded_head, index, "discarded_head") }),
  };

  return validateSessionRecord(record, expectedRepositoryId, index);
}

function validateSessionRecord(record: SessionRecord, expectedRepositoryId: string, index?: number): SessionRecord {
  const position = index === undefined ? "" : ` at index ${index}`;
  if (record.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new SessionRegistryError("UNSUPPORTED_SCHEMA_VERSION", `Unsupported session schema version${position}`, {
      schemaVersion: record.schemaVersion,
    });
  }
  if (!isSessionId(record.sessionId)) {
    throw new SessionRegistryError("INVALID_SESSION_ID", `Invalid session ID${position}: ${record.sessionId}`, {
      sessionId: record.sessionId,
    });
  }
  if (record.repositoryId !== expectedRepositoryId) {
    throw new SessionRegistryError(
      "REGISTRY_REPOSITORY_MISMATCH",
      `Session repository identity does not match${position}`,
      {
        expectedRepositoryId,
        actualRepositoryId: record.repositoryId,
      },
    );
  }
  if (
    !isAbsolutePath(record.repositoryId) ||
    !isAbsolutePath(record.worktreeId) ||
    !isAbsolutePath(record.worktreePath)
  ) {
    throw invalidRecord(index, "repository and worktree identities must be absolute paths");
  }
  if (record.worktreeId !== record.worktreePath) {
    throw invalidRecord(index, "worktree_id must equal the canonical worktree_path");
  }
  if (normalizeBranchId(record.branchName) !== record.branchId) {
    throw invalidRecord(index, "branch_id must be the canonical identity of branch_name");
  }
  if (record.branchName !== record.branchId.slice("refs/heads/".length)) {
    throw invalidRecord(index, "branch_name must be the short name represented by branch_id");
  }
  if (!SESSION_STATES.has(record.state)) {
    throw invalidRecord(index, `unsupported lifecycle state: ${record.state}`);
  }
  if (!isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt)) {
    throw invalidRecord(index, "created_at and updated_at must be canonical UTC timestamps");
  }
  if (Date.parse(record.updatedAt) < Date.parse(record.createdAt)) {
    throw invalidRecord(index, "updated_at cannot precede created_at");
  }
  if (record.baseRevision !== undefined && !isRevision(record.baseRevision)) {
    throw invalidRecord(index, "base_revision must be a full hexadecimal Git revision");
  }
  if (record.label !== undefined && (typeof record.label !== "string" || record.label.length === 0)) {
    throw invalidRecord(index, "label must be a non-empty string");
  }
  if (record.terminalOperation !== undefined && record.terminalOperation !== "discard") {
    throw invalidRecord(index, "terminal_operation is invalid");
  }
  if (record.discardedHead !== undefined && !isRevision(record.discardedHead)) {
    throw invalidRecord(index, "discarded_head must be a full hexadecimal Git revision");
  }
  if (record.terminalOperation === undefined && record.discardedHead !== undefined) {
    throw invalidRecord(index, "discarded_head requires terminal_operation=discard");
  }
  if (record.state !== "closed" && record.state !== "closing" && record.terminalOperation !== undefined) {
    throw invalidRecord(index, "terminal_operation is only valid for a closing or closed session");
  }

  return freezeSessionRecord({ ...record });
}

function validateRecords(records: readonly SessionRecord[], expectedRepositoryId: string): void {
  const sessionIds = new Set<string>();
  const worktreeOwners = new Map<string, string>();
  const branchOwners = new Map<string, string>();

  for (const [index, record] of records.entries()) {
    const validated = validateSessionRecord(record, expectedRepositoryId, index);
    if (sessionIds.has(validated.sessionId)) {
      throw new SessionRegistryError("DUPLICATE_SESSION_ID", `Duplicate session ID: ${validated.sessionId}`, {
        sessionId: validated.sessionId,
      });
    }
    sessionIds.add(validated.sessionId);

    if (!ACTIVE_STATES.has(validated.state)) {
      continue;
    }
    const existingWorktreeOwner = worktreeOwners.get(validated.worktreeId);
    if (existingWorktreeOwner !== undefined) {
      throw new SessionRegistryError(
        "DUPLICATE_WORKTREE_OWNERSHIP",
        `Worktree is claimed by multiple active sessions: ${validated.worktreePath}`,
        { worktree: validated.worktreePath, sessionId: validated.sessionId, ownerSessionId: existingWorktreeOwner },
      );
    }
    worktreeOwners.set(validated.worktreeId, validated.sessionId);

    const existingBranchOwner = branchOwners.get(validated.branchId);
    if (existingBranchOwner !== undefined) {
      throw new SessionRegistryError(
        "DUPLICATE_BRANCH_OWNERSHIP",
        `Branch is claimed by multiple active sessions: ${validated.branchId}`,
        { branch: validated.branchId, sessionId: validated.sessionId, ownerSessionId: existingBranchOwner },
      );
    }
    branchOwners.set(validated.branchId, validated.sessionId);
  }
}

function assertNoOwnershipConflict(records: readonly SessionRecord[], candidate: SessionRecord): void {
  if (!ACTIVE_STATES.has(candidate.state)) {
    return;
  }
  for (const record of records) {
    if (!ACTIVE_STATES.has(record.state)) {
      continue;
    }
    if (record.worktreeId === candidate.worktreeId) {
      throw new SessionRegistryError(
        "DUPLICATE_WORKTREE_OWNERSHIP",
        `Worktree is already owned: ${candidate.worktreePath}`,
        {
          worktree: candidate.worktreePath,
          ownerSessionId: record.sessionId,
        },
      );
    }
    if (record.branchId === candidate.branchId) {
      throw new SessionRegistryError("DUPLICATE_BRANCH_OWNERSHIP", `Branch is already owned: ${candidate.branchId}`, {
        branch: candidate.branchId,
        ownerSessionId: record.sessionId,
      });
    }
  }
}

function assertSessionId(sessionId: string): void {
  if (!isSessionId(sessionId)) {
    throw new SessionRegistryError("INVALID_SESSION_ID", `Invalid session ID: ${sessionId}`, { sessionId });
  }
}

function validateLabel(label: string): string {
  if (typeof label !== "string" || label.length === 0) {
    throw new SessionRegistryError("INVALID_SESSION_RECORD", "Session label must be a non-empty string");
  }
  return label;
}

function toTimestamp(date: Date): string {
  if (Number.isNaN(date.getTime())) {
    throw new SessionRegistryError("INVALID_SESSION_RECORD", "Session clock returned an invalid timestamp");
  }
  return date.toISOString();
}

function isTimestamp(value: string): boolean {
  return (
    ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
  );
}

function isAbsolutePath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value && !value.includes("\u0000");
}

function cloneSessionRecord(record: SessionRecord): SessionRecord {
  return freezeSessionRecord({ ...record });
}

function freezeSessionRecord(record: SessionRecord): SessionRecord {
  return Object.freeze(record);
}

function requireString(value: unknown, index: number, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidRecord(index, `${field} must be a non-empty string`);
  }
  return value;
}

function requireRevision(value: unknown, index: number, field: string): string {
  const revision = requireString(value, index, field);
  if (!isRevision(revision)) {
    throw invalidRecord(index, `${field} must be a full hexadecimal Git revision`);
  }
  return revision;
}

function isRevision(value: string): boolean {
  return /^[0-9a-f]{40,64}$/u.test(value);
}

function isFullRevision(value: string): boolean {
  return /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

function requireState(value: unknown, index: number): SessionState {
  if (typeof value !== "string" || !SESSION_STATES.has(value as SessionState)) {
    throw invalidRecord(index, `state is invalid: ${stringifyDetail(value)}`);
  }
  return value as SessionState;
}

function requireTerminalOperation(value: unknown, index: number): "discard" {
  if (value !== "discard") {
    throw invalidRecord(index, `terminal_operation is invalid: ${stringifyDetail(value)}`);
  }
  return "discard";
}

function requireClaimMode(value: unknown, index: number): ResourceClaimMode {
  if (!isResourceClaimMode(value)) {
    throw invalidRecord(index, `mode is invalid: ${stringifyDetail(value)}`);
  }
  return value;
}

function invalidRecord(index: number | undefined, reason: string): SessionRegistryError {
  return new SessionRegistryError(
    "INVALID_SESSION_RECORD",
    `Invalid session record${index === undefined ? "" : ` at index ${index}`}: ${reason}`,
    {
      ...(index === undefined ? {} : { index }),
    },
  );
}

function assertExactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
  index?: number,
): void {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  if (
    keys.length !== required.length + optional.filter((key) => Object.hasOwn(value, key)).length ||
    keys.some((key) => !allowed.has(key))
  ) {
    throw invalidRecord(index, `unexpected or missing fields: ${keys.join(", ")}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw invalidRecord(index, `missing field: ${key}`);
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function stringifyDetail(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "<invalid>";
}

function toSessionRegistryLockError(error: unknown, lockPath: string): SessionRegistryError {
  if (error instanceof SessionRegistryError) {
    return error;
  }

  if (error instanceof RegistryLockError) {
    const details: Record<string, string | number | boolean> = { path: lockPath };
    for (const [key, value] of Object.entries(error.details)) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        details[key] = value;
      }
    }
    const code =
      error.code === "LOCK_BUSY" || error.code === "LOCK_STALE" || error.code === "LOCK_INVALID"
        ? "REGISTRY_LOCK_TIMEOUT"
        : "REGISTRY_IO_FAILURE";
    return new SessionRegistryError(code, error.message, details, error);
  }

  return new SessionRegistryError("REGISTRY_IO_FAILURE", `Could not operate on ${lockPath}`, { path: lockPath }, error);
}
