import fs from "node:fs";
import path from "node:path";

import { SessionRegistryError } from "../errors.js";
import type { RegistryErrorCode } from "../errors.js";
import { isPostRenameFailure, writeJsonAtomicallySync } from "./atomic.js";
import { RegistryLockError, RepositoryLock } from "./lock.js";
import type { LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION, ResourceClaim } from "../resource-claims.js";
import type { ParsedRuntimeRecords } from "./runtime-records.js";
import type {
  LEGACY_REGISTRY_SCHEMA_VERSION,
  PersistedRegistryV2,
  RegistrySchemaVersion,
  SessionRecord,
} from "../session-registry.js";

export const REGISTRY_DIRECTORY_NAME = "nawabari";
export const REGISTRY_FILE_NAME = "session-registry.json";
export const REGISTRY_LOCK_FILE_NAME = "session-registry.lock";

export interface RegistryPaths {
  readonly directory: string;
  readonly registry: string;
  readonly lock: string;
}

export interface RegistryState {
  readonly registrySchemaVersion: typeof LEGACY_REGISTRY_SCHEMA_VERSION | RegistrySchemaVersion;
  readonly registryRevision: number;
  readonly runtimeEpoch: number;
  readonly runtimeRecords: ParsedRuntimeRecords;
  readonly sessions: readonly SessionRecord[];
  readonly claims: readonly ResourceClaim[];
  readonly claimSetGeneration: number;
  readonly legacyClaimsAbsent: boolean;
  readonly legacyClaimsSchemaVersion?: typeof LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION;
}

interface RepositoryStateBoundaryOptions {
  readonly commonGitDirectory: string;
  readonly lockTimeoutMs: number;
  readonly lockStaleAfterMs: number;
  readonly lockMetadataGraceMs: number;
  readonly emptyState: () => RegistryState;
  readonly parseState: (value: unknown, allowLegacyClaimSchema: boolean) => RegistryState;
  readonly validateCommit: (document: PersistedRegistryV2) => void;
}

/**
 * The sole repository-registry file and lock boundary used by SessionRegistry.
 * It owns canonical path resolution, lock lifecycle, durable reads, and full
 * document replacement. Typed mutation decisions and state construction stay
 * with SessionRegistry; commit validates the complete persisted registry
 * through its typed parser before allowing atomic replacement.
 */
export class RepositoryStateBoundary {
  readonly paths: RegistryPaths;

  private readonly lock: RepositoryLock;
  private readonly emptyState: () => RegistryState;
  private readonly parseState: RepositoryStateBoundaryOptions["parseState"];
  private readonly validateCommit: RepositoryStateBoundaryOptions["validateCommit"];

  constructor(options: RepositoryStateBoundaryOptions) {
    const directory = path.join(options.commonGitDirectory, REGISTRY_DIRECTORY_NAME);
    this.paths = Object.freeze({
      directory,
      registry: path.join(directory, REGISTRY_FILE_NAME),
      lock: path.join(directory, REGISTRY_LOCK_FILE_NAME),
    });
    this.lock = new RepositoryLock({
      lockPath: this.paths.lock,
      staleAfterMs: options.lockStaleAfterMs,
      acquireTimeoutMs: options.lockTimeoutMs,
      metadataGraceMs: options.lockMetadataGraceMs,
    });
    this.emptyState = options.emptyState;
    this.parseState = options.parseState;
    this.validateCommit = options.validateCommit;
  }

  read(allowLegacyClaimSchema = false): RegistryState {
    let contents: string;
    try {
      contents = fs.readFileSync(this.paths.registry, "utf8");
    } catch (error: unknown) {
      if (error instanceof Error && "code" in error && typeof error.code === "string" && error.code === "ENOENT") {
        return this.emptyState();
      }
      throw new SessionRegistryError(
        "REGISTRY_IO_FAILURE",
        `Could not read ${this.paths.registry}`,
        { path: this.paths.registry },
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
        { path: this.paths.registry },
        error,
      );
    }

    return this.parseState(parsed, allowLegacyClaimSchema);
  }

  commit(document: PersistedRegistryV2): void {
    this.validateCommit(document);
    try {
      writeJsonAtomicallySync(this.paths.registry, document);
    } catch (error: unknown) {
      if (isPostRenameFailure(error)) {
        throw new SessionRegistryError(
          "REGISTRY_DURABILITY_UNCERTAIN",
          `Registry rename to ${this.paths.registry} may have already committed, but durable persistence could not be proven`,
          {
            path: this.paths.registry,
            recoveryHints: [
              "Re-read the registry to check whether the mutation is already visible before retrying.",
              "Do not assume this operation did not happen.",
            ],
          },
          error,
        );
      }
      throw new SessionRegistryError(
        "REGISTRY_IO_FAILURE",
        `Could not atomically write ${this.paths.registry}`,
        { path: this.paths.registry },
        error,
      );
    }
  }

  withLock<T>(operation: () => T): T {
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
    const code: RegistryErrorCode =
      error.code === "LOCK_BUSY" || error.code === "LOCK_STALE" || error.code === "LOCK_INVALID"
        ? "REGISTRY_LOCK_TIMEOUT"
        : "REGISTRY_IO_FAILURE";
    return new SessionRegistryError(code, error.message, details, error);
  }

  return new SessionRegistryError("REGISTRY_IO_FAILURE", `Could not operate on ${lockPath}`, { path: lockPath }, error);
}
