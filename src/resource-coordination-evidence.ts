import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  defaultGit,
  readBoundedGitDiff,
  readCurrentHead,
  observeGitCheckpoint,
  readTreePathStates,
  verifyPhysicalExecutionContext,
  type GitCommandRunner,
  type GitTreeEntry,
  type RepositoryContext,
} from "./git.js";
import { SessionRegistryError } from "./errors.js";
import type { GitCheckpointPaths } from "./operation-authorization.js";
import { evidenceHash } from "./repository-evidence.js";
import {
  canonicalizeConcretePath,
  claimsOverlap,
  resourceMatchesClaim,
  type ResourceClaim,
} from "./resource-claims.js";
import type { SessionRecord } from "./session-registry.js";

export const COORDINATION_EVIDENCE_SCHEMA_VERSION = 1 as const;
export const COORDINATION_BLOB_SCHEMA_VERSION = 1 as const;
export const COORDINATION_EVIDENCE_SOURCE = "git-evidence" as const;
export const COORDINATION_DEFAULT_MAX_PATHS = 64 as const;
export const COORDINATION_DEFAULT_MAX_CONTENT_BYTES = 64 * 1024;
export const COORDINATION_DEFAULT_MAX_DIFF_BYTES = 64 * 1024;
export const COORDINATION_DEFAULT_MAX_DIFF_HUNKS = 128;
export const COORDINATION_DEFAULT_MAX_RETRIES = 1;

export type CoordinationObservationStatus = "stable" | "stale" | "unavailable";
export type CoordinationComparisonStatus =
  "no-change" | "one-sided-change" | "two-sided-divergence" | "unavailable" | "ambiguous-base";
export type CoordinationBlobDisposition =
  | "regular"
  | "missing"
  | "untracked"
  | "symlink"
  | "gitlink"
  | "directory"
  | "special"
  | "binary"
  | "read-denied"
  | "too-large"
  | "unavailable";

export interface CoordinationContent {
  readonly origin: "revision-blob" | "worktree-file";
  readonly encoding: "base64";
  readonly bytes: string;
  readonly contentHash: string;
  readonly byteLength: number;
}

export interface CoordinationBlobSide {
  readonly origin: "revision-blob" | "worktree-file";
  readonly state: CoordinationBlobDisposition;
  readonly mode: string | null;
  readonly type: string | null;
  readonly contentHash: string | null;
  readonly byteLength: number | null;
  readonly content: CoordinationContent | null;
  readonly redacted: boolean;
}

export interface CoordinationBlobState {
  readonly schemaVersion: typeof COORDINATION_BLOB_SCHEMA_VERSION;
  readonly source: typeof COORDINATION_EVIDENCE_SOURCE;
  readonly path: string;
  readonly revision: string;
  readonly revisionBlob: CoordinationBlobSide;
  readonly worktree: CoordinationBlobSide;
  readonly equal: boolean;
  readonly complete: boolean;
}

export interface CoordinationBlobReadOptions {
  readonly maxContentBytes?: number;
  /** Content is withheld unless this explicit authority is supplied. */
  readonly includeContent?: boolean;
  readonly operatorAuthorized?: boolean;
  readonly allowedReadPaths?: readonly string[];
}

export interface CoordinationObservationLimits {
  readonly maxPaths?: number;
  readonly maxContentBytes?: number;
  readonly maxDiffBytes?: number;
  readonly maxDiffHunks?: number;
  readonly maxRetries?: number;
  readonly includeContent?: boolean;
  readonly includePatch?: boolean;
  /** Operator authority permits content for paths without a session read claim. */
  readonly operatorAuthorized?: boolean;
  /** Explicitly approved repository-relative paths for cross-session content. */
  readonly allowedReadPaths?: readonly string[];
  readonly git?: GitCommandRunner;
}

export interface CoordinationSelectedSession {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly state: string;
  readonly baseRevision?: string;
  readonly createdAt?: string;
  readonly updatedAt?: string;
}

export interface CoordinationSessionObservation {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
  readonly headId: string | null;
  readonly baseRevision: string | null;
  readonly claimSetGeneration: number;
  readonly checkpoint: GitCheckpointPaths;
  readonly claims: readonly CoordinationClaim[];
  readonly paths: readonly CoordinationPathEvidence[];
  readonly complete: boolean;
}

export interface CoordinationClaim {
  readonly claimId: string;
  readonly sessionId: string;
  readonly resource: string;
  readonly mode: ResourceClaim["mode"];
}

export interface CoordinationPathEvidence {
  readonly path: string;
  readonly base: GitTreeEntry | null;
  readonly head: GitTreeEntry | null;
  readonly blob: CoordinationBlobState;
  readonly changedFromBase: boolean | null;
  readonly changedInWorktree: boolean | null;
  readonly indexChanged: boolean;
  readonly worktreeChanged: boolean;
  readonly untracked: boolean;
  readonly missing: boolean;
  readonly contentHash: string | null;
  readonly mode: string | null;
  readonly diff: CoordinationDiffEvidence | null;
  readonly unavailable: boolean;
  readonly complete: boolean;
}

