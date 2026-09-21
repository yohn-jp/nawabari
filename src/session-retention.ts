import { createHash, randomUUID } from "node:crypto";

import { isResourceClaimMode, type ResourceClaim, type ResourceClaimMode } from "./resource-claims.js";

/** Schema version for the durable park/resume retention record. */
export const SESSION_RETENTION_SCHEMA_VERSION = 1 as const;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const SESSION_RETENTION_ERROR_CODES = Object.freeze([
  "INVALID_INPUT",
  "SESSION_NOT_FOUND",
  "SESSION_NOT_ACTIVE",
  "SESSION_NOT_PARKED",
  "SESSION_ALREADY_PARKED",
  "FENCE_REJECTED",
  "DRAIN_INCOMPLETE",
  "REVALIDATION_FAILED",
  "PHYSICAL_IDENTITY_MISMATCH",
  "PINNED_PROFILE_MISMATCH",
  "EXTERNAL_SCOPE_REJECTED",
  "CLAIM_CONFLICT",
  "STALE_CLAIM_SET",
  "RETENTION_UNCERTAIN",
  "RETENTION_STEP_FAILED",
] as const);

export type SessionRetentionErrorCode = (typeof SESSION_RETENTION_ERROR_CODES)[number];

/** The identity that must remain physically stable while a session is parked. */
export interface SessionPhysicalIdentity {
  readonly repositoryId: string;
  readonly worktreeId: string;
  readonly worktreePath: string;
  readonly branchId: string;
  readonly branchName: string;
}

export type SessionRetentionSessionState = "active" | "parked";

/** A desired claim is an intent, not an authority-bearing persisted claim. */
export interface RetainedClaimIntent {
  readonly resource: string;
  readonly mode: ResourceClaimMode;
}

export interface SessionRetentionRecord {
  readonly schemaVersion: typeof SESSION_RETENTION_SCHEMA_VERSION;
  readonly operationId: string;
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly state: "parked";
  readonly physicalIdentity: SessionPhysicalIdentity;
  readonly desiredClaims: readonly RetainedClaimIntent[];
  /** The profile identity is pinned; the profile itself remains owned by its producer. */
  readonly pinnedProfileDigest: string;
  readonly parkedAt: string;
  readonly updatedAt: string;
}

export interface SessionRetentionSession {
  readonly sessionId: string;
  readonly state: SessionRetentionSessionState;
  readonly physicalIdentity: SessionPhysicalIdentity;
}

/** Snapshot supplied by the existing registry authority. Claims include every session. */
export interface SessionRetentionSnapshot {
  readonly session: SessionRetentionSession;
  readonly claims: readonly ResourceClaim[];
  readonly claimSetGeneration: number;
  readonly retention?: SessionRetentionRecord;
}

export interface RetentionFenceEvidence {
  readonly accepted: true;
  readonly token: string;
}

export interface RetentionDrainEvidence {
  readonly drained: true;
  readonly executionCount: number;
}

