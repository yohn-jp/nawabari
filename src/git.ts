import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { SessionRegistryError } from "./errors.js";
import { CHECKPOINT_MAX_PATHS, type GitCheckpointPaths } from "./operation-authorization.js";
import { canonicalizeConcretePath } from "./resource-claims.js";

export const GIT_COMMAND_TIMEOUT_MS = 10_000;
export const GIT_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
export const REPOSITORY_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const DIFF_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_MAX_DIFF_PATHS = 64 as const;
export const EVIDENCE_MAX_DIFF_BYTES = GIT_COMMAND_MAX_OUTPUT_BYTES;
export const EVIDENCE_MAX_DIFF_HUNKS = 128 as const;
const MAX_ERROR_DETAIL_LENGTH = 4_096;

export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): string;
  /** Preserve leading/trailing whitespace for NUL-delimited Git records. */
  readonly runRaw?: (args: readonly string[], cwd: string) => string;
}

export interface GitCommandRunnerOptions {
  readonly executable?: string;
  readonly timeoutMs?: number;
  readonly maxOutputBytes?: number;
  readonly env?: NodeJS.ProcessEnv;
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
  readonly headId: string;
}

export interface GitWorktreeInfo {
  readonly worktreePath: string;
  readonly branchName: string | null;
  readonly prunable: boolean;
}

export interface ResolveRepositoryOptions {
  readonly cwd?: string;
  readonly git?: GitCommandRunner;
}

export interface ResolveWorktreeOptions extends ResolveRepositoryOptions {
  readonly repository?: RepositoryContext;
  /** Legacy name retained as an expected value; Git remains authoritative. */
  readonly branchName?: string;
  readonly worktreePath?: string;
  readonly expectedWorktreePath?: string;
}

export interface PhysicalExecutionContext {
  readonly repositoryId: string;
  readonly commonGitDirectory: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly headId: string;
  readonly worktree: GitWorktreeInfo;
  readonly worktrees: readonly GitWorktreeInfo[];
}

export function createGitCommandRunner(options: GitCommandRunnerOptions = {}): GitCommandRunner {
  const executable = options.executable ?? "git";
  const timeoutMs = options.timeoutMs ?? GIT_COMMAND_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? GIT_COMMAND_MAX_OUTPUT_BYTES;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    throw new RangeError("Git command timeout must be a positive safe integer");
  }
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1) {
    throw new RangeError("Git command output limit must be a positive safe integer");
  }

  const execute = (args: readonly string[], cwd: string): string => {
    const command = args.map((argument) => boundedDetail(argument)).join(" ");
    try {
      return String(
        execFileSync(executable, [...args], {
          cwd,
          encoding: "utf8",
          maxBuffer: maxOutputBytes,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: timeoutMs,
          env: {
            ...process.env,
            ...options.env,
            GIT_TERMINAL_PROMPT: "0",
            GIT_OPTIONAL_LOCKS: "0",
          },
        }),
      );
    } catch (error: unknown) {
      throw gitProcessError(error, command, cwd);
    }
  };

  return Object.freeze({
    run(args: readonly string[], cwd: string): string {
      return execute(args, cwd).trim();
    },
    runRaw(args: readonly string[], cwd: string): string {
      return execute(args, cwd);
    },
  });
}

export const defaultGit: GitCommandRunner = createGitCommandRunner();

