import {
  SessionRegistry,
  type SessionRecord as RegistrySessionRecord,
  type SessionRegistryOptions,
} from "../session-registry.js";
import { isSessionRegistryError, type SessionRegistryError } from "../errors.js";
import { DomainError, failure, success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";
import {
  type BackendCapabilities,
  type GarbageCollectOptions,
  type GarbageCollectResult,
  type SessionBackend,
  type SessionCloseOptions,
  type SessionCloseResult,
  type SessionContext,
  type SessionCreateOptions,
  type SessionListResult,
  type SessionRecord,
  type StatusResult,
} from "./session.js";

export interface LocalSessionBackendOptions {
  readonly git?: SessionRegistryOptions["git"];
  readonly registry?: Omit<SessionRegistryOptions, "cwd" | "git">;
}

export const LOCAL_SESSION_CAPABILITIES: BackendCapabilities = Object.freeze({
  session_registry: true,
  provisioning: true,
  lifecycle: false,
  garbage_collection: false,
  current_session_resolution: true,
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
    _context: SessionContext,
    _options: SessionCloseOptions,
  ): Promise<DomainResult<SessionCloseResult>> {
    return Promise.resolve(failure(this.unavailableError("session.close")));
  }

  public garbageCollect(
    _context: SessionContext,
    _options: GarbageCollectOptions,
  ): Promise<DomainResult<GarbageCollectResult>> {
    return Promise.resolve(failure(this.unavailableError("gc")));
  }

  private registryFor(context: SessionContext): SessionRegistry {
    return new SessionRegistry({ ...this.registryOptions, cwd: context.cwd, git: this.git });
  }

  private unavailableError(operation: string): DomainError {
    return new DomainError("BACKEND_UNAVAILABLE", "The requested GitPaw session capability is not available.", {
      operation,
      capabilities: { ...LOCAL_SESSION_CAPABILITIES, lifecycle: false, garbage_collection: false },
    });
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

function toDomainError(error: unknown, fallbackCode?: ErrorCode): DomainError {
  if (!isSessionRegistryError(error)) {
    return new DomainError("INTERNAL_ERROR", "An unexpected local session operation error occurred.");
  }

  const details: JsonObject = { ...error.details };
  const code = domainErrorCode(error, fallbackCode);
  return new DomainError(code, error.message, details);
}

function domainErrorCode(error: SessionRegistryError, fallbackCode?: ErrorCode): ErrorCode {
  if (error.code === "SESSION_NOT_FOUND" && fallbackCode !== undefined) return fallbackCode;
  switch (error.code) {
    case "GIT_COMMAND_FAILED":
      return "GIT_OPERATION_FAILED";
    case "INVALID_BRANCH_ID":
      return "INVALID_BRANCH";
    case "INVALID_BASE_REF":
      return "INVALID_BASE_REF";
    case "INVALID_WORKTREE_PATH":
    case "WORKTREE_IDENTITY_AMBIGUOUS":
      return "INVALID_WORKTREE";
    case "DUPLICATE_BRANCH_OWNERSHIP":
      return "BRANCH_OWNED_BY_OTHER_SESSION";
    case "DUPLICATE_WORKTREE_OWNERSHIP":
      return "WORKTREE_OWNED_BY_OTHER_SESSION";
    case "BRANCH_ALREADY_EXISTS":
      return "BRANCH_ALREADY_EXISTS";
    case "WORKTREE_ALREADY_EXISTS":
      return "WORKTREE_ALREADY_EXISTS";
    case "PROTECTED_BRANCH":
      return "PROTECTED_BRANCH";
    case "PROTECTED_WORKTREE":
      return "PROTECTED_WORKTREE";
    case "NOT_A_GIT_REPOSITORY":
      return "NOT_GIT_REPOSITORY";
    case "REGISTRY_CORRUPT":
    case "UNSUPPORTED_SCHEMA_VERSION":
      return "REGISTRY_CORRUPT";
    case "REGISTRY_IO_FAILURE":
      return "REGISTRY_UNREADABLE";
    case "REGISTRY_LOCK_TIMEOUT":
      return "LOCK_CONTENTION";
    case "INVALID_SESSION_ID":
      return "INVALID_SESSION_ID";
    case "SESSION_NOT_FOUND":
      return "SESSION_NOT_FOUND";
    default:
      return "OPERATION_REJECTED";
  }
}
