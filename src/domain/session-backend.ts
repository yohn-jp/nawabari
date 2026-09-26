import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  SessionRegistry,
  type GarbageCollectResult as RegistryGarbageCollectResult,
  type ResourceClaim as RegistryResourceClaim,
  type SessionRecord as RegistrySessionRecord,
  type ManagedExecutionReadiness,
  type SessionHookMaterialAuthority,
  type SessionRegistryOptions,
} from "../session-registry.js";
import type { SessionLifecycleAction as RegistrySessionLifecycleAction } from "../session-lifecycle-actions.js";
import { availableLifecycleOperations } from "../session-lifecycle-classification.js";
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
  type GarbageCollectAssessment,
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
  type SessionDiscardPreview,
  type ReconciliationApplyResult,
  type SessionLifecycleApplyAction,
  type CleanupReconciliation,
  type SessionContext,
  type SessionCreateOptions,
  type SessionManagedRuntimeState,
  type WorkingSetExpansionOptions,
  type WorkingSetExpansionResult,
  type SessionDiagnostic,
  type SessionDiagnosticOptions,
  type SessionDiagnosticSchemaVersion,
  type SessionLifecycleAction,
  type SessionLifecycleProjection,
  type SessionDiagnosticGarbageCollection,
  SESSION_DIAGNOSTIC_DEFAULT_SCHEMA_VERSION,
  SESSION_DIAGNOSTIC_LEGACY_SCHEMA_VERSION,
  SESSION_DIAGNOSTIC_V2_SCHEMA_VERSION,
  type SessionListResult,
  type SessionListOptions,
  type SessionRecord,
  type FileOperationOptions,
  type FileOperationRecordsResult,
  type FileOperationResult,
  type SessionStatusRecord,
  type IntegrationProof as DomainIntegrationProof,
  boundedSessionListing,
  type ReleaseClaimsOptions,
  type ReleaseClaimsResult,
  type ResourceClaim,
  type RegistryMigrationResult,
  type StatusResult,
  type UpdateClaimsOptions,
  type CoordinationPreviewOptions,
  type CoordinationPreviewResult,
  type ResourceCoordinationSnapshotContract,
  type ResourceCoordinationSnapshotOptions,
  type ResourceCoordinationSnapshotResult,
  type ResourceHandoffOptions,
  type ResourceHandoffResult,
  type CoordinationTransactionRequest,
  type CoordinationTransactionResult,
} from "./session.js";
import {
  parseSessionExecutionRecord,
  recordExecutionState,
  toPersistedSessionExecutionRecord,
  type PersistedSessionExecutionRecord,
  type SessionExecutionRecord,
  type SessionExecutionStateInput,
} from "./session-execution-record.js";
import {
  releaseSessionClaimsWithRuntimeDrain,
  closeSessionWithRuntimeDrain,
  discardSessionWithRuntimeDrain,
  type SessionRuntimeLifecycleAdapter,
  type SessionRuntimeLifecycleMutation,
} from "../session-runtime-lifecycle.js";
import type {
  SessionDrainExecution,
  SessionDrainFence,
  SessionDrainFinalization,
  SessionDrainObservation,
} from "./session-execution-control.js";
import {
  observeOwnedExecution,
  SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
  terminateOwnedExecution,
  type OwnedExecutionObservation,
  type SessionExecutionRecord as OwnedSessionExecutionRecord,
} from "./session-process-observation.js";
import {
  CGROUPS_V2_CONTRACT_ID,
  cleanupCgroupScope,
  createCgroupScope,
  deriveCgroupScopeName,
  readCgroupPopulation,
  resolveManagedCgroupRoot,
  type CgroupFileSystem,
} from "./cgroups-v2.js";
import {
  defaultSandboxProbe,
  discoverSandboxRuntimeLayout,
  sandboxDoctorReport,
  type SandboxGitIdentity,
  type SandboxProbe,
} from "./sandbox.js";
import type { ResourceHandoffFenceController } from "../resource-handoff.js";
import { createManagedResourceHandoffExecution } from "../resource-handoff-execution.js";

export interface LocalSessionBackendOptions {
  readonly git?: SessionRegistryOptions["git"];
  /** Minimal host Git identity projected into governed commit operations. */
  readonly gitIdentity?: SandboxGitIdentity;
  /** Generic sandbox evidence; never managed-execution readiness. */
  readonly sandboxProbe?: SandboxProbe;
  /** Explicit managed-execution readiness authority; absence fails closed for required process tracking. */
  readonly managedExecutionReadiness?: ManagedExecutionReadiness;
  /** Explicit delegated subtree accepted by the canonical cgroups-v2 authority. */
  readonly cgroupRoot?: string;
  readonly hookMaterialAuthority?: SessionHookMaterialAuthority;
  readonly registry?: Omit<
    SessionRegistryOptions,
    "cwd" | "git" | "gitIdentity" | "managedExecutionReadiness" | "hookMaterialAuthority"
  >;
  /** Explicit override for the managed-runtime handoff fence (tests/custom composition). */
  readonly resourceHandoffExecution?: ResourceHandoffFenceController;
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
  REGISTRY_FEATURE_UNSUPPORTED: "REGISTRY_FEATURE_UNSUPPORTED",
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
  AUXILIARY_STATE_INVALID: "AUXILIARY_STATE_INVALID",
  AUXILIARY_STATE_AMBIGUOUS: "AUXILIARY_STATE_AMBIGUOUS",
  AUXILIARY_STATE_MATERIALIZATION_FAILED: "AUXILIARY_STATE_MATERIALIZATION_FAILED",
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
  FILE_OPERATION_INVALID: "FILE_OPERATION_INVALID",
  FILE_OPERATION_ID_CONFLICT: "FILE_OPERATION_ID_CONFLICT",
  FILE_OPERATION_INVALID_TRANSITION: "FILE_OPERATION_INVALID_TRANSITION",
  FILE_OPERATION_LIMIT: "FILE_OPERATION_LIMIT",
  FILE_OPERATION_AUTHORITY_DENIED: "FILE_OPERATION_AUTHORITY_DENIED",
  FILE_OPERATION_UNSUPPORTED_SCHEMA: "FILE_OPERATION_UNSUPPORTED_SCHEMA",
  FILE_OPERATION_CORRUPT: "FILE_OPERATION_CORRUPT",
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
  private readonly gitIdentity: SandboxGitIdentity | undefined;
  private readonly sandboxProbe: SandboxProbe | undefined;
  private readonly managedExecutionReadiness: ManagedExecutionReadiness | undefined;
  private readonly managedCgroupRoot: DomainResult<string>;
  private readonly hookMaterialAuthority: SessionHookMaterialAuthority | undefined;
  private readonly registryOptions: Omit<
    SessionRegistryOptions,
    "cwd" | "git" | "gitIdentity" | "managedExecutionReadiness" | "hookMaterialAuthority"
  >;
  private readonly resourceHandoffExecution: ResourceHandoffFenceController | undefined;

