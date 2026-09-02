import path from "node:path";
import {
  SessionRegistry,
  type GarbageCollectResult as RegistryGarbageCollectResult,
  type ResourceClaim as RegistryResourceClaim,
  type SessionRecord as RegistrySessionRecord,
  type SessionRegistryOptions,
} from "../session-registry.js";
import { isSessionRegistryError, type RegistryErrorCode, type SessionRegistryError } from "../errors.js";
import { DomainError, failure, success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";
import {
  type BackendCapabilities,
  type CheckpointEvidence,
  type CheckpointOptions,
  type RepositoryDiffEvidence,
  type RepositoryDiffOptions,
  type RepositoryEvidence,
  type RepositoryEvidenceOptions,
  type CommitOptions,
  type CommitResult,
  type ClaimResourcesOptions,
  type ClaimResourcesResult,
  type ClaimDeltasOptions,
  type ClaimDeltasResult,
  type GarbageCollectOptions,
  type GarbageCollectResult,
  type GuardDecision,
  type GuardOptions,
  type OperationAuthorizationDecision,
  type OperationAuthorizationOptions,
  type PushOptions,
  type PushResult,
  type SessionBackend,
  type SessionCloseOptions,
  type SessionCloseResult,
  type SessionDiscardResult,
  type SessionContext,
  type SessionCreateOptions,
  type SessionDiagnostic,
  type SessionDiagnosticOptions,
  type SessionListResult,
  type SessionListOptions,
  type SessionRecord,
  type IntegrationProof as DomainIntegrationProof,
  boundedSessionListing,
  type ReleaseClaimsOptions,
  type ReleaseClaimsResult,
  type ResourceClaim,
  type RegistryMigrationResult,
  type StatusResult,
  type UpdateClaimsOptions,
} from "./session.js";

export interface LocalSessionBackendOptions {
  readonly git?: SessionRegistryOptions["git"];
  readonly registry?: Omit<SessionRegistryOptions, "cwd" | "git">;
}

export const LOCAL_SESSION_CAPABILITIES: BackendCapabilities = Object.freeze({
  session_registry: true,
  provisioning: true,
  lifecycle: true,
  garbage_collection: true,
  current_session_resolution: true,
  repository_evidence: true,
});

const REGISTRY_ERROR_CODE_MAP: Readonly<Record<RegistryErrorCode, ErrorCode>> = Object.freeze({
  GIT_COMMAND_FAILED: "GIT_COMMAND_FAILED",
  GIT_SPAWN_FAILED: "GIT_SPAWN_FAILED",
  GIT_TIMEOUT: "GIT_TIMEOUT",
  GIT_OUTPUT_LIMIT: "GIT_OUTPUT_LIMIT",
  NOT_A_GIT_REPOSITORY: "NOT_GIT_REPOSITORY",
  REPOSITORY_IDENTITY_AMBIGUOUS: "GIT_STATE_AMBIGUOUS",
  WORKTREE_IDENTITY_AMBIGUOUS: "GIT_STATE_AMBIGUOUS",
  DETACHED_HEAD: "DETACHED_HEAD",
  MISSING_WORKTREE: "MISSING_WORKTREE",
  REPOSITORY_MISMATCH: "REPOSITORY_MISMATCH",
  WORKTREE_MISMATCH: "WORKTREE_MISMATCH",
  BRANCH_MISMATCH: "BRANCH_MISMATCH",
  STALE_REGISTRY: "STALE_REGISTRY",
  STALE_CLAIM_SET: "STALE_CLAIM_SET",
  GIT_STATE_AMBIGUOUS: "GIT_STATE_AMBIGUOUS",
  PHYSICAL_OBSERVATION_UNAVAILABLE: "PHYSICAL_OBSERVATION_UNAVAILABLE",
  INVALID_SESSION_ID: "INVALID_SESSION_ID",
  INVALID_SESSION_RECORD: "INVALID_REGISTRY",
  INVALID_BRANCH_ID: "INVALID_BRANCH",
  INVALID_WORKTREE_PATH: "INVALID_WORKTREE",
  INVALID_BASE_REF: "INVALID_BASE_REF",
  REGISTRY_CORRUPT: "REGISTRY_CORRUPT",
  UNSUPPORTED_SCHEMA_VERSION: "REGISTRY_CORRUPT",
  REGISTRY_REPOSITORY_MISMATCH: "INVALID_REGISTRY",
  DUPLICATE_SESSION_ID: "OPERATION_REJECTED",
  DUPLICATE_WORKTREE_OWNERSHIP: "WORKTREE_OWNED_BY_OTHER_SESSION",
  DUPLICATE_BRANCH_OWNERSHIP: "BRANCH_OWNED_BY_OTHER_SESSION",
  WORKTREE_ALREADY_EXISTS: "WORKTREE_ALREADY_EXISTS",
  BRANCH_ALREADY_EXISTS: "BRANCH_ALREADY_EXISTS",
  PROTECTED_WORKTREE: "PROTECTED_WORKTREE",
  PROTECTED_BRANCH: "PROTECTED_BRANCH",
  SESSION_ID_COLLISION: "OPERATION_REJECTED",
  SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  DIRTY_WORKTREE: "DIRTY_WORKTREE",
  NESTED_REPOSITORY: "NESTED_REPOSITORY",
  OWNERSHIP_MISMATCH: "OWNERSHIP_MISMATCH",
  RECOVERABLE_COMMITS: "RECOVERABLE_COMMITS",
  RECOVERABLE_STASHES: "RECOVERABLE_STASHES",
  RECONCILIATION_DRIFT: "RECONCILIATION_DRIFT",
  REGISTRY_LOCK_TIMEOUT: "LOCK_CONTENTION",
  REGISTRY_IO_FAILURE: "REGISTRY_UNREADABLE",
  REGISTRY_DURABILITY_UNCERTAIN: "REGISTRY_DURABILITY_UNCERTAIN",
  INVALID_CLAIM: "INVALID_CLAIM",
  INVALID_OPERATION: "INVALID_OPERATION",
  OPERATION_REJECTED: "OPERATION_REJECTED",
  INVALID_RESOURCE: "INVALID_RESOURCE",
  MISSING_RESOURCE_CLAIM: "MISSING_RESOURCE_CLAIM",
  INSUFFICIENT_CLAIM_MODE: "INSUFFICIENT_CLAIM_MODE",
  INVALID_CLAIM_RESOURCE: "INVALID_CLAIM_RESOURCE",
  CLAIM_PATH_TRAVERSAL: "CLAIM_PATH_TRAVERSAL",
  CLAIM_SYMLINK_ESCAPE: "CLAIM_SYMLINK_ESCAPE",
  CLAIM_AMBIGUOUS_PATH: "CLAIM_AMBIGUOUS_PATH",
  UNSUPPORTED_CLAIM_GLOB: "UNSUPPORTED_CLAIM_GLOB",
  CLAIM_REPOSITORY_MISMATCH: "CLAIM_REPOSITORY_MISMATCH",
  CLAIM_SESSION_MISMATCH: "CLAIM_SESSION_MISMATCH",
  DUPLICATE_CLAIM: "DUPLICATE_CLAIM",
  CONTRADICTORY_CLAIM: "CONTRADICTORY_CLAIM",
  RESOURCE_CLAIM_CONFLICT: "RESOURCE_CLAIM_CONFLICT",
  CLAIM_NOT_FOUND: "CLAIM_NOT_FOUND",
  SESSION_NOT_ACTIVE: "SESSION_NOT_ACTIVE",
  UNSUPPORTED_CLAIM_SCHEMA_VERSION: "UNSUPPORTED_CLAIM_SCHEMA_VERSION",
  INVALID_COMMIT_MESSAGE: "INVALID_COMMIT_MESSAGE",
  COMMIT_EMPTY_DIFF: "COMMIT_EMPTY_DIFF",
  UNEXPECTED_CHANGED_PATHS: "UNEXPECTED_CHANGED_PATHS",
  COMMIT_STAGING_FAILED: "COMMIT_STAGING_FAILED",
  COMMIT_FAILED: "COMMIT_FAILED",
  COMMIT_RESULT_UNAVAILABLE: "COMMIT_RESULT_UNAVAILABLE",
  COMMIT_RESULT_DIVERGED: "COMMIT_RESULT_DIVERGED",
  INVALID_REMOTE: "INVALID_REMOTE",
  INVALID_REMOTE_BRANCH: "INVALID_REMOTE_BRANCH",
  PUSH_TARGET_MISMATCH: "PUSH_TARGET_MISMATCH",
  PUSH_REMOTE_INSPECTION_FAILED: "PUSH_REMOTE_INSPECTION_FAILED",
  INTEGRATION_FETCH_FAILED: "INTEGRATION_FETCH_FAILED",
  PUSH_NO_UPSTREAM: "PUSH_NO_UPSTREAM",
  PUSH_BEHIND: "PUSH_BEHIND",
  PUSH_DIVERGED: "PUSH_DIVERGED",
  PUSH_DIRTY_WORKTREE: "PUSH_DIRTY_WORKTREE",
  PUSH_FAILED: "PUSH_FAILED",
});

/** SessionBackend implementation backed only by the local Git repository. */
export class LocalSessionBackend implements SessionBackend {
  private readonly git: SessionRegistryOptions["git"];
  private readonly registryOptions: Omit<SessionRegistryOptions, "cwd" | "git">;

  public constructor(options: LocalSessionBackendOptions = {}) {
    this.git = options.git;
    this.registryOptions = options.registry ?? {};
  }

  public async createSession(
    context: SessionContext,
    options: SessionCreateOptions,
  ): Promise<DomainResult<SessionRecord>> {
    try {
      const registry = this.registryFor(context);
      const record = registry.provision({
        branchName: options.branch ?? undefined,
        worktreePath: options.worktree ?? undefined,
        worktreeRoot: options.worktree_root ?? undefined,
        label: options.label ?? undefined,
        baseRef: options.base ?? undefined,
      });
      return success(toDomainRecord(record));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async resolveCurrentSession(context: SessionContext): Promise<DomainResult<SessionRecord>> {
    try {
      return success(toDomainRecord(this.registryFor(context).resolveCurrentSession()));
    } catch (error: unknown) {
      return failure(toDomainError(error, "NO_CURRENT_SESSION"));
    }
  }

  public async getSession(context: SessionContext, sessionId: string): Promise<DomainResult<SessionRecord>> {
    try {
      const record = this.registryFor(context).get(sessionId);
      if (record === undefined) {
        return failure(
          new DomainError("SESSION_NOT_FOUND", `Session was not found: ${sessionId}`, { session_id: sessionId }),
        );
      }
      return success(toDomainRecord(record));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async guard(context: SessionContext, options: GuardOptions): Promise<DomainResult<GuardDecision>> {
    try {
      return success(toDomainGuardDecision(this.registryFor(context).guard({ sessionId: options.session_id })));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async authorizeOperation(
    context: SessionContext,
    options: OperationAuthorizationOptions,
  ): Promise<DomainResult<OperationAuthorizationDecision>> {
    try {
      return success(
        toDomainOperationAuthorizationDecision(
          this.registryFor(context).authorizeOperation({
            operation: options.operation,
            resources: options.resources,
            sessionId: options.session_id,
          }),
        ),
      );
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async checkpoint(
    context: SessionContext,
    options: CheckpointOptions,
  ): Promise<DomainResult<CheckpointEvidence>> {
    try {
      return success(
        toDomainCheckpointEvidence(
          this.registryFor(context).checkpoint({
            sessionId: options.session_id,
          }),
        ),
      );
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async repositoryEvidence(
    context: SessionContext,
    options: RepositoryEvidenceOptions,
  ): Promise<DomainResult<RepositoryEvidence>> {
    try {
      return success(
        toDomainRepositoryEvidence(this.registryFor(context).repositoryEvidence({ sessionId: options.session_id })),
      );
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async repositoryDiff(
    context: SessionContext,
    options: RepositoryDiffOptions,
  ): Promise<DomainResult<RepositoryDiffEvidence>> {
    try {
      return success(
        toDomainRepositoryDiff(
          this.registryFor(context).repositoryDiff({
            sessionId: options.session_id,
            paths: options.paths,
            from: options.from ?? undefined,
            to: options.to ?? undefined,
            includePatch: options.include_patch,
            maxBytes: options.max_bytes ?? undefined,
            maxHunks: options.max_hunks ?? undefined,
          }),
        ),
      );
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async commit(context: SessionContext, options: CommitOptions): Promise<DomainResult<CommitResult>> {
    try {
      const result = this.registryFor(context).commit({
        sessionId: options.session_id,
        message: options.message,
        resources: options.resources,
        messagePattern: options.message_pattern,
      });
      return success(toDomainCommitResult(result));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async push(context: SessionContext, options: PushOptions): Promise<DomainResult<PushResult>> {
    try {
      const result = this.registryFor(context).push({
        sessionId: options.session_id,
        resources: options.resources,
        remote: options.remote,
        branch: options.branch,
        force: options.force,
        createUpstream: options.create_upstream,
      });
      return success(toDomainPushResult(result));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async listSessions(
    context: SessionContext,
    options: SessionListOptions = {},
  ): Promise<DomainResult<SessionListResult>> {
    try {
      const records = this.registryFor(context).list().map(toDomainRecord);
      return success(boundedSessionListing(records, options));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async status(context: SessionContext, options: SessionListOptions = {}): Promise<DomainResult<StatusResult>> {
    try {
      const registry = this.registryFor(context);
      let currentSession: SessionRecord | null = null;
      try {
        currentSession = toDomainRecord(registry.resolveCurrentSession());
      } catch (error: unknown) {
        if (!isSessionRegistryError(error) || error.code !== "SESSION_NOT_FOUND") throw error;
      }
      const listing = boundedSessionListing(registry.list().map(toDomainRecord), options);
      return success({
        repository: registry.repository.repositoryId,
        current_session: currentSession,
        ...listing,
        capabilities: { ...LOCAL_SESSION_CAPABILITIES },
        managed_worktree_root: registry.managedWorktreeRoot,
      });
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public closeSession(
    context: SessionContext,
    options: SessionCloseOptions,
  ): Promise<DomainResult<SessionCloseResult>> {
    try {
      const registry = this.registryFor(context);
      const sessionId = options.session_id ?? registry.resolveCurrentSession().sessionId;
      const result = registry.close({
        sessionId,
        integratedRevision: options.integrated_revision ?? undefined,
        fetchRemote: options.fetch_remote ?? undefined,
        fetchBranch: options.fetch_branch ?? undefined,
      });
      return Promise.resolve(
        success({
          session: toDomainRecord(result.session),
          worktree_removed: result.worktreeRemoved,
          branch_removed: result.branchRemoved,
          idempotent: result.idempotent,
          claim_set_generation: result.claimSetGeneration,
          ...(result.integrationProof === undefined
            ? {}
            : {
                integration_proof: toDomainIntegrationProof(result.integrationProof),
              }),
        }),
      );
    } catch (error: unknown) {
      return Promise.resolve(failure(toDomainError(error, "NO_CURRENT_SESSION")));
    }
  }

  public discardSession(context: SessionContext, sessionId: string): Promise<DomainResult<SessionDiscardResult>> {
    try {
      const result = this.registryFor(context).discard({ sessionId });
      return Promise.resolve(success(toDomainSessionDiscardResult(result)));
    } catch (error: unknown) {
      return Promise.resolve(failure(toDomainError(error)));
    }
  }

  public sessionDiagnostic(
    context: SessionContext,
    options: SessionDiagnosticOptions,
  ): Promise<DomainResult<SessionDiagnostic>> {
    try {
      const registry = this.registryFor(context);
      const sessionId = options.session_id ?? registry.resolveCurrentSession().sessionId;
      const diagnostic = registry.diagnose({
        sessionId,
        integratedRevision: options.integrated_revision ?? undefined,
      });
      return Promise.resolve(success(toDomainSessionDiagnostic(diagnostic)));
    } catch (error: unknown) {
      return Promise.resolve(failure(toDomainError(error, "NO_CURRENT_SESSION")));
    }
  }

  public garbageCollect(
    context: SessionContext,
    options: GarbageCollectOptions,
  ): Promise<DomainResult<GarbageCollectResult>> {
    try {
      const result = this.registryFor(context).garbageCollect({ apply: options.apply });
      return Promise.resolve(success(toDomainGarbageCollectResult(result)));
    } catch (error: unknown) {
      return Promise.resolve(failure(toDomainError(error)));
    }
  }

  public async claimResources(
    context: SessionContext,
    options: ClaimResourcesOptions,
  ): Promise<DomainResult<ClaimResourcesResult>> {
    try {
      const result = this.registryFor(context).claimResources({
        sessionId: options.session_id ?? undefined,
        repositoryId: options.repository ?? undefined,
        claims: options.claims.map(toRegistryClaimInput),
      });
      return success(toDomainClaimResult(result));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async updateClaims(
    context: SessionContext,
    options: UpdateClaimsOptions,
  ): Promise<DomainResult<ClaimResourcesResult>> {
    try {
      const result = this.registryFor(context).updateClaims({
        sessionId: options.session_id ?? undefined,
        repositoryId: options.repository ?? undefined,
        claims: options.claims.map(toRegistryClaimInput),
        expectedClaimSetGeneration: options.expected_claim_set_generation ?? undefined,
        force: options.force === true,
      });
      return success(toDomainClaimResult(result));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async applyClaimDeltas(
    context: SessionContext,
    options: ClaimDeltasOptions,
  ): Promise<DomainResult<ClaimDeltasResult>> {
    try {
      const result = this.registryFor(context).applyClaimDeltas({
        sessionId: options.session_id ?? undefined,
        repositoryId: options.repository ?? undefined,
        deltas: options.deltas,
        expectedClaimSetGeneration: options.expected_claim_set_generation ?? undefined,
        force: options.force === true,
      });
      return success(toDomainClaimDeltasResult(result));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async releaseClaims(
    context: SessionContext,
    options: ReleaseClaimsOptions,
  ): Promise<DomainResult<ReleaseClaimsResult>> {
    try {
      const result = this.registryFor(context).releaseClaims({
        sessionId: options.session_id ?? undefined,
        resources: options.resources ?? undefined,
        claimIds: options.claim_ids ?? undefined,
        all: options.all === true,
        expectedClaimSetGeneration: options.expected_claim_set_generation ?? undefined,
        force: options.force === true,
      });
      return success({
        session_id: result.sessionId,
        released: result.released.map(toDomainClaim),
        remaining: result.remaining.map(toDomainClaim),
        idempotent: result.idempotent,
        claim_set_generation: result.claimSetGeneration,
      });
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async listClaims(
    context: SessionContext,
    sessionId: string | null,
  ): Promise<DomainResult<{ claims: ResourceClaim[]; claim_set_generation: number }>> {
    try {
      const snapshot = this.registryFor(context).listClaimsSnapshot(sessionId);
      return success({
        claims: snapshot.claims.map(toDomainClaim),
        claim_set_generation: snapshot.claimSetGeneration,
      });
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  /** Explicitly migrate legacy claim state through the registry authority. */
  public async migrate(context: SessionContext): Promise<DomainResult<RegistryMigrationResult>> {
    try {
      const result = this.registryFor(context).migrate();
      return success({
        migrated: result.migrated,
        registry_schema_version: result.registrySchemaVersion,
        claim_schema_version: result.claimSchemaVersion,
      });
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  private registryFor(context: SessionContext): SessionRegistry {
    return new SessionRegistry({ ...this.registryOptions, cwd: context.cwd, git: this.git });
  }
}

export function createLocalSessionBackend(options: LocalSessionBackendOptions = {}): SessionBackend {
  return new LocalSessionBackend(options);
}

function toDomainRecord(record: RegistrySessionRecord): SessionRecord {
  return {
    schema_version: record.schemaVersion,
    session_id: record.sessionId,
    repository: record.repositoryId,
    worktree: record.worktreePath,
    worktree_root: path.dirname(record.worktreePath),
    branch: record.branchName,
    state: record.state,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ...(record.baseRevision === undefined ? {} : { base_revision: record.baseRevision }),
    ...(record.label === undefined ? {} : { label: record.label }),
    ...(record.terminalOperation === undefined ? {} : { terminal_operation: record.terminalOperation }),
    ...(record.discardedHead === undefined ? {} : { discarded_head: record.discardedHead }),
  };
}

function toDomainGuardDecision(decision: import("../session-registry.js").GuardDecision): GuardDecision {
  return {
    allowed: decision.allowed,
    code: decision.code === "ALLOWED" ? "ALLOWED" : REGISTRY_ERROR_CODE_MAP[decision.code],
    repository: decision.repositoryId,
    worktree: decision.worktreePath,
    branch: decision.branchName,
    session_id: decision.sessionId,
    owner_session_id: decision.ownerSessionId,
    requested_session_id: decision.requestedSessionId,
    state: decision.state,
    details: { ...decision.details },
  };
}

function toDomainOperationAuthorizationDecision(
  decision: import("../session-registry.js").OperationAuthorizationDecision,
): OperationAuthorizationDecision {
  return {
    schema_version: decision.schemaVersion,
    allowed: decision.allowed,
    code:
      decision.code === "ALLOWED"
        ? "ALLOWED"
        : (REGISTRY_ERROR_CODE_MAP[decision.code as RegistryErrorCode] ?? "OPERATION_REJECTED"),
    operation: decision.operation,
    required_access: decision.requiredAccess,
    repository: decision.repositoryId,
    worktree: decision.worktreePath,
    branch: decision.branchName,
    session_id: decision.sessionId,
    owner_session_id: decision.ownerSessionId,
    requested_session_id: decision.requestedSessionId,
    state: decision.state,
    resources: decision.resources.map((resource) => ({
      resource: resource.resource,
      claim_ids: [...resource.claimIds],
    })),
    details: Object.fromEntries(
      Object.entries(decision.details).map(([key, value]) => [key, Array.isArray(value) ? [...value] : value]),
    ) as JsonObject,
  };
}

function toDomainCheckpointEvidence(
  evidence: import("../operation-authorization.js").CheckpointEvidence,
): CheckpointEvidence {
  return {
    schema_version: evidence.schemaVersion,
    source: evidence.source,
    guarantee: evidence.guarantee,
    repository: evidence.repositoryId,
    worktree: evidence.worktreePath,
    branch: evidence.branchName,
    head: evidence.headId,
    session_id: evidence.sessionId,
    paths: {
      changed: [...evidence.paths.changed],
      staged: [...evidence.paths.staged],
      unstaged: [...evidence.paths.unstaged],
      untracked: [...evidence.paths.untracked],
    },
    in_claim: [...evidence.inClaim],
    out_of_claim: [...evidence.outOfClaim],
    max_paths: evidence.maxPaths,
  };
}

function toDomainRepositoryEvidence(
  evidence: import("../repository-evidence.js").RepositoryEvidenceSnapshot,
): RepositoryEvidence {
  return {
    schema_version: evidence.schemaVersion,
    source: evidence.source,
    guarantee: evidence.guarantee,
    repository: evidence.repositoryId,
    worktree: evidence.worktreePath,
    branch_id: evidence.branchId,
    branch: evidence.branchName,
    session_id: evidence.sessionId,
    session_state: evidence.sessionState as RepositoryEvidence["session_state"],
    session_created_at: evidence.sessionCreatedAt,
    session_updated_at: evidence.sessionUpdatedAt,
    base_revision: evidence.baseRevision,
    base_revision_proven: evidence.baseRevisionProven,
    head: evidence.headId,
    clean: evidence.clean,
    complete: evidence.complete,
    incomplete_reasons: [...evidence.incompleteReasons],
    paths: {
      changed: [...evidence.paths.changed],
      staged: [...evidence.paths.staged],
      unstaged: [...evidence.paths.unstaged],
      untracked: [...evidence.paths.untracked],
      stats: evidence.paths.stats.map((stat) => ({ ...stat })),
    },
    evidence_hash: evidence.evidenceHash,
    bounds: {
      max_paths: evidence.bounds.maxPaths,
      max_diff_paths: evidence.bounds.maxDiffPaths,
      max_diff_bytes: evidence.bounds.maxDiffBytes,
      max_diff_hunks: evidence.bounds.maxDiffHunks,
    },
  };
}

function toDomainRepositoryDiff(
  evidence: import("../repository-evidence.js").RepositoryDiffEvidence,
): RepositoryDiffEvidence {
  return {
    schema_version: evidence.schemaVersion,
    source: evidence.source,
    guarantee: evidence.guarantee,
    repository: evidence.repositoryId,
    worktree: evidence.worktreePath,
    branch_id: evidence.branchId,
    branch: evidence.branchName,
    session_id: evidence.sessionId,
    session_state: evidence.sessionState as RepositoryDiffEvidence["session_state"],
    head: evidence.headId,
    from_revision: evidence.fromRevision,
    to_revision: evidence.toRevision,
    paths: [...evidence.paths],
    stats: evidence.stats.map((stat) => ({ ...stat })),
    complete: evidence.complete,
    incomplete_reasons: [...evidence.incompleteReasons],
    patch: evidence.patch,
    patch_bytes: evidence.patchBytes,
    hunk_count: evidence.hunkCount,
    max_bytes: evidence.maxBytes,
    max_hunks: evidence.maxHunks,
    evidence_hash: evidence.evidenceHash,
  };
}

function toDomainCommitResult(result: import("../session-registry.js").CommitResult): CommitResult {
  return {
    schema_version: result.schemaVersion,
    commit_sha: result.commitSha,
    message: result.message,
    resources: [...result.resources],
    ...(result.reconciliation === undefined
      ? {}
      : {
          reconciliation: {
            outcome: result.reconciliation.outcome,
            retry_safe: result.reconciliation.retrySafe,
            expected_head: result.reconciliation.expectedHead,
            observed_head: result.reconciliation.observedHead,
            expected_resources: [...result.reconciliation.expectedResources],
            observed_resources: [...result.reconciliation.observedResources],
          },
        }),
  };
}

function toDomainPushResult(result: import("../session-registry.js").PushResult): PushResult {
  return {
    schema_version: result.schemaVersion,
    source_sha: result.sourceSha,
    remote: result.remote,
    branch: result.branch,
    target: result.target,
    target_ref: result.targetRef,
    observed_remote_sha: result.observedRemoteSha,
    relation: result.relation,
    force: result.force,
    upstream_created: result.upstreamCreated,
  };
}

function toDomainGarbageCollectResult(result: RegistryGarbageCollectResult): GarbageCollectResult {
  return {
    apply: result.apply,
    candidates: result.candidates.map(toDomainGarbageCollectCandidate),
    eligible: result.eligible?.map(toDomainGarbageCollectCandidate) ?? [],
    cleaned: result.cleaned.map(toDomainRecord),
    blocked: result.blocked.map((blocked) => ({
      session_id: blocked.sessionId,
      code: REGISTRY_ERROR_CODE_MAP[blocked.code],
      message: blocked.message,
      details: { ...blocked.details },
      recovery_hints: [...blocked.recoveryHints],
    })),
  };
}

function toDomainGarbageCollectCandidate(
  candidate: import("../session-registry.js").GarbageCollectCandidate,
): import("./session.js").GarbageCollectCandidate {
  return {
    ...toDomainRecord(candidate),
    physical_state: candidate.physicalState,
    suspicion: candidate.suspicion,
    suspicion_reason: candidate.suspicionReason,
    destructive_eligibility: candidate.destructiveEligibility,
    destructive_eligibility_reason: candidate.destructiveEligibilityReason,
  };
}

function toDomainSessionDiagnostic(diagnostic: import("../session-registry.js").SessionDiagnostic): SessionDiagnostic {
  return {
    schema_version: diagnostic.schemaVersion,
    session_id: diagnostic.session.sessionId,
    repository: diagnostic.repositoryId,
    worktree: diagnostic.worktreePath,
    branch: diagnostic.branchName,
    session: toDomainRecord(diagnostic.session),
    claims: diagnostic.claims.map(toDomainClaim),
    physical_state: diagnostic.physicalState,
    close_readiness: diagnostic.closeReadiness,
    cleanup_readiness: diagnostic.cleanupReadiness,
    result_state: diagnostic.resultState,
    idempotent: diagnostic.idempotent,
    blockers: diagnostic.blockers.map((blocker) => ({
      code: REGISTRY_ERROR_CODE_MAP[blocker.code],
      message: blocker.message,
      details: { ...blocker.details },
      safe_actions: [...blocker.safeActions],
    })),
    safe_actions: [...diagnostic.safeActions],
    integration_evidence: {
      supplied: diagnostic.integrationEvidence.supplied,
      ...(diagnostic.integrationEvidence.integratedRevision === undefined
        ? {}
        : { integrated_revision: diagnostic.integrationEvidence.integratedRevision }),
      ...(diagnostic.integrationEvidence.proof === undefined
        ? {}
        : {
            proof: toDomainIntegrationProof(diagnostic.integrationEvidence.proof),
          }),
    },
    ...(diagnostic.lifecycle === undefined
      ? {}
      : {
          lifecycle_state: diagnostic.lifecycle.state,
          lifecycle: {
            schema_version: diagnostic.lifecycle.schemaVersion,
            state: diagnostic.lifecycle.state,
            session_state: diagnostic.lifecycle.sessionState,
            physical_state: diagnostic.lifecycle.physicalState,
            close_readiness: diagnostic.lifecycle.closeReadiness,
            blockers: diagnostic.lifecycle.blockers.map((blocker) => ({
              code: blocker.code,
              ...(blocker.classification === undefined ? {} : { classification: blocker.classification }),
            })),
            recoverability: diagnostic.lifecycle.recoverability,
            age_suspicious: diagnostic.lifecycle.ageSuspicious,
            gc_authorized: diagnostic.lifecycle.gcAuthorized,
            destructive_cleanup_eligible: diagnostic.lifecycle.destructiveCleanupEligible,
            transitions: diagnostic.lifecycle.transitions.map((transition) => ({ ...transition })),
          },
        }),
    garbage_collection: toDomainGarbageCollectCandidate(diagnostic.garbageCollection),
  };
}

function toDomainSessionDiscardResult(
  result: import("../session-registry.js").DiscardSessionResult,
): SessionDiscardResult {
  return {
    schema_version: result.schemaVersion,
    operation: result.operation,
    session: toDomainRecord(result.session),
    final_state: result.finalState,
    previous_head: result.previousHead,
    worktree_path: result.worktreePath,
    branch_name: result.branchName,
    worktree_removed: result.worktreeRemoved,
    branch_removed: result.branchRemoved,
    released_claims: result.releasedClaims.map(toDomainClaim),
    released_claim_count: result.releasedClaimCount,
    released_claims_truncated: result.releasedClaimsTruncated,
    idempotent: result.idempotent,
    claim_set_generation: result.claimSetGeneration,
  };
}

function toDomainIntegrationProof(proof: import("../session-registry.js").IntegrationProof): DomainIntegrationProof {
  return {
    method: proof.method,
    ...(proof.integratedRevision === undefined ? {} : { integrated_revision: proof.integratedRevision }),
    ...(proof.lineage === undefined
      ? {}
      : {
          lineage: {
            method: proof.lineage.method,
            integration_branch: proof.lineage.integrationBranch,
            integrated_revision: proof.lineage.integratedRevision,
          },
        }),
    ...(proof.content === undefined ? {} : { content: { method: proof.content.method } }),
  };
}

function toRegistryClaimInput(
  input: import("./session.js").ResourceClaimInput,
): import("../resource-claims.js").ResourceClaimInput {
  return {
    resource: input.resource,
    mode: input.mode,
    ...(input.repository === null || input.repository === undefined ? {} : { repositoryId: input.repository }),
    ...(input.session_id === null || input.session_id === undefined ? {} : { sessionId: input.session_id }),
    ...(input.worktree === null || input.worktree === undefined ? {} : { worktreePath: input.worktree }),
  };
}

function toDomainClaimResult(result: import("../session-registry.js").ClaimResourcesResult): ClaimResourcesResult {
  return {
    session: toDomainRecord(result.session),
    claims: result.claims.map(toDomainClaim),
    added: result.added.map(toDomainClaim),
    released: result.released.map(toDomainClaim),
    idempotent: result.idempotent,
    claim_set_generation: result.claimSetGeneration,
  };
}

function toDomainClaimDeltasResult(
  result: import("../session-registry.js").ClaimDeltasResult,
): import("./session.js").ClaimDeltasResult {
  return {
    session: toDomainRecord(result.session),
    claims: result.claims.map(toDomainClaim),
    previous_claim_set_generation: result.previousClaimSetGeneration,
    claim_set_generation: result.claimSetGeneration,
    added: result.added.map(toDomainClaim),
    changed: result.changed.map((change) => ({
      resource: change.resource,
      before: toDomainClaim(change.before),
      after: toDomainClaim(change.after),
    })),
    released: result.released.map(toDomainClaim),
    unchanged: result.unchanged.map((delta) =>
      delta.kind === "upsert"
        ? { kind: delta.kind, resource: delta.resource, claim: toDomainClaim(delta.claim) }
        : { kind: delta.kind, resource: delta.resource },
    ),
    idempotent: result.idempotent,
  };
}

function toDomainClaim(claim: RegistryResourceClaim): ResourceClaim {
  return {
    schema_version: claim.schemaVersion,
    claim_id: claim.claimId,
    session_id: claim.sessionId,
    repository: claim.repositoryId,
    worktree: claim.worktreePath,
    resource: claim.resource,
    mode: claim.mode,
    created_at: claim.createdAt,
    updated_at: claim.updatedAt,
  };
}

function toDomainError(error: unknown, fallbackCode?: ErrorCode): DomainError {
  if (!isSessionRegistryError(error)) {
    const cause = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return new DomainError(
      "INTERNAL_ERROR",
      "An unexpected local session operation error occurred.",
      { cause },
      undefined,
      error,
    );
  }

  const details: JsonObject = { ...error.details };
  const code = domainErrorCode(error, fallbackCode);
  return new DomainError(code, error.message, details);
}

function domainErrorCode(error: SessionRegistryError, fallbackCode?: ErrorCode): ErrorCode {
  if (error.code === "SESSION_NOT_FOUND" && fallbackCode !== undefined) return fallbackCode;
  return REGISTRY_ERROR_CODE_MAP[error.code];
}
