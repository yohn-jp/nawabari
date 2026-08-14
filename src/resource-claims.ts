import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

import { SessionRegistryError, type RegistryErrorDetails } from "./errors.js";

/**
 * Claim schema version 2 records the distinct overlap semantics below. A
 * persisted v1 claim must be explicitly migrated before it is interpreted by
 * the v2 authority.
 */
export const RESOURCE_CLAIM_SCHEMA_VERSION = 2 as const;
export const LEGACY_RESOURCE_CLAIM_SCHEMA_VERSION = 1 as const;

export const RESOURCE_CLAIM_MODES = ["read", "write", "exclusive-write"] as const;
export type ResourceClaimMode = (typeof RESOURCE_CLAIM_MODES)[number];

/**
 * Normative mode definitions:
 * - read is a non-mutating access declaration, not a consistency lease;
 * - write is ordinary mutation authority and may coexist with read;
 * - exclusive-write is stronger mutation authority and excludes every
 *   overlapping claim.
 *
 * A non-overlapping pair is always compatible, regardless of mode.
 */
export const RESOURCE_CLAIM_COMPATIBILITY_MATRIX: Readonly<
  Record<ResourceClaimMode, Readonly<Record<ResourceClaimMode, "compatible" | "conflict">>>
> = Object.freeze({
  read: Object.freeze({ read: "compatible", write: "compatible", "exclusive-write": "conflict" }),
  write: Object.freeze({ read: "compatible", write: "conflict", "exclusive-write": "conflict" }),
  "exclusive-write": Object.freeze({ read: "conflict", write: "conflict", "exclusive-write": "conflict" }),
});

/** Access strength used by operation authorization; higher includes lower access. */
export const RESOURCE_CLAIM_ACCESS_STRENGTH: Readonly<Record<ResourceClaimMode, number>> = Object.freeze({
  read: 0,
  write: 1,
  "exclusive-write": 2,
});

