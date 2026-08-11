import fs from "node:fs";
import path from "node:path";

import {
  defaultGit,
  listGitWorktrees,
  normalizeBranchId,
  resolveRepositoryContext,
  verifyPhysicalExecutionContext,
  type GitCommandRunner,
  type GitWorktreeInfo,
  type PhysicalExecutionContext,
  type RepositoryContext,
} from "./git.js";
import { SessionRegistryError, type RegistryErrorCode, type RegistryErrorDetails } from "./errors.js";
import { generateSessionId, isSessionId } from "./session-id.js";
import { RegistryLockError, RepositoryLock } from "./registry/lock.js";

export const REGISTRY_SCHEMA_VERSION = 1 as const;
export const REGISTRY_DIRECTORY_NAME = "nawabari";
export const REGISTRY_FILE_NAME = "session-registry.json";
export const REGISTRY_LOCK_FILE_NAME = "session-registry.lock";
export const DEFAULT_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_LOCK_METADATA_GRACE_MS = 1_000;

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
  readonly label?: string;
}

export interface CreateSessionOptions {
  readonly worktreePath?: string;
  readonly branchName?: string;
  readonly label?: string;
}

export interface ProvisionSessionOptions {
  readonly worktreePath?: string;
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
}

export interface CloseSessionOptions {
  readonly sessionId?: string | null;
  readonly session_id?: string | null;
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
}