export function resolveRepositoryContext(options: ResolveRepositoryOptions = {}): RepositoryContext {
  const cwd = canonicalDirectory(options.cwd ?? process.cwd(), "REPOSITORY_IDENTITY_AMBIGUOUS", "MISSING_WORKTREE");
  const git = options.git ?? defaultGit;

  let worktreePath: string;
  let commonGitDirectory: string;
  try {
    worktreePath = canonicalDirectory(git.run(["rev-parse", "--show-toplevel"], cwd), "REPOSITORY_IDENTITY_AMBIGUOUS");
    const commonGitDirectoryOutput = git.run(["rev-parse", "--git-common-dir"], cwd);
    if (commonGitDirectoryOutput.length === 0) {
      throw new SessionRegistryError("REPOSITORY_IDENTITY_AMBIGUOUS", "Git returned an empty common directory");
    }
    const commonGitDirectoryPath = path.isAbsolute(commonGitDirectoryOutput)
      ? commonGitDirectoryOutput
      : path.resolve(cwd, commonGitDirectoryOutput);
    commonGitDirectory = canonicalDirectory(commonGitDirectoryPath, "REPOSITORY_IDENTITY_AMBIGUOUS");

    const gitDirectoryOutput = git.run(["rev-parse", "--git-dir"], cwd);
    if (gitDirectoryOutput.length === 0) {
      throw new SessionRegistryError("REPOSITORY_IDENTITY_AMBIGUOUS", "Git returned an empty Git directory");
    }
    const gitDirectoryPath = path.isAbsolute(gitDirectoryOutput)
      ? gitDirectoryOutput
      : path.resolve(cwd, gitDirectoryOutput);
    const gitDirectory = canonicalDirectory(gitDirectoryPath, "REPOSITORY_IDENTITY_AMBIGUOUS");
    if (!isPathInside(commonGitDirectory, gitDirectory)) {
      throw new SessionRegistryError(
        "REPOSITORY_IDENTITY_AMBIGUOUS",
        "Git worktree metadata is outside the repository common directory",
        { commonGitDirectory, gitDirectory },
      );
    }
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) {
      if (
        error.code === "REPOSITORY_IDENTITY_AMBIGUOUS" ||
        error.code === "GIT_SPAWN_FAILED" ||
        error.code === "GIT_TIMEOUT" ||
        error.code === "GIT_OUTPUT_LIMIT" ||
        error.code === "PHYSICAL_OBSERVATION_UNAVAILABLE"
      ) {
        throw error;
      }
      if (
        error.code === "GIT_COMMAND_FAILED" &&
        (error.details.exitCode === undefined || error.details.exitCode === 128)
      ) {
        throw new SessionRegistryError(
          "NOT_A_GIT_REPOSITORY",
          `Could not resolve a repository from ${cwd}`,
          { cwd },
          error,
        );
      }
      throw error;
    }
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      `Could not observe repository identity from ${cwd}`,
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

function readBranchOrDetached(git: GitCommandRunner, cwd: string): string {
  try {
    return readCurrentBranch(git, cwd);
  } catch (error: unknown) {
    if (
      error instanceof SessionRegistryError &&
      error.code === "WORKTREE_IDENTITY_AMBIGUOUS" &&
      error.details.reason === "detached-head"
    ) {
      throw new SessionRegistryError("DETACHED_HEAD", `The worktree at ${cwd} has no branch`, { worktree: cwd }, error);
    }
    throw error;
  }
}

export function resolveWorktreeIdentity(options: ResolveWorktreeOptions = {}): WorktreeIdentity {
  let context: PhysicalExecutionContext;
  try {
    context = verifyPhysicalExecutionContext(options);
  } catch (error: unknown) {
    // Keep the pre-#37 public resolver code while the reusable verifier exposes
    // the more precise detached-head reason to governed callers.
    if (error instanceof SessionRegistryError && error.code === "DETACHED_HEAD") {
      throw new SessionRegistryError("WORKTREE_IDENTITY_AMBIGUOUS", error.message, error.details, error);
    }
    throw error;
  }
  return Object.freeze({
    worktreeId: context.worktreeId,
    worktreePath: context.worktreePath,
    branchId: context.branchId,
    branchName: context.branchName,
    headId: context.headId,
  });
}

/**
 * Verify the physical repository/worktree facts used by governed operations.
 * Every identity in the returned value is observed from Git or canonicalized
 * filesystem state; caller values are expectations only.
 */
export function verifyPhysicalExecutionContext(options: ResolveWorktreeOptions = {}): PhysicalExecutionContext {
  const git = options.git ?? defaultGit;
  const targetPath = options.worktreePath ?? options.cwd ?? options.repository?.worktreePath ?? process.cwd();
  const expectedWorktreePath =
    options.expectedWorktreePath ??
    options.worktreePath ??
    (options.cwd === undefined && options.repository !== undefined ? options.repository.worktreePath : undefined);

  assertDirectoryPath(targetPath);

  const repository = resolveRepositoryContext({ cwd: targetPath, git });
  if (options.repository !== undefined && repository.repositoryId !== options.repository.repositoryId) {
    throw new SessionRegistryError(
      "REPOSITORY_MISMATCH",
      "The observed Git common directory does not match the expected repository",
      {
        expectedRepositoryId: options.repository.repositoryId,
        actualRepositoryId: repository.repositoryId,
      },
    );
  }

  if (expectedWorktreePath !== undefined) {
    const expected = canonicalDirectory(expectedWorktreePath, "WORKTREE_IDENTITY_AMBIGUOUS", "MISSING_WORKTREE");
    if (expected !== repository.worktreePath) {
      throw new SessionRegistryError(
        "WORKTREE_MISMATCH",
        "The observed Git worktree does not match the expected worktree",
        { expectedWorktree: expected, actualWorktree: repository.worktreePath },
      );
    }
  }

  const branchName = readBranchOrDetached(git, repository.worktreePath);
  const branchId = normalizeBranchId(branchName);
  const headId = readCurrentHead(git, repository.worktreePath);
  const worktrees = listGitWorktrees(git, repository.worktreePath);
  const matches = worktrees.filter((worktree) => worktree.worktreePath === repository.worktreePath);
  if (matches.length === 0) {
    throw new SessionRegistryError("MISSING_WORKTREE", "Git did not report the current worktree", {
      worktree: repository.worktreePath,
    });
  }
  if (matches.length > 1) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git reported multiple entries for the current worktree", {
      worktree: repository.worktreePath,
    });
  }
  const worktree = matches[0];
  if (worktree.prunable) {
    throw new SessionRegistryError("MISSING_WORKTREE", "Git marks the current worktree as prunable", {
      worktree: repository.worktreePath,
      prunable: true,
    });
  }
  if (worktree.branchName !== branchName) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git worktree inventory disagrees with the current branch", {
      worktree: repository.worktreePath,
      inventoryBranch: worktree.branchName ?? "<detached>",
      currentBranch: branchName,
    });
  }
  try {
    normalizeBranchId(worktree.branchName);
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "GIT_STATE_AMBIGUOUS",
      "Git worktree inventory contains an invalid branch identity",
      { worktree: repository.worktreePath, branch: worktree.branchName },
      error,
    );
  }

  const finalBranchName = readBranchOrDetached(git, repository.worktreePath);
  const finalHeadId = readCurrentHead(git, repository.worktreePath);
  if (finalBranchName !== branchName || finalHeadId !== headId) {
    throw new SessionRegistryError(
      "GIT_STATE_AMBIGUOUS",
      "The repository/worktree identity changed during physical observation",
      {
        worktree: repository.worktreePath,
        initialBranch: branchName,
        finalBranch: finalBranchName,
        initialHead: headId,
        finalHead: finalHeadId,
      },
    );
  }

  if (options.branchName !== undefined && normalizeBranchId(options.branchName) !== branchId) {
    throw new SessionRegistryError("BRANCH_MISMATCH", "The observed Git branch does not match the expected branch", {
      expectedBranch: options.branchName,
      actualBranch: branchName,
    });
  }

  return Object.freeze({
    repositoryId: repository.repositoryId,
    commonGitDirectory: repository.commonGitDirectory,
    worktreeId: repository.worktreePath,
    worktreePath: repository.worktreePath,
    branchId,
    branchName,
    headId,
    worktree,
    worktrees,
  });
}

