import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { SessionRegistryError } from "./errors.js";
import { resolveWorkingSetPathsWithEvidence } from "./domain/filesystem-policy-materialization.js";
import { CHECKPOINT_MAX_PATHS, type GitCheckpointPaths } from "./operation-authorization.js";
import { canonicalizeConcretePath } from "./resource-claims.js";

export const GIT_COMMAND_TIMEOUT_MS = 10_000;
export const GIT_COMMAND_MAX_OUTPUT_BYTES = 64 * 1024;
export const REPOSITORY_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const DIFF_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_MAX_DIFF_PATHS = 64 as const;
export const EVIDENCE_MAX_DIFF_BYTES = GIT_COMMAND_MAX_OUTPUT_BYTES;
export const EVIDENCE_MAX_DIFF_HUNKS = 128 as const;
export const GIT_SOURCE_MAX_PATHS = 4_096 as const;
export const GIT_SOURCE_MAX_DEPTH = 64 as const;
export const GIT_SOURCE_MAX_FILE_BYTES = 16 * 1_024 * 1_024;
export const GIT_SOURCE_MAX_TOTAL_BYTES = 64 * 1_024 * 1_024;
export const GIT_SOURCE_MAX_METADATA_BYTES = 8 * 1_024 * 1_024;
const MAX_ERROR_DETAIL_LENGTH = 4_096;

/**
 * Git environment variables which can change the repository facts observed
 * by a command.  These are never inherited from the caller: the cwd and the
 * repository metadata observed by Git are the sole local-authority inputs.
 */
const GIT_AUTHORITY_ENVIRONMENT_VARIABLES = new Set([
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_OBJECT_DIRECTORY_RELATIVE",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_QUARANTINE_PATH",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

/**
 * Git environment variables which do not change repository identity but can
 * still change local observation or mutation semantics away from Git's own
 * defaults: substituting an external diff/pathspec/pager/editor process,
 * rewriting index or attribute behavior, or altering which paths a command
 * observes or mutates. These are execution-semantics authority, not
 * transport/authentication, and are removed for the same reason as the
 * repository-identity variables above.
 */
const GIT_SEMANTICS_ENVIRONMENT_VARIABLES = new Set([
  "GIT_EXTERNAL_DIFF",
  "GIT_DIFF_OPTS",
  "GIT_DIFF_PATH_COUNTER",
  "GIT_DIFF_PATH_TOTAL",
  "GIT_PAGER",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_MERGE_VERBOSITY",
  "GIT_ATTR_SOURCE",
  "GIT_ICASE_PATHSPECS",
  "GIT_LITERAL_PATHSPECS",
  "GIT_GLOB_PATHSPECS",
  "GIT_NOGLOB_PATHSPECS",
  "GIT_REFLOG_ACTION",
  "GIT_INDEX_VERSION",
]);

/**
 * Git environment variable name prefixes which govern the same authority
 * boundaries as the exact-name sets above. Matched case-insensitively so
 * that a case-insensitive host environment (e.g. Windows) cannot preserve a
 * differently-cased alias of a sanitized variable.
 */
const GIT_ENVIRONMENT_AUTHORITY_PREFIXES = ["GIT_CONFIG_"];

/**
 * Git config environment is an authority boundary too.  In particular,
 * GIT_CONFIG_COUNT/KEY_n/VALUE_n and GIT_CONFIG_PARAMETERS can inject config
 * without changing the caller's cwd.  System and global config are disabled
 * for governed Git operations; repository-local config remains Git's local
 * authority and transport/authentication variables remain available.
 *
 * Matching is case-insensitive: `NodeJS.ProcessEnv` keys are treated as
 * case-sensitive by V8/Node on every platform, but the underlying OS
 * environment on Windows is case-insensitive, so a caller-supplied `git_dir`
 * or `Git_Config_Count` reaches the same native environment block as
 * `GIT_DIR`/`GIT_CONFIG_COUNT`. Sanitizing only the exact-cased key would
 * leave a same-effect alias in place on that platform.
 */
const GIT_CONFIG_NULL_DEVICE = process.platform === "win32" ? "NUL" : "/dev/null";

function isSanitizedGitEnvironmentKey(key: string): boolean {
  const upperCaseKey = key.toUpperCase();
  return (
    GIT_AUTHORITY_ENVIRONMENT_VARIABLES.has(upperCaseKey) ||
    GIT_SEMANTICS_ENVIRONMENT_VARIABLES.has(upperCaseKey) ||
    GIT_ENVIRONMENT_AUTHORITY_PREFIXES.some((prefix) => upperCaseKey.startsWith(prefix))
  );
}

function canonicalGitSubprocessEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    ...overrides,
  };

  for (const key of Object.keys(environment)) {
    if (isSanitizedGitEnvironmentKey(key)) {
      delete environment[key];
    }
  }

  return {
    ...environment,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: GIT_CONFIG_NULL_DEVICE,
    GIT_CONFIG_GLOBAL: GIT_CONFIG_NULL_DEVICE,
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
  };
}

