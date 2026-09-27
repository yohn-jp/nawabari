export const REGISTRY_ERROR_CODES = [
  "REGISTRY_IO_ERROR",
  "REGISTRY_DURABILITY_UNCERTAIN",
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