/** Read the repository's local worktree inventory without consulting a remote. */
export function listGitWorktrees(git: GitCommandRunner, cwd: string): readonly GitWorktreeInfo[] {
  let output: string;
  try {
    output = git.run(["worktree", "list", "--porcelain"], cwd);
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not observe Git worktrees",
      { cwd },
      error,
    );
  }
  const entries: GitWorktreeInfo[] = [];
  let currentPath: string | undefined;
  let currentBranch: string | null = null;
  let currentPrunable = false;

  const flush = (): void => {
    if (currentPath === undefined) return;
    const worktreePath = canonicalListedPath(currentPath);
    if (entries.some((entry) => entry.worktreePath === worktreePath)) {
      throw new SessionRegistryError(
        "GIT_STATE_AMBIGUOUS",
        `Git reported the worktree more than once: ${worktreePath}`,
        {
          worktree: worktreePath,
        },
      );
    }
    entries.push(
      Object.freeze({
        worktreePath,
        branchName: currentBranch,
        prunable: currentPrunable,
      }),
    );
    currentPath = undefined;
    currentBranch = null;
    currentPrunable = false;
  };

  for (const line of output.split(/\r?\n/u)) {
    if (line.startsWith("worktree ")) {
      flush();
      currentPath = line.slice("worktree ".length);
      if (currentPath.length === 0) {
        throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git reported an empty worktree path");
      }
      continue;
    }
    if (line.startsWith("branch ")) {
      const branchId = line.slice("branch ".length);
      if (branchId.startsWith("refs/heads/")) {
        if (currentBranch !== null) {
          throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git reported multiple branches for one worktree");
        }
        currentBranch = branchId.slice("refs/heads/".length);
      }
      continue;
    }
    if (line === "prunable" || line.startsWith("prunable ")) {
      currentPrunable = true;
    }
  }
  flush();
  return entries;
}

/**
 * Capture only the paths Git currently exposes as changed, staged, unstaged,
 * or untracked. This is evidence, not an OS-level write monitor.
 */