export interface GitCommandRunner {
  run(args: readonly string[], cwd: string): string;
  /** Preserve leading/trailing whitespace for NUL-delimited Git records. */
  readonly runRaw?: (args: readonly string[], cwd: string) => string;
  /** Preserve exact bytes for bounded blob evidence. */
  readonly runBuffer?: (args: readonly string[], cwd: string) => Buffer;
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

export type GitSourceObservationLimits = Readonly<{
  readonly max_paths?: number;
  readonly max_depth?: number;
  readonly max_file_bytes?: number;
  readonly max_total_bytes?: number;
}>;

export type GitSourceObservation = Readonly<{
  /** Physical repository identity; callers must hash this before transport. */
  readonly repository_id: string;
  /** Physical worktree identity; callers must hash this before transport. */
  readonly worktree_id: string;
  readonly branch_id: string;
  readonly head_id: string;
  /** SHA-256 over every resolved file/directory plus Git index/ref/config state. */
  readonly source_sha256: string;
  readonly file_count: number;
  readonly byte_count: number;
}>;

type SourceFileDigest = Readonly<{
  readonly sha256: string;
  readonly bytes: number;
  readonly mode: number;
  readonly version: string;
}>;

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
          env: canonicalGitSubprocessEnvironment(options.env),
        }),
      );
    } catch (error: unknown) {
      throw gitProcessError(error, command, cwd);
    }
  };

  const executeBuffer = (args: readonly string[], cwd: string): Buffer => {
    const command = args.map((argument) => boundedDetail(argument)).join(" ");
    try {
      return Buffer.from(
        execFileSync(executable, [...args], {
          cwd,
          maxBuffer: maxOutputBytes,
          stdio: ["ignore", "pipe", "pipe"],
          timeout: timeoutMs,
          env: canonicalGitSubprocessEnvironment(options.env),
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
    runBuffer(args: readonly string[], cwd: string): Buffer {
      return executeBuffer(args, cwd);
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

/**
 * Capture the exact bounded file set the verifier's working-set selectors can
 * read, together with the index/ref state projected into its private Git
 * metadata. Git status is deliberately not used as content evidence: ignored,
 * untracked, and same-path byte changes must be covered too.
 */
export function captureGitSourceObservation(options: {
  readonly cwd: string;
  readonly read_selectors: readonly string[];
  readonly git?: GitCommandRunner;
  readonly limits?: GitSourceObservationLimits;
}): GitSourceObservation {
  const limits = gitSourceLimits(options.limits);
  const git = options.git ?? createGitCommandRunner({ maxOutputBytes: GIT_SOURCE_MAX_METADATA_BYTES });
  const initial = verifyPhysicalExecutionContext({ cwd: options.cwd, worktreePath: options.cwd, git });
  const normalizedWorktree = path.resolve(options.cwd);
  if (initial.worktreePath !== normalizedWorktree) {
    throw new SessionRegistryError("WORKTREE_MISMATCH", "Git source observation resolved a different worktree", {
      expectedWorktree: normalizedWorktree,
      actualWorktree: initial.worktreePath,
    });
  }

  const resolution = resolveWorkingSetPathsWithEvidence(initial.worktreePath, options.read_selectors, {
    maxSelectors: 2_048,
    maxPaths: limits.max_paths,
    maxDepth: limits.max_depth,
    maxDiagnostics: 256,
  });
  if (!resolution.complete) {
    const code = resolution.truncated ? "GIT_OUTPUT_LIMIT" : "PHYSICAL_OBSERVATION_UNAVAILABLE";
    throw new SessionRegistryError(code, "The verifier-visible source set could not be fully resolved", {
      truncated: resolution.truncated,
      unsupported: resolution.unsupported.length,
      unreadable: resolution.unreadable.length,
      maxPaths: limits.max_paths,
      maxDepth: limits.max_depth,
    });
  }

  const control = captureGitSourceControl(
    git,
    initial.worktreePath,
    initial.commonGitDirectory,
    limits.max_total_bytes,
  );
  let byteCount = control.byte_count;
  let fileCount = 0;
  const sourceHash = createHash("sha256");
  sourceHash.update("nawabari.git-source-observation.v1\0", "utf8");
  sourceHash.update(control.sha256, "ascii");
  sourceHash.update("\0", "ascii");
  sourceHash.update(JSON.stringify(resolution.selectors), "utf8");
  sourceHash.update("\0", "ascii");
  sourceHash.update(JSON.stringify(resolution.missingExact), "utf8");
  sourceHash.update("\0", "ascii");

  const observedVersions = new Map<string, string>();
  for (const entry of resolution.resolved) {
    if (entry.relativePath.includes("\u0000") || entry.relativePath.includes("\uFFFD")) {
      throw new SessionRegistryError(
        "PHYSICAL_OBSERVATION_UNAVAILABLE",
        "A source path is not losslessly representable",
        {
          worktree: initial.worktreePath,
        },
      );
    }
    let digest: SourceFileDigest;
    if (entry.kind === "directory") {
      digest = observeSourceDirectory(entry.absolutePath, entry.identity);
    } else {
      digest = observeSourceFile(entry.absolutePath, entry.identity, entry.parent.identity, {
        maxFileBytes: limits.max_file_bytes,
        remainingBytes: limits.max_total_bytes - byteCount,
      });
      fileCount += 1;
      byteCount += digest.bytes;
    }
    observedVersions.set(entry.absolutePath, digest.version);
    sourceHash.update(
      JSON.stringify([entry.relativePath, entry.kind, digest.mode, digest.bytes, digest.sha256, digest.version]),
      "utf8",
    );
    sourceHash.update("\0", "ascii");
  }

  const finalResolution = resolveWorkingSetPathsWithEvidence(initial.worktreePath, options.read_selectors, {
    maxSelectors: 2_048,
    maxPaths: limits.max_paths,
    maxDepth: limits.max_depth,
    maxDiagnostics: 256,
  });
  if (!finalResolution.complete || sourceResolutionIdentity(resolution) !== sourceResolutionIdentity(finalResolution)) {
    throw new SessionRegistryError(
      "GIT_STATE_AMBIGUOUS",
      "The verifier-visible source set changed during observation",
      {
        worktree: initial.worktreePath,
        truncated: finalResolution.truncated,
        unsupported: finalResolution.unsupported.length,
        unreadable: finalResolution.unreadable.length,
      },
    );
  }
  assertSourceVersionsUnchanged(resolution, observedVersions);
  const final = verifyPhysicalExecutionContext({ cwd: options.cwd, worktreePath: options.cwd, git });
  const finalControl = captureGitSourceControl(
    git,
    final.worktreePath,
    final.commonGitDirectory,
    limits.max_total_bytes,
  );
  if (
    initial.repositoryId !== final.repositoryId ||
    initial.worktreeId !== final.worktreeId ||
    initial.branchId !== final.branchId ||
    initial.headId !== final.headId ||
    control.sha256 !== finalControl.sha256
  ) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git source identity changed during observation", {
      worktree: initial.worktreePath,
    });
  }

  return Object.freeze({
    repository_id: initial.repositoryId,
    worktree_id: initial.worktreeId,
    branch_id: initial.branchId,
    head_id: initial.headId,
    source_sha256: sourceHash.digest("hex"),
    file_count: fileCount,
    byte_count: byteCount,
  });
}

function assertSourceVersionsUnchanged(
  resolution: ReturnType<typeof resolveWorkingSetPathsWithEvidence>,
  observedVersions: ReadonlyMap<string, string>,
): void {
  for (const entry of resolution.resolved) {
    let stat: fs.BigIntStats;
    try {
      stat = fs.lstatSync(entry.absolutePath, { bigint: true });
    } catch (error: unknown) {
      throw sourceObservationError("A verifier-visible source changed during observation", entry.absolutePath, error);
    }
    const version = `${stat.dev.toString(10)}:${stat.ino.toString(10)}:${stat.mtimeNs.toString(10)}:${stat.ctimeNs.toString(10)}`;
    if (
      observedVersions.get(entry.absolutePath) !== version ||
      (entry.kind === "file" ? !stat.isFile() : !stat.isDirectory())
    ) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "A verifier-visible source changed during observation", {
        path: entry.absolutePath,
      });
    }
  }
}

function sourceResolutionIdentity(resolution: ReturnType<typeof resolveWorkingSetPathsWithEvidence>): string {
  return JSON.stringify({
    selectors: resolution.selectors,
    missingExact: resolution.missingExact,
    resolved: resolution.resolved.map((entry) => ({
      relativePath: entry.relativePath,
      selector: entry.selector,
      kind: entry.kind,
      identity: entry.identity,
      parent: entry.parent.identity,
    })),
  });
}

type GitSourceResolvedIdentity = Readonly<{ readonly device: string; readonly inode: string }>;

function observeSourceDirectory(candidate: string, expected: GitSourceResolvedIdentity): SourceFileDigest {
  let stat: fs.BigIntStats;
  try {
    stat = fs.lstatSync(candidate, { bigint: true });
  } catch (error: unknown) {
    throw sourceObservationError("A verifier-visible directory changed during observation", candidate, error);
  }
  if (!stat.isDirectory() || stat.dev.toString(10) !== expected.device || stat.ino.toString(10) !== expected.inode) {
    throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "A verifier-visible directory changed during observation", {
      path: candidate,
    });
  }
  return Object.freeze({
    sha256: createHash("sha256").digest("hex"),
    bytes: 0,
    mode: Number(stat.mode & 0o7777n),
    version: `${stat.dev.toString(10)}:${stat.ino.toString(10)}:${stat.mtimeNs.toString(10)}:${stat.ctimeNs.toString(10)}`,
  });
}

