import { mkdir, readFile as readFileAsync } from "node:fs/promises";
import { join, resolve } from "node:path";

import { writeJsonAtomically, type AtomicWriteHooks } from "./atomic.js";
import { RegistryError } from "./errors.js";
import { RepositoryLock, type RepositoryLockOptions } from "./lock.js";
import { OWNERSHIP_MUTATIONS, type OwnershipMutation, type RegistryCodec, type RegistryMutator } from "./types.js";

export interface RegistryMutationBoundaryOptions<State> {
  commonGitDirectory: string;
  codec: RegistryCodec<State>;
  registryDirectory?: string;
  registryPath?: string;
  lockPath?: string;
  registryDirectoryName?: string;
  registryFileName?: string;
  lockFileName?: string;
  lock?: Omit<RepositoryLockOptions, "lockPath">;
  atomicWriteHooks?: AtomicWriteHooks;
}

function errorCode(error: unknown): string | undefined {
  if (!(error instanceof Error) || !("code" in error)) {
    return undefined;
  }
  const code = error.code;
  return typeof code === "string" ? code : undefined;
}

function isRegistryError(error: unknown): error is RegistryError {
  return error instanceof RegistryError;
}

function wrapMutationError(operation: OwnershipMutation, error: unknown): RegistryError {
  if (isRegistryError(error)) {
    return error;
  }
  return new RegistryError(
    "REGISTRY_MUTATION_FAILED",
    `Registry ${operation} mutation failed`,
    { operation, cause: error instanceof Error ? error.message : String(error) },
    { cause: error },
  );
}

function wrapIoError(message: string, path: string, error: unknown): RegistryError {
  if (isRegistryError(error)) {
    return error;
  }
  return new RegistryError(
    "REGISTRY_IO_ERROR",
    message,
    { path, cause: error instanceof Error ? error.message : String(error) },
    { cause: error },
  );
}

/**
 * Repository-scoped persistence boundary for ownership-changing operations.
 * The codec is supplied by the domain registry (for example #7); this
 * module does not define session, worktree, branch, or lifecycle semantics.
 */
export class RegistryMutationBoundary<State> {
  public readonly commonGitDirectory: string;
  public readonly registryDirectory: string;
  public readonly registryPath: string;
  public readonly lockPath: string;
  private readonly codec: RegistryCodec<State>;
  private readonly lock: RepositoryLock;
  private readonly atomicWriteHooks?: AtomicWriteHooks;

  public constructor(options: RegistryMutationBoundaryOptions<State>) {
    this.commonGitDirectory = resolve(options.commonGitDirectory);
    this.registryDirectory =
      options.registryDirectory ?? join(this.commonGitDirectory, options.registryDirectoryName ?? "nawabari");
    this.registryPath =
      options.registryPath ?? join(this.registryDirectory, options.registryFileName ?? "registry.json");
    this.lockPath = options.lockPath ?? join(this.registryDirectory, options.lockFileName ?? "registry.lock");
    this.codec = options.codec;
    this.lock = new RepositoryLock({
      ...(options.lock ?? {}),
      lockPath: this.lockPath,
    });
    this.atomicWriteHooks = options.atomicWriteHooks;
  }

  public async read(): Promise<State> {
    let raw: string;
    try {
      raw = await readFileAsync(this.registryPath, "utf8");
    } catch (error) {
      if (errorCode(error) === "ENOENT") {
        throw new RegistryError("REGISTRY_NOT_FOUND", "Registry has not been initialized", {
          path: this.registryPath,
        });
      }
      throw wrapIoError("Cannot read registry", this.registryPath, error);
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      throw new RegistryError(
        "REGISTRY_CORRUPT",
        "Registry authoritative state is not valid JSON",
        { path: this.registryPath, cause: error instanceof Error ? error.message : String(error) },
        { cause: error },
      );
    }

    try {
      const state = this.codec.parse(parsed);
      this.codec.validate(state);
      return state;
    } catch (error) {
      if (isRegistryError(error)) {
        throw error;
      }
      throw new RegistryError(
        "REGISTRY_CORRUPT",
        "Registry codec rejected authoritative state",
        { path: this.registryPath, cause: error instanceof Error ? error.message : String(error) },
        { cause: error },
      );
    }
  }

  /** Serialize, validate, and commit one ownership mutation under one lock. */
  public async mutate<Result>(operation: OwnershipMutation, mutator: RegistryMutator<State, Result>): Promise<Result> {
    if (!OWNERSHIP_MUTATIONS.includes(operation)) {
      throw new TypeError(`Unsupported registry mutation: ${operation}`);
    }

    const lease = await this.lock.acquire();
    let result!: Result;
    let failed = false;
    let operationError: unknown;
    try {
      let state: State;
      try {
        state = await this.read();
      } catch (error) {
        if (isRegistryError(error) && error.code === "REGISTRY_NOT_FOUND") {
          state = this.codec.empty();
        } else {
          throw error;
        }
      }

      try {
        result = await mutator(state);
        this.codec.validate(state);
        const persisted = this.codec.serialize === undefined ? state : this.codec.serialize(state);
        await mkdir(this.registryDirectory, { recursive: true, mode: 0o700 });
        await writeJsonAtomically(this.registryPath, persisted, { hooks: this.atomicWriteHooks });
      } catch (error) {
        failed = true;
        operationError = wrapMutationError(operation, error);
      }
    } catch (error) {
      failed = true;
      operationError = wrapMutationError(operation, error);
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

  public create<Result>(mutator: RegistryMutator<State, Result>): Promise<Result> {
    return this.mutate("create", mutator);
  }

  public claim<Result>(mutator: RegistryMutator<State, Result>): Promise<Result> {
    return this.mutate("claim", mutator);
  }

  public close<Result>(mutator: RegistryMutator<State, Result>): Promise<Result> {
    return this.mutate("close", mutator);
  }

  public release<Result>(mutator: RegistryMutator<State, Result>): Promise<Result> {
    return this.mutate("release", mutator);
  }

  public gc<Result>(mutator: RegistryMutator<State, Result>): Promise<Result> {
    return this.mutate("gc", mutator);
  }
}