export interface CoordinationDiffEvidence {
  readonly statsAvailable: boolean;
  readonly additions: number | null;
  readonly deletions: number | null;
  readonly binary: boolean | null;
  readonly patch: string | null;
  readonly patchBytes: number;
  readonly hunkCount: number;
}

export interface CoordinationPathComparison {
  readonly path: string;
  readonly sessionIds: readonly string[];
  readonly status: CoordinationComparisonStatus;
  readonly complete: boolean;
}

export interface CoordinationObservationToken {
  readonly schemaVersion: typeof COORDINATION_EVIDENCE_SCHEMA_VERSION;
  readonly source: typeof COORDINATION_EVIDENCE_SOURCE;
  readonly operation: "coordination-observation";
  readonly status: CoordinationObservationStatus;
  readonly stale: boolean;
  readonly attempts: number;
  readonly repositoryId: string;
  readonly registryRevision: number | null;
  readonly claimSetGeneration: number;
  readonly sessions: readonly CoordinationSessionObservation[];
  readonly paths: readonly CoordinationPathComparison[];
  readonly complete: boolean;
  readonly bounds: CoordinationObservationBounds;
  readonly evidenceHash: string;
}

export interface CoordinationObservationBounds {
  readonly maxPaths: number;
  readonly maxContentBytes: number;
  readonly maxDiffBytes: number;
  readonly maxDiffHunks: number;
  readonly maxRetries: number;
}

interface CoordinationRegistry {
  readonly repository?: RepositoryContext;
  readonly paths?: { readonly registry?: string };
  readonly registryRevision?: number;
  readonly revision?: number;
  readonly sessions?: readonly SessionRecord[];
  readonly claims?: readonly ResourceClaim[] | ((sessionId?: string | null) => readonly ResourceClaim[]);
  read?(): readonly SessionRecord[];
  list?(): readonly SessionRecord[];
  get?(sessionId: string): SessionRecord | undefined;
  listClaims?(sessionId?: string | null): readonly ResourceClaim[];
  listClaimsSnapshot?(sessionId?: string | null): {
    readonly claims: readonly ResourceClaim[];
    readonly claimSetGeneration: number;
  };
  getClaimSetGeneration?(): number;
  claimSetGeneration?(): number;
}

interface RegistrySnapshot {
  readonly sessions: readonly SessionRecord[];
  readonly claims: readonly ResourceClaim[];
  readonly claimSetGeneration: number;
  readonly registryRevision: number | null;
}

interface PhysicalObservation {
  readonly record: SessionRecord;
  readonly headId: string;
  readonly checkpoint: GitCheckpointPaths;
  readonly claims: readonly ResourceClaim[];
}

interface ObservationAttempt {
  readonly token: CoordinationObservationToken;
  readonly stable: boolean;
}

/**
 * Observe the bounded overlap surface for selected sessions. This operation
 * never mutates claims or worktrees. A successful token is valid only when
 * registry, HEAD, checkpoint, and selected path identity remain unchanged
 * across the observation.
 */
export function observeCoordinationInputs(
  registry: CoordinationRegistry,
  selectedSessions: readonly (string | CoordinationSelectedSession)[],
  paths: readonly string[] = [],
  limits: CoordinationObservationLimits = {},
): CoordinationObservationToken {
  const bounds = resolveBounds(limits);
  const git = limits.git ?? defaultGit;
  let baselineRegistry = readRegistrySnapshot(registry);
  const records = selectSessions(baselineRegistry.sessions, selectedSessions);
  if (records.length === 0) {
    throw new SessionRegistryError("SESSION_NOT_FOUND", "At least one coordination session is required");
  }
  const repository = registry.repository ?? resolveRepositoryForRecord(records[0], git);
  if (records.some((record) => record.repositoryId !== repository.repositoryId)) {
    throw new SessionRegistryError("REPOSITORY_MISMATCH", "Selected sessions do not share repository identity", {
      repositoryId: repository.repositoryId,
    });
  }

  const explicitPaths = canonicalizeSelectedPaths(paths, records[0]?.worktreePath);
  const maxRetries = bounds.maxRetries;
  let last: ObservationAttempt | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const attemptRecords = selectSessions(baselineRegistry.sessions, selectedSessions);
    const result = observeAttempt(
      registry,
      repository,
      git,
      attemptRecords,
      baselineRegistry,
      explicitPaths,
      bounds,
      attempt + 1,
      limits,
    );
    last = result;
    if (result.stable) return result.token;
    baselineRegistry = readRegistrySnapshot(registry);
  }
  if (last !== undefined) return last.token;
  throw new SessionRegistryError("PHYSICAL_OBSERVATION_UNAVAILABLE", "Coordination observation produced no result");
}

/**
 * Read one revision blob and its corresponding current worktree entry while
 * preserving origin and non-regular states. Binary and inaccessible content
 * is never converted to an empty string.
 */