  public constructor(options: LocalSessionBackendOptions = {}) {
    this.git = options.git;
    this.gitIdentity = options.gitIdentity;
    this.sandboxProbe = options.sandboxProbe;
    this.registryOptions = options.registry ?? {};
    this.resourceHandoffExecution = options.resourceHandoffExecution;
    this.managedCgroupRoot = resolveManagedCgroupRoot({
      ...(options.cgroupRoot === undefined ? {} : { root: options.cgroupRoot }),
      ...(this.registryOptions.cgroupFilesystem === undefined
        ? {}
        : { filesystem: this.registryOptions.cgroupFilesystem }),
    });
    this.hookMaterialAuthority = options.hookMaterialAuthority;
    this.managedExecutionReadiness =
      options.managedExecutionReadiness ??
      createLocalManagedExecutionReadiness(
        this.sandboxProbe ?? this.registryOptions.sandboxProbe,
        this.registryOptions.cgroupFilesystem,
        this.managedCgroupRoot,
      );
  }

  public getManagedCgroupRoot(): DomainResult<string> {
    return this.managedCgroupRoot;
  }

  public async listSessionExecutions(
    context: SessionContext,
    sessionId: string,
  ): Promise<DomainResult<readonly PersistedSessionExecutionRecord[]>> {
    try {
      return success(this.registryFor(context).listSessionExecutions(sessionId));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async persistSessionExecution(
    context: SessionContext,
    record: PersistedSessionExecutionRecord,
  ): Promise<DomainResult<PersistedSessionExecutionRecord>> {
    try {
      const registry = this.registryFor(context);
      const desired = parseSessionExecutionRecord(record);
      if (!desired.ok) return desired;
      const wanted = toPersistedSessionExecutionRecord(desired.value);
      const currentRecord = registry
        .listSessionExecutions(desired.value.session_id)
        .find((candidate) => candidate.execution_id === desired.value.execution_id);
      if (currentRecord === undefined) return success(registry.persistSessionExecution(wanted));

      const current = parseSessionExecutionRecord(currentRecord);
      if (!current.ok) return current;
      if (!sameSessionExecutionIdentity(current.value, desired.value)) {
        throw new DomainError("OPERATION_REJECTED", "Execution transition changed its immutable identity", {
          execution_id: desired.value.execution_id,
          session_id: desired.value.session_id,
        });
      }
      const persistedCurrent = toPersistedSessionExecutionRecord(current.value);
      if (JSON.stringify(persistedCurrent) === JSON.stringify(wanted)) return success(persistedCurrent);

      const input: SessionExecutionStateInput = {
        state: desired.value.state,
        now: desired.value.updated_at,
        ...(desired.value.supervisor_pid === null || desired.value.supervisor_starttime === null
          ? {}
          : {
              supervisor: {
                pid: desired.value.supervisor_pid,
                starttime: desired.value.supervisor_starttime,
              },
            }),
        ...(JSON.stringify(desired.value.release_attempt) === JSON.stringify(current.value.release_attempt)
          ? {}
          : { release_attempt: desired.value.release_attempt }),
      };
      const preview = recordExecutionState(current.value, input);
      if (!preview.ok) return failure(preview.error);
      if (JSON.stringify(toPersistedSessionExecutionRecord(preview.value)) !== JSON.stringify(wanted)) {
        throw new DomainError(
          "OPERATION_REJECTED",
          "Execution transition does not match the canonical lifecycle result",
          {
            execution_id: desired.value.execution_id,
            session_id: desired.value.session_id,
          },
        );
      }
      return success(registry.transitionSessionExecution(desired.value.execution_id, input, wanted));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async transitionSessionExecution(
    context: SessionContext,
    executionId: string,
    input: SessionExecutionStateInput,
  ): Promise<DomainResult<PersistedSessionExecutionRecord>> {
    try {
      return success(this.registryFor(context).transitionSessionExecution(executionId, input));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async closeSessionLaunchAdmission(
    context: SessionContext,
    sessionId: string,
    expectedEpoch: number,
  ): Promise<DomainResult<{ runtimeEpoch: number }>> {
    try {
      return success(this.registryFor(context).closeSessionLaunchAdmission(sessionId, expectedEpoch));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async getSessionManagedRuntime(
    context: SessionContext,
    sessionId: string,
    executionId?: string,
  ): Promise<DomainResult<SessionManagedRuntimeState>> {
    try {
      return success(this.registryFor(context).getSessionManagedRuntime(sessionId, executionId));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public readSessionRuntimeEpoch(context: SessionContext, sessionId: string): number {
    return this.registryFor(context).readSessionRuntimeEpoch(sessionId);
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
        ...(options.claims === null || options.claims === undefined
          ? {}
          : { initialClaims: options.claims.map(toRegistryClaimInput) }),
        ...(options.claim_enforcement === true ? { claimEnforcement: true } : {}),
        ...(options.auxiliary_state === null || options.auxiliary_state === undefined
          ? {}
          : { auxiliaryState: options.auxiliary_state }),
        ...(options.execution_scope === null || options.execution_scope === undefined
          ? {}
          : { executionScope: options.execution_scope }),
        ...(options.candidate_working_set === null || options.candidate_working_set === undefined
          ? {}
          : { candidateWorkingSet: options.candidate_working_set }),
        ...(options.working_set_repository === null || options.working_set_repository === undefined
          ? {}
          : { workingSetRepository: options.working_set_repository }),
        ...(options.profile === null || options.profile === undefined ? {} : { profile: options.profile }),
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

  public async fileOperation(
    context: SessionContext,
    options: FileOperationOptions,
  ): Promise<DomainResult<FileOperationResult>> {
    try {
      const registry = this.registryFor(context);
      const sessionId = options.operation.session_id;
      let admission: ReturnType<SessionRegistry["getSessionLaunchAdmission"]>;
      try {
        admission = registry.getSessionLaunchAdmission(sessionId);
      } catch {
        // The registry rejects the operation with its canonical error below.
        admission = undefined;
      }
      if (admission === undefined) {
        return success(registry.executeFileOperation(options.operation, options.execution_options));
      }
      const drained = await releaseSessionClaimsWithRuntimeDrain(
        runtimeLifecycleAdapter(
          registry,
          ({ fence }) =>
            registryMutation(() => registry.executeFileOperation(options.operation, options.execution_options, fence)),
          this.registryOptions.cgroupFilesystem,
        ),
        sessionId,
        registry.runtimeEpoch,
      );
      if (!drained.ok) return drained;
      if (drained.value.status !== "completed" || drained.value.value === undefined) {
        return failure(
          new DomainError("OPERATION_REJECTED", "Managed file operation is blocked until owned executions drain.", {
            session_id: sessionId,
            status: drained.value.status,
          }),
        );
      }
      return drained.value.value;
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async fileOperations(
    context: SessionContext,
    sessionId?: string | null,
  ): Promise<DomainResult<FileOperationRecordsResult>> {
    try {
      return success(
        this.registryFor(context)
          .fileOperations(sessionId)
          .map((record) => ({ ...record })),
      );
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async expandWorkingSet(
    context: SessionContext,
    options: WorkingSetExpansionOptions,
  ): Promise<DomainResult<WorkingSetExpansionResult>> {
    try {
      const result = this.registryFor(context).expandWorkingSet({
        sessionId: options.session_id,
        repository: options.repository,
        ...(options.current_revision === null ? {} : { currentRevision: options.current_revision }),
        executionScope: options.execution_scope,
        entries: options.entries,
      });
      return success({
        schema_version: result.schemaVersion,
        operation: result.operation,
        repository: result.repository,
        session_id: result.sessionId,
        previous_revision: result.previousRevision,
        revision: result.revision,
        idempotent: result.idempotent,
        status: result.status,
        outcomes: result.outcomes.map((outcome) => ({ ...outcome })),
        session: toDomainRecord(result.session),
        working_set: result.workingSet as unknown as JsonObject,
      });
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
        allClaimed: options.all_claimed,
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
        allClaimed: options.all_claimed,
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
      let currentSession: SessionStatusRecord | null = null;
      try {
        const record = registry.resolveCurrentSession();
        currentSession = toDomainStatusRecord(record, registry.diagnose(record.sessionId));
      } catch (error: unknown) {
        if (!isSessionRegistryError(error) || error.code !== "SESSION_NOT_FOUND") throw error;
      }
      const records = registry.list();
      const listing = boundedSessionListing(records.map(toDomainRecord), options);
      const statusSessions = listing.sessions.map((session) => {
        const record = records.find((candidate) => candidate.sessionId === session.session_id);
        if (record === undefined) return session;
        return toDomainStatusRecord(record, registry.diagnose(record.sessionId));
      });
      return success({
        repository: registry.repository.repositoryId,
        current_session: currentSession,
        ...listing,
        sessions: statusSessions,
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
      const registryOptions = {
        sessionId,
        integratedRevision: options.integrated_revision ?? undefined,
        fetchRemote: options.fetch_remote ?? undefined,
        fetchBranch: options.fetch_branch ?? undefined,
      };
      const close = (fence?: import("./session-execution-control.js").SessionDrainFinalization) =>
        registryMutation(() => registry.close(registryOptions, fence));
      if (registry.getSessionLaunchAdmission(sessionId) === undefined) {
        const mutation = close();
        return Promise.resolve(mutation.ok ? success(toDomainCloseSessionResult(mutation.value)) : mutation);
      }
      const drained = closeSessionWithRuntimeDrain(
        runtimeLifecycleAdapter(registry, ({ fence }) => close(fence), this.registryOptions.cgroupFilesystem),
        sessionId,
        registry.runtimeEpoch,
      );
      return drained.then((outcome) => {
        if (!outcome.ok) return outcome as DomainResult<SessionCloseResult>;
        if (outcome.value.status !== "completed" || outcome.value.value === undefined) {
          return failure(
            new DomainError("OPERATION_REJECTED", "Session close is blocked until owned executions drain."),
          );
        }
        const mutation = outcome.value.value;
        if (!mutation.ok) return mutation;
        return Promise.resolve(success(toDomainCloseSessionResult(mutation.value)));
      });
    } catch (error: unknown) {
      return Promise.resolve(failure(toDomainError(error, "NO_CURRENT_SESSION")));
    }
  }

  public discardSession(context: SessionContext, sessionId: string): Promise<DomainResult<SessionDiscardResult>> {
    try {
      const registry = this.registryFor(context);
      if (registry.getSessionLaunchAdmission(sessionId) === undefined) {
        const mutation = registryMutation(() => registry.discard(sessionId));
        return Promise.resolve(mutation.ok ? success(toDomainSessionDiscardResult(mutation.value)) : mutation);
      }
      return discardSessionWithRuntimeDrain(
        runtimeLifecycleAdapter(
          registry,
          ({ session_id: mutationSessionId, fence }) =>
            registryMutation(() => registry.discard({ sessionId: mutationSessionId }, fence)),
          this.registryOptions.cgroupFilesystem,
        ),
        sessionId,
        registry.runtimeEpoch,
      ).then((outcome) => {
        if (!outcome.ok) return outcome as DomainResult<SessionDiscardResult>;
        if (outcome.value.status !== "completed" || outcome.value.value === undefined) {
          return failure(
            new DomainError("OPERATION_REJECTED", "Session discard is blocked until owned executions drain."),
          );
        }
        const mutation = outcome.value.value;
        if (!mutation.ok) return mutation;
        return success(toDomainSessionDiscardResult(mutation.value));
      });
    } catch (error: unknown) {
      return Promise.resolve(failure(toDomainError(error)));
    }
  }

  public discardPreview(context: SessionContext, sessionId: string): Promise<DomainResult<SessionDiscardPreview>> {
    try {
      const result = this.registryFor(context).previewDiscard({ sessionId });
      return Promise.resolve(success(toDomainSessionDiscardPreview(result)));
    } catch (error: unknown) {
      return Promise.resolve(failure(toDomainError(error, "NO_CURRENT_SESSION")));
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
      return Promise.resolve(success(toDomainSessionDiagnostic(diagnostic, options.schema_version)));
    } catch (error: unknown) {
      return Promise.resolve(failure(toDomainError(error, "NO_CURRENT_SESSION")));
    }
  }

  public reconcileApply(context: SessionContext, sessionId: string): Promise<DomainResult<ReconciliationApplyResult>> {
    try {
      const result = this.registryFor(context).reconcileApply(sessionId);
      return Promise.resolve(success(toDomainReconciliationApplyResult(result)));
    } catch (error: unknown) {
      return Promise.resolve(failure(toDomainError(error)));
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
      const registry = this.registryFor(context);
      const sessionId = options.session_id ?? registry.resolveCurrentSession().sessionId;
      const result = await mutateClaimsWithRuntimeDrain(
        registry,
        sessionId,
        this.registryOptions.cgroupFilesystem,
        (fence) =>
          registryMutation(() =>
            registry.claimResources(
              {
                sessionId: options.session_id ?? undefined,
                repositoryId: options.repository ?? undefined,
                claims: options.claims.map(toRegistryClaimInput),
              },
              fence,
            ),
          ),
      );
      return result.ok ? success(toDomainClaimResult(result.value)) : result;
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async updateClaims(
    context: SessionContext,
    options: UpdateClaimsOptions,
  ): Promise<DomainResult<ClaimResourcesResult>> {
    try {
      const registry = this.registryFor(context);
      const sessionId = options.session_id ?? registry.resolveCurrentSession().sessionId;
      const result = await mutateClaimsWithRuntimeDrain(
        registry,
        sessionId,
        this.registryOptions.cgroupFilesystem,
        (fence) =>
          registryMutation(() =>
            registry.updateClaims(
              {
                sessionId: options.session_id ?? undefined,
                repositoryId: options.repository ?? undefined,
                claims: options.claims.map(toRegistryClaimInput),
                expectedClaimSetGeneration: options.expected_claim_set_generation ?? undefined,
                force: options.force === true,
              },
              fence,
            ),
          ),
      );
      return result.ok ? success(toDomainClaimResult(result.value)) : result;
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async applyClaimDeltas(
    context: SessionContext,
    options: ClaimDeltasOptions,
  ): Promise<DomainResult<ClaimDeltasResult>> {
    try {
      const registry = this.registryFor(context);
      const sessionId = options.session_id ?? registry.resolveCurrentSession().sessionId;
      const result = await mutateClaimsWithRuntimeDrain(
        registry,
        sessionId,
        this.registryOptions.cgroupFilesystem,
        (fence) =>
          registryMutation(() =>
            registry.applyClaimDeltas(
              {
                sessionId: options.session_id ?? undefined,
                repositoryId: options.repository ?? undefined,
                deltas: options.deltas,
                expectedClaimSetGeneration: options.expected_claim_set_generation ?? undefined,
                force: options.force === true,
              },
              fence,
            ),
          ),
      );
      return result.ok ? success(toDomainClaimDeltasResult(result.value)) : result;
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async releaseClaims(
    context: SessionContext,
    options: ReleaseClaimsOptions,
  ): Promise<DomainResult<ReleaseClaimsResult>> {
    try {
      const registry = this.registryFor(context);
      const sessionId = options.session_id ?? registry.resolveCurrentSession().sessionId;
      const result = await mutateClaimsWithRuntimeDrain(
        registry,
        sessionId,
        this.registryOptions.cgroupFilesystem,
        (fence) =>
          registryMutation(() =>
            registry.releaseClaims(
              {
                sessionId,
                resources: options.resources ?? undefined,
                claimIds: options.claim_ids ?? undefined,
                all: options.all === true,
                expectedClaimSetGeneration: options.expected_claim_set_generation ?? undefined,
                force: options.force === true,
              },
              undefined,
              fence,
            ),
          ),
      );
      if (!result.ok) return result;
      const released = result.value;
      return success({
        session_id: released.sessionId,
        released: released.released.map(toDomainClaim),
        remaining: released.remaining.map(toDomainClaim),
        idempotent: released.idempotent,
        claim_set_generation: released.claimSetGeneration,
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

  public async coordinationPreview(
    context: SessionContext,
    options: CoordinationPreviewOptions,
  ): Promise<DomainResult<CoordinationPreviewResult>> {
    try {
      return success(this.registryFor(context).coordinationPreview(options));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async resourceCoordinationSnapshot(
    context: SessionContext,
    contract: ResourceCoordinationSnapshotContract,
    bounds?: ResourceCoordinationSnapshotOptions,
  ): Promise<DomainResult<ResourceCoordinationSnapshotResult>> {
    try {
      return success(this.registryFor(context).resourceCoordinationSnapshot(contract, bounds));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async handoffResources(
    context: SessionContext,
    options: ResourceHandoffOptions,
  ): Promise<DomainResult<ResourceHandoffResult>> {
    try {
      const registry = this.registryFor(context);
      const execution = this.resourceHandoffExecution ?? createManagedResourceHandoffExecution(registry);
      return success(await registry.handoffResources(options, execution));
    } catch (error: unknown) {
      return failure(toDomainError(error));
    }
  }

  public async applyCoordinationTransaction(
    context: SessionContext,
    request: CoordinationTransactionRequest,
  ): Promise<DomainResult<CoordinationTransactionResult>> {
    try {
      return success(this.registryFor(context).applyCoordinationTransaction(request));
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
    return new SessionRegistry({
      ...this.registryOptions,
      cwd: context.cwd,
      git: this.git,
      gitIdentity: this.gitIdentity,
      sandboxProbe: this.sandboxProbe,
      managedExecutionReadiness: this.managedExecutionReadiness,
      hookMaterialAuthority: this.hookMaterialAuthority,
    });
  }
}

function createLocalManagedExecutionReadiness(
  probe: SandboxProbe | undefined,
  filesystem: CgroupFileSystem | undefined,
  root: DomainResult<string>,
): ManagedExecutionReadiness {
  return () => {
    try {
      const doctor = sandboxDoctorReport(probe ?? defaultSandboxProbe, discoverSandboxRuntimeLayout());
      if (!doctor.ready) return { ready: false };

      if (!root.ok) return { ready: false };

      const created = createCgroupScope(
        { session_id: "nawabari-managed-readiness", execution_id: `readiness-${crypto.randomUUID()}` },
        { root: root.value, ...(filesystem === undefined ? {} : { filesystem }) },
      );
      if (!created.ok) return { ready: false };

      let population: ReturnType<typeof readCgroupPopulation> | undefined;
      try {
        population = readCgroupPopulation(created.value, filesystem);
      } catch {
        // The scope is still cleaned below, but uncertain observation is not readiness.
      }

      let cleaned: ReturnType<typeof cleanupCgroupScope> | undefined;
      try {
        cleaned = cleanupCgroupScope(created.value, filesystem);
      } catch {
        return { ready: false };
      }

      return {
        ready:
          population?.state === "empty" &&
          cleaned?.ok === true &&
          cleaned.value.removed &&
          cleaned.value.after_population.state === "empty",
      };
    } catch {
      return { ready: false };
    }
  };
}

export function createLocalSessionBackend(options: LocalSessionBackendOptions = {}): SessionBackend {
  return new LocalSessionBackend(options);
}

function runtimeLifecycleAdapter<T>(
  registry: SessionRegistry,
  mutate: (mutation: SessionRuntimeLifecycleMutation) => T | Promise<T>,
  cgroupFilesystem?: CgroupFileSystem,
): SessionRuntimeLifecycleAdapter<T> {
  const snapshot = (sessionId: string) => {
    const executions: SessionDrainExecution[] = [];
    const currentBootId = observeKernelBootId();
    for (const persisted of registry.listSessionExecutions(sessionId)) {
      const parsed = parseSessionExecutionRecord(persisted);
      if (!parsed.ok) throw parsed.error;
      const owned =
        currentBootId === null
          ? null
          : observeOwnedExecution(ownedExecutionRecord(parsed.value), {
              current_boot_id: currentBootId,
              ...(cgroupFilesystem === undefined ? {} : { filesystem: cgroupFilesystem }),
            });
      executions.push({
        record: parsed.value,
        observation: owned === null || !owned.ok ? unknownOwnedExecution(parsed.value) : owned.value,
      });
    }
    const trackedAdmission = registry.getSessionLaunchAdmission(sessionId);
    return {
      session_id: sessionId,
      runtime_epoch: registry.runtimeEpoch,
      executions,
      kernel_empty:
        trackedAdmission !== undefined &&
        executions.length > 0 &&
        executions.every(
          ({ observation }) =>
            observation.state === "empty" &&
            observation.cgroups !== null &&
            observation.cgroups.population.state === "empty",
        ),
    };
  };
  return {
    observe: snapshot,
    close_admission: (request) => {
      try {
        return {
          ok: true,
          value: {
            admission: "closed" as const,
            runtime_epoch: registry.closeSessionLaunchAdmission(request.session_id, Number(request.expected_epoch))
              .runtimeEpoch,
          },
        };
      } catch (error: unknown) {
        return failure(toDomainError(error));
      }
    },
    terminate: (sessionId, fence: SessionDrainFence): SessionDrainObservation => {
      if (
        fence.session_id !== sessionId ||
        fence.policy !== "terminate" ||
        fence.admission !== "closed" ||
        fence.admission_epoch !== registry.runtimeEpoch
      ) {
        throw new DomainError(
          "OPERATION_REJECTED",
          "Owned termination requires the exact closed session drain fence.",
          {
            session_id: sessionId,
            fence_session_id: fence.session_id,
          },
        );
      }
      const currentBootId = observeKernelBootId();
      if (currentBootId !== null) {
        const records = new Map(
          registry.listSessionExecutions(sessionId).map((persisted) => {
            const parsed = parseSessionExecutionRecord(persisted);
            if (!parsed.ok) throw parsed.error;
            return [parsed.value.execution_id, parsed.value] as const;
          }),
        );
        for (const fenced of fence.executions) {
          const record = records.get(fenced.record.execution_id);
          if (record === undefined || record.session_id !== sessionId) continue;
          if (
            JSON.stringify(record.cgroup_identity) !== JSON.stringify(fenced.record.cgroup_identity) ||
            record.boot_id !== fenced.record.boot_id
          ) {
            throw new DomainError("OPERATION_REJECTED", "The owned execution identity changed during termination.", {
              session_id: sessionId,
              execution_id: record.execution_id,
            });
          }
          const owned = ownedExecutionRecord(record);
          const termination = terminateOwnedExecution(
            owned,
            {
              kind: "terminate",
              session_id: sessionId,
              execution_id: record.execution_id,
              boot_id: record.boot_id,
            },
            {
              current_boot_id: currentBootId,
              retain_scope: true,
              ...(cgroupFilesystem === undefined ? {} : { filesystem: cgroupFilesystem }),
            },
          );
          if (!termination.ok) continue;
          if (record.state !== "exited") {
            const terminal = recordExecutionState(record, { state: "exited" });
            if (!terminal.ok) throw terminal.error;
            registry.transitionSessionExecution(
              record.execution_id,
              { state: "exited", now: terminal.value.updated_at },
              toPersistedSessionExecutionRecord(terminal.value),
            );
          }
        }
      }
      const afterTermination = snapshot(sessionId);
      return {
        observed_epoch: afterTermination.runtime_epoch,
        executions: afterTermination.executions,
        kernel_empty: afterTermination.kernel_empty,
      };
    },
    mutate,
  };
}

async function mutateClaimsWithRuntimeDrain<T>(
  registry: SessionRegistry,
  sessionId: string,
  cgroupFilesystem: CgroupFileSystem | undefined,
  mutation: (fence?: SessionDrainFinalization) => DomainResult<T>,
): Promise<DomainResult<T>> {
  if (registry.getSessionLaunchAdmission(sessionId) === undefined) return mutation();
  const drained = await releaseSessionClaimsWithRuntimeDrain(
    runtimeLifecycleAdapter(registry, ({ fence }) => mutation(fence), cgroupFilesystem),
    sessionId,
    registry.runtimeEpoch,
  );
  if (!drained.ok) return drained;
  if (drained.value.status !== "completed" || drained.value.value === undefined) {
    return failure(
      new DomainError("OPERATION_REJECTED", "Managed claim mutation is blocked until owned executions drain.", {
        session_id: sessionId,
        status: drained.value.status,
      }),
    );
  }
  return drained.value.value;
}

function ownedExecutionRecord(record: SessionExecutionRecord): OwnedSessionExecutionRecord {
  const name = deriveCgroupScopeName(record.cgroup_identity);
  const root = record.cgroup_root;
  return {
    schema_version: 1,
    session_id: record.session_id,
    execution_id: record.execution_id,
    boot_id: record.boot_id,
    state: record.state === "attached" || record.state === "running" ? "active" : "terminal",
    cgroups:
      root === null || root === undefined
        ? null
        : {
            contract_id: CGROUPS_V2_CONTRACT_ID,
            root,
            parent: `${root}/nawabari`,
            path: `${root}/nawabari/${name}`,
            name,
            boot_id: record.boot_id,
            identity: { session_id: record.session_id, execution_id: record.execution_id },
          },
  };
}

function unknownOwnedExecution(record: SessionExecutionRecord): OwnedExecutionObservation {
  return {
    contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
    session_id: record.session_id,
    execution_id: record.execution_id,
    boot_id: record.boot_id,
    state: "unknown",
    cgroups: null,
  };
}

function observeKernelBootId(): string | null {
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return value.length > 0 && value.length <= 256 && !value.includes("\0") ? value : null;
  } catch {
    return null;
  }
}

function registryMutation<T>(mutation: () => T): DomainResult<T> {
  try {
    return success(mutation());
  } catch (error: unknown) {
    return failure(toDomainError(error));
  }
}

function sameSessionExecutionIdentity(current: SessionExecutionRecord, next: SessionExecutionRecord): boolean {
  return (
    current.contract_id === next.contract_id &&
    current.schema_version === next.schema_version &&
    current.session_id === next.session_id &&
    current.execution_id === next.execution_id &&
    current.profile_digest === next.profile_digest &&
    current.filesystem_token === next.filesystem_token &&
    current.runtime_epoch === next.runtime_epoch &&
    current.boot_id === next.boot_id &&
    current.created_at === next.created_at &&
    JSON.stringify(current.cgroup_identity) === JSON.stringify(next.cgroup_identity) &&
    current.cgroup_root === next.cgroup_root
  );
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
    ...(record.workingSet === undefined
      ? {}
      : { working_set: record.workingSet as unknown as import("./errors.js").JsonObject }),
    ...(record.claimEnforcement === undefined ? {} : { claim_enforcement: record.claimEnforcement }),
  };
}

function toDomainLifecycleProjection(
  lifecycle: import("../session-registry.js").SessionLifecycleClassification,
): NonNullable<SessionDiagnostic["lifecycle"]> {
  return {
    schema_version: lifecycle.schemaVersion,
    state: lifecycle.state,
    session_state: lifecycle.sessionState,
    physical_state: lifecycle.physicalState,
    close_readiness: lifecycle.closeReadiness,
    blockers: lifecycle.blockers.map((blocker) => ({
      code: blocker.code,
      ...(blocker.classification === undefined ? {} : { classification: blocker.classification }),
    })),
    recoverability: lifecycle.recoverability,
    age_suspicious: lifecycle.ageSuspicious,
    gc_authorized: lifecycle.gcAuthorized,
    destructive_cleanup_eligible: lifecycle.destructiveCleanupEligible,
    available_operations: [...availableLifecycleOperations(lifecycle)],
    transitions: lifecycle.transitions.map((transition) => ({ ...transition })),
  };
}

function toDomainStatusRecord(
  record: RegistrySessionRecord,
  diagnostic: import("../session-registry.js").SessionDiagnostic,
): import("./session.js").SessionStatusRecord {
  const projected = toDomainSessionDiagnostic(diagnostic);
  return {
    ...toDomainRecord(record),
    physical_state: projected.physical_state,
    close_readiness: projected.close_readiness,
    cleanup_readiness: projected.cleanup_readiness,
    result_state: projected.result_state,
    blockers: projected.blockers,
    safe_actions: [...projected.safe_actions],
    ...(projected.next_action === undefined ? {} : { next_action: projected.next_action }),
    next_actions: projected.next_actions,
    ...(projected.lifecycle_state === undefined ? {} : { lifecycle_state: projected.lifecycle_state }),
    ...(projected.lifecycle === undefined ? {} : { lifecycle: projected.lifecycle }),
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
    diagnostics: evidence.diagnostics.map((diagnostic) => ({ ...diagnostic })),
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
    ...(result.reconciliation === undefined
      ? {}
      : {
          reconciliation: {
            outcome: result.reconciliation.outcome,
            retry_safe: result.reconciliation.retrySafe,
            repository: result.reconciliation.repositoryId,
            remote: result.reconciliation.remote,
            branch: result.reconciliation.branch,
            target_ref: result.reconciliation.targetRef,
            precondition_sha: result.reconciliation.preconditionSha,
            intended_source_sha: result.reconciliation.intendedSourceSha,
            observed_remote_sha: result.reconciliation.observedRemoteSha,
          },
        }),
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

function toDomainReconciliationApplyResult(
  result: import("../session-registry.js").ReconciliationApplyResult,
): ReconciliationApplyResult {
  return {
    schema_version: result.schemaVersion,
    operation: result.operation,
    outcome: result.outcome,
    repository: result.repositoryId,
    session_id: result.sessionId,
    action: toDomainSessionLifecycleApplyAction(result.action),
    session: toDomainRecord(result.session),
    lifecycle: toDomainLifecycleProjection(result.lifecycle),
    physical_state: result.physicalState,
    claims: result.claims.map(toDomainClaim),
    released_claims: result.releasedClaims.map(toDomainClaim),
    released_claim_count: result.releasedClaimCount,
    worktree_removed: result.worktreeRemoved,
    branch_removed: result.branchRemoved,
    claim_set_generation: result.claimSetGeneration,
    ...(result.reconciliation === undefined
      ? {}
      : { reconciliation: toDomainCleanupReconciliation(result.reconciliation) }),
  };
}

function toDomainSessionLifecycleApplyAction(
  action: import("../session-lifecycle-actions.js").SessionLifecycleApplyAction,
): SessionLifecycleApplyAction {
  return {
    schema_version: action.schemaVersion,
    action_id: action.actionId,
    kind: action.kind,
    command: action.command,
    session_id: action.sessionId,
    required_args: [...action.requiredArgs] as ["--session", string, "--apply"],
    requires_explicit_intent: action.requiresExplicitIntent,
    mutates: action.mutates,
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
    ...(candidate.lifecycle === undefined ? {} : { lifecycle: toDomainLifecycleProjection(candidate.lifecycle) }),
    ...(candidate.nextActions === undefined
      ? {}
      : { next_actions: candidate.nextActions.map(toDomainSessionLifecycleAction) }),
  };
}

/**
 * Diagnostics carry one canonical lifecycle projection (`diagnostic.lifecycle`
 * / `diagnostic.nextActions`). The explicit v1 compatibility projection keeps
 * the established nested fields; v2 retains those fields as references to
 * the canonical top-level values instead of serializing a second graph.
 */
function toDomainGarbageCollectAssessment(
  assessment: import("../session-registry.js").GarbageCollectAssessment,
  lifecycle: SessionLifecycleProjection | undefined,
  nextActions: readonly SessionLifecycleAction[],
  schemaVersion: SessionDiagnosticSchemaVersion,
): SessionDiagnosticGarbageCollection {
  const lifecycleCompatibility =
    lifecycle === undefined
      ? {}
      : schemaVersion === SESSION_DIAGNOSTIC_LEGACY_SCHEMA_VERSION
        ? { lifecycle }
        : {
            lifecycle: {
              schema_version: SESSION_DIAGNOSTIC_V2_SCHEMA_VERSION,
              authority: "session_diagnostic.lifecycle" as const,
              ref: "#/lifecycle" as const,
            },
          };
  const nextActionsCompatibility =
    schemaVersion === SESSION_DIAGNOSTIC_LEGACY_SCHEMA_VERSION
      ? { next_actions: [...nextActions] }
      : {
          next_actions: {
            schema_version: SESSION_DIAGNOSTIC_V2_SCHEMA_VERSION,
            authority: "session_diagnostic.next_actions" as const,
            ref: "#/next_actions" as const,
          },
        };
  return {
    ...toDomainRecord(assessment),
    physical_state: assessment.physicalState,
    suspicion: assessment.suspicion,
    suspicion_reason: assessment.suspicionReason,
    destructive_eligibility: assessment.destructiveEligibility,
    destructive_eligibility_reason: assessment.destructiveEligibilityReason,
    ...lifecycleCompatibility,
    ...nextActionsCompatibility,
  };
}

function toDomainSessionDiagnostic(
  diagnostic: import("../session-registry.js").SessionDiagnostic,
  schemaVersion: SessionDiagnosticSchemaVersion = SESSION_DIAGNOSTIC_DEFAULT_SCHEMA_VERSION,
): SessionDiagnostic {
  const nextActions = diagnostic.nextActions.map(toDomainSessionLifecycleAction);
  const lifecycle = diagnostic.lifecycle === undefined ? undefined : toDomainLifecycleProjection(diagnostic.lifecycle);
  return {
    schema_version: schemaVersion,
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
    ...(diagnostic.nextAction === undefined
      ? {}
      : { next_action: toDomainSessionLifecycleAction(diagnostic.nextAction) }),
    next_actions: nextActions,
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
    ...(lifecycle === undefined
      ? {}
      : {
          lifecycle_state: lifecycle.state,
          lifecycle,
        }),
    garbage_collection: toDomainGarbageCollectAssessment(
      diagnostic.garbageCollection,
      lifecycle,
      nextActions,
      schemaVersion,
    ),
  };
}

function toDomainSessionLifecycleAction(action: RegistrySessionLifecycleAction): SessionLifecycleAction {
  switch (action.kind) {
    case "retain":
      return {
        schema_version: action.schemaVersion,
        action_id: action.actionId,
        kind: action.kind,
        command: action.command,
        reason: action.reason,
      };
    case "integrated-revision":
      return {
        schema_version: action.schemaVersion,
        action_id: action.actionId,
        kind: action.kind,
        command: action.command,
        integrated_revision: action.integratedRevision,
      };
    case "bounded-integration-fetch":
      return {
        schema_version: action.schemaVersion,
        action_id: action.actionId,
        kind: action.kind,
        command: action.command,
        integrated_revision: action.integratedRevision,
        fetch_remote: action.fetchRemote,
        fetch_branch: action.fetchBranch,
      };
    case "explicit-discard":
      return {
        schema_version: action.schemaVersion,
        action_id: action.actionId,
        kind: action.kind,
        command: action.command,
        session_id: action.sessionId,
        requires_explicit_intent: action.requiresExplicitIntent,
      };
    case "reconcile":
      return {
        schema_version: action.schemaVersion,
        action_id: action.actionId,
        kind: action.kind,
        command: action.command,
        session_id: action.sessionId,
        mutates: action.mutates,
      };
  }
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
    ...(result.reconciliation === undefined
      ? {}
      : { reconciliation: toDomainCleanupReconciliation(result.reconciliation) }),
  };
}

function toDomainCloseSessionResult(result: ReturnType<SessionRegistry["close"]>): SessionCloseResult {
  return {
    session: toDomainRecord(result.session),
    worktree_removed: result.worktreeRemoved,
    branch_removed: result.branchRemoved,
    idempotent: result.idempotent,
    claim_set_generation: result.claimSetGeneration,
    ...(result.reconciliation === undefined
      ? {}
      : { reconciliation: toDomainCleanupReconciliation(result.reconciliation) }),
    ...(result.integrationProof === undefined
      ? {}
      : { integration_proof: toDomainIntegrationProof(result.integrationProof) }),
  };
}

function toDomainSessionDiscardPreview(
  preview: import("../session-registry.js").DiscardPreview,
): SessionDiscardPreview {
  const evidence = (item: import("../session-registry.js").DiscardPreviewEvidence) => ({
    code: REGISTRY_ERROR_CODE_MAP[item.code],
    message: item.message,
    details: { ...item.details },
  });
  return {
    schema_version: preview.schemaVersion,
    operation: preview.operation,
    destructive: preview.destructive,
    warning: preview.warning,
    session_id: preview.session.sessionId,
    repository: preview.session.repositoryId,
    worktree: preview.session.worktreePath,
    branch: preview.session.branchName,
    session: toDomainRecord(preview.session),
    current_state: preview.currentState,
    persisted_state: preview.persistedState,
    physical_state: preview.physicalState,
    worktree_present: preview.worktreePresent,
    branch_present: preview.branchPresent,
    head: preview.head,
    worktree_head: preview.worktreeHead,
    branch_head: preview.branchHead,
    expected_head: preview.expectedHead,
    recoverable_commits: {
      observable: preview.recoverableCommits.observable,
      present: preview.recoverableCommits.present,
      evidence: preview.recoverableCommits.evidence.map(evidence),
    },
    uncommitted_work: {
      observable: preview.uncommittedWork.observable,
      present: preview.uncommittedWork.present,
      evidence: preview.uncommittedWork.evidence.map(evidence),
    },
    claims: preview.claims.map(toDomainClaim),
    claim_count: preview.claimCount,
    claims_truncated: preview.claimsTruncated,
    destructive_scope: {
      worktree: preview.destructiveScope.worktree,
      branch: preview.destructiveScope.branch,
      unintegrated_commits: preview.destructiveScope.unintegratedCommits,
      uncommitted_work: preview.destructiveScope.uncommittedWork,
      claims: preview.destructiveScope.claims,
    },
    diagnostic: {
      close_readiness: preview.diagnostic.closeReadiness,
      cleanup_readiness: preview.diagnostic.cleanupReadiness,
      result_state: preview.diagnostic.resultState,
      blockers: preview.diagnostic.blockers.map(evidence),
      ...(preview.diagnostic.lifecycleState === undefined
        ? {}
        : { lifecycle_state: preview.diagnostic.lifecycleState }),
    },
  };
}

function toDomainCleanupReconciliation(
  reconciliation: import("../session-registry.js").CleanupReconciliation,
): CleanupReconciliation {
  return {
    operation: reconciliation.operation,
    outcome: reconciliation.outcome,
    retry_safe: reconciliation.retrySafe,
    repository: reconciliation.repositoryId,
    session_id: reconciliation.sessionId,
    worktree: reconciliation.worktreePath,
    branch: reconciliation.branchName,
    expected_head: reconciliation.expectedHead,
    observed_worktree_head: reconciliation.observedWorktreeHead,
    observed_branch_head: reconciliation.observedBranchHead,
    worktree_present: reconciliation.worktreePresent,
    branch_present: reconciliation.branchPresent,
    remaining: [...reconciliation.remaining],
    ...(reconciliation.reason === undefined ? {} : { reason: reconciliation.reason }),
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
  if (error instanceof DomainError) return error;
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
