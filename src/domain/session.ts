import { DomainError, type DomainResult, failure, type ErrorCode, type JsonObject } from "./errors.js";

export type { OperationName } from "../operation-authorization.js";

export type SessionState = "new" | "active" | "closing" | "closed" | "stale";

export type SessionRecord = {
  schema_version: number;
  session_id: string;
  repository: string;
  worktree: string;
  worktree_root?: string;
  branch: string;
  state: SessionState;
  created_at: string;
  updated_at: string;
  base_revision?: string;
  label?: string;
  terminal_operation?: "discard";
  discarded_head?: string;
};

export type SessionContext = {
  cwd: string;
};

export type SessionCreateOptions = {
  branch: string | null;
  worktree: string | null;
  worktree_root?: string | null;
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

export type UpdateClaimsOptions = ClaimResourcesOptions & {
  expected_claim_set_generation?: number | null;
  force?: boolean;
};

export type ResourceClaimDelta =
  { kind: "upsert"; resource: string; mode: ResourceClaimMode } | { kind: "release"; resource: string };

export type ClaimDeltasOptions = {
  session_id: string | null;
  deltas: ResourceClaimDelta[];
  repository?: string | null;
  expected_claim_set_generation?: number | null;
  force?: boolean;
};

export type ReleaseClaimsOptions = {
  session_id: string | null;
  /** Exact canonical resources to release; repeatable and mutually exclusive with claim_ids/all. */
  resources?: string[] | null;
  claim_ids?: string[] | null;
  /** Explicitly release every claim owned by the target session. */
  all?: boolean;
  expected_claim_set_generation?: number | null;
  force?: boolean;
};

export type ClaimResourcesResult = {
  session: SessionRecord;
  claims: ResourceClaim[];
  added: ResourceClaim[];
  released: ResourceClaim[];
  idempotent: boolean;
  claim_set_generation: number;
};

export type ReleaseClaimsResult = {
  session_id: string;
  released: ResourceClaim[];
  remaining: ResourceClaim[];
  idempotent: boolean;
  claim_set_generation: number;
};

export type ClaimModeChange = {
  resource: string;
  before: ResourceClaim;
  after: ResourceClaim;
};

export type UnchangedClaimDelta =
  { kind: "upsert"; resource: string; claim: ResourceClaim } | { kind: "release"; resource: string };

export type ClaimDeltasResult = {
  session: SessionRecord;
  claims: ResourceClaim[];
  previous_claim_set_generation: number;
  claim_set_generation: number;
  added: ResourceClaim[];
  changed: ClaimModeChange[];
  released: ResourceClaim[];
  unchanged: UnchangedClaimDelta[];
  idempotent: boolean;
};

export type SessionCloseOptions = {
  session_id: string | null;
  /** Caller-supplied authoritative revision proving non-ancestry integration (e.g. a squash-merge commit). Independently re-verified by exact Git tree-object equivalence; never trusted blindly. */
  integrated_revision?: string | null;
  /** Explicit opt-in remote used only to obtain missing integration-proof objects. */
  fetch_remote?: string | null;
  /** Explicit opt-in integration branch used only to obtain missing proof objects. */
  fetch_branch?: string | null;
};

export type IntegrationProof = {
  method: "ancestor" | "tree-equivalence";
  integrated_revision?: string;
  lineage?: {
    method: "integration-branch-ancestor";
    integration_branch: string;
    integrated_revision: string;
  };
  content?: {
    method: "tree-equivalence";
  };
};

export type SessionDiagnosticOptions = {
  session_id: string | null;
  /** Same non-ancestry integration evidence accepted by session close; independently re-verified, never trusted blindly. */
  integrated_revision?: string | null;
};

/**
 * Explicit close/cleanup readiness states. `external_evidence_required`
 * marks the #123 non-ancestry-integration case rather than a generic
 * permanent blocker. `not_due` only applies to cleanup readiness: the
 * session is safely closable but has not yet met the GC staleness
 * threshold.
 */
export type ReadinessState = "ready" | "not_due" | "blocked" | "external_evidence_required" | "ambiguous";

/** How complete/certain a diagnostic snapshot is, independent of readiness. */
export type DiagnosticCompleteness = "complete" | "ambiguous" | "stale" | "external_evidence_required";

export type SessionDiagnosticBlocker = {
  code: ErrorCode;
  message: string;
  details: JsonObject;
  /** Stable, kebab-case next-action identifiers; reusable by orchestrators. */
  safe_actions: string[];
};

export type SessionDiagnosticIntegrationEvidence = {
  supplied: boolean;
  integrated_revision?: string;
  proof?: IntegrationProof;
};

export type SessionDiagnostic = {
  schema_version: number;
  session_id: string;
  repository: string;
  worktree: string;
  branch: string;
  session: SessionRecord;
  claims: ResourceClaim[];
  physical_state: string;
  close_readiness: ReadinessState;
  cleanup_readiness: ReadinessState;
  result_state: DiagnosticCompleteness;
  idempotent: boolean;
  blockers: SessionDiagnosticBlocker[];
  safe_actions: string[];
  integration_evidence: SessionDiagnosticIntegrationEvidence;
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
  source_sha: string;
  remote: string;
  branch: string;
  target: string;
  target_ref: string;
  observed_remote_sha: string | null;
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
  integration_proof?: IntegrationProof;
  claim_set_generation: number;
};

export type SessionDiscardResult = {
  schema_version: number;
  operation: "discard";
  session: SessionRecord;
  final_state: SessionState;
  previous_head: string | null;
  worktree_path: string;
  branch_name: string;
  worktree_removed: boolean;
  branch_removed: boolean;
  released_claims: ResourceClaim[];
  released_claim_count: number;
  released_claims_truncated: boolean;
  idempotent: boolean;
  claim_set_generation: number;
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

/** Result of explicitly upgrading the persisted resource-claim schema. */
export type RegistryMigrationResult = {
  migrated: boolean;
  registry_schema_version: number;
  claim_schema_version: number;
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
  discardSession?(context: SessionContext, sessionId: string): Promise<DomainResult<SessionDiscardResult>>;
  sessionDiagnostic?(
    context: SessionContext,
    options: SessionDiagnosticOptions,
  ): Promise<DomainResult<SessionDiagnostic>>;
  garbageCollect(context: SessionContext, options: GarbageCollectOptions): Promise<DomainResult<GarbageCollectResult>>;
  claimResources?(context: SessionContext, options: ClaimResourcesOptions): Promise<DomainResult<ClaimResourcesResult>>;
  updateClaims?(context: SessionContext, options: UpdateClaimsOptions): Promise<DomainResult<ClaimResourcesResult>>;
  applyClaimDeltas?(context: SessionContext, options: ClaimDeltasOptions): Promise<DomainResult<ClaimDeltasResult>>;
  releaseClaims?(context: SessionContext, options: ReleaseClaimsOptions): Promise<DomainResult<ReleaseClaimsResult>>;
  listClaims?(
    context: SessionContext,
    sessionId: string | null,
  ): Promise<DomainResult<{ claims: ResourceClaim[]; claim_set_generation: number }>>;
  migrate?(context: SessionContext): Promise<DomainResult<RegistryMigrationResult>>;
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

  discardSession(_context: SessionContext, _sessionId: string): Promise<DomainResult<SessionDiscardResult>> {
    return this.unavailable("session.discard");
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