export interface ResourceClaim {
  readonly schemaVersion: typeof RESOURCE_CLAIM_SCHEMA_VERSION;
  readonly claimId: string;
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly worktreePath: string;
  /** Canonical repository-relative POSIX path or supported glob. */
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ResourceClaimInput {
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly repositoryId?: string;
  readonly repository_id?: string;
  readonly sessionId?: string;
  readonly session_id?: string;
  readonly worktreePath?: string;
  readonly worktree_path?: string;
}

export interface ClaimOwnerContext {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly state: string;
}

export interface CanonicalResourceClaimInput {
  readonly resource: string;
  readonly mode: ResourceClaimMode;
}

const CLAIM_ID_PREFIX = "claim-";
const MAX_SYMLINK_SCAN_ENTRIES = 20_000;
const WINDOWS_ABSOLUTE_PATH = /^[A-Za-z]:[\\/]/u;
const WINDOWS_DRIVE_RELATIVE_PATH = /^[A-Za-z]:/u;
const UNSUPPORTED_GLOB_SYNTAX = /[\[\]{}()]/u;
const WILDCARD_CHARACTERS = /[*?]/u;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export function isResourceClaimMode(value: unknown): value is ResourceClaimMode {
  return typeof value === "string" && (RESOURCE_CLAIM_MODES as readonly string[]).includes(value);
}

export function claimModeGrantsAccess(granted: ResourceClaimMode, required: ResourceClaimMode): boolean {
  return RESOURCE_CLAIM_ACCESS_STRENGTH[granted] >= RESOURCE_CLAIM_ACCESS_STRENGTH[required];
}

export function canonicalClaimId(sessionId: string, resource: string, mode: ResourceClaimMode): string {
  const digest = createHash("sha256")
    .update(sessionId)
    .update("\u0000")
    .update(mode)
    .update("\u0000")
    .update(resource)
    .digest("hex");
  return `${CLAIM_ID_PREFIX}${digest}`;
}

export function canonicalizeClaimInput(
  input: ResourceClaimInput,
  owner: ClaimOwnerContext,
): CanonicalResourceClaimInput {
  if (!isRecord(input)) {
    throw claimError("INVALID_CLAIM", "A resource claim must be an object");
  }
  if (!isResourceClaimMode(input.mode)) {
    throw claimError("INVALID_CLAIM", "Resource claim mode is unsupported", {
      mode: stringifyDetail(input.mode),
    });
  }

  const repositoryId = input.repositoryId ?? input.repository_id;
  if (repositoryId !== undefined && repositoryId !== owner.repositoryId) {
    throw claimError("CLAIM_REPOSITORY_MISMATCH", "Resource claim repository does not match its session", {
      expectedRepositoryId: owner.repositoryId,
      actualRepositoryId: repositoryId,
    });
  }
  const sessionId = input.sessionId ?? input.session_id;
  if (sessionId !== undefined && sessionId !== owner.sessionId) {
    throw claimError("CLAIM_SESSION_MISMATCH", "Resource claim session does not match its owner", {
      expectedSessionId: owner.sessionId,
      actualSessionId: sessionId,
    });
  }
  const worktreePath = input.worktreePath ?? input.worktree_path;
  if (worktreePath !== undefined && typeof worktreePath !== "string") {
    throw claimError("CLAIM_SESSION_MISMATCH", "Resource claim worktree must be a string", {
      expectedWorktreePath: owner.worktreePath,
      actualWorktreePath: stringifyDetail(worktreePath),
    });
  }
  if (worktreePath !== undefined && path.resolve(worktreePath) !== owner.worktreePath) {
    throw claimError("CLAIM_SESSION_MISMATCH", "Resource claim worktree does not match its session", {
      expectedWorktreePath: owner.worktreePath,
      actualWorktreePath: worktreePath,
    });
  }

  return {
    resource: canonicalizeClaimResource(input.resource, owner.worktreePath),
    mode: input.mode,
  };
}

/**
 * Canonicalize a claim lexically and against the physical worktree. The
 * operation is deliberately conservative: it rejects syntax that cannot be
 * represented unambiguously instead of guessing what a caller meant.
 */
export function canonicalizeClaimResource(resource: string, worktreePath: string): string {
  validateResourceString(resource);
  const canonical = canonicalResourceSyntax(resource);
  const root = canonicalWorktreeRoot(worktreePath);
  const segments = canonical.split("/");
  const wildcardIndex = segments.findIndex((segment) => WILDCARD_CHARACTERS.test(segment));
  const staticSegments = wildcardIndex === -1 ? segments : segments.slice(0, wildcardIndex);
  const staticPath = walkStaticPath(root, staticSegments, canonical);

  if (wildcardIndex !== -1) {
    // A glob can select a symlink that does not exist yet. Inspect all current
    // candidates below the first wildcard and reject the whole claim when
    // physical ambiguity is observable. Future callers must still revalidate.
    assertNoSymlinkCandidates(staticPath, segments.slice(wildcardIndex).includes("**"), canonical);
  } else {
    const candidate = path.resolve(root, ...segments);
    assertWithinRoot(root, candidate, canonical);
    const entry = lstatIfPresent(candidate);
    if (entry?.isSymbolicLink()) {
      throw claimError("CLAIM_SYMLINK_ESCAPE", "Resource path is a symbolic link", { resource: canonical });
    }
    if (entry !== undefined) {
      try {
        assertWithinRoot(root, fs.realpathSync.native(candidate), canonical);
      } catch (error: unknown) {
        if (error instanceof SessionRegistryError) throw error;
        throw claimError("CLAIM_SYMLINK_ESCAPE", "Resource path escapes its owning worktree", {
          resource: canonical,
        });
      }
    }
  }

  return canonical;
}

/**
 * Canonicalize a concrete repository-relative path (NOT a glob pattern)
 * against the physical worktree. Any `*` or `?` characters in the input are
 * treated as literal filename characters, not glob wildcards. The path is
 * validated for traversal and symlink escapes exactly like
 * `canonicalizeClaimResource`, but without glob expansion or candidate
 * scanning.
 */
export function canonicalizeConcretePath(resource: string, worktreePath: string): string {
  validateResourceString(resource);
  const canonical = canonicalResourceSyntax(resource);
  const root = canonicalWorktreeRoot(worktreePath);
  const segments = canonical.split("/");
  const candidate = walkStaticPath(root, segments, canonical);
  assertWithinRoot(root, candidate, canonical);
  const entry = lstatIfPresent(candidate);
  if (entry?.isSymbolicLink()) {
    throw claimError("CLAIM_SYMLINK_ESCAPE", "Resource path is a symbolic link", { resource: canonical });
  }
  if (entry !== undefined) {
    try {
      assertWithinRoot(root, fs.realpathSync.native(candidate), canonical);
    } catch (error: unknown) {
      if (error instanceof SessionRegistryError) throw error;
      throw claimError("CLAIM_SYMLINK_ESCAPE", "Resource path escapes its owning worktree", {
        resource: canonical,
      });
    }
  }
  return canonical;
}

/** Validate a resource already persisted as canonical without requiring its worktree to exist. */
export function assertCanonicalClaimResource(resource: string): void {
  validateResourceString(resource);
  if (canonicalResourceSyntax(resource) !== resource) {
    throw claimError("CLAIM_AMBIGUOUS_PATH", "Persisted resource is not canonical", { resource });
  }
}

export function createResourceClaim(
  input: CanonicalResourceClaimInput,
  owner: ClaimOwnerContext,
  timestamp: string,
): ResourceClaim {
  if (!isResourceClaimMode(input.mode)) {
    throw claimError("INVALID_CLAIM", "Resource claim mode is unsupported", {
      mode: stringifyDetail(input.mode),
    });
  }
  assertCanonicalClaimResource(input.resource);
  if (!isTimestamp(timestamp)) {
    throw claimError("INVALID_CLAIM", "Claim timestamp is not canonical", { timestamp });
  }
  return Object.freeze({
    schemaVersion: RESOURCE_CLAIM_SCHEMA_VERSION,
    claimId: canonicalClaimId(owner.sessionId, input.resource, input.mode),
    sessionId: owner.sessionId,
    repositoryId: owner.repositoryId,
    worktreePath: owner.worktreePath,
    resource: input.resource,
    mode: input.mode,
    createdAt: timestamp,
    updatedAt: timestamp,
  });
}

export function cloneResourceClaim(claim: ResourceClaim): ResourceClaim {
  return Object.freeze({ ...claim });
}

export function claimsOverlap(left: ResourceClaim, right: ResourceClaim): boolean {
  return globPatternsOverlap(left.resource, right.resource);
}

/** Match a canonical concrete repository resource against a persisted claim. */
export function resourceMatchesClaim(claim: Pick<ResourceClaim, "resource">, resource: string): boolean {
  return globPatternsOverlap(claim.resource, resource);
}

/** Apply the existing claim compatibility matrix to one concrete resource. */
export function resourceClaimConflictsWithAccess(
  claim: Pick<ResourceClaim, "resource" | "mode">,
  resource: string,
  requiredMode: ResourceClaimMode,
): boolean {
  return (
    resourceMatchesClaim(claim, resource) &&
    RESOURCE_CLAIM_COMPATIBILITY_MATRIX[claim.mode][requiredMode] === "conflict"
  );
}

export function claimsConflict(left: ResourceClaim, right: ResourceClaim): boolean {
  return claimsOverlap(left, right) && RESOURCE_CLAIM_COMPATIBILITY_MATRIX[left.mode][right.mode] === "conflict";
}

export function claimSortKey(claim: Pick<ResourceClaim, "sessionId" | "resource" | "mode" | "claimId">): string {
  return `${claim.resource}\u0000${claim.mode}\u0000${claim.sessionId}\u0000${claim.claimId}`;
}

export function sortResourceClaims<T extends Pick<ResourceClaim, "sessionId" | "resource" | "mode" | "claimId">>(
  claims: readonly T[],
): T[] {
  return [...claims].sort((left, right) => compareCodePointStrings(claimSortKey(left), claimSortKey(right)));
}

export function compareCodePointStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

export function claimError(
  code:
    | "INVALID_CLAIM"
    | "INVALID_CLAIM_RESOURCE"
    | "CLAIM_PATH_TRAVERSAL"
    | "CLAIM_SYMLINK_ESCAPE"
    | "CLAIM_AMBIGUOUS_PATH"
    | "UNSUPPORTED_CLAIM_GLOB"
    | "CLAIM_REPOSITORY_MISMATCH"
    | "CLAIM_SESSION_MISMATCH"
    | "DUPLICATE_CLAIM"
    | "CONTRADICTORY_CLAIM"
    | "RESOURCE_CLAIM_CONFLICT"
    | "CLAIM_NOT_FOUND"
    | "SESSION_NOT_ACTIVE"
    | "UNSUPPORTED_CLAIM_SCHEMA_VERSION",
  message: string,
  details: RegistryErrorDetails = {},
): SessionRegistryError {
  return new SessionRegistryError(code, message, details);
}

function validateResourceString(resource: string): void {
  if (typeof resource !== "string" || resource.length === 0) {
    throw claimError("INVALID_CLAIM_RESOURCE", "Claim resource must be a non-empty string");
  }
  if (resource.includes("\u0000")) {
    throw claimError("INVALID_CLAIM_RESOURCE", "Claim resource contains a NUL byte");
  }
  if (resource !== resource.normalize("NFC")) {
    throw claimError("CLAIM_AMBIGUOUS_PATH", "Claim resource is not Unicode-normalized", { resource });
  }
  if (resource.includes("\\")) {
    throw claimError("CLAIM_AMBIGUOUS_PATH", "Backslash separators and escapes are unsupported", { resource });
  }
  if (resource.startsWith("/") || WINDOWS_ABSOLUTE_PATH.test(resource) || WINDOWS_DRIVE_RELATIVE_PATH.test(resource)) {
    throw claimError("CLAIM_PATH_TRAVERSAL", "Claim resource must be repository-relative", { resource });
  }
}

function canonicalResourceSyntax(resource: string): string {
  const segments = resource.split("/");
  if (segments.some((segment) => segment === "..")) {
    throw claimError("CLAIM_PATH_TRAVERSAL", "Claim resource contains a parent traversal segment", { resource });
  }
  if (segments.length === 0 || segments.some((segment) => segment.length === 0 || segment === ".")) {
    throw claimError("CLAIM_AMBIGUOUS_PATH", "Claim resource contains ambiguous path separators", { resource });
  }
  if (segments.some((segment) => UNSUPPORTED_GLOB_SYNTAX.test(segment))) {
    throw claimError("UNSUPPORTED_CLAIM_GLOB", "Claim resource uses unsupported glob syntax", { resource });
  }
  for (const segment of segments) {
    if (segment.includes("**") && segment !== "**") {
      throw claimError("UNSUPPORTED_CLAIM_GLOB", "Double-star must occupy a complete path segment", { resource });
    }
  }
  if (segments.length === 1 && segments[0] === "**") return "**";
  return segments.join("/");
}

function canonicalWorktreeRoot(worktreePath: string): string {
  const lexical = path.resolve(worktreePath);
  const entry = lstatIfPresent(lexical);
  if (entry?.isSymbolicLink()) {
    throw claimError("CLAIM_SYMLINK_ESCAPE", "The owning session worktree is a symbolic link", {
      worktree: lexical,
    });
  }
  if (entry === undefined || !entry.isDirectory()) {
    throw new SessionRegistryError(
      "WORKTREE_IDENTITY_AMBIGUOUS",
      "The owning session worktree is missing or not a directory",
      { worktree: lexical },
    );
  }
  let realpath: string;
  try {
    realpath = fs.realpathSync.native(lexical);
  } catch (error: unknown) {
    throw new SessionRegistryError(
      "WORKTREE_IDENTITY_AMBIGUOUS",
      "The owning session worktree cannot be resolved",
      { worktree: lexical },
      error,
    );
  }
  if (path.resolve(realpath) !== lexical) {
    throw claimError("CLAIM_SYMLINK_ESCAPE", "The owning worktree has a symbolic-link alias", {
      worktree: lexical,
      realpath,
    });
  }
  return realpath;
}

function walkStaticPath(root: string, segments: readonly string[], resource: string): string {
  let current = root;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    current = path.join(current, segment);
    assertWithinRoot(root, current, resource);
    const entry = lstatIfPresent(current);
    if (entry?.isSymbolicLink()) {
      throw claimError("CLAIM_SYMLINK_ESCAPE", "Claim path contains a symbolic link", { resource });
    }
    if (entry !== undefined && !entry.isDirectory() && index !== segments.length - 1) {
      throw claimError("INVALID_CLAIM_RESOURCE", "Claim path traverses a non-directory", { resource });
    }
    if (entry === undefined) break;
  }
  return current;
}