export function captureGitCheckpoint(git: GitCommandRunner, cwd: string): GitCheckpointPaths {
  let output: string;
  try {
    const run = git.runRaw ?? git.run;
    output = run(["status", "--porcelain=v1", "--untracked-files=all", "--ignored=no", "-z"], cwd);
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not observe Git checkpoint paths",
      {
        cwd,
      },
      error,
    );
  }

  const changed = new Set<string>();
  const staged = new Set<string>();
  const unstaged = new Set<string>();
  const untracked = new Set<string>();
  const records = output.split("\u0000");

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (record.length === 0) continue;
    if (record.length < 4 || record[2] !== " ") {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid status record", { cwd });
    }

    const indexStatus = record[0];
    const worktreeStatus = record[1];
    const paths = [record.slice(3)];
    if (indexStatus === "R" || indexStatus === "C") {
      const source = records[index + 1];
      if (source === undefined || source.length === 0) {
        throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an incomplete rename status record", {
          cwd,
        });
      }
      index += 1;
      paths.push(source);
    }

    for (const resource of paths) {
      if (resource.length === 0 || resource.includes("\u0000")) {
        throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid changed path", { cwd });
      }
      changed.add(resource);
      if (indexStatus !== " " && indexStatus !== "?") staged.add(resource);
      if (worktreeStatus !== " " && worktreeStatus !== "?") unstaged.add(resource);
      if (indexStatus === "?" && worktreeStatus === "?") untracked.add(resource);
      if (changed.size > CHECKPOINT_MAX_PATHS) {
        throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Git checkpoint contains too many paths", {
          cwd,
          maxPaths: CHECKPOINT_MAX_PATHS,
        });
      }
    }
  }

  return Object.freeze({
    changed: sortGitPaths(changed),
    staged: sortGitPaths(staged),
    unstaged: sortGitPaths(unstaged),
    untracked: sortGitPaths(untracked),
  });
}

/**
 * Read the exact set of paths a resulting commit actually changed, directly
 * from Git rather than from pre-commit staging intent. Bounded and NUL-safe,
 * mirroring captureGitCheckpoint's evidence guarantees.
 */
export function readCommitChangedPaths(git: GitCommandRunner, cwd: string, commitSha: string): readonly string[] {
  let output: string;
  try {
    const run = git.runRaw ?? git.run;
    output = run(["diff-tree", "--no-commit-id", "--name-only", "-r", "--root", "-z", commitSha], cwd);
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not observe the resulting commit's changed paths",
      { cwd, commitSha },
      error,
    );
  }

  const paths = new Set<string>();
  const records = output.endsWith("\n") ? output.slice(0, -1).split("\u0000") : output.split("\u0000");
  for (const record of records) {
    if (record.length === 0) continue;
    paths.add(record);
    if (paths.size > CHECKPOINT_MAX_PATHS) {
      throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Committed path set exceeds the bounded evidence limit", {
        cwd,
        commitSha,
        maxPaths: CHECKPOINT_MAX_PATHS,
      });
    }
  }
  return sortGitPaths(paths);
}

/**
 * Canonicalize concrete paths reported by Git against the physical worktree.
 * Git-observed paths are not glob patterns, so literal `*` and `?` characters
 * remain valid filename characters. Any path that cannot be represented as a
 * canonical repository resource fails closed as ambiguous Git state.
 */
export function canonicalizeGitObservedPaths(paths: readonly string[], worktreePath: string): readonly string[] {
  const canonical = new Set<string>();
  for (const resource of paths) {
    try {
      canonical.add(canonicalizeConcretePath(resource, worktreePath));
    } catch (error: unknown) {
      throw new SessionRegistryError(
        "GIT_STATE_AMBIGUOUS",
        "Git reported a path that cannot be represented as a canonical repository resource",
        { path: resource },
        error,
      );
    }
  }
  return sortGitPaths(canonical);
}

/** Observe and canonicalize all bounded Git checkpoint path sets. */
export function observeGitCheckpoint(git: GitCommandRunner, cwd: string): GitCheckpointPaths {
  const observed = captureGitCheckpoint(git, cwd);
  return Object.freeze({
    changed: canonicalizeGitObservedPaths(observed.changed, cwd),
    staged: canonicalizeGitObservedPaths(observed.staged, cwd),
    unstaged: canonicalizeGitObservedPaths(observed.unstaged, cwd),
    untracked: canonicalizeGitObservedPaths(observed.untracked, cwd),
  });
}

export interface GitMutationPaths {
  readonly changed: readonly string[];
  readonly staged: readonly string[];
}

export interface GitPathStat {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean | null;
  /** False means Git did not expose a stat for this requested path. */
  readonly available: boolean;
}

