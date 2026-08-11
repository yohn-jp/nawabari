export type RegistryErrorCode =
  | "GIT_COMMAND_FAILED"
  | "GIT_SPAWN_FAILED"
  | "GIT_TIMEOUT"
  | "GIT_OUTPUT_LIMIT"
  | "NOT_A_GIT_REPOSITORY"
  | "REPOSITORY_IDENTITY_AMBIGUOUS"
  | "WORKTREE_IDENTITY_AMBIGUOUS"
  | "DETACHED_HEAD"
  | "MISSING_WORKTREE"
  | "REPOSITORY_MISMATCH"
  | "WORKTREE_MISMATCH"
  | "BRANCH_MISMATCH"
  | "STALE_REGISTRY"
  | "GIT_STATE_AMBIGUOUS"
  | "PHYSICAL_OBSERVATION_UNAVAILABLE"
  | "INVALID_SESSION_ID"
  | "INVALID_SESSION_RECORD"
  | "INVALID_BRANCH_ID"
  | "INVALID_WORKTREE_PATH"
  | "INVALID_BASE_REF"
  | "REGISTRY_CORRUPT"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "REGISTRY_REPOSITORY_MISMATCH"
  | "DUPLICATE_SESSION_ID"
  | "DUPLICATE_WORKTREE_OWNERSHIP"
  | "DUPLICATE_BRANCH_OWNERSHIP"
  | "WORKTREE_ALREADY_EXISTS"
  | "BRANCH_ALREADY_EXISTS"
  | "PROTECTED_WORKTREE"
  | "PROTECTED_BRANCH"
  | "SESSION_ID_COLLISION"
  | "SESSION_NOT_FOUND"
  | "DIRTY_WORKTREE"
  | "OWNERSHIP_MISMATCH"
  | "RECOVERABLE_COMMITS"
  | "REGISTRY_LOCK_TIMEOUT"
  | "REGISTRY_IO_FAILURE"
  | "INVALID_CLAIM"
  | "INVALID_OPERATION"
  | "INVALID_RESOURCE"
  | "MISSING_RESOURCE_CLAIM"
  | "INVALID_CLAIM_RESOURCE"
  | "CLAIM_PATH_TRAVERSAL"
  | "CLAIM_SYMLINK_ESCAPE"
  | "CLAIM_AMBIGUOUS_PATH"
  | "UNSUPPORTED_CLAIM_GLOB"
  | "CLAIM_REPOSITORY_MISMATCH"
  | "CLAIM_SESSION_MISMATCH"
  | "DUPLICATE_CLAIM"
  | "CONTRADICTORY_CLAIM"
  | "RESOURCE_CLAIM_CONFLICT"
  | "CLAIM_NOT_FOUND"
  | "SESSION_NOT_ACTIVE"
  | "UNSUPPORTED_CLAIM_SCHEMA_VERSION";

export type RegistryErrorDetails = Readonly<Record<string, boolean | number | string>>;

export class SessionRegistryError extends Error {
  readonly code: RegistryErrorCode;
  readonly details: RegistryErrorDetails;

  constructor(code: RegistryErrorCode, message: string, details: RegistryErrorDetails = {}, cause?: unknown) {
    super(message, { cause });
    this.name = "SessionRegistryError";
    this.code = code;
    this.details = details;
  }
}

export function isSessionRegistryError(error: unknown): error is SessionRegistryError {
  return error instanceof SessionRegistryError;
}
