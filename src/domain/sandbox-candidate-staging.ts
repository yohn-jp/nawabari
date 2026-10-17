import fs from "node:fs";
import path from "node:path";
import { DomainError, failure, success, type DomainResult } from "./errors.js";
import type { SandboxExecutionRequest } from "./sandbox.js";

/** Conservative intersection check: uncertainty refuses the owner scratch grant. */
export function candidateStagingSelectorMayOverlap(selector: string, scratchRoot: string): boolean {
  const normalized = selector.replaceAll("\\", "/").replace(/\/+$/u, "");
  if (normalized.length === 0 || normalized.startsWith("/") || normalized.split("/").includes("..")) return true;
  const wildcard = normalized.search(/[?*]/u);
  const prefix = wildcard === -1 ? normalized : normalized.slice(0, wildcard).replace(/\/+$/u, "");
  if (prefix.length === 0) return true;
  // A partial path component before a wildcard can match the reserved root.
  if (scratchRoot.startsWith(prefix) || prefix.startsWith(`${scratchRoot}/`)) return true;
  return scratchRoot === prefix || scratchRoot.startsWith(`${prefix}/`);
}

/** Resolve only the private directory issued by the fixed Nawabari staging operation. */
export function resolveOwnerCandidateStagingRoot(request: SandboxExecutionRequest): DomainResult<string | null> {
  const intent = request.owner_candidate_staging ?? request.owner_candidate_verification;
  if (intent === undefined) return success(null);
  const refuse = (reason: string) =>
    failure(
      new DomainError("SANDBOX_TOPOLOGY_INVALID", "The owner candidate staging scope is unavailable.", { reason }),
    );
  if (request.owner_candidate_staging !== undefined && request.owner_candidate_verification !== undefined)
    return refuse("only one fixed candidate operation may be selected");
  const verification = request.owner_candidate_verification;
  if (
    verification !== undefined &&
    (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(verification.head_id) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(verification.tree_id) ||
      !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(verification.base_commit))
  )
    return refuse("invalid staged source identity");
  if (!/^sha256:[0-9a-f]{64}$/u.test(intent.candidate_digest) || !/^[0-9a-f]{24}$/u.test(intent.source_key))
    return refuse("invalid fixed staging identity");
  if (
    request.runtime_projection?.policy.mode !== "strict" ||
    request.runtime_projection.working_set === undefined ||
    request.git_profile === undefined ||
    request.compiled_session_environment === undefined
  )
    return refuse("staging requires a bounded managed strict session");
  const relative = `.nawabari-verification-candidates/${intent.candidate_digest.slice(7)}/${intent.source_key}`;
  const forbidden = [
    ...request.runtime_projection.working_set.scope.deny,
    ...request.git_profile.filesystem.deny,
    ...request.git_profile.filesystem.immutable,
  ];
  if (forbidden.some((selector) => candidateStagingSelectorMayOverlap(selector, relative)))
    return refuse("reserved scratch overlaps a denied or immutable selector");
  try {
    if (fs.realpathSync.native(request.worktree) !== request.worktree) return refuse("noncanonical worktree");
    let current = request.worktree;
    for (const component of relative.split("/")) {
      current = path.join(current, component);
      const stat = fs.lstatSync(current);
      if (
        !stat.isDirectory() ||
        stat.isSymbolicLink() ||
        stat.uid !== process.getuid?.() ||
        (stat.mode & 0o077) !== 0 ||
        fs.realpathSync.native(current) !== current
      )
        return refuse("reserved scratch must be canonical, owner-private directories without symlinks");
    }
    if (verification !== undefined) {
      for (const child of ["repo", "repo/.git"]) {
        const target = path.join(current, child);
        const stat = fs.lstatSync(target);
        if (
          !stat.isDirectory() ||
          stat.isSymbolicLink() ||
          stat.uid !== process.getuid?.() ||
          fs.realpathSync.native(target) !== target
        )
          return refuse("staged repository metadata is not canonical and owned");
      }
    }
    return success(current);
  } catch {
    return refuse("reserved scratch cannot be observed safely");
  }
}