export function readCoordinationBlobState(
  git: GitCommandRunner,
  worktree: string,
  revision: string,
  resource: string,
  options: CoordinationBlobReadOptions = {},
): CoordinationBlobState {
  const maxContentBytes = options.maxContentBytes ?? COORDINATION_DEFAULT_MAX_CONTENT_BYTES;
  assertBound(maxContentBytes, "maxContentBytes");
  const canonicalPath = canonicalizeConcretePath(resource, worktree);
  let revisionEntry: GitTreeEntry | undefined;
  try {
    revisionEntry = readTreePathStates(git, worktree, revision, [canonicalPath]).get(canonicalPath);
  } catch {
    const unavailable = Object.freeze({
      schemaVersion: COORDINATION_BLOB_SCHEMA_VERSION,
      source: COORDINATION_EVIDENCE_SOURCE,
      path: canonicalPath,
      revision,
      revisionBlob: emptySide("revision-blob", "unavailable"),
      worktree: readWorktreeSide(worktree, canonicalPath, maxContentBytes),
      equal: false,
      complete: false,
    });
    const contentAuthorized =
      options.includeContent === true &&
      (options.operatorAuthorized === true || (options.allowedReadPaths ?? []).includes(canonicalPath));
    return contentAuthorized ? unavailable : redactBlob(unavailable);
  }
  const revisionBlob = readRevisionSide(git, worktree, revision, canonicalPath, revisionEntry, maxContentBytes);
  const worktreeSide = readWorktreeSide(worktree, canonicalPath, maxContentBytes);
  const equal =
    revisionBlob.state === "regular" &&
    worktreeSide.state === "regular" &&
    revisionBlob.contentHash !== null &&
    revisionBlob.contentHash === worktreeSide.contentHash &&
    revisionBlob.mode === worktreeSide.mode;
  const complete = revisionBlob.state !== "unavailable" && worktreeSide.state !== "unavailable";
  const result = Object.freeze({
    schemaVersion: COORDINATION_BLOB_SCHEMA_VERSION,
    source: COORDINATION_EVIDENCE_SOURCE,
    path: canonicalPath,
    revision,
    revisionBlob,
    worktree: worktreeSide,
    equal,
    complete,
  });
  const contentAuthorized =
    options.includeContent === true &&
    (options.operatorAuthorized === true || (options.allowedReadPaths ?? []).includes(canonicalPath));
  return contentAuthorized ? result : redactBlob(result);
}

function observeAttempt(
  registry: CoordinationRegistry,
  repository: RepositoryContext,
  git: GitCommandRunner,
  records: readonly SessionRecord[],
  initialRegistry: RegistrySnapshot,
  explicitPaths: readonly string[],
  bounds: CoordinationObservationBounds,
  attempt: number,
  limits: CoordinationObservationLimits,
): ObservationAttempt {
  const selectedIds = new Set(records.map((record) => record.sessionId));
  const initialClaims = initialRegistry.claims.filter((claim) => selectedIds.has(claim.sessionId));
  let physical: readonly PhysicalObservation[];
  try {
    physical = readPhysicalObservations(repository, git, records, initialClaims);
  } catch {
    return unavailableAttemptToken(repository, records, initialClaims, initialRegistry, explicitPaths, bounds, attempt);
  }
  const selectedPaths = limitPaths(
    explicitPaths.length > 0 ? explicitPaths : deriveOverlapPaths(physical, initialClaims),
    bounds.maxPaths,
  );
  let observationUnavailable = false;
  const sessionObservations = physical.map((entry) => {
    try {
      const session = buildSessionObservation(
        entry,
        selectedPaths,
        initialClaims,
        records.length,
        initialRegistry.claimSetGeneration,
        git,
        bounds,
        limits,
      );
      if (session.paths.some((pathEvidence) => pathEvidence.unavailable)) observationUnavailable = true;
      return session;
    } catch {
      observationUnavailable = true;
      return unavailableSessionObservation(
        entry.record,
        entry.headId,
        entry.checkpoint,
        entry.claims,
        selectedPaths,
        initialRegistry.claimSetGeneration,
      );
    }
  });
  const baseRevisions = sessionObservations.map((session) => session.baseRevision);
  const baseCompatible =
    baseRevisions.length === 1
      ? baseRevisions[0] !== null
      : baseRevisions.length > 1 &&
        baseRevisions[0] !== null &&
        baseRevisions.every((revision) => revision !== null && revision === baseRevisions[0]);
  const pathComparisons = selectedPaths.map((resource) => comparePath(resource, sessionObservations, baseCompatible));

  let finalPhysical: readonly PhysicalObservation[];
  try {
    finalPhysical = readPhysicalObservations(repository, git, records, initialClaims);
  } catch {
    return unavailableAttemptToken(repository, records, initialClaims, initialRegistry, selectedPaths, bounds, attempt);
  }
  const finalRegistry = readRegistrySnapshot(registry);
  const unchanged =
    sameRegistrySnapshot(initialRegistry, finalRegistry, selectedIds) &&
    physical.every((entry, index) => samePhysicalObservation(entry, finalPhysical[index])) &&
    sessionObservations.every((session, index) =>
      samePathIdentity(session, finalPhysical[index], selectedPaths, bounds, limits),
    );
  const status: CoordinationObservationStatus = !unchanged
    ? "stale"
    : observationUnavailable
      ? "unavailable"
      : "stable";
  const complete =
    unchanged && sessionObservations.every((session) => session.complete) && pathComparisons.every((p) => p.complete);
  const withoutHash = {
    schemaVersion: COORDINATION_EVIDENCE_SCHEMA_VERSION,
    source: COORDINATION_EVIDENCE_SOURCE,
    operation: "coordination-observation" as const,
    status,
    stale: !unchanged,
    attempts: attempt,
    repositoryId: repository.repositoryId,
    registryRevision: finalRegistry.registryRevision,
    claimSetGeneration: finalRegistry.claimSetGeneration,
    sessions: Object.freeze(sessionObservations),
    paths: Object.freeze(pathComparisons),
    complete,
    bounds,
  };
  return {
    stable: unchanged || observationUnavailable,
    token: Object.freeze({ ...withoutHash, evidenceHash: evidenceHash(withoutHash) }),
  };
}