export type RetentionStepRejection = {
  readonly accepted: false;
  readonly code: "FENCE_REJECTED" | "DRAIN_INCOMPLETE" | "REVALIDATION_FAILED";
  readonly reason: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type RetentionFenceResult = RetentionFenceEvidence | RetentionStepRejection;
export type RetentionDrainResult = RetentionDrainEvidence | RetentionStepRejection;

function isRejectedStep(value: RetentionStepRejection | object): value is RetentionStepRejection {
  return "accepted" in value && value.accepted === false;
}

export interface ParkCommitInput {
  readonly operationId: string;
  readonly sessionId: string;
  readonly expectedState: "active";
  readonly expectedClaimSetGeneration: number;
  readonly fenceToken: string;
  readonly physicalIdentity: SessionPhysicalIdentity;
  readonly desiredClaims: readonly RetainedClaimIntent[];
  readonly pinnedProfileDigest: string;
  readonly releaseClaimIds: readonly string[];
  readonly parkedAt: string;
}

export interface ResumeValidationInput {
  readonly operationId: string;
  readonly sessionId: string;
  readonly snapshot: SessionRetentionSnapshot;
  readonly retention: SessionRetentionRecord;
  readonly physicalIdentity: SessionPhysicalIdentity;
  readonly pinnedProfileDigest: string;
  readonly latestExternalScope: unknown;
  readonly desiredClaims: readonly RetainedClaimIntent[];
}

export interface ResumeValidationAccepted {
  readonly accepted: true;
  /** Opaque proof tied to the current all-claims observation/CAS. */
  readonly token: string;
}

export interface ResumeValidationRejected {
  readonly accepted: false;
  readonly code: "CLAIM_CONFLICT" | "STALE_CLAIM_SET" | "EXTERNAL_SCOPE_REJECTED";
  readonly reason: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type ResumeValidationResult = ResumeValidationAccepted | ResumeValidationRejected;

export interface ResumeCommitInput extends ResumeValidationInput {
  readonly expectedState: "parked";
  readonly expectedClaimSetGeneration: number;
  readonly validationToken: string;
}

export interface RetentionCommitAccepted {
  readonly status: "committed";
  readonly operationId: string;
  readonly snapshot: SessionRetentionSnapshot;
  readonly releasedClaims?: readonly ResourceClaim[];
  readonly reacquiredClaims?: readonly ResourceClaim[];
}

export interface RetentionCommitUncertain {
  readonly status: "uncertain";
  readonly operationId: string;
  readonly reason: string;
}

export interface RetentionCommitRejected {
  readonly status: "rejected";
  readonly operationId: string;
  readonly code: "CLAIM_CONFLICT" | "STALE_CLAIM_SET";
  readonly reason: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export type RetentionCommitResult = RetentionCommitAccepted | RetentionCommitUncertain | RetentionCommitRejected;

export interface RetentionReobservationResolved {
  readonly status: "resolved";
  readonly operationId: string;
  readonly state: SessionRetentionSessionState;
  readonly snapshot: SessionRetentionSnapshot;
}

export interface RetentionReobservationUnknown {
  readonly status: "unknown";
  readonly operationId: string;
  readonly reason: string;
}

export type RetentionReobservation = RetentionReobservationResolved | RetentionReobservationUnknown;

/**
 * Adapter boundary for the existing SessionRegistry authority.
 *
 * `atomicPark` must persist the retention record, parked session state, and
 * removal of every target-session claim in one registry write. `atomicResume`
 * must re-check the pinned profile, latest external scope, physical identity,
 * all-claims conflict set, and CAS generation while holding the same lock
 * before persisting active state and claims together. The retention module
 * intentionally cannot provide that lock itself.
 */
export interface SessionRetentionAuthority {
  observe(sessionId: string): SessionRetentionSnapshot;
  fence(input: { readonly sessionId: string; readonly operationId: string }): RetentionFenceResult;
  drain(input: {
    readonly sessionId: string;
    readonly operationId: string;
    readonly fenceToken: string;
  }): RetentionDrainResult;
  revalidate(input: {
    readonly sessionId: string;
    readonly operationId: string;
    readonly fenceToken: string;
  }): SessionRetentionSnapshot | RetentionStepRejection;
  atomicPark(input: ParkCommitInput): RetentionCommitResult;
  validateResume(input: ResumeValidationInput): ResumeValidationResult;
  atomicResume(input: ResumeCommitInput): RetentionCommitResult;
  reobserve(input: {
    readonly operationId: string;
    readonly sessionId: string;
    readonly operation: "park" | "resume";
  }): RetentionReobservation;
}

export interface ParkSessionOptions {
  readonly sessionId: string;
  readonly pinnedProfile: unknown;
  readonly desiredClaims?: readonly ResourceClaim[];
  readonly operationId?: string;
  readonly now?: string;
}

export interface ResumeSessionOptions {
  readonly sessionId: string;
  readonly pinnedProfile: unknown;
  readonly latestExternalScope: unknown;
  readonly operationId?: string;
}

export interface SessionRetentionOperationResult {
  readonly schemaVersion: typeof SESSION_RETENTION_SCHEMA_VERSION;
  readonly operation: "park" | "resume";
  readonly operationId: string;
  readonly sessionId: string;
  readonly status: "parked" | "resumed" | "uncertain";
  readonly claimSetGeneration: number | null;
  readonly snapshot?: SessionRetentionSnapshot;
  readonly retention?: SessionRetentionRecord;
  readonly releasedClaims?: readonly ResourceClaim[];
  readonly reacquiredClaims?: readonly ResourceClaim[];
  readonly reconciliation?: RetentionReobservation;
  readonly reason?: string;
}

export class SessionRetentionError extends Error {
  public readonly code: SessionRetentionErrorCode;
  public readonly details: Readonly<Record<string, unknown>>;

  public constructor(
    code: SessionRetentionErrorCode,
    message: string,
    details: Readonly<Record<string, unknown>> = {},
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "SessionRetentionError";
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

function fail(
  code: SessionRetentionErrorCode,
  message: string,
  details: Readonly<Record<string, unknown>> = {},
): never {
  throw new SessionRetentionError(code, message, details);
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail("INVALID_INPUT", `${path} must be a bounded non-empty string`);
  }
  return value.normalize("NFC");
}

function operationId(value: unknown, path: string): string {
  return nonEmptyString(value, path);
}

function timestamp(value: unknown, path: string): string {
  const result = nonEmptyString(value, path);
  const parsed = Date.parse(result);
  if (!ISO_TIMESTAMP_PATTERN.test(result) || !Number.isFinite(parsed) || new Date(parsed).toISOString() !== result) {
    fail("INVALID_INPUT", `${path} must be a canonical ISO timestamp`);
  }
  return result;
}

function assertGeneration(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    fail("INVALID_INPUT", `${path} must be a non-negative safe integer`);
  }
  return value as number;
}

function clonePhysicalIdentity(value: SessionPhysicalIdentity): SessionPhysicalIdentity {
  if (typeof value !== "object" || value === null) fail("INVALID_INPUT", "physicalIdentity must be an object");
  return Object.freeze({
    repositoryId: nonEmptyString(value.repositoryId, "physicalIdentity.repositoryId"),
    worktreeId: nonEmptyString(value.worktreeId, "physicalIdentity.worktreeId"),
    worktreePath: nonEmptyString(value.worktreePath, "physicalIdentity.worktreePath"),
    branchId: nonEmptyString(value.branchId, "physicalIdentity.branchId"),
    branchName: nonEmptyString(value.branchName, "physicalIdentity.branchName"),
  });
}

function samePhysicalIdentity(left: SessionPhysicalIdentity, right: SessionPhysicalIdentity): boolean {
  return (
    left.repositoryId === right.repositoryId &&
    left.worktreeId === right.worktreeId &&
    left.worktreePath === right.worktreePath &&
    left.branchId === right.branchId &&
    left.branchName === right.branchName
  );
}

function stableClone(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value))
      fail("INVALID_INPUT", "identity contains a non-finite number");
    return value;
  }
  if (typeof value === "undefined") fail("INVALID_INPUT", "identity cannot contain undefined");
  if (typeof value !== "object") fail("INVALID_INPUT", "identity contains an unsupported value");
  if (seen.has(value)) fail("INVALID_INPUT", "identity cannot contain cycles");
  seen.add(value);
  let result: unknown;
  if (Array.isArray(value)) {
    result = value.map((entry) => stableClone(entry, seen));
  } else {
    const object = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(object).sort()) output[key] = stableClone(object[key], seen);
    result = output;
  }
  seen.delete(value);
  return result;
}

