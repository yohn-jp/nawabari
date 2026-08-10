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
  | "GIT_OPERATION_FAILED"
  | "GIT_UNAVAILABLE"
  | "INVALID_ARGUMENT"
  | "INVALID_BRANCH"
  | "INVALID_BASE_REF"
  | "INVALID_REGISTRY"
  | "INVALID_SESSION_ID"
  | "INVALID_WORKTREE"
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
    code === "MISSING_ARGUMENT"
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