function readPhysicalObservations(
  repository: RepositoryContext,
  git: GitCommandRunner,
  records: readonly SessionRecord[],
  claims: readonly ResourceClaim[],
): readonly PhysicalObservation[] {
  return records.map((record) => {
    if (record.state !== "active") {
      throw new SessionRegistryError("STALE_REGISTRY", `Session is not active: ${record.sessionId}`, {
        sessionId: record.sessionId,
        state: record.state,
      });
    }
    const physical = verifyPhysicalExecutionContext({
      repository,
      worktreePath: record.worktreePath,
      branchName: record.branchName,
      git,
    });
    if (
      physical.worktreeId !== record.worktreeId ||
      physical.branchId !== record.branchId ||
      physical.worktreePath !== record.worktreePath
    ) {
      throw new SessionRegistryError("OWNERSHIP_MISMATCH", "Selected session does not own its physical worktree", {
        sessionId: record.sessionId,
        expectedWorktree: record.worktreePath,
        actualWorktree: physical.worktreePath,
      });
    }
    const headId = readCurrentHead(git, record.worktreePath);
    const checkpoint = observeCheckpoint(git, record.worktreePath);
    return Object.freeze({
      record,
      headId,
      checkpoint,
      claims: Object.freeze(claims.filter((claim) => claim.sessionId === record.sessionId)),
    });
  });
}

function unavailableAttemptToken(
  repository: RepositoryContext,
  records: readonly SessionRecord[],
  claims: readonly ResourceClaim[],
  registry: RegistrySnapshot,
  paths: readonly string[],
  bounds: CoordinationObservationBounds,
  attempt: number,
): ObservationAttempt {
  const selectedPaths = limitPaths(paths, bounds.maxPaths);
  const sessions = records.map((record) =>
    unavailableSessionObservation(
      record,
      null,
      emptyCheckpoint(),
      claims.filter((claim) => claim.sessionId === record.sessionId),
      selectedPaths,
      registry.claimSetGeneration,
    ),
  );
  const comparisons = selectedPaths.map((resource) => comparePath(resource, sessions, true));
  const withoutHash = {
    schemaVersion: COORDINATION_EVIDENCE_SCHEMA_VERSION,
    source: COORDINATION_EVIDENCE_SOURCE,
    operation: "coordination-observation" as const,
    status: "unavailable" as const,
    stale: false,
    attempts: attempt,
    repositoryId: repository.repositoryId,
    registryRevision: registry.registryRevision,
    claimSetGeneration: registry.claimSetGeneration,
    sessions: Object.freeze(sessions),
    paths: Object.freeze(comparisons),
    complete: false,
    bounds,
  };
  return {
    stable: true,
    token: Object.freeze({ ...withoutHash, evidenceHash: evidenceHash(withoutHash) }),
  };
}

function unavailableSessionObservation(
  record: SessionRecord,
  headId: string | null,
  checkpoint: GitCheckpointPaths,
  claims: readonly ResourceClaim[],
  paths: readonly string[],
  claimSetGeneration: number,
): CoordinationSessionObservation {
  return Object.freeze({
    sessionId: record.sessionId,
    repositoryId: record.repositoryId,
    worktreeId: record.worktreeId,
    worktreePath: record.worktreePath,
    branchId: record.branchId,
    branchName: record.branchName,
    headId,
    baseRevision: record.baseRevision ?? null,
    claimSetGeneration,
    checkpoint,
    claims: Object.freeze(
      claims.map(({ claimId, sessionId, resource, mode }) => ({ claimId, sessionId, resource, mode })),
    ),
    paths: Object.freeze(
      paths.map((resource) =>
        Object.freeze({
          path: resource,
          base: null,
          head: null,
          blob: unavailableBlobState(resource, headId ?? "unavailable"),
          changedFromBase: null,
          changedInWorktree: null,
          indexChanged: false,
          worktreeChanged: false,
          untracked: false,
          missing: false,
          contentHash: null,
          mode: null,
          diff: null,
          unavailable: true,
          complete: false,
        }),
      ),
    ),
    complete: false,
  });
}

function unavailableBlobState(resource: string, revision: string): CoordinationBlobState {
  return Object.freeze({
    schemaVersion: COORDINATION_BLOB_SCHEMA_VERSION,
    source: COORDINATION_EVIDENCE_SOURCE,
    path: resource,
    revision,
    revisionBlob: emptySide("revision-blob", "unavailable"),
    worktree: emptySide("worktree-file", "unavailable"),
    equal: false,
    complete: false,
  });
}

function emptyCheckpoint(): GitCheckpointPaths {
  return Object.freeze({ changed: [], staged: [], unstaged: [], untracked: [] });
}