export interface BoundedGitDiffOptions {
  readonly paths: readonly string[];
  readonly from?: string;
  readonly to?: string;
  readonly includePatch?: boolean;
  readonly maxBytes?: number;
  readonly maxHunks?: number;
}

export interface BoundedGitDiff {
  readonly schemaVersion: typeof DIFF_EVIDENCE_SCHEMA_VERSION;
  readonly fromRevision: string;
  readonly toRevision: string | null;
  readonly paths: readonly string[];
  readonly stats: readonly GitPathStat[];
  readonly patch: string | null;
  readonly patchBytes: number;
  readonly hunkCount: number;
}

/** Observe the canonical changed/staged sets used by governed mutations. */
export function observeGitMutationPaths(git: GitCommandRunner, cwd: string): GitMutationPaths {
  const observed = observeGitCheckpoint(git, cwd);
  return Object.freeze({ changed: observed.changed, staged: observed.staged });
}

/** Read and canonicalize the exact paths changed by a resulting commit. */
export function readCanonicalCommitChangedPaths(
  git: GitCommandRunner,
  cwd: string,
  commitSha: string,
): readonly string[] {
  return canonicalizeGitObservedPaths(readCommitChangedPaths(git, cwd, commitSha), cwd);
}

/**
 * Read bounded per-path Git statistics. The caller must provide explicit
 * concrete paths; an empty path selection is rejected so this cannot become a
 * repository-wide diff browser.
 */
export function readGitPathStats(
  git: GitCommandRunner,
  cwd: string,
  paths: readonly string[],
  from = "HEAD",
  to?: string,
): readonly GitPathStat[] {
  const canonicalPaths = canonicalizeDiffPaths(paths, cwd);
  const range = resolveDiffRange(git, cwd, from, to);
  return readGitPathStatsForRange(git, cwd, canonicalPaths, range.fromRevision, range.toRevision);
}

/** Read a selected, byte- and hunk-bounded diff plus its canonical path stats. */
export function readBoundedGitDiff(git: GitCommandRunner, cwd: string, options: BoundedGitDiffOptions): BoundedGitDiff {
  const canonicalPaths = canonicalizeDiffPaths(options.paths, cwd);
  const range = resolveDiffRange(git, cwd, options.from ?? "HEAD", options.to);
  const stats = readGitPathStatsForRange(git, cwd, canonicalPaths, range.fromRevision, range.toRevision);
  const includePatch = options.includePatch === true;
  const maxBytes = options.maxBytes ?? EVIDENCE_MAX_DIFF_BYTES;
  const maxHunks = options.maxHunks ?? EVIDENCE_MAX_DIFF_HUNKS;
  assertDiffBound(maxBytes, EVIDENCE_MAX_DIFF_BYTES, "maxBytes");
  assertDiffBound(maxHunks, EVIDENCE_MAX_DIFF_HUNKS, "maxHunks");

  if (!includePatch) {
    return Object.freeze({
      schemaVersion: DIFF_EVIDENCE_SCHEMA_VERSION,
      fromRevision: range.fromRevision,
      toRevision: range.toRevision,
      paths: canonicalPaths,
      stats,
      patch: null,
      patchBytes: 0,
      hunkCount: 0,
    });
  }

  let patch: string;
  try {
    const run = git.runRaw ?? git.run;
    patch = run(diffArguments(range.fromRevision, range.toRevision, canonicalPaths, ["--unified=0", "--patch"]), cwd);
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not observe the selected Git diff",
      {
        cwd,
      },
      error,
    );
  }

  const patchBytes = Buffer.byteLength(patch, "utf8");
  if (patchBytes > maxBytes) {
    throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Selected Git diff exceeds the byte bound", {
      cwd,
      maxBytes,
      patchBytes,
    });
  }
  const hunkCount = (patch.match(/^@@ /gmu) ?? []).length;
  if (hunkCount > maxHunks) {
    throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Selected Git diff exceeds the hunk bound", {
      cwd,
      maxHunks,
      hunkCount,
    });
  }

  return Object.freeze({
    schemaVersion: DIFF_EVIDENCE_SCHEMA_VERSION,
    fromRevision: range.fromRevision,
    toRevision: range.toRevision,
    paths: canonicalPaths,
    stats,
    patch,
    patchBytes,
    hunkCount,
  });
}

