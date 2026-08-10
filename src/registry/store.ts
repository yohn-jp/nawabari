import { realpathSync } from "node:fs";
import { mkdir, readFile as readFileAsync } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

import { writeJsonAtomically, type AtomicWriteHooks } from "./atomic.js";
import { RegistryError } from "./errors.js";
import { RepositoryLock, type RepositoryLockOptions } from "./lock.js";
import {
  OWNERSHIP_MUTATIONS,
  REGISTRY_SCHEMA_VERSION,
  SESSION_LIFECYCLE_STATES,
  type OwnershipMutation,
  type RegistryDocument,
  type RegistryMutator,
  type SessionLifecycleState,
  type SessionRecord,
} from "./types.js";

export interface RepositoryRegistryOptions {
  commonGitDirectory: string;
  repositoryId?: string;
  lock?: Omit<RepositoryLockOptions, "lockPath">;
  atomicWriteHooks?: AtomicWriteHooks;
  now?: () => number;
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }

  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function isLifecycleState(value: unknown): value is SessionLifecycleState {
  return typeof value === "string" && SESSION_LIFECYCLE_STATES.includes(value as SessionLifecycleState);
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function invalidDocument(message: string, details: Readonly<Record<string, unknown>> = {}): RegistryError {
  return new RegistryError("REGISTRY_CORRUPT", message, details);
}

function parseSessionRecord(value: unknown, index: number, repositoryId: string): SessionRecord {
  if (!isRecord(value)) {
    throw invalidDocument("Registry session record is not an object", { index });
  }

  if (typeof value.schemaVersion === "number" && value.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new RegistryError("REGISTRY_UNSUPPORTED_SCHEMA", "Registry session record schema is unsupported", {
      index,
      schemaVersion: value.schemaVersion,
    });
  }

  const recordRepositoryId = value.repositoryId;
  const label = value.label;
  if (
    value.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(recordRepositoryId) ||
    !isNonEmptyString(value.worktreePath) ||
    !isAbsolute(value.worktreePath) ||
    !isNonEmptyString(value.branch) ||
    !isLifecycleState(value.state) ||
    !isTimestamp(value.createdAt) ||
    !isTimestamp(value.updatedAt) ||
    (label !== undefined && typeof label !== "string")
  ) {
    throw invalidDocument("Registry session record has invalid fields", { index });
  }

  if (recordRepositoryId !== repositoryId) {
    throw new RegistryError("REGISTRY_REPOSITORY_MISMATCH", "Registry session belongs to another repository", {
      index,
      expectedRepositoryId: repositoryId,
      actualRepositoryId: recordRepositoryId,
    });
  }

  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    sessionId: value.sessionId,
    repositoryId: recordRepositoryId,
    worktreePath: value.worktreePath,
    branch: value.branch,
    state: value.state,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
    ...(label === undefined ? {} : { label }),
  };
}

function ownsResources(record: SessionRecord): boolean {
  return record.state !== "closed";
}