function buildSessionObservation(
  physical: PhysicalObservation,
  selectedPaths: readonly string[],
  claims: readonly ResourceClaim[],
  selectedSessionCount: number,
  claimSetGeneration: number,
  git: GitCommandRunner,
  bounds: CoordinationObservationBounds,
  limits: CoordinationObservationLimits,
): CoordinationSessionObservation {
  const { record } = physical;
  const baseRevision = record.baseRevision ?? null;
  const baseTree =
    baseRevision === null
      ? new Map<string, GitTreeEntry>()
      : readTreePathStates(git, record.worktreePath, baseRevision, selectedPaths);
  const headTree = readTreePathStates(git, record.worktreePath, physical.headId, selectedPaths);
  const pathEvidence = selectedPaths.map((resource) => {
    const authorized = contentAuthorized(record.sessionId, resource, claims, selectedSessionCount, limits);
    let blob = readCoordinationBlobState(git, record.worktreePath, physical.headId, resource, {
      maxContentBytes: bounds.maxContentBytes,
      includeContent: limits.includeContent === true && authorized,
      operatorAuthorized: authorized,
      allowedReadPaths: limits.allowedReadPaths,
    });
    const base = baseTree.get(resource) ?? null;
    const head = headTree.get(resource) ?? null;
    const checkpoint = physical.checkpoint;
    const indexChanged = checkpoint.staged.includes(resource);
    const worktreeChanged = checkpoint.unstaged.includes(resource);
    const untracked = checkpoint.untracked.includes(resource);
    const missing = blob.worktree.state === "missing";
    const changedInWorktree = indexChanged || worktreeChanged || untracked || missing || !blob.equal;
    const changedFromBase = baseRevision === null ? null : !treeEntriesEqualSafe(base, head) || changedInWorktree;
    if (untracked && blob.worktree.state === "regular") {
      blob = Object.freeze({
        ...blob,
        worktree: Object.freeze({ ...blob.worktree, state: "untracked" as const }),
      });
    }
    const redactedBlob = limits.includeContent === true && authorized ? blob : redactBlob(blob);
    const diff = readDiffEvidence(git, record.worktreePath, physical.headId, resource, authorized, bounds, limits);
    const diffComplete = diff !== null && (diff.statsAvailable || changedInWorktree === false);
    return Object.freeze({
      path: resource,
      base,
      head,
      blob: redactedBlob,
      changedFromBase,
      changedInWorktree,
      indexChanged,
      worktreeChanged,
      untracked,
      missing,
      contentHash: redactedBlob.worktree.contentHash,
      mode: redactedBlob.worktree.mode,
      diff,
      unavailable: !redactedBlob.complete || diff === null,
      complete: redactedBlob.complete && diffComplete,
    });
  });
  return Object.freeze({
    sessionId: record.sessionId,
    repositoryId: record.repositoryId,
    worktreeId: record.worktreeId,
    worktreePath: record.worktreePath,
    branchId: record.branchId,
    branchName: record.branchName,
    headId: physical.headId,
    baseRevision,
    claimSetGeneration,
    checkpoint: physical.checkpoint,
    claims: Object.freeze(
      physical.claims.map(({ claimId, sessionId, resource, mode }) => ({ claimId, sessionId, resource, mode })),
    ),
    paths: Object.freeze(pathEvidence),
    complete: pathEvidence.every((entry) => entry.complete),
  });
}

function readDiffEvidence(
  git: GitCommandRunner,
  worktree: string,
  headId: string,
  resource: string,
  authorized: boolean,
  bounds: CoordinationObservationBounds,
  limits: CoordinationObservationLimits,
): CoordinationDiffEvidence | null {
  try {
    const diff = readBoundedGitDiff(git, worktree, {
      paths: [resource],
      from: headId,
      includePatch: authorized && limits.includePatch === true,
      maxBytes: bounds.maxDiffBytes,
      maxHunks: bounds.maxDiffHunks,
    });
    const stat = diff.stats[0];
    return Object.freeze({
      statsAvailable: stat?.available ?? false,
      additions: stat?.additions ?? null,
      deletions: stat?.deletions ?? null,
      binary: stat?.binary ?? null,
      patch: authorized ? diff.patch : null,
      patchBytes: authorized ? diff.patchBytes : 0,
      hunkCount: authorized ? diff.hunkCount : 0,
    });
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError && error.code === "GIT_OUTPUT_LIMIT") throw error;
    return null;
  }
}

function comparePath(
  pathName: string,
  sessions: readonly CoordinationSessionObservation[],
  baseCompatible: boolean,
): CoordinationPathComparison {
  const selected = sessions.map((session) => session.paths.find((entry) => entry.path === pathName));
  const complete = selected.every((entry) => entry !== undefined && entry.complete);
  if (!baseCompatible || !complete || selected.some((entry) => entry?.changedFromBase === null)) {
    const ambiguousBase =
      !baseCompatible || selected.some((entry) => entry?.changedFromBase === null && entry?.blob.complete !== false);
    return Object.freeze({
      path: pathName,
      sessionIds: Object.freeze(sessions.map((session) => session.sessionId)),
      status: ambiguousBase ? "ambiguous-base" : "unavailable",
      complete: false,
    });
  }
  const changed = selected.map((entry) => entry?.changedFromBase === true);
  const changedCount = changed.filter(Boolean).length;
  const status: CoordinationComparisonStatus =
    changedCount === 0 ? "no-change" : changedCount === 1 ? "one-sided-change" : "two-sided-divergence";
  return Object.freeze({
    path: pathName,
    sessionIds: Object.freeze(sessions.map((session) => session.sessionId)),
    status,
    complete,
  });
}

