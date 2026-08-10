export const REGISTRY_ERROR_CODES = [
  "REGISTRY_NOT_FOUND",
  "REGISTRY_CORRUPT",
  "REGISTRY_UNSUPPORTED_SCHEMA",
  "REGISTRY_REPOSITORY_MISMATCH",
  "REGISTRY_DUPLICATE_SESSION",
  "REGISTRY_DUPLICATE_WORKTREE",
  "REGISTRY_DUPLICATE_BRANCH",
  "REGISTRY_IO_ERROR",
  "REGISTRY_MUTATION_FAILED",
  "LOCK_BUSY",
  "LOCK_STALE",
  "LOCK_INVALID",
  "LOCK_IO_ERROR",
  "LOCK_RELEASE_FAILED",
] as const;

export type RegistryErrorCode = (typeof REGISTRY_ERROR_CODES)[number];

export class RegistryError extends Error {
  public readonly code: RegistryErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: RegistryErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "RegistryError";
    this.code = code;
    this.details = details;
  }
}

export function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError;
}