export function validateRegistryDocument(document: RegistryDocument, expectedRepositoryId?: string): void {
  if (document.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new RegistryError("REGISTRY_UNSUPPORTED_SCHEMA", "Registry document schema is unsupported", {
      schemaVersion: document.schemaVersion,
    });
  }
  if (!isNonEmptyString(document.repositoryId)) {
    throw invalidDocument("Registry repository identity is missing");
  }
  if (expectedRepositoryId !== undefined && document.repositoryId !== expectedRepositoryId) {
    throw new RegistryError("REGISTRY_REPOSITORY_MISMATCH", "Registry belongs to another repository", {
      expectedRepositoryId,
      actualRepositoryId: document.repositoryId,
    });
  }
  if (!isTimestamp(document.updatedAt) || !Array.isArray(document.sessions)) {
    throw invalidDocument("Registry document has invalid top-level fields");
  }

  const sessionIds = new Set<string>();
  const worktrees = new Map<string, string>();
  const branches = new Map<string, string>();
  for (const [index, record] of document.sessions.entries()) {
    if (!isRecord(record)) {
      throw invalidDocument("Registry session record is not an object", { index });
    }
    if (record.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
      throw new RegistryError("REGISTRY_UNSUPPORTED_SCHEMA", "Registry session record schema is unsupported", {
        index,
        schemaVersion: record.schemaVersion,
      });
    }
    if (record.repositoryId !== document.repositoryId) {
      throw new RegistryError("REGISTRY_REPOSITORY_MISMATCH", "Registry session repository differs from document", {
        index,
        expectedRepositoryId: document.repositoryId,
        actualRepositoryId: record.repositoryId,
      });
    }
    if (
      !isNonEmptyString(record.sessionId) ||
      !isNonEmptyString(record.worktreePath) ||
      !isAbsolute(record.worktreePath)
    ) {
      throw invalidDocument("Registry session identity is invalid", { index });
    }
    if (!isNonEmptyString(record.branch) || !isLifecycleState(record.state)) {
      throw invalidDocument("Registry session ownership fields are invalid", { index });
    }
    if (!isTimestamp(record.createdAt) || !isTimestamp(record.updatedAt)) {
      throw invalidDocument("Registry session timestamp is invalid", { index });
    }
    if (record.label !== undefined && typeof record.label !== "string") {
      throw invalidDocument("Registry session label is invalid", { index });
    }
    if (sessionIds.has(record.sessionId)) {
      throw new RegistryError("REGISTRY_DUPLICATE_SESSION", "Registry contains duplicate session ownership", {
        index,
        sessionId: record.sessionId,
      });
    }
    sessionIds.add(record.sessionId);

    if (!ownsResources(record)) {
      continue;
    }

    const normalizedWorktree = canonicalPath(record.worktreePath);
    const previousWorktreeOwner = worktrees.get(normalizedWorktree);
    if (previousWorktreeOwner !== undefined) {
      throw new RegistryError("REGISTRY_DUPLICATE_WORKTREE", "Registry contains duplicate active worktree ownership", {
        index,
        worktreePath: record.worktreePath,
        ownerSessionId: previousWorktreeOwner,
        sessionId: record.sessionId,
      });
    }
    worktrees.set(normalizedWorktree, record.sessionId);

    const previousBranchOwner = branches.get(record.branch);
    if (previousBranchOwner !== undefined) {
      throw new RegistryError("REGISTRY_DUPLICATE_BRANCH", "Registry contains duplicate active branch ownership", {
        index,
        branch: record.branch,
        ownerSessionId: previousBranchOwner,
        sessionId: record.sessionId,
      });
    }
    branches.set(record.branch, record.sessionId);
  }
}

export function parseRegistryDocument(raw: unknown, expectedRepositoryId?: string): RegistryDocument {
  if (!isRecord(raw)) {
    throw invalidDocument("Registry document is not an object");
  }
  if (typeof raw.schemaVersion === "number" && raw.schemaVersion !== REGISTRY_SCHEMA_VERSION) {
    throw new RegistryError("REGISTRY_UNSUPPORTED_SCHEMA", "Registry document schema is unsupported", {
      schemaVersion: raw.schemaVersion,
    });
  }
  const repositoryId = raw.repositoryId;
  const updatedAt = raw.updatedAt;
  const sessionsValue = raw.sessions;
  if (
    raw.schemaVersion !== REGISTRY_SCHEMA_VERSION ||
    !isNonEmptyString(repositoryId) ||
    !isTimestamp(updatedAt) ||
    !Array.isArray(sessionsValue)
  ) {
    throw invalidDocument("Registry document has invalid fields");
  }

  const sessions = sessionsValue.map((record, index) => parseSessionRecord(record, index, repositoryId));
  const document: RegistryDocument = {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    repositoryId,
    updatedAt,
    sessions,
  };
  validateRegistryDocument(document, expectedRepositoryId);
  return document;
}

export function createEmptyRegistry(repositoryId: string, now = Date.now()): RegistryDocument {
  return {
    schemaVersion: REGISTRY_SCHEMA_VERSION,
    repositoryId,
    updatedAt: new Date(now).toISOString(),
    sessions: [],
  };
}

function cloneDocument(document: RegistryDocument): RegistryDocument {
  return {
    schemaVersion: document.schemaVersion,
    repositoryId: document.repositoryId,
    updatedAt: document.updatedAt,
    sessions: document.sessions.map((record) => ({ ...record })),
  };
}

function mutationError(operation: OwnershipMutation, error: unknown): RegistryError {
  if (error instanceof RegistryError) {
    return error;
  }
  return new RegistryError(
    "REGISTRY_MUTATION_FAILED",
    `Registry ${operation} mutation failed`,
    { operation, cause: error instanceof Error ? error.message : String(error) },
    { cause: error },
  );
}