function samePathIdentity(
  initial: CoordinationSessionObservation,
  finalPhysical: PhysicalObservation | undefined,
  selectedPaths: readonly string[],
  bounds: CoordinationObservationBounds,
  limits: CoordinationObservationLimits,
): boolean {
  if (initial.headId === null || finalPhysical === undefined || finalPhysical.headId !== initial.headId) return false;
  if (!sameCheckpoint(initial.checkpoint, finalPhysical.checkpoint)) return false;
  if (initial.paths.some((pathEvidence) => pathEvidence.unavailable)) return true;
  const finalGit = defaultGitOr(limits);
  const headId = initial.headId;
  return selectedPaths.every((resource) => {
    const current = readCoordinationBlobState(finalGit, initial.worktreePath, headId, resource, {
      maxContentBytes: bounds.maxContentBytes,
      includeContent: false,
    });
    const first = initial.paths.find((entry) => entry.path === resource)?.blob;
    return first !== undefined && blobFingerprint(first) === blobFingerprint(current);
  });
}

function samePhysicalObservation(left: PhysicalObservation, right: PhysicalObservation | undefined): boolean {
  if (right === undefined || left.headId !== right.headId || !sameCheckpoint(left.checkpoint, right.checkpoint))
    return false;
  return true;
}

function readRevisionSide(
  git: GitCommandRunner,
  worktree: string,
  revision: string,
  resource: string,
  entry: GitTreeEntry | undefined,
  maxContentBytes: number,
): CoordinationBlobSide {
  const origin = "revision-blob" as const;
  if (entry === undefined) return emptySide(origin, "missing");
  if (entry.type !== "blob") {
    return emptySide(origin, entry.mode === "160000" || entry.type === "commit" ? "gitlink" : "directory", entry);
  }
  if (entry.mode === "120000") return emptySide(origin, "symlink", entry);
  let bytes: Buffer;
  try {
    bytes = readGitBuffer(git, ["cat-file", "blob", `${revision}:${resource}`], worktree);
  } catch {
    return emptySide(origin, "unavailable", entry);
  }
  return contentSide(origin, bytes, entry.mode, entry.type, maxContentBytes);
}

function readWorktreeSide(worktree: string, resource: string, maxContentBytes: number): CoordinationBlobSide {
  const candidate = path.resolve(worktree, ...resource.split("/"));
  let fd: number;
  try {
    fd = fs.openSync(candidate, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return emptySide("worktree-file", "missing");
    if (isNodeError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
      return emptySide("worktree-file", "read-denied");
    }
    if (isNodeError(error) && error.code === "ELOOP")
      return emptySide("worktree-file", "symlink", { mode: "120000", type: "symlink" });
    return emptySide("worktree-file", "unavailable");
  }
  let mode: string | null = null;
  let side: CoordinationBlobSide;
  try {
    const before = fs.fstatSync(fd);
    if (before.isDirectory()) {
      side = emptySide("worktree-file", "directory", { mode: "040000", type: "tree" });
    } else if (!before.isFile()) {
      side = emptySide("worktree-file", "special", { mode: "000000", type: "special" });
    } else {
      mode = (before.mode & 0o111) === 0 ? "100644" : "100755";
      if (before.size > maxContentBytes) {
        side = Object.freeze({
          ...emptySide("worktree-file", "too-large", { mode, type: "blob" }),
          byteLength: before.size,
        });
      } else {
        const bytes = Buffer.allocUnsafe(before.size);
        let offset = 0;
        while (offset < bytes.length) {
          const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null);
          if (count === 0) break;
          offset += count;
        }
        const after = fs.fstatSync(fd);
        side =
          offset !== bytes.length ||
          before.dev !== after.dev ||
          before.ino !== after.ino ||
          before.mode !== after.mode ||
          before.size !== after.size ||
          before.mtimeMs !== after.mtimeMs ||
          before.ctimeMs !== after.ctimeMs
            ? emptySide("worktree-file", "unavailable", { mode, type: "blob" })
            : contentSide("worktree-file", bytes, mode, "blob", maxContentBytes);
      }
    }
  } catch (error: unknown) {
    if (isNodeError(error) && (error.code === "EACCES" || error.code === "EPERM")) {
      side = emptySide("worktree-file", "read-denied", mode === null ? undefined : { mode, type: "blob" });
    } else {
      side = emptySide("worktree-file", "unavailable", mode === null ? undefined : { mode, type: "blob" });
    }
  }
  try {
    fs.closeSync(fd);
  } catch {
    return emptySide("worktree-file", "unavailable", mode === null ? undefined : { mode, type: "blob" });
  }
  return side;
}

