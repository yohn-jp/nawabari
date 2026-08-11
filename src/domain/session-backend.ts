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
  type ClaimResourcesOptions,
  type ClaimResourcesResult,
  type GarbageCollectOptions,
  type GarbageCollectResult,
  type GuardDecision,
  type GuardOptions,
  type SessionBackend,
  type SessionCloseOptions,
  type SessionCloseResult,
  type SessionContext,
  type SessionCreateOptions,
  type SessionListResult,
  type SessionRecord,
  type ReleaseClaimsOptions,
  type ReleaseClaimsResult,
  type ResourceClaim,
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
});

const REGISTRY_ERROR_CODE_MAP: Readonly<Record<RegistryErrorCode, ErrorCode>> = Object.freeze({
  GIT_COMMAND_FAILED: "GIT_OPERATION_FAILED",
  NOT_A_GIT_REPOSITORY: "NOT_GIT_REPOSITORY",
  REPOSITORY_IDENTITY_AMBIGUOUS: "NOT_GIT_REPOSITORY",
  WORKTREE_IDENTITY_AMBIGUOUS: "INVALID_WORKTREE",
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
  OWNERSHIP_MISMATCH: "OWNERSHIP_MISMATCH",
  RECOVERABLE_COMMITS: "RECOVERABLE_COMMITS",
  REGISTRY_LOCK_TIMEOUT: "LOCK_CONTENTION",
  REGISTRY_IO_FAILURE: "REGISTRY_UNREADABLE",
  INVALID_CLAIM: "INVALID_CLAIM",
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

  public async listSessions(context: SessionContext): Promise<DomainResult<SessionListResult>> {
    try {
      return success({ sessions: this.registryFor(context).list().map(toDomainRecord) });
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async status(context: SessionContext): Promise<DomainResult<StatusResult>> {
    try {
      const registry = this.registryFor(context);
      let currentSession: SessionRecord | null = null;
      try {
        currentSession = toDomainRecord(registry.resolveCurrentSession());
      } catch (error: unknown) {
        if (!isSessionRegistryError(error) || error.code !== "SESSION_NOT_FOUND") throw error;
      }
      return success({
        repository: registry.repository.repositoryId,
        current_session: currentSession,
        sessions: registry.list().map(toDomainRecord),
        capabilities: { ...LOCAL_SESSION_CAPABILITIES },
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
      const result = registry.close(sessionId);
      return Promise.resolve(
        success({
          session: toDomainRecord(result.session),
          worktree_removed: result.worktreeRemoved,
          branch_removed: result.branchRemoved,
          idempotent: result.idempotent,
        }),
      );
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
      });
      return success(toDomainClaimResult(result));
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
        claimIds: options.claim_ids ?? undefined,
      });
      return success({
        session_id: result.sessionId,
        released: result.released.map(toDomainClaim),
        remaining: result.remaining.map(toDomainClaim),
        idempotent: result.idempotent,
      });
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async listClaims(
    context: SessionContext,
    sessionId: string | null,
  ): Promise<DomainResult<{ claims: ResourceClaim[] }>> {
    try {
      return success({ claims: this.registryFor(context).listClaims(sessionId).map(toDomainClaim) });
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
    branch: record.branchName,
    state: record.state,
    created_at: record.createdAt,
    updated_at: record.updatedAt,
    ...(record.label === undefined ? {} : { label: record.label }),
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

function toDomainGarbageCollectResult(result: RegistryGarbageCollectResult): GarbageCollectResult {
  return {
    apply: result.apply,
    candidates: result.candidates.map(toDomainRecord),
    cleaned: result.cleaned.map(toDomainRecord),
    blocked: result.blocked.map((blocked) => ({
      session_id: blocked.sessionId,
      code: REGISTRY_ERROR_CODE_MAP[blocked.code],
      message: blocked.message,
      details: { ...blocked.details },
    })),
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