function assertNoSymlinkCandidates(root: string, recursive: boolean, resource: string): void {
  if (!fs.existsSync(root)) return;
  let inspected = 0;
  const visit = (directory: string, deep: boolean): void => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch (error: unknown) {
      throw claimError("CLAIM_AMBIGUOUS_PATH", "Could not inspect glob candidates", { resource });
    }
    for (const entry of entries) {
      inspected += 1;
      if (inspected > MAX_SYMLINK_SCAN_ENTRIES) {
        throw claimError("CLAIM_AMBIGUOUS_PATH", "Glob candidate set is too large to validate safely", { resource });
      }
      if (entry.isSymbolicLink()) {
        throw claimError("CLAIM_SYMLINK_ESCAPE", "Glob may select a symbolic link", { resource });
      }
      if (deep && entry.isDirectory()) visit(path.join(directory, entry.name), true);
    }
  };
  visit(root, recursive);
}

function assertWithinRoot(root: string, candidate: string, resource: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (relative !== "" && (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)))
  ) {
    throw claimError("CLAIM_PATH_TRAVERSAL", "Claim resource escapes its owning worktree", { resource });
  }
}

function lstatIfPresent(candidate: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return undefined;
    throw claimError("CLAIM_AMBIGUOUS_PATH", "Could not inspect claim path", { path: candidate });
  }
}