/** Stable digest used to pin a producer-owned profile without copying its authority. */
export function retentionIdentityDigest(value: unknown): string {
  const canonical = JSON.stringify(stableClone(value, new Set<object>()));
  return createHash("sha256").update(canonical).digest("hex");
}

function cloneClaimIntent(value: RetainedClaimIntent, path: string): RetainedClaimIntent {
  if (typeof value !== "object" || value === null) fail("INVALID_INPUT", `${path} must be an object`);
  const resource = nonEmptyString(value.resource, `${path}.resource`);
  if (!isResourceClaimMode(value.mode)) fail("INVALID_INPUT", `${path}.mode is unsupported`);
  return Object.freeze({ resource, mode: value.mode });
}

function compareIntent(left: RetainedClaimIntent, right: RetainedClaimIntent): number {
  const a = `${left.resource}\u0000${left.mode}`;
  const b = `${right.resource}\u0000${right.mode}`;
  return a < b ? -1 : a > b ? 1 : 0;
}

function cloneAndSortIntents(values: readonly RetainedClaimIntent[], path: string): readonly RetainedClaimIntent[] {
  if (!Array.isArray(values)) fail("INVALID_INPUT", `${path} must be an array`);
  const normalized = values.map((value, index) => cloneClaimIntent(value, `${path}[${index}]`)).sort(compareIntent);
  for (let index = 1; index < normalized.length; index += 1) {
    const previous = normalized[index - 1];
    const current = normalized[index];
    if (previous !== undefined && current !== undefined && compareIntent(previous, current) === 0) {
      fail("INVALID_INPUT", `${path} contains duplicate claim intents`, { resource: current.resource });
    }
  }
  return Object.freeze(normalized);
}