export interface GarbageCollectResult {
  readonly apply: boolean;
  readonly candidates: readonly SessionRecord[];
  readonly cleaned: readonly SessionRecord[];
  readonly blocked: readonly GarbageCollectBlocked[];
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

export interface VerifiedExecutionContext extends PhysicalExecutionContext {
  readonly session: SessionRecord;
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
  readonly label?: string;
}

export interface PersistedRegistry {
  readonly schema_version: RegistrySchemaVersion;
  readonly repository_id: string;
  readonly sessions: readonly PersistedSessionRecord[];
}

const ACTIVE_STATES: ReadonlySet<SessionState> = new Set(["new", "active", "closing", "stale"]);
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
      const records = this.readUnsafe();
      const sessionId = generateUniqueSessionId(records, this.idGenerator);
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
        ...(options.label === undefined ? {} : { label: validateLabel(options.label) }),
      });

      assertNoOwnershipConflict(records, record);
      assertGitResourcesAvailable(this.git, this.repository.worktreePath, resources);

      let gitProvisioned = false;
      try {
        this.git.run(
          ["worktree", "add", "--quiet", "-b", resources.branchName, resources.worktreePath, resources.baseRef],
          this.repository.worktreePath,
        );
        gitProvisioned = true;
        verifyPhysicalExecutionContext({
          repository: this.repository,
          worktreePath: resources.worktreePath,
          branchName: resources.branchName,
          git: this.git,
        });
        this.writeUnsafe([...records, record]);
        return cloneSessionRecord(record);
      } catch (error: unknown) {
        if (gitProvisioned) {
          rollbackProvisionedResources(this.git, this.repository.worktreePath, resources);
        }
        throw classifyProvisioningFailure(error, this.git, this.repository.worktreePath, resources);
      }
    });
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

  private resolveSessionOwnership(
    physical: PhysicalExecutionContext,
    requestedSessionId: string | null,
  ): SessionRecord {
    const records = this.readUnsafe();
    const currentRecords = records.filter(
      (record) => record.state !== "closed" && samePath(record.worktreeId, physical.worktreePath),
    );
    if (currentRecords.length > 1) {
      throw new SessionRegistryError(
        "DUPLICATE_WORKTREE_OWNERSHIP",
        `Multiple sessions claim the current worktree: ${physical.worktreePath}`,
        { worktree: physical.worktreePath, sessionId: requestedSessionId ?? "<unspecified>" },
      );
    }
    const currentRecord = currentRecords[0];
    if (currentRecord === undefined) {
      const branchRecord = records.find((record) => record.state !== "closed" && record.branchId === physical.branchId);
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
        { sessionId: currentRecord.sessionId, state: currentRecord.state, worktree: physical.worktreePath },
      );
    }
    if (currentRecord.repositoryId !== physical.repositoryId) {
      throw new SessionRegistryError("REPOSITORY_MISMATCH", "The session repository identity does not match Git", {
        expectedRepositoryId: currentRecord.repositoryId,
        actualRepositoryId: physical.repositoryId,
      });
    }
    if (currentRecord.worktreePath !== physical.worktreePath) {
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

    try {
      if (requestedSessionId !== null && !isSessionId(requestedSessionId)) {
        return deniedGuard("INVALID_SESSION_ID", base, { sessionId: requestedSessionId });
      }

      const physical = verifyPhysicalExecutionContext({
        repository: this.repository,
        worktreePath: this.repository.worktreePath,
        git: this.git,
      });
      const identityBase = { ...base, branchName: physical.branchName };

      if (this.protectedWorktree(this.repository.worktreePath, physical.worktrees)) {
        return deniedGuard(
          "PROTECTED_WORKTREE",
          identityBase,
          { worktree: this.repository.worktreePath },
          identityBase.ownerSessionId,
          identityBase.state,
        );
      }
      if (this.protectedBranch(physical.branchName, physical.worktrees)) {
        return deniedGuard(
          "PROTECTED_BRANCH",
          identityBase,
          { branch: physical.branchName },
          identityBase.ownerSessionId,
          identityBase.state,
        );
      }

      let currentRecord: SessionRecord;
      try {
        currentRecord = this.resolveSessionOwnership(physical, requestedSessionId);
      } catch (error: unknown) {
        if (error instanceof SessionRegistryError && error.code === "DUPLICATE_WORKTREE_OWNERSHIP") {
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
        return deniedGuard(error.code, base, error.details, base.ownerSessionId, base.state);
      }
      throw error;
    }
  }

  /** Close one session only after its ownership and recoverability are proven safe. */
  close(sessionIdOrOptions?: string | null | CloseSessionOptions): CloseSessionResult {
    return this.withLock(() => {
      const sessionId =
        typeof sessionIdOrOptions === "object" && sessionIdOrOptions !== null
          ? (sessionIdOrOptions.sessionId ?? sessionIdOrOptions.session_id)
          : sessionIdOrOptions;
      const selectedSessionId = sessionId ?? this.resolveCurrentSession().sessionId;
      assertSessionId(selectedSessionId);
      return this.closeUnsafe(selectedSessionId);
    });
  }

  closeSession(sessionIdOrOptions?: string | null | CloseSessionOptions): CloseSessionResult {
    return this.close(sessionIdOrOptions);
  }

  /** Detect stale sessions, optionally applying only cleanup that passes close preflight. */
  garbageCollect(options: GarbageCollectOptions = {}): GarbageCollectResult {
    const apply = options.apply ?? false;
    const staleAfterMs = options.staleAfterMs ?? this.staleAfterMs;
    assertStaleAfterMs(staleAfterMs);

    return this.withLock(() => {
      let records = [...this.readUnsafe()];
      const now = toTimestamp(this.clock());
      const worktrees = listGitWorktrees(this.git, this.repository.worktreePath);
      const candidates = records
        .filter((record) => isStaleCandidate(record, now, staleAfterMs, worktrees))
        .map(cloneSessionRecord);

      if (!apply || candidates.length === 0) {
        return {
          apply,
          candidates,
          cleaned: [],
          blocked: [],
        };
      }

      const cleaned: SessionRecord[] = [];
      const blocked: GarbageCollectBlocked[] = [];
      for (const candidate of candidates) {
        const current = records.find((record) => record.sessionId === candidate.sessionId);
        if (current === undefined || current.state === "closed") continue;

        if (current.state !== "stale" && current.state !== "closing") {
          const staleRecord = transitionSessionState(current, "stale", this.clock);
          records = replaceRecord(records, staleRecord);
          validateRecords(records, this.repository.repositoryId);
          this.writeUnsafe(records);
        }

        try {
          const result = this.closeUnsafe(candidate.sessionId);
          cleaned.push(result.session);
        } catch (error: unknown) {
          if (!(error instanceof SessionRegistryError)) throw error;
          blocked.push({
            sessionId: candidate.sessionId,
            code: error.code,
            message: error.message,
            details: error.details,
          });
        }
        records = [...this.readUnsafe()];
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

  private closeUnsafe(sessionId: string): CloseSessionResult {
    const records = this.readUnsafe();
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
      };
    }

    const resources = this.inspectCleanupResources(record);
    const closingRecord = record.state === "closing" ? record : transitionSessionState(record, "closing", this.clock);
    let closingRecords = replaceRecord(records, closingRecord);
    validateRecords(closingRecords, this.repository.repositoryId);
    this.writeUnsafe(closingRecords);

    let worktreeRemoved = false;
    let branchRemoved = false;

    if (resources.removeWorktree) {
      removeSessionWorktree(this.git, resources.gitCwd, record.worktreePath);
      worktreeRemoved = resources.worktreePresent;
    }

    if (resources.branchPresent && resources.removeBranch) {
      removeSessionBranch(this.git, resources.gitCwd, record.branchName);
      branchRemoved = true;
    }

    const closedRecord = transitionSessionState(closingRecord, "closed", this.clock);
    closingRecords = replaceRecord(closingRecords, closedRecord);
    validateRecords(closingRecords, this.repository.repositoryId);
    this.writeUnsafe(closingRecords);

    return {
      session: cloneSessionRecord(closedRecord),
      worktreeRemoved,
      branchRemoved,
      idempotent: false,
    };
  }

  private inspectCleanupResources(record: SessionRecord): CleanupResources {
    const git = this.git;
    const worktrees = listGitWorktrees(git, this.repository.worktreePath);
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
    const branchPresent = localBranchExists(git, this.repository.worktreePath, record.branchId);
    if (worktreePresent) {
      if (!branchPresent || registeredWorktree?.branchName !== record.branchName) {
        throw ownershipMismatch(record, "The registered worktree no longer has the owned local branch");
      }
      assertWorktreeClean(git, record.worktreePath);
    }

    const worktreeProtection = this.protectedWorktree(record.worktreePath, worktrees);
    const branchProtection = this.protectedBranch(record.branchName, worktrees);
    const removeBranch = branchPresent && !branchProtection && this.branchIsReachableFromIntegration(record);

    return {
      gitCwd,
      worktreePresent,
      branchPresent,
      removeWorktree: registeredWorktree !== undefined && !worktreeProtection,
      removeBranch,
    };
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

  private protectedBranch(branchName: string, worktrees: readonly GitWorktreeInfo[]): boolean {
    const defaultBranchName = resolveDefaultBranchName(
      this.git,
      this.repository.worktreePath,
      worktrees,
      this.defaultBranchName,
    );
    const protectedBranchIds = [
      ...(defaultBranchName === undefined ? [] : [normalizeBranchId(defaultBranchName)]),
      ...this.protectedBranchNames.map((candidate) => normalizeBranchId(candidate)),
    ];
    return protectedBranchIds.includes(normalizeBranchId(branchName));
  }

  private branchIsReachableFromIntegration(record: SessionRecord): boolean {
    const git = this.git;
    const worktrees = listGitWorktrees(git, this.repository.worktreePath);
    const defaultBranchName = resolveDefaultBranchName(
      git,
      this.repository.worktreePath,
      worktrees,
      this.defaultBranchName,
    );
    if (defaultBranchName === undefined) {
      throw new SessionRegistryError(
        "RECOVERABLE_COMMITS",
        `Cannot prove that commits on ${record.branchName} are safely retained: no integration branch is known`,
        { branch: record.branchName },
      );
    }
    if (normalizeBranchId(defaultBranchName) === record.branchId) return true;
    try {
      git.run(
        ["merge-base", "--is-ancestor", record.branchId, normalizeBranchId(defaultBranchName)],
        this.repository.worktreePath,
      );
      return true;
    } catch (error: unknown) {
      if (isExpectedGitLookupFailure(error)) {
        throw new SessionRegistryError(
          "RECOVERABLE_COMMITS",
          `Commits on ${record.branchName} are not proven reachable from ${defaultBranchName}`,
          { branch: record.branchName, integrationBranch: defaultBranchName },
          error,
        );
      }
      throw error;
    }
  }

  private resolveProvisioningResources(options: ProvisionSessionOptions, sessionId: string): ProvisioningResources {
    const git = this.git;
    const worktrees = listGitWorktrees(git, this.repository.worktreePath);
    const requestedWorktreePath = resolveProvisionedWorktreePath(
      options.worktreePath ??
        path.join(this.worktreeRoot, `${path.basename(this.repository.worktreePath)}-${sessionId}`),
      this.worktreeRoot,
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
    const baseRef = resolveBaseRef(git, this.repository.worktreePath, options.baseRef ?? "HEAD");
    return {
      worktreePath: requestedWorktreePath,
      branchId,
      branchName: shortBranchName,
      baseRef,
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
    };
  }

  private readUnsafe(): readonly SessionRecord[] {
    let contents: string;
    try {
      contents = fs.readFileSync(this.paths.registry, "utf8");
    } catch (error: unknown) {
      if (isNodeError(error) && error.code === "ENOENT") {
        return [];
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

    return parseRegistry(parsed, this.repository.repositoryId);
  }

  private writeUnsafe(records: readonly SessionRecord[]): void {
    const registry: PersistedRegistry = {
      schema_version: REGISTRY_SCHEMA_VERSION,
      repository_id: this.repository.repositoryId,
      sessions: records.map((record) => toPersistedSessionRecord(record, this.repository.repositoryId)),
    };
    const contents = `${JSON.stringify(registry, null, 2)}\n`;
    const temporaryPath = `${this.paths.registry}.tmp-${process.pid}-${generateSessionId()}`;
    let descriptor: number | undefined;

    try {
      fs.mkdirSync(this.paths.directory, { recursive: true, mode: 0o700 });
      descriptor = fs.openSync(temporaryPath, "wx", 0o600);
      fs.writeFileSync(descriptor, contents, "utf8");
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporaryPath, this.paths.registry);
      syncDirectory(this.paths.directory);
    } catch (error: unknown) {
      if (descriptor !== undefined) {
        closeQuietly(descriptor);
      }
      unlinkQuietly(temporaryPath);
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
      const records = this.readUnsafe();
      const { records: nextRecords, result } = mutation(records);
      validateRecords(nextRecords, this.repository.repositoryId);
      this.writeUnsafe(nextRecords);
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
}

interface ProvisioningResources {
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly baseRef: string;
}

interface MutationResult<T> {
  readonly records: readonly SessionRecord[];
  readonly result: T;
}

interface CleanupResources {
  readonly gitCwd: string;
  readonly worktreePresent: boolean;
  readonly branchPresent: boolean;
  readonly removeWorktree: boolean;
  readonly removeBranch: boolean;
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
  });
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

function assertWorktreeClean(git: GitCommandRunner, worktreePath: string): void {
  // Ignore build/cache artifacts owned by the repository's .gitignore. Git's
  // default status still reports tracked edits and recoverable untracked files.
  const status = git.run(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no"], worktreePath);
  if (status.length > 0) {
    throw new SessionRegistryError("DIRTY_WORKTREE", `Worktree contains recoverable changes: ${worktreePath}`, {
      worktree: worktreePath,
      status,
    });
  }
}

function removeSessionWorktree(git: GitCommandRunner, cwd: string, worktreePath: string): void {
  const force = !fs.existsSync(worktreePath);
  git.run(["worktree", "remove", ...(force ? ["--force"] : []), worktreePath], cwd);
}

function removeSessionBranch(git: GitCommandRunner, cwd: string, branchName: string): void {
  git.run(["branch", "-d", "--", branchName], cwd);
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

function resolveBaseRef(git: GitCommandRunner, cwd: string, candidate: string): string {
  if (
    candidate.trim().length === 0 ||
    candidate !== candidate.trim() ||
    candidate.startsWith("-") ||
    candidate.includes("\u0000")
  ) {
    throw new SessionRegistryError("INVALID_BASE_REF", `Invalid base ref: ${candidate}`, { baseRef: candidate });
  }
  try {
    git.run(["rev-parse", "--verify", `${candidate}^{commit}`], cwd);
    return candidate;
  } catch (error: unknown) {
    if (isExpectedGitLookupFailure(error)) {
      throw new SessionRegistryError("INVALID_BASE_REF", `Base ref does not resolve to a commit: ${candidate}`, {
        baseRef: candidate,
      });
    }
    throw error;
  }
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
    ...(validated.label === undefined ? {} : { label: validated.label }),
  };
}

function parseRegistry(value: unknown, expectedRepositoryId: string): readonly SessionRecord[] {
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
  assertExactKeys(value, ["schema_version", "repository_id", "sessions"]);

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

  const records = value.sessions.map((candidate, index) => parseSessionRecord(candidate, index, expectedRepositoryId));
  validateRecords(records, expectedRepositoryId);
  return records;
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
    ["label"],
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
    ...(value.label === undefined ? {} : { label: requireString(value.label, index, "label") }),
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
  if (record.label !== undefined && (typeof record.label !== "string" || record.label.length === 0)) {
    throw invalidRecord(index, "label must be a non-empty string");
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

function requireState(value: unknown, index: number): SessionState {
  if (typeof value !== "string" || !SESSION_STATES.has(value as SessionState)) {
    throw invalidRecord(index, `state is invalid: ${stringifyDetail(value)}`);
  }
  return value as SessionState;
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

function closeQuietly(descriptor: number): void {
  try {
    fs.closeSync(descriptor);
  } catch {
    // The original operation's error is more useful than a best-effort close error.
  }
}

function unlinkQuietly(filePath: string): void {
  try {
    fs.unlinkSync(filePath);
  } catch {
    // A missing temporary file is already the desired state.
  }
}

function syncDirectory(directory: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directory, "r");
    fs.fsyncSync(descriptor);
  } catch {
    // Directory fsync is not available on every supported filesystem. The
    // file itself was fsynced before rename, so continue on that limitation.
  } finally {
    if (descriptor !== undefined) {
      closeQuietly(descriptor);
    }
  }
}
