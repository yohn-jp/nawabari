import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const digest = /^sha256:([0-9a-f]{64})$/u;
const gitObjectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

export type SessionCandidateBundleStorageIdentity = Readonly<{
  readonly candidate_digest: string;
  readonly project_id: string;
  readonly source_id: string;
  readonly bundle_sha256: string;
  readonly base_commit: string;
  readonly candidate_commit: string;
  readonly candidate_tree: string;
}>;

export type SessionCandidateBundleStorageReceipt = Readonly<{
  readonly staging_root: string;
  readonly repository_path: string;
  readonly head_id: string;
  readonly tree_id: string;
}>;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function identityParts(candidateDigest: string, projectId: string, sourceId: string): {
  candidateHex: string;
  sourceKey: string;
} {
  const candidate = digest.exec(candidateDigest);
  if (
    candidate === null ||
    typeof projectId !== "string" ||
    projectId.length < 1 ||
    projectId.length > 256 ||
    projectId.includes("\0") ||
    typeof sourceId !== "string" ||
    sourceId.length < 1 ||
    sourceId.length > 256 ||
    sourceId.includes("\0")
  ) {
    throw new TypeError("candidate bundle identity is invalid");
  }
  return { candidateHex: candidate[1]!, sourceKey: sha256(`${projectId}\0${sourceId}`).slice(0, 24) };
}

export function sessionCandidateBundleIdentityKeys(
  candidateDigest: string,
  projectId: string,
  sourceId: string,
): Readonly<{ candidate_hex: string; source_key: string }> {
  const identity = identityParts(candidateDigest, projectId, sourceId);
  return { candidate_hex: identity.candidateHex, source_key: identity.sourceKey };
}

/** Deterministic owner-only candidate root; no caller-selected path is accepted. */
export function sessionCandidateBundleStagingRootPath(
  worktree: string,
  candidateDigest: string,
  projectId: string,
  sourceId: string,
): string {
  const identity = identityParts(candidateDigest, projectId, sourceId);
  if (!path.isAbsolute(worktree) || path.resolve(worktree) !== worktree)
    throw new TypeError("candidate bundle identity is invalid");
  return path.join(worktree, ".nawabari-verification-candidates", identity.candidateHex, identity.sourceKey);
}

/** Deterministic owner-only bundle transfer path. */
export function sessionCandidateBundleTransferPath(
  worktree: string,
  candidateDigest: string,
  projectId: string,
  sourceId: string,
  bundleSha256: string,
): string {
  const bundle = digest.exec(bundleSha256);
  if (bundle === null) throw new TypeError("candidate bundle transfer identity is invalid");
  return path.join(
    sessionCandidateBundleStagingRootPath(worktree, candidateDigest, projectId, sourceId),
    `.candidate-${bundle[1]}.bundle`,
  );
}

/** Deterministic candidate Git repository path inside the owned scratch root. */
export function sessionCandidateBundleRepositoryPath(
  worktree: string,
  candidateDigest: string,
  projectId: string,
  sourceId: string,
): string {
  return path.join(sessionCandidateBundleStagingRootPath(worktree, candidateDigest, projectId, sourceId), "repo");
}

function reject(reason: string): never {
  throw new Error(`Candidate scratch cannot be released safely: ${reason}.`);
}

function lstatOwnedDirectory(target: string, expectedUid: number, requirePrivate = true): void {
  const stat = fs.lstatSync(target);
  if (
    !stat.isDirectory() ||
    stat.isSymbolicLink() ||
    (requirePrivate && (stat.mode & 0o077) !== 0) ||
    stat.uid !== expectedUid ||
    fs.realpathSync.native(target) !== target
  ) {
    reject("owner-private directory identity changed");
  }
}

function scanTreeWithoutMetadataLinks(root: string): void {
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      const stat = fs.lstatSync(target);
      if (stat.isSymbolicLink()) reject("Git metadata contains a symbolic link");
      if (stat.isDirectory()) {
        pending.push(target);
      } else if (!stat.isFile()) {
        reject("scratch contains a non-regular filesystem object");
      }
    }
  }
}