export class RepositoryRegistry {
  public readonly commonGitDirectory: string;
  public readonly repositoryId: string;
  public readonly registryDirectory: string;
  public readonly registryPath: string;
  public readonly lockPath: string;
  private readonly lock: RepositoryLock;
  private readonly atomicWriteHooks?: AtomicWriteHooks;
  private readonly now: () => number;

  public constructor(options: RepositoryRegistryOptions) {
    this.commonGitDirectory = canonicalPath(options.commonGitDirectory);
    this.repositoryId = options.repositoryId ?? this.commonGitDirectory;
    if (!isNonEmptyString(this.repositoryId)) {
      throw new TypeError("repositoryId must be a non-empty string");
    }
    this.registryDirectory = join(this.commonGitDirectory, "gitpaw");
    this.registryPath = join(this.registryDirectory, "registry.json");
    this.lockPath = join(this.registryDirectory, "registry.lock");
    this.lock = new RepositoryLock({
      ...(options.lock ?? {}),
      lockPath: this.lockPath,
    });
    this.atomicWriteHooks = options.atomicWriteHooks;
    this.now = options.now ?? Date.now;
  }

  public async read(): Promise<RegistryDocument> {
    let raw: string;
    try {
      raw = await readFileAsync(this.registryPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new RegistryError("REGISTRY_NOT_FOUND", "Repository registry has not been initialized", {
          registryPath: this.registryPath,
        });
      }
      throw new RegistryError(
        "REGISTRY_IO_ERROR",
        "Cannot read repository registry",
        { registryPath: this.registryPath, cause: error instanceof Error ? error.message : String(error) },
        { cause: error },
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new RegistryError(
        "REGISTRY_CORRUPT",
        "Repository registry is not valid JSON",
        { registryPath: this.registryPath, cause: error instanceof Error ? error.message : String(error) },
        { cause: error },
      );
    }

    return parseRegistryDocument(parsed, this.repositoryId);
  }

  /**
   * Run one ownership-changing operation under the repository-scoped lock.
   * The callback supplies product semantics; this boundary only serializes,
   * validates, and atomically commits the resulting registry document.
   */
  public async mutate<T>(operation: OwnershipMutation, mutator: RegistryMutator<T>): Promise<T> {
    if (!OWNERSHIP_MUTATIONS.includes(operation)) {
      throw new TypeError(`Unsupported registry mutation: ${operation}`);
    }

    const lease = await this.lock.acquire();
    let result!: T;
    let failed = false;
    let operationError: unknown;
    try {
      let current: RegistryDocument;
      try {
        current = await this.read();
      } catch (error) {
        if (error instanceof RegistryError && error.code === "REGISTRY_NOT_FOUND") {
          current = createEmptyRegistry(this.repositoryId, this.now());
        } else {
          throw error;
        }
      }

      const draft = cloneDocument(current);
      try {
        result = await mutator(draft);
      } catch (error) {
        failed = true;
        operationError = mutationError(operation, error);
      }

      if (!failed) {
        draft.updatedAt = new Date(this.now()).toISOString();
        try {
          validateRegistryDocument(draft, this.repositoryId);
          await mkdir(this.registryDirectory, { recursive: true, mode: 0o700 });
          await writeJsonAtomically(this.registryPath, draft, {
            hooks: this.atomicWriteHooks,
          });
        } catch (error) {
          failed = true;
          operationError = mutationError(operation, error);
        }
      }
    } catch (error) {
      failed = true;
      operationError = mutationError(operation, error);
    }

    try {
      await lease.release();
    } catch (error) {
      if (!failed) {
        failed = true;
        operationError = new RegistryError(
          "LOCK_RELEASE_FAILED",
          `Registry ${operation} completed but lock release failed`,
          { operation, cause: error instanceof Error ? error.message : String(error) },
          { cause: error },
        );
      }
    }

    if (failed) {
      throw operationError;
    }
    return result;
  }

  public create<T>(mutator: RegistryMutator<T>): Promise<T> {
    return this.mutate("create", mutator);
  }

  public claim<T>(mutator: RegistryMutator<T>): Promise<T> {
    return this.mutate("claim", mutator);
  }

  public close<T>(mutator: RegistryMutator<T>): Promise<T> {
    return this.mutate("close", mutator);
  }

  public release<T>(mutator: RegistryMutator<T>): Promise<T> {
    return this.mutate("release", mutator);
  }

  public gc<T>(mutator: RegistryMutator<T>): Promise<T> {
    return this.mutate("gc", mutator);
  }
}