function contentSide(
  origin: "revision-blob" | "worktree-file",
  bytes: Buffer,
  mode: string,
  type: string,
  maxContentBytes: number,
): CoordinationBlobSide {
  const contentHash = hashBytes(bytes);
  const common = {
    origin,
    mode,
    type,
    contentHash,
    byteLength: bytes.byteLength,
    redacted: false,
  } as const;
  if (bytes.byteLength > maxContentBytes)
    return Object.freeze({ ...common, state: "too-large" as const, content: null });
  if (isBinary(bytes)) return Object.freeze({ ...common, state: "binary" as const, content: null });
  return Object.freeze({
    ...common,
    state: "regular" as const,
    content: {
      origin,
      encoding: "base64" as const,
      bytes: bytes.toString("base64"),
      contentHash,
      byteLength: bytes.byteLength,
    },
  });
}

function emptySide(
  origin: "revision-blob" | "worktree-file",
  state: CoordinationBlobDisposition,
  entry?: Pick<GitTreeEntry, "mode" | "type">,
): CoordinationBlobSide {
  return Object.freeze({
    origin,
    state,
    mode: entry?.mode ?? null,
    type: entry?.type ?? null,
    contentHash: null,
    byteLength: null,
    content: null,
    redacted: false,
  });
}

function redactBlob(blob: CoordinationBlobState): CoordinationBlobState {
  const redact = (side: CoordinationBlobSide): CoordinationBlobSide =>
    Object.freeze({ ...side, content: null, redacted: side.content !== null || side.redacted });
  return Object.freeze({ ...blob, revisionBlob: redact(blob.revisionBlob), worktree: redact(blob.worktree) });
}

function blobFingerprint(blob: CoordinationBlobState): string {
  return JSON.stringify({
    path: blob.path,
    revision: blob.revision,
    revisionBlob: sideFingerprint(blob.revisionBlob),
    worktree: sideFingerprint(blob.worktree),
  });
}

function sideFingerprint(side: CoordinationBlobSide): unknown {
  return {
    origin: side.origin,
    state: side.state,
    mode: side.mode,
    type: side.type,
    contentHash: side.contentHash,
    byteLength: side.byteLength,
  };
}

function contentAuthorized(
  sessionId: string,
  resource: string,
  claims: readonly ResourceClaim[],
  selectedSessionCount: number,
  limits: CoordinationObservationLimits,
): boolean {
  if (limits.operatorAuthorized === true) return true;
  const allowed = limits.allowedReadPaths ?? [];
  if (allowed.some((candidate) => candidate === resource)) return true;
  if (selectedSessionCount > 1) return false;
  return claims.some((claim) => claim.sessionId === sessionId && resourceMatchesClaim(claim, resource));
}

function deriveOverlapPaths(
  physical: readonly PhysicalObservation[],
  claims: readonly ResourceClaim[],
): readonly string[] {
  const result = new Set<string>();
  for (let index = 0; index < claims.length; index += 1) {
    const left = claims[index];
    if (left === undefined) continue;
    for (let rightIndex = index + 1; rightIndex < claims.length; rightIndex += 1) {
      const right = claims[rightIndex];
      if (right === undefined || left.sessionId === right.sessionId || !claimsOverlap(left, right)) continue;
      for (const entry of physical) {
        for (const candidate of entry.checkpoint.changed) {
          if (resourceMatchesClaim(left, candidate) && resourceMatchesClaim(right, candidate)) result.add(candidate);
        }
      }
      if (!hasGlob(left.resource) && !hasGlob(right.resource) && left.resource === right.resource)
        result.add(left.resource);
    }
  }
  return [...result].sort(compareStrings);
}

function selectSessions(
  records: readonly SessionRecord[],
  selected: readonly (string | CoordinationSelectedSession)[],
): readonly SessionRecord[] {
  if (selected.length === 0) return records.filter((record) => record.state === "active");
  const result: SessionRecord[] = [];
  for (const candidate of selected) {
    const sessionId = typeof candidate === "string" ? candidate : candidate.sessionId;
    const record = records.find((entry) => entry.sessionId === sessionId);
    if (record === undefined)
      throw new SessionRegistryError("SESSION_NOT_FOUND", `Session was not found: ${sessionId}`, { sessionId });
    result.push(record);
  }
  const ids = new Set<string>();
  return result.filter((record) => {
    if (ids.has(record.sessionId)) return false;
    ids.add(record.sessionId);
    return true;
  });
}

function canonicalizeSelectedPaths(paths: readonly string[], worktree: string | undefined): readonly string[] {
  if (paths.length === 0) return [];
  if (worktree === undefined)
    throw new SessionRegistryError("MISSING_WORKTREE", "Cannot canonicalize coordination paths");
  const result = new Set<string>();
  for (const resource of paths) result.add(canonicalizeConcretePath(resource, worktree));
  return [...result].sort(compareStrings);
}

function limitPaths(paths: readonly string[], maxPaths: number): readonly string[] {
  if (paths.length > maxPaths) {
    throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Coordination path selection exceeds its bound", {
      maxPaths,
      pathCount: paths.length,
    });
  }
  return Object.freeze([...paths].sort(compareStrings));
}