function observeSourceFile(
  candidate: string,
  expected: GitSourceResolvedIdentity,
  expectedParent: GitSourceResolvedIdentity,
  limits: { readonly maxFileBytes: number; readonly remainingBytes: number },
): SourceFileDigest {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const directory = fs.constants.O_DIRECTORY;
  let parentDescriptor: number | undefined;
  let descriptor: number | undefined;
  try {
    parentDescriptor = fs.openSync(path.dirname(candidate), fs.constants.O_RDONLY | directory | noFollow);
    const parent = fs.fstatSync(parentDescriptor, { bigint: true });
    if (
      !parent.isDirectory() ||
      parent.dev.toString(10) !== expectedParent.device ||
      parent.ino.toString(10) !== expectedParent.inode
    ) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "A verifier-visible parent changed during observation", {
        path: path.dirname(candidate),
      });
    }
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile() || before.dev.toString(10) !== expected.device || before.ino.toString(10) !== expected.inode) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "A verifier-visible file changed during observation", {
        path: candidate,
      });
    }
    if (before.size > BigInt(limits.maxFileBytes) || before.size > BigInt(limits.remainingBytes)) {
      throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Verifier-visible source exceeds its byte bound", {
        path: candidate,
        fileBytes: before.size.toString(10),
        maxFileBytes: limits.maxFileBytes,
        remainingBytes: limits.remainingBytes,
      });
    }

    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1_024);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > limits.maxFileBytes || bytes > limits.remainingBytes) {
        throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Verifier-visible source exceeds its byte bound", {
          path: candidate,
          maxFileBytes: limits.maxFileBytes,
          remainingBytes: limits.remainingBytes,
        });
      }
      hash.update(chunk.subarray(0, read));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mode !== after.mode ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes) !== after.size
    ) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "A verifier-visible file changed while it was read", {
        path: candidate,
      });
    }
    return Object.freeze({
      sha256: hash.digest("hex"),
      bytes,
      mode: Number(after.mode & 0o7777n),
      version: `${after.dev.toString(10)}:${after.ino.toString(10)}:${after.mtimeNs.toString(10)}:${after.ctimeNs.toString(10)}`,
    });
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw sourceObservationError("A verifier-visible file could not be read", candidate, error);
  } finally {
    for (const handle of [descriptor, parentDescriptor]) {
      if (handle === undefined) continue;
      try {
        fs.closeSync(handle);
      } catch {
        // Preserve the observation result.
      }
    }
  }
}

