import {
  observeCoordinationInputs,
  readCoordinationBlobState,
  type CoordinationBlobSide,
  type CoordinationObservationToken,
  type CoordinationPathEvidence,
  type CoordinationSessionObservation,
} from "./resource-coordination-evidence.js";
import {
  classifyThreeWayPath,
  type MergePathInput,
  type ThreeWayDecision,
  type ThreeWayUnknownReason,
} from "./resource-merge-decision.js";
import {
  analyzeTextMerge,
  MERGE_PREVIEW_MAX_OUTPUT_BYTES,
  type ConflictRange,
  type TextMergeResult,
} from "./resource-text-merge.js";
import { evidenceHash } from "./repository-evidence.js";
import { SessionRegistryError } from "./errors.js";
import { resourceMatchesClaim } from "./resource-claims.js";
import { defaultGit, type GitCommandRunner, type GitTreeEntry } from "./git.js";

export const COORDINATION_PREVIEW_SCHEMA_VERSION = 1 as const;
export const COORDINATION_PREVIEW_OPERATION = "coordination-preview" as const;
export const COORDINATION_PREVIEW_DEFAULT_MAX_CONTENT_BYTES = 64 * 1024;
export const COORDINATION_PREVIEW_DEFAULT_MAX_DIFF_BYTES = 64 * 1024;
export const COORDINATION_PREVIEW_DEFAULT_MAX_DIFF_HUNKS = 128;
export const COORDINATION_PREVIEW_DEFAULT_MAX_RETRIES = 1;

export type CoordinationPreviewOutcome = "clean" | "conflict" | "unknown" | "unavailable" | "stale";

export type CoordinationPreviewUnknownReason =
  | ThreeWayUnknownReason
  | "base-mismatch"
  | "observation-incomplete"
  | "read-authority-required"
  | "preview-executable-unavailable"
  | "stale-observation"
  | "signal"
  | "timeout"
  | "output-limit";

/**
 * The preview request is deliberately explicit. The short `left`/`right`
 * names are the CLI-facing spelling; the session-id names are accepted by
 * domain callers so the same typed producer can be wired without a second
 * semantic contract.
 */
export interface CoordinationPreviewOptions {
  readonly left?: string;
  readonly right?: string;
  readonly left_session_id?: string;
  readonly right_session_id?: string;
  readonly path: string;
  readonly include_patch?: boolean;
  readonly read_authorized?: boolean;
  readonly operator_authorized?: boolean;
  readonly allowed_read_paths?: readonly string[];
  readonly max_content_bytes?: number;
  readonly max_diff_bytes?: number;
  readonly max_diff_hunks?: number;
  readonly max_retries?: number;
  readonly max_output_bytes?: number;
  /** Absolute Git executable used by the isolated text-merge producer. */
  readonly git_executable?: string;
  readonly git?: GitCommandRunner;
}

/** Structural registry input keeps this producer independent of backend wiring. */
export type CoordinationPreviewRegistry = Parameters<typeof observeCoordinationInputs>[0];

export interface CoordinationPreviewSession {
  readonly sessionId: string;
  readonly worktreeId: string;
  readonly branchId: string;
  readonly baseRevision: string | null;
  readonly headId: string | null;
  readonly claimSetGeneration: number;
}

export interface CoordinationPreviewBudget {
  readonly maxContentBytes: number;
  readonly maxDiffBytes: number;
  readonly maxDiffHunks: number;
  readonly maxRetries: number;
  readonly maxOutputBytes: number;
  readonly contentBytes: number;
  readonly patchBytes: number;
  readonly truncated: boolean;
}

export interface CoordinationPreviewMerge {
  readonly outcome: TextMergeResult["outcome"];
  readonly conflictCount: number | null;
  readonly preview: string | null;
  readonly previewBytes: number;
  readonly conflictRanges: readonly ConflictRange[];
  readonly exitCode: number | null;
  readonly reason?: string;
}