function canonicalizeDiffPaths(paths: readonly string[], cwd: string): readonly string[] {
  if (paths.length === 0) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "A bounded diff requires at least one explicit path", {
      cwd,
    });
  }
  if (paths.length > EVIDENCE_MAX_DIFF_PATHS) {
    throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "The selected diff contains too many paths", {
      cwd,
      maxPaths: EVIDENCE_MAX_DIFF_PATHS,
      pathCount: paths.length,
    });
  }
  const canonical = new Set<string>();
  for (const resource of paths) {
    try {
      canonical.add(canonicalizeConcretePath(resource, cwd));
    } catch (error: unknown) {
      throw new SessionRegistryError(
        "GIT_STATE_AMBIGUOUS",
        "The selected diff path cannot be represented as a canonical repository resource",
        { path: resource },
        error,
      );
    }
  }
  return sortGitPaths(canonical);
}

function resolveDiffRange(
  git: GitCommandRunner,
  cwd: string,
  from: string,
  to: string | undefined,
): { readonly fromRevision: string; readonly toRevision: string | null } {
  const fromRevision = resolveDiffRevision(git, cwd, from, "from");
  const toRevision = to === undefined ? null : resolveDiffRevision(git, cwd, to, "to");
  return { fromRevision, toRevision };
}

function resolveDiffRevision(git: GitCommandRunner, cwd: string, ref: string, side: string): string {
  if (ref.length === 0 || ref !== ref.trim() || ref.startsWith("-") || ref.includes("\u0000")) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", `Invalid ${side} revision selector`, { side, ref });
  }
  try {
    const revision = git.run(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
    if (!/^[0-9a-f]{40,64}$/u.test(revision)) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", `Git returned an invalid ${side} revision`, {
        side,
        ref,
        revision,
      });
    }
    return revision;
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError && error.code !== "GIT_COMMAND_FAILED") throw error;
    throw new SessionRegistryError(
      "GIT_STATE_AMBIGUOUS",
      `Could not resolve the ${side} diff revision`,
      {
        side,
        ref,
      },
      error,
    );
  }
}

function readGitPathStatsForRange(
  git: GitCommandRunner,
  cwd: string,
  paths: readonly string[],
  fromRevision: string,
  toRevision: string | null,
): readonly GitPathStat[] {
  let output: string;
  try {
    const run = git.runRaw ?? git.run;
    output = run(diffArguments(fromRevision, toRevision, paths, ["--numstat", "--no-renames"]), cwd);
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not observe Git path statistics",
      {
        cwd,
      },
      error,
    );
  }

  const observed = new Map<string, GitPathStat>();
  const records = output.endsWith("\n") ? output.slice(0, -1).split("\u0000") : output.split("\u0000");
  for (const record of records) {
    if (record.length === 0) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = firstTab === -1 ? -1 : record.indexOf("\t", firstTab + 1);
    if (firstTab <= 0 || secondTab <= firstTab + 1 || secondTab === record.length - 1) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid numstat record", { cwd });
    }
    const additionsText = record.slice(0, firstTab);
    const deletionsText = record.slice(firstTab + 1, secondTab);
    const rawPath = record.slice(secondTab + 1);
    let canonicalPath: string;
    try {
      canonicalPath = canonicalizeConcretePath(rawPath, cwd);
    } catch (error: unknown) {
      throw new SessionRegistryError(
        "GIT_STATE_AMBIGUOUS",
        "Git returned an unrepresentable stat path",
        {
          cwd,
          path: rawPath,
        },
        error,
      );
    }
    if (!paths.includes(canonicalPath) || observed.has(canonicalPath)) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an unexpected or duplicate stat path", {
        cwd,
        path: canonicalPath,
      });
    }
    const binary = additionsText === "-" || deletionsText === "-";
    const additions = binary ? null : parseStatCount(additionsText, cwd, canonicalPath);
    const deletions = binary ? null : parseStatCount(deletionsText, cwd, canonicalPath);
    observed.set(
      canonicalPath,
      Object.freeze({
        path: canonicalPath,
        additions,
        deletions,
        binary,
        available: true,
      }),
    );
  }

  return Object.freeze(
    paths.map(
      (resource) =>
        observed.get(resource) ??
        Object.freeze({
          path: resource,
          additions: null,
          deletions: null,
          binary: null,
          available: false,
        }),
    ),
  );
}

function parseStatCount(value: string, cwd: string, resource: string): number {
  if (!/^\d+$/u.test(value)) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid numstat count", {
      cwd,
      path: resource,
      value,
    });
  }
  const count = Number(value);
  if (!Number.isSafeInteger(count)) {
    throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Git returned an unbounded numstat count", {
      cwd,
      path: resource,
    });
  }
  return count;
}

function diffArguments(
  fromRevision: string,
  toRevision: string | null,
  paths: readonly string[],
  flags: readonly string[],
): string[] {
  return [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    ...flags,
    fromRevision,
    ...(toRevision === null ? [] : [toRevision]),
    "--",
    ...paths.map((resource) => `:(literal)${resource}`),
  ];
}