function captureGitSourceControl(
  git: GitCommandRunner,
  cwd: string,
  commonGitDirectory: string,
  maximumBytes: number,
): { readonly sha256: string; readonly byte_count: number } {
  if (git.runBuffer === undefined) {
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Git runner cannot preserve exact source bytes",
      {
        cwd,
      },
    );
  }
  try {
    const indexPathValue = git.run(["rev-parse", "--git-path", "index"], cwd);
    const indexPath = path.isAbsolute(indexPathValue)
      ? path.resolve(indexPathValue)
      : path.resolve(cwd, indexPathValue);
    if (!isPathInside(commonGitDirectory, indexPath)) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git index escaped the repository authority", { cwd });
    }
    const index = observeBoundedRawFile(indexPath, GIT_SOURCE_MAX_METADATA_BYTES, maximumBytes);
    const indexEntries = git.runBuffer(["ls-files", "--stage", "-z"], cwd);
    const references = git.runBuffer(["show-ref", "--head", "-d"], cwd);
    const localConfig = git.runBuffer(["config", "--local", "--null", "--list"], cwd);
    if (
      indexEntries.byteLength > GIT_SOURCE_MAX_METADATA_BYTES ||
      references.byteLength > GIT_SOURCE_MAX_METADATA_BYTES
    ) {
      throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Git source metadata exceeds its byte bound", {
        cwd,
        maxBytes: GIT_SOURCE_MAX_METADATA_BYTES,
      });
    }
    const metadataBytes = index.bytes + indexEntries.byteLength + references.byteLength + localConfig.byteLength;
    if (metadataBytes > maximumBytes) {
      throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Git source metadata exceeds its total byte bound", {
        cwd,
        metadataBytes,
        maxBytes: maximumBytes,
      });
    }
    const hash = createHash("sha256");
    hash.update("nawabari.git-source-control.v1\0", "utf8");
    hash.update(index.sha256, "ascii");
    hash.update("\0", "ascii");
    hash.update(index.version, "utf8");
    hash.update("\0", "ascii");
    hash.update(indexEntries);
    hash.update("\0", "ascii");
    hash.update(references);
    hash.update("\0", "ascii");
    hash.update(localConfig);
    return Object.freeze({ sha256: hash.digest("hex"), byte_count: metadataBytes });
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw sourceObservationError("Git source metadata could not be observed", cwd, error);
  }
}