export interface CoordinationPreviewResult {
  readonly schemaVersion: typeof COORDINATION_PREVIEW_SCHEMA_VERSION;
  readonly operation: typeof COORDINATION_PREVIEW_OPERATION;
  readonly repositoryId: string;
  readonly leftSessionId: string;
  readonly rightSessionId: string;
  readonly path: string;
  readonly baseRevision: string | null;
  readonly generation: number;
  readonly heads: {
    readonly left: string | null;
    readonly right: string | null;
  };
  readonly sessions: {
    readonly left: CoordinationPreviewSession;
    readonly right: CoordinationPreviewSession;
  };
  readonly decision: ThreeWayDecision | null;
  readonly merge: CoordinationPreviewMerge | null;
  readonly outcome: CoordinationPreviewOutcome;
  readonly unknown: boolean;
  readonly unknownReason?: CoordinationPreviewUnknownReason;
  readonly stale: boolean;
  readonly complete: boolean;
  readonly budget: CoordinationPreviewBudget;
  /** Opaque evidence token for a consumer that wants to revalidate the preview. */
  readonly previewToken: string;
  readonly digest: string;
  readonly evidenceHash: string;
  /** The patch/merged preview is absent unless explicitly requested and authorized. */
  readonly patch: string | null;
  readonly conflictRanges: readonly ConflictRange[];
}

/**
 * Produce a non-mutating, identity-bound three-way preview for one concrete
 * resource. This function only consumes the existing registry/evidence/Git
 * authorities; it never merges, checks out, stages, commits, or updates refs.
 */
export function previewCoordination(
  registry: CoordinationPreviewRegistry,
  options: CoordinationPreviewOptions,
): CoordinationPreviewResult {
  const leftSessionId = sessionId(options.left_session_id, options.left, "left");
  const rightSessionId = sessionId(options.right_session_id, options.right, "right");
  if (leftSessionId === rightSessionId) {
    throw new SessionRegistryError("INVALID_SESSION_ID", "Coordination preview requires two distinct sessions", {
      sessionId: leftSessionId,
    });
  }
  if (typeof options.path !== "string" || options.path.length === 0) {
    throw new SessionRegistryError("INVALID_RESOURCE", "Coordination preview requires one explicit path");
  }

  const includePatch = options.include_patch === true;
  const readAuthorized =
    options.read_authorized === true ||
    options.operator_authorized === true ||
    (options.allowed_read_paths?.includes(options.path) ?? false);
  if (includePatch && !readAuthorized) {
    throw new SessionRegistryError(
      "INSUFFICIENT_CLAIM_MODE",
      "Coordination preview patch output requires explicit read authority",
      { path: options.path },
    );
  }

  const bounds = resolveBounds(options);
  const git = options.git ?? defaultGit;
  const token = observeCoordinationInputs(registry, [leftSessionId, rightSessionId], [options.path], {
    maxPaths: 1,
    maxContentBytes: bounds.maxContentBytes,
    maxDiffBytes: bounds.maxDiffBytes,
    maxDiffHunks: bounds.maxDiffHunks,
    maxRetries: bounds.maxRetries,
    includeContent: includePatch && readAuthorized,
    includePatch: includePatch && readAuthorized,
    operatorAuthorized: readAuthorized,
    allowedReadPaths: options.allowed_read_paths,
    git,
  });

  const left = sessionObservation(token, leftSessionId);
  const right = sessionObservation(token, rightSessionId);
  const observedPath = token.paths[0]?.path ?? options.path;
  const explicitPathAuthority =
    options.operator_authorized === true || (options.allowed_read_paths?.includes(observedPath) ?? false);
  requirePathAuthority(left, right, observedPath, explicitPathAuthority);

  const common = commonBase(left, right);
  const sessionFacts = {
    left: toSessionFacts(left, token.claimSetGeneration),
    right: toSessionFacts(right, token.claimSetGeneration),
  };
  const digestInput = {
    repositoryId: token.repositoryId,
    leftSessionId,
    rightSessionId,
    path: observedPath,
    generation: token.claimSetGeneration,
    leftHead: left.headId,
    rightHead: right.headId,
    baseRevision: common.baseRevision,
    evidenceHash: token.evidenceHash,
  };
  const previewToken = evidenceHash(digestInput);

  if (token.stale) {
    return finish({
      token,
      leftSessionId,
      rightSessionId,
      path: observedPath,
      baseRevision: common.baseRevision,
      sessions: sessionFacts,
      outcome: "stale",
      unknown: true,
      unknownReason: "stale-observation",
      decision: null,
      merge: null,
      patch: null,
      conflictRanges: [],
      previewToken,
      budget: bounds,
    });
  }

  if (token.status !== "stable" || !token.complete || !common.compatible) {
    const unknownReason: CoordinationPreviewUnknownReason = !common.compatible
      ? "base-mismatch"
      : token.status === "unavailable" || !token.complete
        ? "observation-incomplete"
        : "base-mismatch";
    return finish({
      token,
      leftSessionId,
      rightSessionId,
      path: observedPath,
      baseRevision: common.baseRevision,
      sessions: sessionFacts,
      outcome: token.status === "unavailable" ? "unavailable" : "unknown",
      unknown: true,
      unknownReason,
      decision: null,
      merge: null,
      patch: null,
      conflictRanges: [],
      previewToken,
      budget: bounds,
    });
  }

  const leftPath = pathEvidence(left, observedPath);
  const rightPath = pathEvidence(right, observedPath);
  const baseEvidence = readBaseEvidence(
    left,
    observedPath,
    bounds.maxContentBytes,
    git,
    includePatch && readAuthorized,
  );
  const baseContent = includePatch && readAuthorized ? (baseEvidence?.content ?? null) : null;
  const base = mergeBlobSide(baseEvidence, baseContent);
  const leftState = mergePathState(leftPath, includePatch && readAuthorized ? leftPath.blob.worktree.content : null);
  const rightState = mergePathState(rightPath, includePatch && readAuthorized ? rightPath.blob.worktree.content : null);
  let decision = classifyThreeWayPath(base, leftState, rightState);
  let merge: CoordinationPreviewMerge | null = null;
  let outcome: CoordinationPreviewOutcome = decision.outcome;
  let unknownReason: CoordinationPreviewUnknownReason | undefined = decision.reason;

  if (decision.requiresTextMerge) {
    if (!includePatch || !readAuthorized) {
      unknownReason = "read-authority-required";
    } else {
      const textInput = mergeBytes(baseContent, leftPath.blob.worktree.content, rightPath.blob.worktree.content);
      if (textInput === null || options.git_executable === undefined) {
        unknownReason =
          options.git_executable === undefined ? "preview-executable-unavailable" : "observation-incomplete";
      } else {
        const textResult = analyzeTextMerge(
          {
            base: textInput.base,
            left: textInput.left,
            right: textInput.right,
            maxOutputBytes: bounds.maxOutputBytes,
          },
          options.git_executable,
        );
        merge = toMerge(textResult, includePatch && readAuthorized);
        outcome = textResult.outcome;
        if (textResult.outcome === "unknown") unknownReason = mergeUnknownReason(textResult.reason);
      }
    }
    decision = Object.freeze({
      ...decision,
      outcome: outcome === "unknown" ? "unknown" : outcome,
    });
  }

  if (unknownReason !== undefined) outcome = "unknown";
  return finish({
    token,
    leftSessionId,
    rightSessionId,
    path: observedPath,
    baseRevision: common.baseRevision,
    sessions: sessionFacts,
    outcome,
    unknown: outcome === "unknown",
    ...(unknownReason === undefined ? {} : { unknownReason }),
    decision,
    merge,
    patch: merge?.preview ?? null,
    conflictRanges: merge?.conflictRanges ?? [],
    previewToken,
    budget: bounds,
  });
}

