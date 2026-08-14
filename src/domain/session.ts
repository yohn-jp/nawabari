import { DomainError, type DomainResult, failure, type ErrorCode, type JsonObject } from "./errors.js";

export type { OperationName } from "../operation-authorization.js";

export type SessionState = "new" | "active" | "closing" | "closed" | "stale";

export type SessionRecord = {
  schema_version: number;
  session_id: string;
  repository: string;
  worktree: string;
  branch: string;
  state: SessionState;
  created_at: string;
  updated_at: string;
  base_revision?: string;
  label?: string;
};

export type SessionContext = {
  cwd: string;
};

export type SessionCreateOptions = {
  branch: string | null;
  worktree: string | null;
  label: string | null;
  base?: string | null;
};

export type ResourceClaimMode = "read" | "write" | "exclusive-write";

export type ResourceClaim = {
  schema_version: number;
  claim_id: string;
  session_id: string;
  repository: string;
  worktree: string;
  resource: string;
  mode: ResourceClaimMode;
  created_at: string;
  updated_at: string;
};

export type ResourceClaimInput = {
  resource: string;
  mode: ResourceClaimMode;
  repository?: string | null;
  session_id?: string | null;
  worktree?: string | null;
};

export type ClaimResourcesOptions = {
  session_id: string | null;
  claims: ResourceClaimInput[];
  repository?: string | null;
};

export type UpdateClaimsOptions = ClaimResourcesOptions;

export type ReleaseClaimsOptions = {
  session_id: string | null;
  claim_ids?: string[] | null;
};

export type ClaimResourcesResult = {
  session: SessionRecord;
  claims: ResourceClaim[];
  added: ResourceClaim[];
  released: ResourceClaim[];
  idempotent: boolean;
};

export type ReleaseClaimsResult = {
  session_id: string;
  released: ResourceClaim[];
  remaining: ResourceClaim[];
  idempotent: boolean;
};

export type SessionCloseOptions = {
  session_id: string | null;
};

export type GuardOptions = {
  session_id: string | null;
};

export type GuardDecision = {
  allowed: boolean;
  code: ErrorCode | "ALLOWED";
  repository: string;
  worktree: string;
  branch: string | null;
  session_id: string | null;
  owner_session_id: string | null;
  requested_session_id: string | null;
  state: SessionState | null;
  details: JsonObject;
};

export type OperationAuthorizationOptions = {
  operation: string;
  resources: string[];
  session_id: string | null;
};

export type AuthorizedResource = {
  resource: string;
  claim_ids: string[];
};

export type OperationAuthorizationDecision = {
  schema_version: number;
  allowed: boolean;
  code: ErrorCode | "ALLOWED";
  operation: string;
  required_access: ResourceClaimMode | null;
  repository: string;
  worktree: string;
  branch: string | null;
  session_id: string | null;
  owner_session_id: string | null;
  requested_session_id: string | null;
  state: string | null;
  resources: AuthorizedResource[];
  details: JsonObject;
};

export type CheckpointOptions = {
  session_id: string | null;
};

export type CheckpointPaths = {
  changed: string[];
  staged: string[];
  unstaged: string[];
  untracked: string[];
};

export type CheckpointEvidence = {
  schema_version: number;
  source: "git";
  guarantee: "git-observable-only";
  repository: string;
  worktree: string;
  branch: string;
  head: string;
  session_id: string;
  paths: CheckpointPaths;
  in_claim: string[];
  out_of_claim: string[];
  max_paths: number;
};

export type RepositoryEvidenceStat = {
  path: string;
  additions: number | null;
  deletions: number | null;
  binary: boolean | null;
  available: boolean;
};

export type RepositoryEvidence = {
  schema_version: number;
  source: "git";
  guarantee: "git-observable-only";
  repository: string;
  worktree: string;
  branch_id: string;
  branch: string;
  session_id: string;
  session_state: SessionState;
  session_created_at: string;
  session_updated_at: string;
  base_revision: string | null;
  base_revision_proven: boolean;
  head: string;
  clean: boolean;
  complete: boolean;
  incomplete_reasons: string[];
  paths: CheckpointPaths & { stats: RepositoryEvidenceStat[] };
  evidence_hash: string;
  bounds: {
    max_paths: number;
    max_diff_paths: number;
    max_diff_bytes: number;
    max_diff_hunks: number;
  };
};

export type RepositoryEvidenceOptions = {
  session_id: string;
};

export type RepositoryDiffOptions = {
  session_id: string;
  paths: string[];
  from?: string | null;
  to?: string | null;
  include_patch: boolean;
  max_bytes?: number | null;
  max_hunks?: number | null;
};