function observeBoundedRawFile(
  candidate: string,
  maximumFileBytes: number,
  maximumTotalBytes: number,
): SourceFileDigest {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(candidate, fs.constants.O_RDONLY | noFollow);
    const before = fs.fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error("Git index is not a regular file");
    if (before.size > BigInt(maximumFileBytes) || before.size > BigInt(maximumTotalBytes)) {
      throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Git index exceeds its byte bound", {
        maxFileBytes: maximumFileBytes,
        maxTotalBytes: maximumTotalBytes,
      });
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1_024);
    let bytes = 0;
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      bytes += read;
      if (bytes > maximumFileBytes || bytes > maximumTotalBytes) {
        throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Git index exceeds its byte bound", {
          maxFileBytes: maximumFileBytes,
          maxTotalBytes: maximumTotalBytes,
        });
      }
      hash.update(chunk.subarray(0, read));
    }
    const after = fs.fstatSync(descriptor, { bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs ||
      BigInt(bytes) !== after.size
    ) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git index changed during source observation", {});
    }
    return Object.freeze({
      sha256: hash.digest("hex"),
      bytes,
      mode: Number(after.mode & 0o7777n),
      version: `${after.dev.toString(10)}:${after.ino.toString(10)}:${after.mtimeNs.toString(10)}:${after.ctimeNs.toString(10)}`,
    });
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw sourceObservationError("Git index could not be read", candidate, error);
  } finally {
    if (descriptor !== undefined) {
      try {
        fs.closeSync(descriptor);
      } catch {
        // Preserve the observation result.
      }
    }
  }
}

function sourceObservationError(message: string, candidate: string, cause: unknown): SessionRegistryError {
  return new SessionRegistryError("PHYSICAL_OBSERVATION_UNAVAILABLE", message, { path: candidate }, cause);
}