/** Stable transport projection used by domain, CLI, and contract adapters. */
export function serializeCoordinationPreview(result: CoordinationPreviewResult): string {
  assertPreview(result);
  return stableJson(result);
}

interface PreviewFinishInput {
  readonly token: CoordinationObservationToken;
  readonly leftSessionId: string;
  readonly rightSessionId: string;
  readonly path: string;
  readonly baseRevision: string | null;
  readonly sessions: { readonly left: CoordinationPreviewSession; readonly right: CoordinationPreviewSession };
  readonly outcome: CoordinationPreviewOutcome;
  readonly unknown: boolean;
  readonly unknownReason?: CoordinationPreviewUnknownReason;
  readonly stale?: boolean;
  readonly complete?: boolean;
  readonly decision: ThreeWayDecision | null;
  readonly merge: CoordinationPreviewMerge | null;
  readonly patch: string | null;
  readonly conflictRanges: readonly ConflictRange[];
  readonly previewToken: string;
  readonly budget: CoordinationPreviewBudget;
}

function finish(input: PreviewFinishInput): CoordinationPreviewResult {
  const mergeBytes = input.merge?.previewBytes ?? 0;
  const budget = Object.freeze({
    ...input.budget,
    contentBytes: input.budget.contentBytes,
    patchBytes: mergeBytes,
    truncated: input.budget.truncated || input.merge?.reason === "output-limit",
  });
  const withoutDigest = {
    schemaVersion: COORDINATION_PREVIEW_SCHEMA_VERSION,
    operation: COORDINATION_PREVIEW_OPERATION,
    repositoryId: input.token.repositoryId,
    leftSessionId: input.leftSessionId,
    rightSessionId: input.rightSessionId,
    path: input.path,
    baseRevision: input.baseRevision,
    generation: input.token.claimSetGeneration,
    heads: Object.freeze({ left: input.sessions.left.headId, right: input.sessions.right.headId }),
    sessions: Object.freeze(input.sessions),
    decision: input.decision,
    merge: input.merge,
    outcome: input.outcome,
    unknown: input.unknown,
    ...(input.unknownReason === undefined ? {} : { unknownReason: input.unknownReason }),
    stale: input.stale ?? input.outcome === "stale",
    complete: input.complete ?? (input.outcome === "clean" || input.outcome === "conflict"),
    budget,
    previewToken: input.previewToken,
    patch: input.patch,
    conflictRanges: Object.freeze([...input.conflictRanges]),
  };
  const digest = evidenceHash(withoutDigest);
  return Object.freeze({ ...withoutDigest, digest, evidenceHash: digest });
}