function claimIntent(claim: ResourceClaim, path: string): RetainedClaimIntent {
  if (typeof claim !== "object" || claim === null) fail("INVALID_INPUT", `${path} must be a claim`);
  return cloneClaimIntent({ resource: claim.resource, mode: claim.mode }, path);
}

function claimsForSession(snapshot: SessionRetentionSnapshot): readonly ResourceClaim[] {
  return snapshot.claims.filter((claim) => claim.sessionId === snapshot.session.sessionId);
}

function assertSnapshot(snapshot: SessionRetentionSnapshot, sessionId: string): void {
  if (typeof snapshot !== "object" || snapshot === null)
    fail("RETENTION_STEP_FAILED", "Authority returned no snapshot");
  if (snapshot.session.sessionId !== sessionId) {
    fail("SESSION_NOT_FOUND", "Authority returned a snapshot for a different session", {
      expectedSessionId: sessionId,
      actualSessionId: snapshot.session.sessionId,
    });
  }
  assertGeneration(snapshot.claimSetGeneration, "snapshot.claimSetGeneration");
  clonePhysicalIdentity(snapshot.session.physicalIdentity);
}

function checkDesiredSubset(
  desiredClaims: readonly RetainedClaimIntent[],
  currentClaims: readonly ResourceClaim[],
  sessionId: string,
): void {
  const available = new Set(
    currentClaims
      .filter((claim) => claim.sessionId === sessionId)
      .map((claim) => `${claim.resource}\u0000${claim.mode}`),
  );
  for (const desired of desiredClaims) {
    if (!available.has(`${desired.resource}\u0000${desired.mode}`)) {
      fail("INVALID_INPUT", "desiredClaims may only retain claims currently owned by the session", {
        sessionId,
        resource: desired.resource,
        mode: desired.mode,
      });
    }
  }
}

function operationResult(
  operation: "park" | "resume",
  operationIdValue: string,
  sessionId: string,
  status: "parked" | "resumed" | "uncertain",
  snapshot: SessionRetentionSnapshot,
  options: {
    retention?: SessionRetentionRecord;
    releasedClaims?: readonly ResourceClaim[];
    reacquiredClaims?: readonly ResourceClaim[];
    reconciliation?: RetentionReobservation;
  } = {},
): SessionRetentionOperationResult {
  return Object.freeze({
    schemaVersion: SESSION_RETENTION_SCHEMA_VERSION,
    operation,
    operationId: operationIdValue,
    sessionId,
    status,
    claimSetGeneration: snapshot.claimSetGeneration,
    snapshot,
    ...(options.retention === undefined ? {} : { retention: options.retention }),
    ...(options.releasedClaims === undefined ? {} : { releasedClaims: options.releasedClaims }),
    ...(options.reacquiredClaims === undefined ? {} : { reacquiredClaims: options.reacquiredClaims }),
    ...(options.reconciliation === undefined ? {} : { reconciliation: options.reconciliation }),
  });
}

