import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";
import { resolveRepositoryContext, type GitCommandRunner } from "./git.js";
import { writeJsonAtomicallySync } from "./registry/atomic.js";
import { RepositoryLock } from "./registry/lock.js";
import { REGISTRY_DIRECTORY_NAME, REGISTRY_FILE_NAME } from "./session-registry.js";

/**
 * Machine-local repository locator catalog for the Control Server.
 *
 * Nawabari's durable state lives inside each repository's common Git
 * directory, so no existing record can enumerate the repositories on this
 * machine. This catalog stores only the identity/path locators needed to
 * reopen those existing repository backends. It never stores session,
 * runtime, claim, filesystem, or snapshot state and is never authority: every
 * read re-resolves Git identity and the repository's own registry.
 */
export const CONTROL_REPOSITORY_CATALOG_SCHEMA_VERSION = 1 as const;
export const CONTROL_REPOSITORY_CATALOG_FILE_NAME = "control-repositories.json";
export const MAX_CONTROL_REPOSITORIES = 256;
const MAX_CATALOG_BYTES = 256 * 1024;
const MAX_LOCATOR_CODE_POINTS = 4_096;

export type RepositoryLocator = Readonly<{
  /** Canonical Nawabari repository identity (the common Git directory). */
  repository_id: string;
  /** Worktree path used to reopen the repository backend. */
  worktree_path: string;
}>;

export type ControlRepository = Readonly<{
  /** Opaque route key derived from the canonical repository identity. */
  repository_key: string;
  repository_id: string;
  worktree_path: string;
  available: boolean;
}>;

/** Default machine-local catalog path; XDG state is ephemeral to Nawabari authority. */
export function defaultControlRepositoryCatalogPath(env: NodeJS.ProcessEnv = process.env): string {
  const stateHome =
    env.XDG_STATE_HOME !== undefined && path.isAbsolute(env.XDG_STATE_HOME)
      ? env.XDG_STATE_HOME
      : path.join(os.homedir(), ".local", "state");
  return path.join(stateHome, "nawabari", CONTROL_REPOSITORY_CATALOG_FILE_NAME);
}

export function repositoryKey(repositoryId: string): string {
  return createHash("sha256").update(repositoryId, "utf8").digest("hex").slice(0, 32);
}

function catalogFailure(catalogPath: string, reason: string): DomainResult<never> {
  return failure(
    new DomainError("INVALID_REGISTRY", "The control repository locator catalog is invalid.", {
      catalog: catalogPath,
      reason,
    }),
  );
}

function boundedLocatorText(value: unknown): value is string {
  return (
    typeof value === "string" &&
    path.isAbsolute(value) &&
    [...value].length <= MAX_LOCATOR_CODE_POINTS &&
    !/\p{Cc}/u.test(value)
  );
}

export function readRepositoryLocators(catalogPath: string): DomainResult<readonly RepositoryLocator[]> {
  let text: string;
  try {
    const stat = fs.statSync(catalogPath);
    if (!stat.isFile() || stat.size > MAX_CATALOG_BYTES) return catalogFailure(catalogPath, "size-or-type");
    text = fs.readFileSync(catalogPath, "utf8");
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return success([]);
    return catalogFailure(catalogPath, "unreadable");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return catalogFailure(catalogPath, "malformed-json");
  }
  const document = parsed as { schema_version?: unknown; repositories?: unknown };
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    document.schema_version !== CONTROL_REPOSITORY_CATALOG_SCHEMA_VERSION ||
    !Array.isArray(document.repositories) ||
    document.repositories.length > MAX_CONTROL_REPOSITORIES
  ) {
    return catalogFailure(catalogPath, "schema");
  }
  const locators: RepositoryLocator[] = [];
  for (const entry of document.repositories as unknown[]) {
    const candidate = entry as { repository_id?: unknown; worktree_path?: unknown } | null;
    if (
      candidate === null ||
      typeof candidate !== "object" ||
      Object.keys(candidate).length !== 2 ||
      !boundedLocatorText(candidate.repository_id) ||
      !boundedLocatorText(candidate.worktree_path)
    ) {
      return catalogFailure(catalogPath, "entry");
    }
    locators.push({ repository_id: candidate.repository_id, worktree_path: candidate.worktree_path });
  }
  return success(locators);
}