function resolveBounds(options: CoordinationPreviewOptions): CoordinationPreviewBudget {
  const maxContentBytes = positiveBound(options.max_content_bytes, COORDINATION_PREVIEW_DEFAULT_MAX_CONTENT_BYTES);
  const maxDiffBytes = positiveBound(options.max_diff_bytes, COORDINATION_PREVIEW_DEFAULT_MAX_DIFF_BYTES);
  const maxDiffHunks = positiveBound(options.max_diff_hunks, COORDINATION_PREVIEW_DEFAULT_MAX_DIFF_HUNKS);
  const maxRetries = nonNegativeBound(options.max_retries, COORDINATION_PREVIEW_DEFAULT_MAX_RETRIES);
  const maxOutputBytes = positiveBound(options.max_output_bytes, MERGE_PREVIEW_MAX_OUTPUT_BYTES);
  return Object.freeze({
    maxContentBytes,
    maxDiffBytes,
    maxDiffHunks,
    maxRetries,
    maxOutputBytes,
    contentBytes: 0,
    patchBytes: 0,
    truncated: false,
  });
}

function positiveBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Coordination preview bound must be a positive safe integer");
  }
  return value;
}

function nonNegativeBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new SessionRegistryError("GIT_OUTPUT_LIMIT", "Coordination preview retry bound must be non-negative");
  }
  return value;
}

function sessionId(primary: string | undefined, secondary: string | undefined, side: string): string {
  const value = primary ?? secondary;
  if (typeof value !== "string" || value.length === 0) {
    throw new SessionRegistryError("INVALID_SESSION_ID", `Coordination preview requires an explicit ${side} session`);
  }
  if (primary !== undefined && secondary !== undefined && primary !== secondary) {
    throw new SessionRegistryError("INVALID_SESSION_ID", `${side} session identifiers disagree`);
  }
  return value;
}

function sessionObservation(token: CoordinationObservationToken, sessionId: string): CoordinationSessionObservation {
  const session = token.sessions.find((candidate) => candidate.sessionId === sessionId);
  if (session === undefined) {
    throw new SessionRegistryError("SESSION_NOT_FOUND", `Coordination session was not observed: ${sessionId}`, {
      sessionId,
    });
  }
  return session;
}

function requirePathAuthority(
  left: CoordinationSessionObservation,
  right: CoordinationSessionObservation,
  resource: string,
  readAuthorized: boolean,
): void {
  const leftAllowed = left.claims.some((claim) => resourceMatchesClaim(claim, resource));
  const rightAllowed = right.claims.some((claim) => resourceMatchesClaim(claim, resource));
  if (readAuthorized || (leftAllowed && rightAllowed)) return;
  const missing = !leftAllowed && !rightAllowed ? "both" : !leftAllowed ? "left" : "right";
  throw new SessionRegistryError("MISSING_RESOURCE_CLAIM", "Coordination preview path is outside session authority", {
    path: resource,
    missing,
  });
}

function commonBase(
  left: CoordinationSessionObservation,
  right: CoordinationSessionObservation,
): { readonly baseRevision: string | null; readonly compatible: boolean } {
  const baseRevision = left.baseRevision;
  if (baseRevision === null || right.baseRevision === null || baseRevision !== right.baseRevision) {
    return { baseRevision, compatible: false };
  }
  const leftPath = left.paths[0];
  const rightPath = right.paths[0];
  return {
    baseRevision,
    compatible: sameTreeEntry(leftPath?.base ?? null, rightPath?.base ?? null),
  };
}

