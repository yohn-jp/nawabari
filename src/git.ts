import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { SessionRegistryError } from "./errors.js";

export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): string;
}

export interface RepositoryContext {
  readonly repositoryId: string;
  readonly commonGitDirectory: string;
  readonly worktreePath: string;
}

export interface WorktreeIdentity {
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
}

export interface GitWorktreeInfo {
  readonly worktreePath: string;
  readonly branchName: string | null;
}

export interface ResolveRepositoryOptions {
  readonly cwd?: string;
  readonly git?: GitCommandRunner;
}

export interface ResolveWorktreeOptions extends ResolveRepositoryOptions {
  readonly repository?: RepositoryContext;
  readonly branchName?: string;
}

export const defaultGit: GitCommandRunner = {
  run(args, cwd): string {
    try {
      return execFileSync("git", [...args], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
    } catch (error: unknown) {
      throw new SessionRegistryError(
        "GIT_COMMAND_FAILED",
        `git ${args.join(" ")} failed in ${cwd}`,
        { command: args.join(" "), cwd },
        error,
      );
    }
  },
};

export function resolveRepositoryContext(options: ResolveRepositoryOptions = {}): RepositoryContext {
  const cwd = canonicalDirectory(options.cwd ?? process.cwd(), "REPOSITORY_IDENTITY_AMBIGUOUS");
  const git = options.git ?? defaultGit;

  let worktreePath: string;
  let commonGitDirectory: string;
  try {
    worktreePath = canonicalDirectory(git.run(["rev-parse", "--show-toplevel"], cwd), "REPOSITORY_IDENTITY_AMBIGUOUS");
    const commonGitDirectoryOutput = git.run(["rev-parse", "--git-common-dir"], cwd);
    const commonGitDirectoryPath = path.isAbsolute(commonGitDirectoryOutput)
      ? commonGitDirectoryOutput
      : path.resolve(cwd, commonGitDirectoryOutput);
    commonGitDirectory = canonicalDirectory(commonGitDirectoryPath, "REPOSITORY_IDENTITY_AMBIGUOUS");
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError && error.code === "REPOSITORY_IDENTITY_AMBIGUOUS") {
      throw error;
    }
    throw new SessionRegistryError(
      "NOT_A_GIT_REPOSITORY",
      `Could not resolve a repository from ${cwd}`,
      { cwd },
      error,
    );
  }

  return Object.freeze({
    repositoryId: commonGitDirectory,
    commonGitDirectory,
    worktreePath,
  });
}

export function resolveWorktreeIdentity(options: ResolveWorktreeOptions = {}): WorktreeIdentity {
  const repository = options.repository ?? resolveRepositoryContext(options);
  const git = options.git ?? defaultGit;
  const branchName = options.branchName ?? readCurrentBranch(git, repository.worktreePath);
  const branchId = normalizeBranchId(branchName);

  return Object.freeze({
    worktreeId: repository.worktreePath,
    worktreePath: repository.worktreePath,
    branchId,
    branchName: branchId.slice("refs/heads/".length),
  });
}

/** Read the repository's local worktree inventory without consulting a remote. */
export function listGitWorktrees(git: GitCommandRunner, cwd: string): readonly GitWorktreeInfo[] {
  const output = git.run(["worktree", "list", "--porcelain"], cwd);
  const entries: GitWorktreeInfo[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | null = null;

  const flush = (): void => {
    if (currentPath === undefined) return;
    entries.push(Object.freeze({ worktreePath: canonicalListedPath(currentPath), branchName: currentBranch }));
    currentPath = undefined;
    currentBranch = null;
  };

  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length);
      continue;
    }
    if (line.startsWith("branch ")) {
      const branchId = line.slice("branch ".length);
      if (branchId.startsWith("refs/heads/")) {
        currentBranch = branchId.slice("refs/heads/".length);
      }
    }
  }
  flush();
  return entries;
}

export function normalizeBranchId(branchName: string): string {
  const trimmed = branchName.trim();
  if (trimmed !== branchName) {
    throw new SessionRegistryError("INVALID_BRANCH_ID", `Invalid branch identity: ${branchName}`, { branchName });
  }
  if (trimmed.startsWith("refs/") && !trimmed.startsWith("refs/heads/")) {
    throw new SessionRegistryError("INVALID_BRANCH_ID", `Invalid local branch identity: ${branchName}`, { branchName });
  }
  const normalized = trimmed.startsWith("refs/heads/") ? trimmed : `refs/heads/${trimmed}`;
  const shortName = normalized.slice("refs/heads/".length);
  const components = shortName.split("/");

  if (
    shortName.length === 0 ||
    shortName.startsWith("/") ||
    shortName.endsWith("/") ||
    shortName.includes("..") ||
    shortName === "@" ||
    shortName.includes("@{") ||
    shortName.endsWith(".") ||
    shortName.endsWith(".lock") ||
    components.some((component) => component.startsWith(".") || component.endsWith(".")) ||
    shortName.includes("//") ||
    /[\u0000-\u0020~^:?*[\\]/u.test(shortName)
  ) {
    throw new SessionRegistryError("INVALID_BRANCH_ID", `Invalid branch identity: ${branchName}`, { branchName });
  }

  return normalized;
}

function canonicalListedPath(candidate: string): string {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function readCurrentBranch(git: GitCommandRunner, cwd: string): string {
  try {
    const branchName = git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
    if (branchName.length === 0) {
      throw new SessionRegistryError("WORKTREE_IDENTITY_AMBIGUOUS", `The worktree at ${cwd} has no branch`, { cwd });
    }
    return branchName;
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError && error.code === "WORKTREE_IDENTITY_AMBIGUOUS") {
      throw error;
    }
    throw new SessionRegistryError(
      "WORKTREE_IDENTITY_AMBIGUOUS",
      `Could not resolve the current branch for ${cwd}`,
      { cwd },
      error,
    );
  }
}

function canonicalDirectory(
  candidate: string,
  errorCode: "REPOSITORY_IDENTITY_AMBIGUOUS" | "WORKTREE_IDENTITY_AMBIGUOUS",
): string {
  if (candidate.trim().length === 0) {
    throw new SessionRegistryError(errorCode, "Git returned an empty directory identity");
  }
  const resolved = path.resolve(candidate);
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error("path is not a directory");
    }
    return fs.realpathSync.native(resolved);
  } catch (error: unknown) {
    throw new SessionRegistryError(
      errorCode,
      `Could not resolve directory identity: ${resolved}`,
      { path: resolved },
      error,
    );
  }
}