function gitSourceLimits(requested: GitSourceObservationLimits | undefined): Required<GitSourceObservationLimits> {
  const limit = (value: number | undefined, fallback: number, maximum: number, field: string): number => {
    const selected = value ?? fallback;
    if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) {
      throw new RangeError(`Git source ${field} must be a positive integer no greater than ${maximum}`);
    }
    return selected;
  };
  return Object.freeze({
    max_paths: limit(requested?.max_paths, GIT_SOURCE_MAX_PATHS, GIT_SOURCE_MAX_PATHS, "path limit"),
    max_depth: limit(requested?.max_depth, GIT_SOURCE_MAX_DEPTH, GIT_SOURCE_MAX_DEPTH, "depth limit"),
    max_file_bytes: limit(
      requested?.max_file_bytes,
      GIT_SOURCE_MAX_FILE_BYTES,
      GIT_SOURCE_MAX_FILE_BYTES,
      "file limit",
    ),
    max_total_bytes: limit(
      requested?.max_total_bytes,
      GIT_SOURCE_MAX_TOTAL_BYTES,
      GIT_SOURCE_MAX_TOTAL_BYTES,
      "total byte limit",
    ),
  });
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

/** A Git tree entry's exact identity: file mode, object type, and content-addressed blob/tree SHA. */
export interface GitTreeEntry {
  readonly mode: string;
  readonly type: string;
  readonly sha: string;
}

/**
 * Read the exact repository-root-relative paths that differ between two
 * revisions (added, modified, deleted, or type-changed). Renames are
 * reported as a delete plus an add so no path is ever collapsed away.
 */
export function readChangedPathNames(git: GitCommandRunner, cwd: string, from: string, to: string): readonly string[] {
  let output: string;
  try {
    const run = git.runRaw ?? git.run;
    output = run(
      ["diff", "--no-color", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", from, to],
      cwd,
    );
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not observe the integration comparison changed paths",
      { cwd, from, to },
      error,
    );
  }
  const paths = output.split("\u0000").filter((entry) => entry.length > 0);
  for (const resource of paths) {
    if (resource.includes("\u0000")) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid changed path", { cwd });
    }
  }
  return Object.freeze(paths);
}

/**
 * Read the exact tree-level identity (mode, type, blob/tree SHA) of an
 * explicit set of paths at one revision. A path absent from the returned
 * map does not exist at that revision. Because blob SHAs are content
 * hashes, this is a byte-exact comparison mechanism — content, file mode,
 * and binary-ness are all captured, and no textual normalization (e.g.
 * whitespace-only differences) can ever be mistaken for a match. Submodule
 * gitlinks and other non-blob entries are captured by type+sha as well, so
 * they cannot be misread as an absent path.
 */
export function readTreePathStates(
  git: GitCommandRunner,
  cwd: string,
  revision: string,
  paths: readonly string[],
): ReadonlyMap<string, GitTreeEntry> {
  const result = new Map<string, GitTreeEntry>();
  if (paths.length === 0) return result;
  let output: string;
  try {
    const run = git.runRaw ?? git.run;
    output = run(
      ["ls-tree", "-r", "-z", "--full-tree", revision, "--", ...paths.map((resource) => `:(literal)${resource}`)],
      cwd,
    );
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError(
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Could not observe the integration comparison tree state",
      { cwd, revision },
      error,
    );
  }
  const records = output.split("\u0000").filter((record) => record.length > 0);
  for (const record of records) {
    const tab = record.indexOf("\t");
    if (tab <= 0) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid ls-tree record", {
        cwd,
        revision,
      });
    }
    const meta = record.slice(0, tab).split(" ");
    const path = record.slice(tab + 1);
    if (meta.length < 3 || meta[0].length === 0 || meta[1].length === 0 || meta[2].length === 0) {
      throw new SessionRegistryError("GIT_STATE_AMBIGUOUS", "Git returned an invalid ls-tree metadata record", {
        cwd,
        revision,
      });
    }
    result.set(path, Object.freeze({ mode: meta[0], type: meta[1], sha: meta[2] }));
  }
  return result;
}

/** Exact tree-entry equality: both absent, or identical mode, type, and blob/tree SHA. */
export function treeEntriesEqual(a: GitTreeEntry | undefined, b: GitTreeEntry | undefined): boolean {
  if (a === undefined || b === undefined) return a === undefined && b === undefined;
  return a.mode === b.mode && a.type === b.type && a.sha === b.sha;
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
