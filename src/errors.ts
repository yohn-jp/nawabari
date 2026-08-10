export type RegistryErrorCode =
  | "GIT_COMMAND_FAILED"
  | "NOT_A_GIT_REPOSITORY"
  | "REPOSITORY_IDENTITY_AMBIGUOUS"
  | "WORKTREE_IDENTITY_AMBIGUOUS"
  | "INVALID_SESSION_ID"
  | "INVALID_SESSION_RECORD"
  | "INVALID_BRANCH_ID"
  | "REGISTRY_CORRUPT"
  | "UNSUPPORTED_SCHEMA_VERSION"
  | "REGISTRY_REPOSITORY_MISMATCH"
  | "DUPLICATE_SESSION_ID"
  | "DUPLICATE_WORKTREE_OWNERSHIP"
  | "DUPLICATE_BRANCH_OWNERSHIP"
  | "SESSION_ID_COLLISION"
  | "SESSION_NOT_FOUND"
  | "REGISTRY_LOCK_TIMEOUT"
  | "REGISTRY_IO_FAILURE";

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