function assertDiffBound(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new SessionRegistryError("GIT_OUTPUT_LIMIT", `${name} is outside the bounded diff limit`, {
      [name]: value,
      max,
    });
  }
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
    shortName.startsWith("-") ||
    shortName.includes("..") ||
    shortName === "@" ||
    shortName.endsWith("@") ||
    shortName.includes("@{") ||
    shortName.endsWith(".") ||
    shortName.endsWith(".lock") ||
    components.some(
      (component) => component.startsWith(".") || component.endsWith(".") || component.endsWith(".lock"),
    ) ||
    shortName.includes("//") ||
    /[\u0000-\u0020~^:?*[\\]/u.test(shortName)
  ) {
    throw new SessionRegistryError("INVALID_BRANCH_ID", `Invalid branch identity: ${branchName}`, { branchName });
  }

  return normalized;
}

export function readCurrentBranch(git: GitCommandRunner, cwd: string): string {
  try {
    const branchName = git.run(["symbolic-ref", "--quiet", "--short", "HEAD"], cwd);
    if (branchName.length === 0) {
      throw new SessionRegistryError("WORKTREE_IDENTITY_AMBIGUOUS", `The worktree at ${cwd} has no branch`, {
        cwd,
        reason: "detached-head",
      });
    }
    return branchName;
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) {
      if (error.code === "GIT_SPAWN_FAILED" || error.code === "GIT_TIMEOUT" || error.code === "GIT_OUTPUT_LIMIT") {
        throw error;
      }
      if (error.code === "WORKTREE_IDENTITY_AMBIGUOUS") throw error;
      if (
        error.code === "GIT_COMMAND_FAILED" &&
        (error.details.exitCode === undefined || error.details.exitCode === 1 || error.details.exitCode === 128)
      ) {
        throw new SessionRegistryError(
          "WORKTREE_IDENTITY_AMBIGUOUS",
          `Could not resolve the current branch for ${cwd}`,
          { cwd, reason: "detached-head" },
          error,
        );
      }
      throw error;
    }
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      `Could not observe the current branch for ${cwd}`,
      {
        cwd,
      },
      error,
    );
  }
}

export function readCurrentHead(git: GitCommandRunner, cwd: string): string {
  try {
    const head = git.run(["rev-parse", "--verify", "HEAD"], cwd);
    if (!/^[0-9a-f]{40,64}$/u.test(head)) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", `Git returned an invalid HEAD for ${cwd}`, { cwd });
    }
    return head;
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) {
      if (error.code === "GIT_SPAWN_FAILED" || error.code === "GIT_TIMEOUT" || error.code === "GIT_OUTPUT_LIMIT") {
        throw error;
      }
      if (error.code === "GIT_STATE_AMBIGUOUS") throw error;
      if (
        error.code === "GIT_COMMAND_FAILED" &&
        (error.details.exitCode === undefined || error.details.exitCode === 128)
      ) {
        throw new SessionRegistryError(
          "GIT_STATE_AMBIGUOUS",
          `Could not resolve HEAD for ${cwd}`,
          { cwd, reason: "head-unavailable" },
          error,
        );
      }
      throw error;
    }
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      `Could not observe HEAD for ${cwd}`,
      { cwd },
      error,
    );
  }
}

function canonicalListedPath(candidate: string): string {
  let resolved: string;
  try {
    resolved = path.resolve(candidate);
  } catch (error: unknown) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git reported an invalid worktree path", {}, error);
  }
  try {
    return fs.realpathSync.native(resolved);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return resolved;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      `Could not canonicalize the Git worktree path: ${resolved}`,
      { worktree: resolved },
      error,
    );
  }
}

function canonicalDirectory(
  candidate: string,
  errorCode: "REPOSITORY_IDENTITY_AMBIGUOUS" | "WORKTREE_IDENTITY_AMBIGUOUS",
  missingCode?: "MISSING_WORKTREE",
): string {
  if (candidate.trim().length === 0) {
    throw new SessionRegistryError(errorCode, "Git returned an empty directory identity");
  }
  let resolved: string;
  try {
    resolved = path.resolve(candidate);
  } catch (error: unknown) {
    throw new SessionRegistryError(errorCode, "Git returned an invalid directory identity", {}, error);
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new Error("path is not a directory");
    }
    return fs.realpathSync.native(resolved);
  } catch (error: unknown) {
    if (missingCode !== undefined && isNodeError(error) && error.code === "ENOENT") {
      throw new SessionRegistryError(
        missingCode,
        `The worktree path is missing: ${resolved}`,
        { worktree: resolved },
        error,
      );
    }
    throw new SessionRegistryError(
      errorCode,
      `Could not resolve directory identity: ${resolved}`,
      { path: resolved },
      error,
    );
  }
}

