export type JsonPrimitive = null | boolean | number | string;

export type JsonValue = JsonPrimitive | JsonObject | JsonValue[];

export interface JsonObject {
  [key: string]: JsonValue;
}

export type ErrorCode =
  | "BACKEND_UNAVAILABLE"
  | "BRANCH_OWNED_BY_OTHER_SESSION"
  | "BRANCH_ALREADY_EXISTS"
  | "DOCTOR_FAILED"
  | "DIRTY_WORKTREE"
  | "GIT_COMMAND_FAILED"
  | "GIT_OPERATION_FAILED"
  | "GIT_SPAWN_FAILED"
  | "GIT_TIMEOUT"
  | "GIT_OUTPUT_LIMIT"
  | "GIT_UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "INVALID_BRANCH"
  | "INVALID_BASE_REF"
  | "INVALID_REGISTRY"
  | "INVALID_SESSION_ID"
  | "INVALID_WORKTREE"
  | "DETACHED_HEAD"
  | "MISSING_WORKTREE"
  | "REPOSITORY_MISMATCH"
  | "WORKTREE_MISMATCH"
  | "BRANCH_MISMATCH"
  | "STALE_REGISTRY"
  | "GIT_STATE_AMBIGUOUS"
  | "PHYSICAL_OBSERVATION_UNAVAILABLE"
  | "LOCK_CONTENTION"
  | "MISSING_ARGUMENT"
  | "NO_COMMAND"
  | "NO_CURRENT_SESSION"
  | "NOT_GIT_REPOSITORY"
  | "OPERATION_REJECTED"
  | "OWNERSHIP_MISMATCH"
  | "PROTECTED_BRANCH"
  | "PROTECTED_WORKTREE"
  | "RECOVERABLE_COMMITS"
  | "REGISTRY_CORRUPT"
  | "REGISTRY_UNREADABLE"
  | "SESSION_NOT_FOUND"
  | "STALE_SESSION"
  | "UNSUPPORTED_RUNTIME"
  | "UNKNOWN_COMMAND"
  | "WORKTREE_OWNED_BY_OTHER_SESSION"
  | "WORKTREE_ALREADY_EXISTS"
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
  | "UNSUPPORTED_CLAIM_SCHEMA_VERSION"
  | "INVALID_COMMIT_MESSAGE"
  | "COMMIT_EMPTY_DIFF"
  | "UNEXPECTED_CHANGED_PATHS"
  | "COMMIT_STAGING_FAILED"
  | "COMMIT_FAILED"
  | "COMMIT_RESULT_UNAVAILABLE"
  | "INVALID_REMOTE"
  | "INVALID_REMOTE_BRANCH"
  | "PUSH_TARGET_MISMATCH"
  | "PUSH_REMOTE_INSPECTION_FAILED"
  | "PUSH_NO_UPSTREAM"
  | "PUSH_BEHIND"
  | "PUSH_DIVERGED"
  | "PUSH_DIRTY_WORKTREE"
  | "PUSH_FAILED"
  | "INTERNAL_ERROR";

export const EXIT_CODES = Object.freeze({
  success: 0,
  usage: 2,
  rejected: 3,
  unavailable: 4,
  doctor: 5,
  internal: 70,
});

function defaultExitCode(code: ErrorCode): number {
  if (code === "BACKEND_UNAVAILABLE") return EXIT_CODES.unavailable;
  if (code === "DOCTOR_FAILED") return EXIT_CODES.doctor;
  if (
    code === "UNKNOWN_COMMAND" ||
    code === "NO_COMMAND" ||
    code === "INVALID_ARGUMENT" ||
    code === "MISSING_ARGUMENT" ||
    code === "INVALID_OPERATION" ||
    code === "INVALID_COMMIT_MESSAGE" ||
    code === "INVALID_REMOTE" ||
    code === "INVALID_REMOTE_BRANCH"
  ) {
    return EXIT_CODES.usage;
  }
  if (code === "INTERNAL_ERROR") return EXIT_CODES.internal;
  return EXIT_CODES.rejected;
}

export class DomainError extends Error {
  readonly code: ErrorCode;
  readonly exitCode: number;
  readonly details: JsonObject | null;

  constructor(
    code: ErrorCode,
    message: string,
    details: JsonObject | null = null,
    exitCode = defaultExitCode(code),
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "DomainError";
    this.code = code;
    this.exitCode = exitCode;
    this.details = details;
  }
}

export type DomainResult<T> = { ok: true; value: T } | { ok: false; error: DomainError };

export function success<T>(value: T): DomainResult<T> {
  return { ok: true, value };
}

export function failure<T = never>(error: DomainError): DomainResult<T> {
  return { ok: false, error };
}