function resolveUncertain(
  authority: SessionRetentionAuthority,
  operation: "park" | "resume",
  operationIdValue: string,
  sessionId: string,
  expectedState: SessionRetentionSessionState,
  commit: RetentionCommitUncertain,
): SessionRetentionOperationResult {
  const reconciliation = authority.reobserve({ operationId: operationIdValue, sessionId, operation });
  if (reconciliation.status === "resolved") {
    const observedSessionMatches = reconciliation.snapshot.session.sessionId === sessionId;
    const observedOperationMatches = reconciliation.operationId === operationIdValue;
    const observedStateMatches = reconciliation.state === expectedState;
    const observedSnapshotStateMatches = reconciliation.snapshot.session.state === expectedState;
    const postconditionMatches =
      operation === "park"
        ? reconciliation.snapshot.retention?.state === "parked" &&
          reconciliation.snapshot.retention.operationId === operationIdValue &&
          reconciliation.snapshot.retention.sessionId === sessionId
        : reconciliation.snapshot.retention === undefined;
    if (
      observedSessionMatches &&
      observedOperationMatches &&
      observedStateMatches &&
      observedSnapshotStateMatches &&
      postconditionMatches
    ) {
      return operationResult(
        operation,
        operationIdValue,
        sessionId,
        operation === "park" ? "parked" : "resumed",
        reconciliation.snapshot,
        { reconciliation },
      );
    }
    const reasons = [
      ...(observedSessionMatches ? [] : ["session identity mismatch"]),
      ...(observedOperationMatches ? [] : ["operation identity mismatch"]),
      ...(observedStateMatches ? [] : [`state ${reconciliation.state} does not match ${expectedState}`]),
      ...(observedSnapshotStateMatches ? [] : ["snapshot session state does not match the reported state"]),
      ...(postconditionMatches
        ? []
        : [operation === "park" ? "park retention record is absent or mismatched" : "resume retention record remains"]),
    ];
    return unresolvedResult(operation, operationIdValue, sessionId, reasons.join("; "));
  }
  if (reconciliation.operationId !== operationIdValue) {
    return unresolvedResult(operation, operationIdValue, sessionId, "operation identity mismatch");
  }
  return Object.freeze({
    schemaVersion: SESSION_RETENTION_SCHEMA_VERSION,
    operation,
    operationId: operationIdValue,
    sessionId,
    status: "uncertain",
    claimSetGeneration: null,
    reconciliation,
    snapshot: undefined,
    ...(commit.reason.length === 0 ? {} : { reason: commit.reason }),
  });
}

function unresolvedResult(
  operation: "park" | "resume",
  operationIdValue: string,
  sessionId: string,
  reason: string,
): SessionRetentionOperationResult {
  const reconciliation: RetentionReobservationUnknown = {
    status: "unknown",
    operationId: operationIdValue,
    reason,
  };
  return Object.freeze({
    schemaVersion: SESSION_RETENTION_SCHEMA_VERSION,
    operation,
    operationId: operationIdValue,
    sessionId,
    status: "uncertain",
    claimSetGeneration: null,
    reconciliation,
    reason,
  });
}

function assertCommitIdentity(commit: RetentionCommitResult, operationIdValue: string): void {
  if (commit.operationId !== operationIdValue) {
    fail("RETENTION_STEP_FAILED", "Authority returned a receipt for another operation", {
      expectedOperationId: operationIdValue,
      actualOperationId: commit.operationId,
    });
  }
}

function handleRejectedCommit(commit: RetentionCommitRejected): never {
  fail(commit.code, commit.reason, { operationId: commit.operationId, ...commit.details });
}

function handleParkCommit(
  authority: SessionRetentionAuthority,
  operationIdValue: string,
  sessionId: string,
  commit: RetentionCommitResult,
): SessionRetentionOperationResult {
  assertCommitIdentity(commit, operationIdValue);
  if (commit.status === "rejected") return handleRejectedCommit(commit);
  if (commit.status === "uncertain") {
    return resolveUncertain(authority, "park", operationIdValue, sessionId, "parked", commit);
  }
  if (commit.snapshot.session.state !== "parked" || commit.snapshot.retention === undefined) {
    fail("RETENTION_STEP_FAILED", "Park commit did not produce parked state and retention evidence", {
      operationId: operationIdValue,
    });
  }
  return operationResult("park", operationIdValue, sessionId, "parked", commit.snapshot, {
    retention: commit.snapshot.retention,
    releasedClaims: commit.releasedClaims,
  });
}