function globPatternsOverlap(left: string, right: string): boolean {
  const leftSegments = left.split("/");
  const rightSegments = right.split("/");
  const queue: Array<[number, number, boolean]> = [[0, 0, false]];
  const visited = new Set<string>();

  while (queue.length > 0) {
    const [leftIndex, rightIndex, consumed] = queue.shift() as [number, number, boolean];
    const key = `${leftIndex}:${rightIndex}:${consumed ? 1 : 0}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === leftSegments.length && rightIndex === rightSegments.length) {
      if (consumed) return true;
      continue;
    }

    const leftGlobStar = leftSegments[leftIndex] === "**";
    const rightGlobStar = rightSegments[rightIndex] === "**";

    if (leftGlobStar) {
      queue.push([leftIndex + 1, rightIndex, consumed]);
      queue.push([leftIndex, rightIndex, true]);
    }
    if (rightGlobStar) {
      queue.push([leftIndex, rightIndex + 1, consumed]);
      queue.push([leftIndex, rightIndex, true]);
    }
    if (leftGlobStar && rightGlobStar) {
      queue.push([leftIndex + 1, rightIndex + 1, consumed]);
      continue;
    }
    if (leftIndex >= leftSegments.length || rightIndex >= rightSegments.length) continue;
    if (rightGlobStar) {
      queue.push([leftIndex + 1, rightIndex, true]);
      continue;
    }
    if (leftGlobStar) {
      queue.push([leftIndex, rightIndex + 1, true]);
      continue;
    }
    if (segmentPatternsOverlap(leftSegments[leftIndex], rightSegments[rightIndex])) {
      queue.push([leftIndex + 1, rightIndex + 1, true]);
    }
  }
  return false;
}

function segmentPatternsOverlap(left: string, right: string): boolean {
  const queue: Array<[number, number, boolean]> = [[0, 0, false]];
  const visited = new Set<string>();
  while (queue.length > 0) {
    const [leftIndex, rightIndex, consumed] = queue.shift() as [number, number, boolean];
    const key = `${leftIndex}:${rightIndex}:${consumed ? 1 : 0}`;
    if (visited.has(key)) continue;
    visited.add(key);
    if (leftIndex === left.length && rightIndex === right.length) {
      if (consumed) return true;
      continue;
    }

    const leftChar = left[leftIndex];
    const rightChar = right[rightIndex];
    if (leftChar === "*") queue.push([leftIndex + 1, rightIndex, consumed]);
    if (rightChar === "*") queue.push([leftIndex, rightIndex + 1, consumed]);

    if (leftChar === "*" && rightIndex < right.length) queue.push([leftIndex, rightIndex + 1, true]);
    if (rightChar === "*" && leftIndex < left.length) queue.push([leftIndex + 1, rightIndex, true]);

    if (leftIndex < left.length && rightIndex < right.length && leftChar !== "*" && rightChar !== "*") {
      if (leftChar === "?" || rightChar === "?" || leftChar === rightChar) {
        queue.push([leftIndex + 1, rightIndex + 1, true]);
      }
    }
  }
  return false;
}

function isTimestamp(value: string): boolean {
  return (
    ISO_TIMESTAMP_PATTERN.test(value) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value
  );
}

function isRecord(value: unknown): value is ResourceClaimInput {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}

function stringifyDetail(value: unknown): string {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
    ? String(value)
    : "<invalid>";
}