function sameTreeEntry(left: GitTreeEntry | null, right: GitTreeEntry | null): boolean {
  if (left === null || right === null) return left === right;
  return left.mode === right.mode && left.type === right.type && left.sha === right.sha;
}

function pathEvidence(session: CoordinationSessionObservation, resource: string): CoordinationPathEvidence {
  const evidence = session.paths.find((candidate) => candidate.path === resource);
  if (evidence === undefined) {
    throw new SessionRegistryError("PHYSICAL_OBSERVATION_UNAVAILABLE", "Coordination path evidence is unavailable", {
      path: resource,
      sessionId: session.sessionId,
    });
  }
  return evidence;
}

function mergePathState(
  value: CoordinationPathEvidence,
  content: { readonly bytes: string; readonly byteLength: number } | null = null,
): MergePathInput {
  return mergeBlobSide(value.blob.worktree, content);
}

function mergeBlobSide(
  side: CoordinationBlobSide | null,
  content: { readonly bytes: string; readonly byteLength: number } | null,
): MergePathInput {
  if (side === null || side.state === "missing") return null;
  const kind =
    side.state === "binary"
      ? "binary"
      : side.state === "gitlink"
        ? "submodule"
        : side.state === "directory"
          ? "directory"
          : side.state === "regular" || side.state === "untracked"
            ? "regular"
            : "unknown";
  return {
    exists: true,
    mode: side.mode,
    type: side.type,
    kind,
    sha: side.contentHash,
    content: decodeContent(content),
  };
}

function readBaseEvidence(
  session: CoordinationSessionObservation,
  resource: string,
  maxContentBytes: number,
  git: GitCommandRunner,
  includeContent: boolean,
): CoordinationBlobSide | null {
  if (session.baseRevision === null) return null;
  const blob = readCoordinationBlobState(git, session.worktreePath, session.baseRevision, resource, {
    maxContentBytes,
    includeContent,
    operatorAuthorized: includeContent,
  });
  return blob.revisionBlob;
}

function decodeContent(content: { readonly bytes: string; readonly byteLength: number } | null): Uint8Array | null {
  if (content === null) return null;
  const bytes = Buffer.from(content.bytes, "base64");
  return bytes.byteLength === content.byteLength ? bytes : null;
}

function mergeBytes(
  base: { readonly bytes: string; readonly byteLength: number } | null,
  left: { readonly bytes: string; readonly byteLength: number } | null,
  right: { readonly bytes: string; readonly byteLength: number } | null,
): { readonly base: Uint8Array; readonly left: Uint8Array; readonly right: Uint8Array } | null {
  const baseBytes = decodeContent(base);
  const leftBytes = decodeContent(left);
  const rightBytes = decodeContent(right);
  if (baseBytes === null || leftBytes === null || rightBytes === null) return null;
  return { base: baseBytes, left: leftBytes, right: rightBytes };
}

function toSessionFacts(session: CoordinationSessionObservation, generation: number): CoordinationPreviewSession {
  return Object.freeze({
    sessionId: session.sessionId,
    worktreeId: session.worktreeId,
    branchId: session.branchId,
    baseRevision: session.baseRevision,
    headId: session.headId,
    claimSetGeneration: generation,
  });
}

function toMerge(result: TextMergeResult, includePreview: boolean): CoordinationPreviewMerge {
  return Object.freeze({
    outcome: result.outcome,
    conflictCount: result.conflictCount,
    preview: includePreview ? result.preview : null,
    previewBytes: includePreview ? result.previewBytes : 0,
    conflictRanges: includePreview ? result.conflictRanges : [],
    exitCode: result.exitCode,
    ...(result.reason === undefined ? {} : { reason: result.reason }),
  });
}

function mergeUnknownReason(reason: string | undefined): CoordinationPreviewUnknownReason {
  if (reason === "signal" || reason === "timeout" || reason === "output-limit") return reason;
  if (reason === "executable-unavailable") return "preview-executable-unavailable";
  return "observation-incomplete";
}

function assertPreview(result: CoordinationPreviewResult): void {
  if (
    result.schemaVersion !== COORDINATION_PREVIEW_SCHEMA_VERSION ||
    result.operation !== COORDINATION_PREVIEW_OPERATION ||
    typeof result.previewToken !== "string" ||
    typeof result.evidenceHash !== "string"
  ) {
    throw new TypeError("Invalid coordination preview result");
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, sortJson(child)]),
    );
  }
  return value;
}