function handleResumeCommit(
  authority: SessionRetentionAuthority,
  operationIdValue: string,
  sessionId: string,
  commit: RetentionCommitResult,
): SessionRetentionOperationResult {
  assertCommitIdentity(commit, operationIdValue);
  if (commit.status === "rejected") return handleRejectedCommit(commit);
  if (commit.status === "uncertain") {
    return resolveUncertain(authority, "resume", operationIdValue, sessionId, "active", commit);
  }
  if (commit.snapshot.session.state !== "active" || commit.snapshot.retention !== undefined) {
    fail("RETENTION_STEP_FAILED", "Resume commit did not produce active state without retention evidence", {
      operationId: operationIdValue,
    });
  }
  return operationResult("resume", operationIdValue, sessionId, "resumed", commit.snapshot, {
    reacquiredClaims: commit.reacquiredClaims,
  });
}

/** Execute fence → drain → revalidation → one atomic park write. */
export function parkSession(
  authority: SessionRetentionAuthority,
  options: ParkSessionOptions,
): SessionRetentionOperationResult {
  const sessionId = nonEmptyString(options.sessionId, "sessionId");
  const operationIdValue = operationId(options.operationId ?? randomUUID(), "operationId");
  const pinnedProfileDigest = retentionIdentityDigest(options.pinnedProfile);
  const parkedAt = timestamp(options.now ?? new Date().toISOString(), "now");
  const initial = authority.observe(sessionId);
  assertSnapshot(initial, sessionId);
  if (initial.session.state === "parked") {
    fail("SESSION_ALREADY_PARKED", "Session is already parked", { sessionId });
  }
  if (initial.session.state !== "active") {
    fail("SESSION_NOT_ACTIVE", `Session cannot be parked while ${initial.session.state}`, { sessionId });
  }

  const currentClaims = claimsForSession(initial);
  const desiredClaims = cloneAndSortIntents(
    options.desiredClaims === undefined
      ? currentClaims.map((claim) => claimIntent(claim, "desiredClaims"))
      : options.desiredClaims.map((claim, index) => claimIntent(claim, `desiredClaims[${index}]`)),
    "desiredClaims",
  );
  checkDesiredSubset(desiredClaims, initial.claims, sessionId);

  const fence = authority.fence({ sessionId, operationId: operationIdValue });
  if (isRejectedStep(fence)) {
    fail("FENCE_REJECTED", fence.reason, { operationId: operationIdValue, ...fence.details });
  }
  const drain = authority.drain({ sessionId, operationId: operationIdValue, fenceToken: fence.token });
  if (isRejectedStep(drain)) {
    fail("DRAIN_INCOMPLETE", drain.reason, { operationId: operationIdValue, ...drain.details });
  }
  const revalidated = authority.revalidate({ sessionId, operationId: operationIdValue, fenceToken: fence.token });
  if (isRejectedStep(revalidated)) {
    fail("REVALIDATION_FAILED", revalidated.reason, { operationId: operationIdValue, ...revalidated.details });
  }
  assertSnapshot(revalidated, sessionId);
  if (revalidated.session.state !== "active") {
    fail("REVALIDATION_FAILED", "Session was no longer active after drain", { sessionId });
  }
  if (!samePhysicalIdentity(initial.session.physicalIdentity, revalidated.session.physicalIdentity)) {
    fail("PHYSICAL_IDENTITY_MISMATCH", "Physical session identity changed during park", { sessionId });
  }
  checkDesiredSubset(desiredClaims, revalidated.claims, sessionId);

  const releaseClaimIds = revalidated.claims
    .filter((claim) => claim.sessionId === sessionId)
    .map((claim) => claim.claimId)
    .sort();
  const commit = authority.atomicPark({
    operationId: operationIdValue,
    sessionId,
    expectedState: "active",
    expectedClaimSetGeneration: revalidated.claimSetGeneration,
    fenceToken: fence.token,
    physicalIdentity: revalidated.session.physicalIdentity,
    desiredClaims,
    pinnedProfileDigest,
    releaseClaimIds,
    parkedAt,
  });
  return handleParkCommit(authority, operationIdValue, sessionId, commit);
}