export type RepositoryDiffEvidence = {
  schema_version: number;
  source: "git";
  guarantee: "git-observable-only";
  repository: string;
  worktree: string;
  branch_id: string;
  branch: string;
  session_id: string;
  session_state: SessionState;
  head: string;
  from_revision: string;
  to_revision: string | null;
  paths: string[];
  stats: RepositoryEvidenceStat[];
  complete: boolean;
  incomplete_reasons: string[];
  patch: string | null;
  patch_bytes: number;
  hunk_count: number;
  max_bytes: number;
  max_hunks: number;
  evidence_hash: string;
};

export type CommitOptions = {
  session_id: string | null;
  message: string;
  resources: string[];
  /** Caller-declared commit-message rule; validated only when supplied. */
  message_pattern?: string | null;
};

export type CommitResult = {
  schema_version: number;
  commit_sha: string;
  message: string;
  resources: string[];
};

export type PushOptions = {
  session_id: string | null;
  resources: string[];
  remote: string | null;
  branch: string | null;
  force: boolean;
  create_upstream: boolean;
};

export type PushRelation = "no-upstream" | "up-to-date" | "ahead" | "behind" | "diverged";

export type PushResult = {
  schema_version: number;
  remote: string;
  branch: string;
  target: string;
  relation: PushRelation;
  force: boolean;
  upstream_created: boolean;
};

export type GarbageCollectOptions = {
  apply: boolean;
};

export type BackendCapabilities = {
  session_registry: boolean;
  provisioning: boolean;
  lifecycle: boolean;
  garbage_collection: boolean;
  current_session_resolution: boolean;
  repository_evidence?: boolean;
};

/**
 * Default discovery limits are semantic collection limits, not presentation
 * byte targets. Callers that need more records can page an explicit history
 * request with `offset` and `limit`.
 */
export const DEFAULT_SESSION_LIST_LIMIT = 32 as const;
export const MAX_SESSION_LIST_LIMIT = 128 as const;

export type SessionListOptions = {
  include_closed?: boolean;
  limit?: number;
  offset?: number;
};

export type SessionListResult = {
  sessions: SessionRecord[];
  total?: number;
  returned?: number;
  limit?: number;
  offset?: number;
  truncated?: boolean;
  next_offset?: number | null;
  closed_count?: number;
  history_available?: boolean;
  history_included?: boolean;
};

export type StatusResult = {
  repository: string | null;
  current_session: SessionRecord | null;
  sessions: SessionRecord[];
  capabilities: BackendCapabilities;
  managed_worktree_root?: string | null;
  total?: number;
  returned?: number;
  limit?: number;
  offset?: number;
  truncated?: boolean;
  next_offset?: number | null;
  closed_count?: number;
  history_available?: boolean;
  history_included?: boolean;
};

/** Project a registry collection into the bounded agent-facing listing shape. */
export function boundedSessionListing(
  records: readonly SessionRecord[],
  options: SessionListOptions = {},
): SessionListResult {
  const includeClosed = options.include_closed ?? false;
  const limit = options.limit ?? DEFAULT_SESSION_LIST_LIMIT;
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_SESSION_LIST_LIMIT) {
    throw new RangeError(`session list limit must be an integer from 1 to ${MAX_SESSION_LIST_LIMIT}`);
  }
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new RangeError("session list offset must be a non-negative integer");
  }

  const closedCount = records.reduce((count, record) => count + (record.state === "closed" ? 1 : 0), 0);
  const visible = includeClosed ? [...records] : records.filter((record) => record.state !== "closed");
  const sessions = visible.slice(offset, offset + limit);
  const nextOffset = offset + sessions.length < visible.length ? offset + sessions.length : null;
  return {
    sessions: [...sessions],
    total: visible.length,
    returned: sessions.length,
    limit,
    offset,
    truncated: nextOffset !== null,
    next_offset: nextOffset,
    closed_count: closedCount,
    history_available: !includeClosed && closedCount > 0,
    history_included: includeClosed,
  };
}

export type SessionCloseResult = {
  session: SessionRecord;
  worktree_removed: boolean;
  branch_removed: boolean;
  idempotent?: boolean;
};

export type GarbageCollectBlocked = {
  session_id: string;
  code: ErrorCode;
  message: string;
  details: JsonObject;
  recovery_hints: string[];
};

export type GarbageCollectResult = {
  apply: boolean;
  candidates: SessionRecord[];
  cleaned: SessionRecord[];
  blocked?: GarbageCollectBlocked[];
};