function registryExists(repositoryId: string): boolean {
  return fs.existsSync(path.join(repositoryId, REGISTRY_DIRECTORY_NAME, REGISTRY_FILE_NAME));
}

/**
 * Record the Nawabari-managed repository containing `cwd`. Repositories
 * without an existing Nawabari registry are not recorded.
 */
export function registerRepositoryLocator(
  catalogPath: string,
  cwd: string,
  git?: GitCommandRunner,
): DomainResult<RepositoryLocator | null> {
  let locator: RepositoryLocator;
  try {
    const repository = resolveRepositoryContext({ cwd, ...(git === undefined ? {} : { git }) });
    locator = { repository_id: repository.repositoryId, worktree_path: repository.worktreePath };
  } catch {
    return success(null);
  }
  if (!registryExists(locator.repository_id)) return success(null);

  let lease: ReturnType<RepositoryLock["acquireSync"]>;
  try {
    lease = new RepositoryLock({ lockPath: `${catalogPath}.lock` }).acquireSync();
  } catch {
    return catalogFailure(catalogPath, "lock-unavailable");
  }

  let result: DomainResult<RepositoryLocator>;
  try {
    const current = readRepositoryLocators(catalogPath);
    if (!current.ok) {
      result = current;
    } else {
      const existing = current.value.find((entry) => entry.repository_id === locator.repository_id);
      if (existing?.worktree_path === locator.worktree_path) {
        result = success(existing);
      } else {
        const repositories = [
          ...current.value.filter((entry) => entry.repository_id !== locator.repository_id),
          locator,
        ];
        if (repositories.length > MAX_CONTROL_REPOSITORIES) {
          result = catalogFailure(catalogPath, "capacity");
        } else {
          try {
            writeJsonAtomicallySync(catalogPath, {
              schema_version: CONTROL_REPOSITORY_CATALOG_SCHEMA_VERSION,
              repositories,
            });
            result = success(locator);
          } catch {
            result = catalogFailure(catalogPath, "unwritable");
          }
        }
      }
    }
  } catch {
    result = catalogFailure(catalogPath, "unavailable");
  }

  try {
    lease.release();
  } catch {
    return catalogFailure(catalogPath, "lock-release-failed");
  }
  return result;
}

/** Re-resolve each locator against current Git identity and repository persistence. */
export function listControlRepositories(
  catalogPath: string,
  git?: GitCommandRunner,
): DomainResult<readonly ControlRepository[]> {
  const locators = readRepositoryLocators(catalogPath);
  if (!locators.ok) return locators;
  return success(
    locators.value.map((locator) => ({
      repository_key: repositoryKey(locator.repository_id),
      repository_id: locator.repository_id,
      worktree_path: locator.worktree_path,
      available: openRepositoryLocator(locator, git).ok,
    })),
  );
}

/** Reopen one locator; identity drift or a missing registry is not-found, never a new repository. */
export function openRepositoryLocator(
  locator: RepositoryLocator,
  git?: GitCommandRunner,
): DomainResult<{ readonly cwd: string }> {
  const unavailable = failure(
    new DomainError("NOT_GIT_REPOSITORY", "The locally known repository is not currently available.", {
      repository_id: locator.repository_id,
    }),
  );
  try {
    const repository = resolveRepositoryContext({ cwd: locator.worktree_path, ...(git === undefined ? {} : { git }) });
    if (repository.repositoryId !== locator.repository_id || !registryExists(locator.repository_id)) {
      return unavailable;
    }
    return success({ cwd: repository.worktreePath });
  } catch {
    return unavailable;
  }
}