/** Execute pinned-profile/physical/scope checks, all-claim conflict validation, and one CAS resume write. */
export function resumeSession(
  authority: SessionRetentionAuthority,
  options: ResumeSessionOptions,
): SessionRetentionOperationResult {
  const sessionId = nonEmptyString(options.sessionId, "sessionId");
  const operationIdValue = operationId(options.operationId ?? randomUUID(), "operationId");
  const pinnedProfileDigest = retentionIdentityDigest(options.pinnedProfile);
  const snapshot = authority.observe(sessionId);
  assertSnapshot(snapshot, sessionId);
  if (snapshot.session.state !== "parked") {
    fail("SESSION_NOT_PARKED", `Session cannot resume while ${snapshot.session.state}`, { sessionId });
  }
  const retention = snapshot.retention;
  if (retention === undefined || retention.state !== "parked") {
    fail("SESSION_NOT_PARKED", "Parked session has no retention record", { sessionId });
  }
  if (retention.sessionId !== sessionId) {
    fail("RETENTION_STEP_FAILED", "Retention record belongs to another session", { sessionId });
  }
  if (retention.repositoryId !== snapshot.session.physicalIdentity.repositoryId) {
    fail("PHYSICAL_IDENTITY_MISMATCH", "Retention record repository identity does not match the session", {
      sessionId,
    });
  }
  if (!samePhysicalIdentity(snapshot.session.physicalIdentity, retention.physicalIdentity)) {
    fail("PHYSICAL_IDENTITY_MISMATCH", "Parked physical identity no longer matches the session", { sessionId });
  }
  if (retention.pinnedProfileDigest !== pinnedProfileDigest) {
    fail("PINNED_PROFILE_MISMATCH", "Resume profile does not match the pinned park profile", { sessionId });
  }
  if (options.latestExternalScope === undefined || options.latestExternalScope === null) {
    fail("EXTERNAL_SCOPE_REJECTED", "Resume requires the latest external scope observation", { sessionId });
  }

  const desiredClaims = cloneAndSortIntents(retention.desiredClaims, "retention.desiredClaims");
  const validation = authority.validateResume({
    operationId: operationIdValue,
    sessionId,
    snapshot,
    retention,
    physicalIdentity: snapshot.session.physicalIdentity,
    pinnedProfileDigest,
    latestExternalScope: options.latestExternalScope,
    desiredClaims,
  });
  if (!validation.accepted) {
    const code: SessionRetentionErrorCode =
      validation.code === "CLAIM_CONFLICT"
        ? "CLAIM_CONFLICT"
        : validation.code === "STALE_CLAIM_SET"
          ? "STALE_CLAIM_SET"
          : "EXTERNAL_SCOPE_REJECTED";
    fail(code, validation.reason, { operationId: operationIdValue, ...validation.details });
  }

  const commit = authority.atomicResume({
    operationId: operationIdValue,
    sessionId,
    expectedState: "parked",
    expectedClaimSetGeneration: snapshot.claimSetGeneration,
    snapshot,
    retention,
    physicalIdentity: snapshot.session.physicalIdentity,
    pinnedProfileDigest,
    latestExternalScope: options.latestExternalScope,
    desiredClaims,
    validationToken: validation.token,
  });
  return handleResumeCommit(authority, operationIdValue, sessionId, commit);
}

/** Object form useful to adapters that retain one service instance. */
export class SessionRetentionService {
  public constructor(private readonly authority: SessionRetentionAuthority) {}

  public parkSession(options: ParkSessionOptions): SessionRetentionOperationResult {
    return parkSession(this.authority, options);
  }

  public resumeSession(options: ResumeSessionOptions): SessionRetentionOperationResult {
    return resumeSession(this.authority, options);
  }
}