/**
 * Compute the sorted, stable per-file `git patch-id` set for the content
 * change between two revisions. This is a deterministic, Git-native proof
 * of "these two diffs introduce the same net content change" that is
 * independent of commit ancestry, blob SHAs, and surrounding context —
 * the mechanism used to prove a squash/rebase-integrated branch is safe to
 * reclaim even though its original commit is not an ancestor of the
 * integration branch.
 */
export function computeRangePatchIds(git: GitCommandRunner, cwd: string, from: string, to: string): readonly string[] {
  let diffText: string;
  try {
    const run = git.runRaw ?? git.run;
    diffText = run(["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--find-renames=100%", from, to], cwd);
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not observe the integration comparison diff",
      { cwd, from, to },
      error,
    );
  }
  if (diffText.trim().length === 0) return Object.freeze([]);

  let patchIdOutput: string;
  try {
    patchIdOutput = String(
      execFileSync("git", ["patch-id", "--stable"], {
        input: diffText,
        encoding: "utf8",
        maxBuffer: GIT_COMMAND_MAX_OUTPUT_BYTES,
        timeout: GIT_COMMAND_TIMEOUT_MS,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      }),
    );
  } catch (error: unknown) {
    throw gitProcessError(error, "patch-id --stable", cwd);
  }

  const ids = patchIdOutput
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split(/\s+/u)[0])
    .filter((id): id is string => id !== undefined && /^[0-9a-f]{40,64}$/u.test(id));
  return Object.freeze([...ids].sort());
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function assertDirectoryPath(candidate: string): void {
  let resolved: string;
  try {
    resolved = path.resolve(candidate);
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not resolve the worktree path",
      { worktree: boundedDetail(candidate) },
      error,
    );
  }
  try {
    const stat = fs.statSync(resolved);
    if (!stat.isDirectory()) {
      throw new SessionRegistryError("MISSING_WORKTREE", `The worktree path is not a directory: ${resolved}`, {
        worktree: resolved,
      });
    }
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    if (isNodeError(error) && (error.code === "ENOENT" || error.code === "ENOTDIR")) {
      throw new SessionRegistryError(
        "MISSING_WORKTREE",
        `The worktree path is missing: ${resolved}`,
        { worktree: resolved },
        error,
      );
    }
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      `Could not inspect the worktree path: ${resolved}`,
      { worktree: resolved },
      error,
    );
  }
}

function isPathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function sortGitPaths(paths: ReadonlySet<string>): readonly string[] {
  return Object.freeze([...paths].sort((left, right) => (left < right ? -1 : left > right ? 1 : 0)));
}

function boundedDetail(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return text.length > MAX_ERROR_DETAIL_LENGTH ? `${text.slice(0, MAX_ERROR_DETAIL_LENGTH)}…` : text;
}

function gitProcessError(error: unknown, command: string, cwd: string): SessionRegistryError {
  const candidate = error as {
    readonly code?: unknown;
    readonly status?: unknown;
    readonly signal?: unknown;
    readonly killed?: unknown;
    readonly stderr?: unknown;
  };
  const details: Record<string, string | number | boolean> = {
    command: boundedDetail(command),
    cwd: boundedDetail(cwd),
  };
  if (typeof candidate.status === "number") details.exitCode = candidate.status;
  if (typeof candidate.signal === "string") details.signal = candidate.signal;
  if (typeof candidate.stderr === "string" && candidate.stderr.length > 0) {
    details.stderr = boundedDetail(candidate.stderr);
  }

  let code: "GIT_COMMAND_FAILED" | "GIT_SPAWN_FAILED" | "GIT_TIMEOUT" | "GIT_OUTPUT_LIMIT";
  if (candidate.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" || candidate.code === "ENOBUFS") {
    code = "GIT_OUTPUT_LIMIT";
  } else if (candidate.code === "ETIMEDOUT") {
    code = "GIT_TIMEOUT";
  } else if (candidate.killed === true) {
    code = "GIT_TIMEOUT";
  } else if (
    (candidate.status === undefined || candidate.status === null) &&
    (candidate.code === "ENOENT" || candidate.code === "EACCES" || candidate.code === "ENOTDIR")
  ) {
    code = "GIT_SPAWN_FAILED";
  } else code = "GIT_COMMAND_FAILED";

  return new SessionRegistryError(code, `git ${command} failed in ${cwd}`, details, error);
}