export interface SessionBackend {
  createSession(context: SessionContext, options: SessionCreateOptions): Promise<DomainResult<SessionRecord>>;
  resolveCurrentSession(context: SessionContext): Promise<DomainResult<SessionRecord>>;
  getSession(context: SessionContext, sessionId: string): Promise<DomainResult<SessionRecord>>;
  guard(context: SessionContext, options: GuardOptions): Promise<DomainResult<GuardDecision>>;
  authorizeOperation?(
    context: SessionContext,
    options: OperationAuthorizationOptions,
  ): Promise<DomainResult<OperationAuthorizationDecision>>;
  checkpoint?(context: SessionContext, options: CheckpointOptions): Promise<DomainResult<CheckpointEvidence>>;
  repositoryEvidence?(
    context: SessionContext,
    options: RepositoryEvidenceOptions,
  ): Promise<DomainResult<RepositoryEvidence>>;
  repositoryDiff?(
    context: SessionContext,
    options: RepositoryDiffOptions,
  ): Promise<DomainResult<RepositoryDiffEvidence>>;
  commit?(context: SessionContext, options: CommitOptions): Promise<DomainResult<CommitResult>>;
  push?(context: SessionContext, options: PushOptions): Promise<DomainResult<PushResult>>;
  listSessions(context: SessionContext, options?: SessionListOptions): Promise<DomainResult<SessionListResult>>;
  status(context: SessionContext, options?: SessionListOptions): Promise<DomainResult<StatusResult>>;
  closeSession(context: SessionContext, options: SessionCloseOptions): Promise<DomainResult<SessionCloseResult>>;
  garbageCollect(context: SessionContext, options: GarbageCollectOptions): Promise<DomainResult<GarbageCollectResult>>;
  claimResources?(context: SessionContext, options: ClaimResourcesOptions): Promise<DomainResult<ClaimResourcesResult>>;
  updateClaims?(context: SessionContext, options: UpdateClaimsOptions): Promise<DomainResult<ClaimResourcesResult>>;
  releaseClaims?(context: SessionContext, options: ReleaseClaimsOptions): Promise<DomainResult<ReleaseClaimsResult>>;
  listClaims?(context: SessionContext, sessionId: string | null): Promise<DomainResult<{ claims: ResourceClaim[] }>>;
}

const UNAVAILABLE_CAPABILITIES: BackendCapabilities = {
  session_registry: false,
  provisioning: false,
  lifecycle: false,
  garbage_collection: false,
  current_session_resolution: false,
  repository_evidence: false,
};

export function unavailableCapabilities(): BackendCapabilities {
  return { ...UNAVAILABLE_CAPABILITIES };
}

class UnavailableSessionBackend implements SessionBackend {
  private unavailable<T>(operation: string): Promise<DomainResult<T>> {
    return Promise.resolve(
      failure(
        new DomainError("BACKEND_UNAVAILABLE", "The requested Nawabari session capability is not available.", {
          operation,
          capabilities: unavailableCapabilities(),
        }),
      ),
    );
  }

  createSession(_context: SessionContext, _options: SessionCreateOptions): Promise<DomainResult<SessionRecord>> {
    return this.unavailable("session.create");
  }

  resolveCurrentSession(_context: SessionContext): Promise<DomainResult<SessionRecord>> {
    return this.unavailable("session.resolve_current");
  }

  guard(_context: SessionContext, _options: GuardOptions): Promise<DomainResult<GuardDecision>> {
    return this.unavailable("guard");
  }

  authorizeOperation(
    _context: SessionContext,
    _options: OperationAuthorizationOptions,
  ): Promise<DomainResult<OperationAuthorizationDecision>> {
    return this.unavailable("authorize");
  }

  checkpoint(_context: SessionContext, _options: CheckpointOptions): Promise<DomainResult<CheckpointEvidence>> {
    return this.unavailable("checkpoint");
  }

  getSession(_context: SessionContext, _sessionId: string): Promise<DomainResult<SessionRecord>> {
    return this.unavailable("session.show");
  }

  listSessions(_context: SessionContext): Promise<DomainResult<SessionListResult>> {
    return this.unavailable("session.list");
  }

  status(_context: SessionContext): Promise<DomainResult<StatusResult>> {
    return this.unavailable("status");
  }

  closeSession(_context: SessionContext, _options: SessionCloseOptions): Promise<DomainResult<SessionCloseResult>> {
    return this.unavailable("session.close");
  }

  garbageCollect(
    _context: SessionContext,
    _options: GarbageCollectOptions,
  ): Promise<DomainResult<GarbageCollectResult>> {
    return this.unavailable("gc");
  }
}

export function createUnavailableSessionBackend(): SessionBackend {
  return new UnavailableSessionBackend();
}
