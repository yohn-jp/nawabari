import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import { resolve } from "node:path";

import { RegistryError } from "./errors.js";
import { RepositoryRegistry, type RepositoryRegistryOptions } from "./store.js";

const execFile = promisify(execFileCallback);

export interface RepositoryContext {
  commonGitDirectory: string;
  repositoryId: string;
  worktreePath: string;
}

async function canonicalPath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
}

async function gitValue(cwd: string, argument: string): Promise<string> {
  try {
    const result = await execFile("git", ["rev-parse", argument], {
      cwd,
      encoding: "utf8",
    });
    const value = result.stdout.trim();
    if (value.length === 0) {
      throw new Error(`git rev-parse ${argument} returned an empty value`);
    }
    return value;
  } catch (error) {
    throw new RegistryError(
      "REGISTRY_REPOSITORY_RESOLUTION_FAILED",
      `Cannot resolve repository with git ${argument}`,
      { cwd, argument, cause: error instanceof Error ? error.message : String(error) },
      { cause: error },
    );
  }
}

/** Resolve the repository-common Git state from any worktree. */
export async function resolveRepositoryContext(cwd = process.cwd()): Promise<RepositoryContext> {
  const [commonGitDirectoryValue, worktreePathValue] = await Promise.all([
    gitValue(cwd, "--git-common-dir"),
    gitValue(cwd, "--show-toplevel"),
  ]);
  const commonGitDirectory = await canonicalPath(resolve(cwd, commonGitDirectoryValue));
  const worktreePath = await canonicalPath(worktreePathValue);
  return {
    commonGitDirectory,
    repositoryId: commonGitDirectory,
    worktreePath,
  };
}

export async function openRepositoryRegistry(
  cwd = process.cwd(),
  options: Omit<RepositoryRegistryOptions, "commonGitDirectory" | "repositoryId"> &
    Pick<RepositoryRegistryOptions, "repositoryId"> = {},
): Promise<RepositoryRegistry> {
  const context = await resolveRepositoryContext(cwd);
  return new RepositoryRegistry({
    ...options,
    commonGitDirectory: context.commonGitDirectory,
    repositoryId: options.repositoryId ?? context.repositoryId,
  });
}