function readRegistrySnapshot(registry: CoordinationRegistry): RegistrySnapshot {
  const sessions = registry.read?.() ?? registry.list?.() ?? registry.sessions ?? [];
  let claims: readonly ResourceClaim[] =
    typeof registry.claims === "function" ? registry.claims() : (registry.claims ?? []);
  let claimSetGeneration = 0;
  if (registry.listClaimsSnapshot !== undefined) {
    const snapshot = registry.listClaimsSnapshot();
    claims = snapshot.claims;
    claimSetGeneration = snapshot.claimSetGeneration;
  } else if (registry.listClaims !== undefined) {
    claims = registry.listClaims();
    claimSetGeneration = registry.getClaimSetGeneration?.() ?? registry.claimSetGeneration?.() ?? 0;
  } else {
    claimSetGeneration = registry.getClaimSetGeneration?.() ?? registry.claimSetGeneration?.() ?? 0;
  }
  const registryRevision = readRegistryRevision(registry);
  return Object.freeze({ sessions: [...sessions], claims: [...claims], claimSetGeneration, registryRevision });
}

function readRegistryRevision(registry: CoordinationRegistry): number | null {
  const direct = registry.registryRevision ?? registry.revision;
  if (direct !== undefined) return Number.isSafeInteger(direct) && direct >= 0 ? direct : null;
  const registryPath = registry.paths?.registry;
  if (registryPath === undefined) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(registryPath, "utf8")) as { registry_revision?: unknown };
    return typeof parsed.registry_revision === "number" &&
      Number.isSafeInteger(parsed.registry_revision) &&
      parsed.registry_revision >= 0
      ? parsed.registry_revision
      : null;
  } catch {
    return null;
  }
}

function sameRegistrySnapshot(left: RegistrySnapshot, right: RegistrySnapshot, selected: ReadonlySet<string>): boolean {
  if (left.registryRevision !== right.registryRevision || left.claimSetGeneration !== right.claimSetGeneration)
    return false;
  const leftSessions = left.sessions.filter((record) => selected.has(record.sessionId));
  const rightSessions = right.sessions.filter((record) => selected.has(record.sessionId));
  const leftClaims = left.claims.filter((claim) => selected.has(claim.sessionId));
  const rightClaims = right.claims.filter((claim) => selected.has(claim.sessionId));
  return stableJson(leftSessions) === stableJson(rightSessions) && stableJson(leftClaims) === stableJson(rightClaims);
}

function sameCheckpoint(left: GitCheckpointPaths, right: GitCheckpointPaths): boolean {
  return (
    stableJson(left.changed) === stableJson(right.changed) &&
    stableJson(left.staged) === stableJson(right.staged) &&
    stableJson(left.unstaged) === stableJson(right.unstaged) &&
    stableJson(left.untracked) === stableJson(right.untracked)
  );
}

function observeCheckpoint(git: GitCommandRunner, worktree: string): GitCheckpointPaths {
  return observeGitCheckpoint(git, worktree);
}

function defaultGitOr(limits: CoordinationObservationLimits): GitCommandRunner {
  return limits.git ?? defaultGit;
}

function resolveRepositoryForRecord(record: SessionRecord, git: GitCommandRunner): RepositoryContext {
  const physical = verifyPhysicalExecutionContext({ cwd: record.worktreePath, git });
  return {
    repositoryId: physical.repositoryId,
    commonGitDirectory: physical.commonGitDirectory,
    worktreePath: physical.worktreePath,
  };
}

function readGitBuffer(git: GitCommandRunner, args: readonly string[], cwd: string): Buffer {
  if (git.runBuffer !== undefined) return git.runBuffer(args, cwd);
  throw new SessionRegistryError("PHYSICAL_OBSERVATION_UNAVAILABLE", "Exact Git blob bytes are unavailable", {
    cwd,
    command: args[0] ?? "git",
  });
}

function treeEntriesEqualSafe(left: GitTreeEntry | null, right: GitTreeEntry | null): boolean {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && left.type === right.type && left.sha === right.sha;
}

function hashBytes(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function isBinary(bytes: Buffer): boolean {
  return bytes.includes(0);
}

function hasGlob(resource: string): boolean {
  return resource.includes("*") || resource.includes("?");
}

function resolveBounds(limits: CoordinationObservationLimits): CoordinationObservationBounds {
  const bounds = {
    maxPaths: limits.maxPaths ?? COORDINATION_DEFAULT_MAX_PATHS,
    maxContentBytes: limits.maxContentBytes ?? COORDINATION_DEFAULT_MAX_CONTENT_BYTES,
    maxDiffBytes: limits.maxDiffBytes ?? COORDINATION_DEFAULT_MAX_DIFF_BYTES,
    maxDiffHunks: limits.maxDiffHunks ?? COORDINATION_DEFAULT_MAX_DIFF_HUNKS,
    maxRetries: limits.maxRetries ?? COORDINATION_DEFAULT_MAX_RETRIES,
  };
  assertBound(bounds.maxPaths, "maxPaths");
  assertBound(bounds.maxContentBytes, "maxContentBytes");
  assertBound(bounds.maxDiffBytes, "maxDiffBytes");
  assertBound(bounds.maxDiffHunks, "maxDiffHunks");
  assertBound(bounds.maxRetries, "maxRetries");
  return Object.freeze(bounds);
}

function assertBound(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative safe integer`);
}

function stableJson(value: unknown): string {
  return JSON.stringify(value);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && typeof error.code === "string";
}