function rejectNestedGitMetadata(repositoryPath: string): void {
  const pending = [repositoryPath];
  while (pending.length > 0) {
    const directory = pending.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (directory === repositoryPath && entry.name === ".git") continue;
      const stat = fs.lstatSync(target);
      if (entry.name === ".git") reject("a nested Git repository was added");
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) pending.push(target);
      else if (!stat.isFile()) reject("candidate contains a non-regular filesystem object");
    }
  }
}

function git(worktree: string, args: readonly string[]): string {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_TERMINAL_PROMPT: "0",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  for (const name of [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
    "GIT_OBJECT_DIRECTORY",
    "GIT_ALTERNATE_OBJECT_DIRECTORIES",
    "GIT_CONFIG_PARAMETERS",
  ]) {
    delete environment[name];
  }
  try {
    return String(
      execFileSync(
        "git",
        ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "gc.auto=0", ...args],
        {
          cwd: worktree,
          encoding: "utf8",
          env: environment,
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
          stdio: ["ignore", "pipe", "pipe"],
        },
      ),
    ).trim();
  } catch {
    return reject("Git identity or cleanliness could not be verified");
  }
}

/** Revalidate the exact clean staged repository before owner-side removal. */
export function inspectSessionCandidateBundleScratch(
  worktree: string,
  identity: SessionCandidateBundleStorageIdentity,
): SessionCandidateBundleStorageReceipt {
  if (typeof process.getuid !== "function") return reject("the current owner identity is unavailable");
  if (
    !gitObjectId.test(identity.base_commit) ||
    !gitObjectId.test(identity.candidate_commit) ||
    !gitObjectId.test(identity.candidate_tree) ||
    !digest.test(identity.bundle_sha256)
  ) {
    return reject("source identity is invalid");
  }
  const uid = process.getuid();
  let stagingRoot: string;
  let repositoryPath: string;
  try {
    stagingRoot = sessionCandidateBundleStagingRootPath(
      worktree,
      identity.candidate_digest,
      identity.project_id,
      identity.source_id,
    );
    repositoryPath = sessionCandidateBundleRepositoryPath(
      worktree,
      identity.candidate_digest,
      identity.project_id,
      identity.source_id,
    );
  } catch {
    return reject("owner identity is invalid");
  }
  try {
    if (!path.isAbsolute(worktree) || path.resolve(worktree) !== worktree || fs.realpathSync.native(worktree) !== worktree)
      reject("the owned worktree is not canonical");
    const worktreeStat = fs.lstatSync(worktree);
    if (!worktreeStat.isDirectory() || worktreeStat.isSymbolicLink() || worktreeStat.uid !== uid)
      reject("the owned worktree identity changed");
    const base = path.join(worktree, ".nawabari-verification-candidates");
    const candidateDirectory = path.dirname(stagingRoot);
    lstatOwnedDirectory(base, uid);
    lstatOwnedDirectory(candidateDirectory, uid);
    lstatOwnedDirectory(stagingRoot, uid);

    const stageEntries = fs.readdirSync(stagingRoot).sort();
    if (stageEntries.length !== 1 || stageEntries[0] !== "repo")
      reject("scratch has an unexpected or recoverable transfer entry");
    lstatOwnedDirectory(repositoryPath, uid);
    const gitDirectory = path.join(repositoryPath, ".git");
    lstatOwnedDirectory(gitDirectory, uid, false);
    scanTreeWithoutMetadataLinks(gitDirectory);
    rejectNestedGitMetadata(repositoryPath);

    const gitEntries = fs.readdirSync(gitDirectory);
    if (gitEntries.includes("objects")) {
      const info = path.join(gitDirectory, "objects", "info");
      if (fs.existsSync(info) && fs.readdirSync(info).includes("alternates"))
        reject("repository depends on external Git objects");
    }
    if (gitEntries.includes("shallow")) reject("repository is shallow");

    const { candidateHex, sourceKey } = identityParts(
      identity.candidate_digest,
      identity.project_id,
      identity.source_id,
    );
    const baseRef = `refs/nawabari/bases/${candidateHex}`;
    const candidateRef = `refs/nawabari/candidates/${candidateHex}/${sourceKey}`;
    const branchRef = `refs/heads/nawabari-candidate-${candidateHex}-${sourceKey}`;
    const expectedRefs = [baseRef, candidateRef, branchRef].sort();
    const actualRefs = git(repositoryPath, ["for-each-ref", "--format=%(refname)"])
      .split("\n")
      .filter(Boolean)
      .sort();
    if (JSON.stringify(actualRefs) !== JSON.stringify(expectedRefs)) reject("repository has unexpected refs");
    if (git(repositoryPath, ["remote"]) !== "") reject("repository has an unexpected remote");
    if (git(repositoryPath, ["rev-parse", "--show-toplevel"]) !== repositoryPath)
      reject("Git worktree does not resolve to the owned candidate repository");
    if (git(repositoryPath, ["rev-parse", "--absolute-git-dir"]) !== gitDirectory)
      reject("Git metadata does not resolve inside the owned candidate repository");
    if (git(repositoryPath, ["symbolic-ref", "--quiet", "HEAD"]) !== branchRef)
      reject("candidate branch identity changed");

    const headId = git(repositoryPath, ["rev-parse", "--verify", "HEAD^{commit}"]);
    const treeId = git(repositoryPath, ["rev-parse", "--verify", "HEAD^{tree}"]);
    const baseId = git(repositoryPath, ["rev-parse", "--verify", `${baseRef}^{commit}`]);
    const candidateId = git(repositoryPath, ["rev-parse", "--verify", `${candidateRef}^{commit}`]);
    const candidateTree = git(repositoryPath, ["rev-parse", "--verify", `${candidateRef}^{tree}`]);
    if (
      headId !== identity.candidate_commit ||
      treeId !== identity.candidate_tree ||
      baseId !== identity.base_commit ||
      candidateId !== identity.candidate_commit ||
      candidateTree !== identity.candidate_tree
    ) {
      reject("candidate source identity changed");
    }
    try {
      execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "merge-base", "--is-ancestor", baseId, candidateId], {
        cwd: repositoryPath,
        env: {
          ...process.env,
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_TERMINAL_PROMPT: "0",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_NO_REPLACE_OBJECTS: "1",
        },
        timeout: 30_000,
        stdio: ["ignore", "ignore", "pipe"],
      });
    } catch {
      reject("candidate does not descend from the declared base commit");
    }
    if (
      git(repositoryPath, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching", "--ignore-submodules=none"]) !==
      ""
    ) {
      reject("candidate worktree contains dirty or recoverable files");
    }
    return { staging_root: stagingRoot, repository_path: repositoryPath, head_id: headId, tree_id: treeId };
  } catch (error: unknown) {
    if (error instanceof Error && error.message.startsWith("Candidate scratch cannot be released safely:")) throw error;
    return reject("owner-private candidate paths could not be observed safely");
  }
}

/** Remove exactly the validated Nawabari-owned source root; never follows links. */
export function removeSessionCandidateBundleScratch(
  worktree: string,
  identity: SessionCandidateBundleStorageIdentity,
): SessionCandidateBundleStorageReceipt {
  const receipt = inspectSessionCandidateBundleScratch(worktree, identity);
  fs.rmSync(receipt.staging_root, { recursive: true, force: false, maxRetries: 0 });
  try {
    fs.lstatSync(receipt.staging_root);
    return reject("owned scratch remains after removal");
  } catch (error: unknown) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return receipt;
    if (error instanceof Error && error.message.startsWith("Candidate scratch cannot be released safely:")) throw error;
    return reject("removal could not be verified");
  }
}
