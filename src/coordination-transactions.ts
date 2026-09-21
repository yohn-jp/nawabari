import { createHash } from "node:crypto";

import { SessionRegistryError, type RegistryErrorDetails } from "./errors.js";
import {
  canonicalizeClaimInput,
  canonicalizeConcretePath,
  canonicalizeClaimResource,
  claimsConflict,
  claimsOverlap,
  claimModeGrantsAccess,
  compareCodePointStrings,
  createResourceClaim,
  permitsCoordinatedWrite,
  resourceClaimConflictsWithAccess,
  resourceMatchesClaim,
  sortResourceClaims,
  type ClaimOwnerContext,
  type CoordinationFacts,
  type ResourceClaim,
  type ResourceClaimInput,
  type ResourceClaimMode,
  type SharedWriteBinding,
} from "./resource-claims.js";
import {
  CHECKPOINT_MAX_PATHS,
  isOperationName,
  requiredAccessForOperation,
  type OperationName,
} from "./operation-authorization.js";
import type { SessionRecord } from "./session-registry.js";

/** Version of the transport-neutral coordinated claim transaction producer. */
export const COORDINATION_TRANSACTION_SCHEMA_VERSION = 1 as const;
export const COORDINATION_TRANSACTION_SERIALIZATION_KEYS = Object.freeze([
  "registry",
  "domain-session",
  "cli",
  "contract",
] as const);

export type CoordinationTransactionKind = "acquire" | "replace" | "delta" | "release";

export interface CoordinationClaimInput extends ResourceClaimInput {
  readonly sharing?: SharedWriteBinding;
}

export type CoordinationClaimDelta =
  | {
      readonly kind: "upsert";
      readonly resource: string;
      readonly mode: ResourceClaimMode;
      readonly sharing?: SharedWriteBinding;
    }
  | { readonly kind: "release"; readonly resource: string };

/** A fact supplied by the execution-control authority, not inferred here. */
export interface ManagedExecution {
  readonly executionId: string;
  readonly sessionId: string;
  readonly state: "active" | "draining" | "stopped" | "unknown";
  /** False means this is an untracked legacy process and is not a proof of absence. */
  readonly managed: boolean;
  /** Empty or omitted means the authority cannot bound the process to a path. */
  readonly resources?: readonly string[];
}

/** X07 execution-fence evidence consumed by claim authority during shrink. */
export interface ExecutionFence {
  readonly epoch: number;
  readonly state: "open" | "draining" | "fenced" | "unknown";
  readonly observed: boolean;
}

export interface CoordinationTransactionSnapshot {
  readonly repositoryId: string;
  readonly claimSetGeneration: number;
  readonly sessions: readonly SessionRecord[];
  readonly claims: readonly ResourceClaim[];
}

export interface CoordinationTransactionRequest {
  readonly kind: CoordinationTransactionKind;
  readonly sessionId: string;
  readonly repositoryId?: string;
  readonly claims?: readonly CoordinationClaimInput[];
  readonly deltas?: readonly CoordinationClaimDelta[];
  readonly resources?: readonly string[];
  /** One explicit group binding applied to every write declaration in this request. */
  readonly sharing?: SharedWriteBinding;
  readonly expectedClaimSetGeneration?: number | null;
  readonly force?: boolean;
  readonly timestamp?: string;
  readonly managedExecutions?: readonly ManagedExecution[];
  readonly executionFence?: ExecutionFence;
}

export interface CoordinationTransactionChange {
  readonly resource: string;
  readonly before: ResourceClaim | null;
  readonly after: ResourceClaim | null;
  readonly kind: "added" | "changed" | "released" | "unchanged";
}

export interface CoordinationTransactionCommit {
  readonly schemaVersion: typeof COORDINATION_TRANSACTION_SCHEMA_VERSION;
  readonly repositoryId: string;
  readonly sessions: readonly SessionRecord[];
  readonly claims: readonly ResourceClaim[];
  readonly previousClaimSetGeneration: number;
  readonly claimSetGeneration: number;
  readonly changes: readonly CoordinationTransactionChange[];
}

export interface CoordinationTransactionPlan extends CoordinationTransactionCommit {
  readonly idempotent: boolean;
  readonly sessionId: string;
  readonly sessionClaims: readonly ResourceClaim[];
}

export interface CoordinationTransactionResult {
  readonly schemaVersion: typeof COORDINATION_TRANSACTION_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly claims: readonly ResourceClaim[];
  readonly previousClaimSetGeneration: number;
  readonly claimSetGeneration: number;
  readonly changes: readonly CoordinationTransactionChange[];
  readonly idempotent: boolean;
}

export interface CoordinationTransactionOptions {
  /** Called once after every validation has completed and only for a mutation. */
  readonly commit?: (commit: CoordinationTransactionCommit) => void;
  /** Return physical/generation evidence for an overlapping pair. */
  readonly coordinationFacts?: (left: ResourceClaim, right: ResourceClaim) => CoordinationFacts | undefined;
}

export interface OperationAuthorizationRequest {
  readonly operation: string;
  readonly sessionId: string;
  readonly resources: readonly string[];
  readonly snapshot: CoordinationTransactionSnapshot;
  readonly coordinationFacts?: (left: ResourceClaim, right: ResourceClaim) => CoordinationFacts | undefined;
}

export interface AuthorizedCoordinationResource {
  readonly resource: string;
  readonly claimIds: readonly string[];
}

export interface CoordinationOperationAuthorization {
  readonly schemaVersion: typeof COORDINATION_TRANSACTION_SCHEMA_VERSION;
  readonly allowed: boolean;
  readonly operation: string;
  readonly requiredAccess: ResourceClaimMode | null;
  readonly sessionId: string;
  readonly resources: readonly AuthorizedCoordinationResource[];
  readonly code:
    | "ALLOWED"
    | "INVALID_OPERATION"
    | "INVALID_RESOURCE"
    | "SESSION_NOT_FOUND"
    | "SESSION_NOT_ACTIVE"
    | "MISSING_RESOURCE_CLAIM"
    | "INSUFFICIENT_CLAIM_MODE"
    | "RESOURCE_CLAIM_CONFLICT";
  readonly details: RegistryErrorDetails;
}

/**
 * Plan one complete claim transition without invoking persistence. Every
 * input is normalized before overlap, generation, and execution checks run.
 * Callers can therefore inspect a complete plan and commit it exactly once.
 */
export function planCoordinationTransaction(
  snapshot: CoordinationTransactionSnapshot,
  request: CoordinationTransactionRequest,
  options: Pick<CoordinationTransactionOptions, "coordinationFacts"> = {},
): CoordinationTransactionPlan {
  assertSnapshot(snapshot);
  assertRequest(request);
  const owner = selectOwner(snapshot, request);
  assertConcurrency(snapshot.claimSetGeneration, request);
  const timestamp = request.timestamp ?? new Date().toISOString();
  const current = snapshot.claims.filter((claim) => claim.sessionId === owner.sessionId);
  const external = snapshot.claims.filter((claim) => claim.sessionId !== owner.sessionId);
  const requested = normalizeRequest(owner, request);
  const nextByResource = materializeNextClaims(current, requested, request.kind, timestamp, owner);
  const nextSessionClaims = sortResourceClaims([...nextByResource.values()]);
  assertCompleteClaimSet(nextSessionClaims, external, snapshot, options.coordinationFacts);
  assertExecutionDrain(current, nextSessionClaims, request.managedExecutions ?? [], request.executionFence);

  const nextClaims = sortResourceClaims([...external, ...nextSessionClaims]);
  const changed = buildChanges(current, nextSessionClaims);
  const claimSetGeneration = changed.some((change) => change.kind !== "unchanged")
    ? snapshot.claimSetGeneration + 1
    : snapshot.claimSetGeneration;
  const commit: CoordinationTransactionCommit = freezeCommit({
    schemaVersion: COORDINATION_TRANSACTION_SCHEMA_VERSION,
    repositoryId: snapshot.repositoryId,
    sessions: snapshot.sessions,
    claims: nextClaims,
    previousClaimSetGeneration: snapshot.claimSetGeneration,
    claimSetGeneration,
    changes: changed,
  });
  return Object.freeze({
    ...commit,
    idempotent: claimSetGeneration === snapshot.claimSetGeneration,
    sessionId: owner.sessionId,
    sessionClaims: Object.freeze(nextSessionClaims.map(cloneClaim)),
  });
}

/** Plan and, if needed, invoke the supplied atomic writer exactly once. */
export function applyCoordinationTransaction(
  snapshot: CoordinationTransactionSnapshot,
  request: CoordinationTransactionRequest,
  options: CoordinationTransactionOptions = {},
): CoordinationTransactionResult {
  const plan = planCoordinationTransaction(snapshot, request, options);
  if (!plan.idempotent) options.commit?.(plan);
  return Object.freeze({
    schemaVersion: plan.schemaVersion,
    sessionId: plan.sessionId,
    claims: Object.freeze(plan.sessionClaims.map(cloneClaim)),
    previousClaimSetGeneration: plan.previousClaimSetGeneration,
    claimSetGeneration: plan.claimSetGeneration,
    changes: Object.freeze(plan.changes.map(cloneChange)),
    idempotent: plan.idempotent,
  });
}

/**
 * Authorize a concrete operation against the same claim set used by the
 * transaction planner. A coordinated write remains ordinary WRITE: commit,
 * push, and other exclusive operations still require exclusive-write.
 */
export function authorizeCoordinationOperation(
  request: OperationAuthorizationRequest,
): CoordinationOperationAuthorization {
  assertSnapshot(request.snapshot);
  if (!isOperationName(request.operation)) {
    return deniedAuthorization(request, null, "INVALID_OPERATION", { operation: request.operation });
  }
  const owner = request.snapshot.sessions.find((session) => session.sessionId === request.sessionId);
  if (owner === undefined) return deniedAuthorization(request, null, "SESSION_NOT_FOUND", {});
  if (owner.state !== "active") {
    return deniedAuthorization(request, null, "SESSION_NOT_ACTIVE", { state: owner.state });
  }
  if (owner.repositoryId !== request.snapshot.repositoryId) {
    return deniedAuthorization(request, null, "SESSION_NOT_FOUND", {
      repositoryId: owner.repositoryId,
      expectedRepositoryId: request.snapshot.repositoryId,
    });
  }
  const requiredAccess = requiredAccessForOperation(request.operation as OperationName);
  if (!Array.isArray(request.resources) || request.resources.length === 0) {
    return deniedAuthorization(request, requiredAccess, "INVALID_RESOURCE", {
      reason: "at-least-one-concrete-resource-required",
    });
  }
  if (request.resources.length > CHECKPOINT_MAX_PATHS) {
    return deniedAuthorization(request, requiredAccess, "INVALID_RESOURCE", {
      reason: "too-many-resources",
      maxResources: CHECKPOINT_MAX_PATHS,
    });
  }
  let resources: readonly string[];
  try {
    resources = request.resources.map((resource) => canonicalizeConcretePath(resource, owner.worktreePath));
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) {
      return deniedAuthorization(request, requiredAccess, "INVALID_RESOURCE", {
        code: error.code,
        ...error.details,
      });
    }
    throw error;
  }
  const ownClaims = request.snapshot.claims.filter((claim) => claim.sessionId === owner.sessionId);
  const externalClaims = request.snapshot.claims.filter((claim) => claim.sessionId !== owner.sessionId);
  const authorized: AuthorizedCoordinationResource[] = [];
  for (const resource of resources) {
    const matching = ownClaims.filter((claim) => resourceMatchesClaim(claim, resource));
    const granting = matching.filter((claim) => claimModeGrantsAccess(claim.mode, requiredAccess));
    if (granting.length === 0) {
      const conflicting = externalClaims.find((claim) =>
        resourceClaimConflictsWithAccess(claim, resource, requiredAccess),
      );
      if (conflicting !== undefined) {
        return deniedAuthorization(request, requiredAccess, "RESOURCE_CLAIM_CONFLICT", {
          resource,
          claimId: conflicting.claimId,
          ownerSessionId: conflicting.sessionId,
          requiredAccess,
        });
      }
      if (matching.length > 0) {
        return deniedAuthorization(request, requiredAccess, "INSUFFICIENT_CLAIM_MODE", {
          resource,
          requiredAccess,
          grantedModes: matching.map((claim) => claim.mode).sort(compareCodePointStrings),
        });
      }
      return deniedAuthorization(request, requiredAccess, "MISSING_RESOURCE_CLAIM", {
        resource,
        requiredAccess,
      });
    }
    const conflicting = externalClaims.find((claim) =>
      claimsConflict(
        granting[0] as ResourceClaim,
        claim,
        request.coordinationFacts?.(granting[0] as ResourceClaim, claim),
      ),
    );
    if (conflicting !== undefined) {
      return deniedAuthorization(request, requiredAccess, "RESOURCE_CLAIM_CONFLICT", {
        resource,
        claimId: conflicting.claimId,
        ownerSessionId: conflicting.sessionId,
        requiredAccess,
      });
    }
    authorized.push(Object.freeze({ resource, claimIds: Object.freeze(granting.map((claim) => claim.claimId)) }));
  }
  return Object.freeze({
    schemaVersion: COORDINATION_TRANSACTION_SCHEMA_VERSION,
    allowed: true,
    operation: request.operation,
    requiredAccess,
    sessionId: request.sessionId,
    resources: Object.freeze(authorized),
    code: "ALLOWED",
    details: Object.freeze({}),
  });
}

/** Canonical, non-mutating check used by integration adapters before a write. */
export function requiresDrainForClaimTransition(
  before: ResourceClaim,
  after: ResourceClaim | undefined,
  executions: readonly ManagedExecution[],
): boolean {
  if (!isAuthorityShrinking(before, after)) return false;
  return executions.some(
    (execution) =>
      execution.sessionId === before.sessionId &&
      execution.managed &&
      execution.state !== "stopped" &&
      executionOverlapsClaim(execution, before),
  );
}

/** Stable serialization for transport adapters and contract tests. */
export function serializeCoordinationTransaction(value: CoordinationTransactionCommit): string {
  return JSON.stringify(value);
}

function selectOwner(
  snapshot: CoordinationTransactionSnapshot,
  request: CoordinationTransactionRequest,
): SessionRecord {
  const owner = snapshot.sessions.find((session) => session.sessionId === request.sessionId);
  if (owner === undefined) {
    throw transactionError("SESSION_NOT_FOUND", "Session was not found", { sessionId: request.sessionId });
  }
  if (owner.state !== "active") {
    throw transactionError("SESSION_NOT_ACTIVE", "Session is not active", {
      sessionId: request.sessionId,
      state: owner.state,
    });
  }
  if (request.repositoryId !== undefined && request.repositoryId !== snapshot.repositoryId) {
    throw transactionError("REPOSITORY_MISMATCH", "Transaction repository does not match the snapshot", {
      expectedRepositoryId: snapshot.repositoryId,
      actualRepositoryId: request.repositoryId,
    });
  }
  if (owner.repositoryId !== snapshot.repositoryId) {
    throw transactionError("REPOSITORY_MISMATCH", "Session repository does not match the snapshot", {
      expectedRepositoryId: snapshot.repositoryId,
      actualRepositoryId: owner.repositoryId,
    });
  }
  return owner;
}

function normalizeRequest(owner: SessionRecord, request: CoordinationTransactionRequest): NormalizedRequest {
  if (request.kind === "acquire" || request.kind === "replace") {
    const inputs = request.claims ?? [];
    if (request.kind === "acquire" && inputs.length === 0) {
      throw transactionError("INVALID_CLAIM", "At least one claim is required");
    }
    const requestSharing = request.sharing;
    if (
      requestSharing !== undefined &&
      inputs.some((input) => input.sharing !== undefined && !sameSharing(input.sharing, requestSharing))
    ) {
      throw transactionError("CONTRADICTORY_CLAIM", "Request contains conflicting sharing bindings");
    }
    return {
      kind: request.kind,
      claims: canonicalInputs(inputs, owner, requestSharing),
      resources: [],
    };
  }
  if (request.kind === "release") {
    if (request.resources === undefined || request.resources.length === 0) {
      throw transactionError("INVALID_CLAIM", "At least one release resource is required");
    }
    if (request.deltas !== undefined || request.claims !== undefined || request.sharing !== undefined) {
      throw transactionError("INVALID_OPERATION", "Release cannot include claims or deltas");
    }
    return {
      kind: request.kind,
      claims: [],
      resources: uniqueCanonicalResources(
        request.resources.map((resource) => canonicalizeClaimResource(resource, owner.worktreePath)),
      ),
    };
  }
  const deltas = request.deltas ?? [];
  if (deltas.length === 0) throw transactionError("INVALID_CLAIM", "At least one claim delta is required");
  const seen = new Set<string>();
  const normalized = deltas.map((delta): NormalizedDelta => {
    if (delta.kind !== "upsert" && delta.kind !== "release") {
      throw transactionError("INVALID_CLAIM", "Claim delta kind is unsupported");
    }
    const resource = canonicalizeClaimResource(delta.resource, owner.worktreePath);
    if (seen.has(resource))
      throw transactionError("DUPLICATE_CLAIM", "Request contains duplicate claim delta", { resource });
    seen.add(resource);
    if (delta.kind === "release") return { kind: "release", resource };
    const input = canonicalizeClaimInput(
      { resource: delta.resource, mode: delta.mode, sharing: delta.sharing ?? request.sharing },
      ownerContext(owner),
    );
    return { kind: "upsert", resource: input.resource, mode: input.mode, sharing: input.sharing };
  });
  return {
    kind: "delta",
    claims: normalized.filter((delta): delta is NormalizedClaim => delta.kind === "upsert"),
    resources: normalized,
  };
}

interface NormalizedClaim {
  readonly kind: "upsert";
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly sharing?: SharedWriteBinding;
}

interface NormalizedDeltaRelease {
  readonly kind: "release";
  readonly resource: string;
}

type NormalizedDelta = NormalizedClaim | NormalizedDeltaRelease;

interface NormalizedRequest {
  readonly kind: CoordinationTransactionKind;
  readonly claims: readonly (NormalizedClaim | CanonicalClaim)[];
  readonly resources: readonly (string | NormalizedDelta)[];
}

interface CanonicalClaim {
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly sharing?: SharedWriteBinding;
}

function canonicalInputs(
  inputs: readonly CoordinationClaimInput[],
  owner: SessionRecord,
  requestSharing?: SharedWriteBinding,
): readonly CanonicalClaim[] {
  const seen = new Set<string>();
  return inputs
    .map((input) =>
      canonicalizeClaimInput(
        {
          ...input,
          ...(input.sharing === undefined && requestSharing !== undefined ? { sharing: requestSharing } : {}),
        },
        ownerContext(owner),
      ),
    )
    .map((claim) => {
      if (seen.has(claim.resource))
        throw transactionError("DUPLICATE_CLAIM", "Request contains duplicate claim", { resource: claim.resource });
      seen.add(claim.resource);
      return claim;
    })
    .sort((left, right) => compareCodePointStrings(claimKey(left), claimKey(right)));
}

function materializeNextClaims(
  current: readonly ResourceClaim[],
  request: NormalizedRequest,
  kind: CoordinationTransactionKind,
  timestamp: string,
  owner: SessionRecord,
): Map<string, ResourceClaim> {
  const next = new Map(current.map((claim) => [claim.resource, claim]));
  const ownerContextValue = ownerContext(owner);
  if (kind === "replace") {
    next.clear();
    for (const input of request.claims) {
      const claim = input as CanonicalClaim;
      next.set(claim.resource, createResourceClaim(claim, ownerContextValue, timestamp));
    }
    return next;
  }
  if (kind === "acquire") {
    for (const input of request.claims) {
      const claim = input as CanonicalClaim;
      const existing = next.get(claim.resource);
      if (existing !== undefined) {
        if (!claimEquivalentInput(existing, claim)) {
          throw transactionError("CONTRADICTORY_CLAIM", "Session already owns the resource with different authority", {
            resource: claim.resource,
            currentMode: existing.mode,
            requestedMode: claim.mode,
          });
        }
        continue;
      }
      next.set(claim.resource, createResourceClaim(claim, ownerContextValue, timestamp));
    }
    return next;
  }
  if (kind === "release") {
    for (const resource of request.resources) next.delete(resource as string);
    return next;
  }
  for (const delta of request.resources as readonly NormalizedDelta[]) {
    if (delta.kind === "release") {
      next.delete(delta.resource);
    } else {
      next.set(delta.resource, createResourceClaim(delta, ownerContextValue, timestamp));
    }
  }
  return next;
}

function assertCompleteClaimSet(
  sessionClaims: readonly ResourceClaim[],
  externalClaims: readonly ResourceClaim[],
  snapshot: CoordinationTransactionSnapshot,
  facts: ((left: ResourceClaim, right: ResourceClaim) => CoordinationFacts | undefined) | undefined,
): void {
  for (let index = 0; index < sessionClaims.length; index += 1) {
    const current = sessionClaims[index] as ResourceClaim;
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      const prior = sessionClaims[priorIndex] as ResourceClaim;
      if (claimsOverlap(current, prior)) {
        throw transactionError("CONTRADICTORY_CLAIM", "A session cannot own overlapping claims", {
          resource: current.resource,
          otherResource: prior.resource,
        });
      }
    }
  }
  for (const candidate of sessionClaims) {
    for (const current of externalClaims) {
      if (!claimsOverlap(candidate, current)) continue;
      const evidence = facts?.(candidate, current);
      if (claimsConflict(candidate, current, evidence)) {
        throw transactionError("RESOURCE_CLAIM_CONFLICT", "Resource claim conflicts with an active session claim", {
          claimId: candidate.claimId,
          ownerClaimId: current.claimId,
          ownerSessionId: current.sessionId,
          resource: candidate.resource,
          coordination: evidence === undefined ? "unproven" : permitsCoordinatedWrite(evidence),
        });
      }
    }
  }
  for (const claim of sessionClaims) {
    if (claim.repositoryId !== snapshot.repositoryId) {
      throw transactionError("REPOSITORY_MISMATCH", "Claim repository does not match the transaction snapshot", {
        repositoryId: claim.repositoryId,
      });
    }
  }
}

function assertExecutionDrain(
  before: readonly ResourceClaim[],
  after: readonly ResourceClaim[],
  executions: readonly ManagedExecution[],
  fence: ExecutionFence | undefined,
): void {
  const afterByResource = new Map(after.map((claim) => [claim.resource, claim]));
  for (const prior of before) {
    const next = afterByResource.get(prior.resource);
    if (!isAuthorityShrinking(prior, next)) continue;
    const active = executions.find(
      (execution) =>
        execution.sessionId === prior.sessionId &&
        execution.managed &&
        execution.state !== "stopped" &&
        executionOverlapsClaim(execution, prior),
    );
    if (active === undefined) continue;
    throw transactionError("OPERATION_REJECTED", "Claim authority cannot shrink while execution is active", {
      reason: "drain-required",
      executionId: active.executionId,
      executionState: active.state,
      claimId: prior.claimId,
      resource: prior.resource,
      fenceState: fence?.state ?? "unknown",
      fenceObserved: fence?.observed === true,
      requiredAction: "drain-managed-execution",
    });
  }
}

function isAuthorityShrinking(before: ResourceClaim, after: ResourceClaim | undefined): boolean {
  if (after === undefined) return true;
  if (!claimModeGrantsAccess(after.mode, before.mode)) return true;
  if (before.mode === "write" && after.mode === "write") {
    const beforeGroup = before.sharing?.groupId;
    const afterGroup = after.sharing?.groupId;
    if (beforeGroup !== afterGroup) return true;
  }
  return false;
}

function executionOverlapsClaim(execution: ManagedExecution, claim: ResourceClaim): boolean {
  if (execution.resources === undefined || execution.resources.length === 0) return true;
  return execution.resources.some((resource) => resourceMatchesClaim(claim, resource));
}

function buildChanges(
  before: readonly ResourceClaim[],
  after: readonly ResourceClaim[],
): CoordinationTransactionChange[] {
  const byResource = new Map(after.map((claim) => [claim.resource, claim]));
  const resources = new Set([...before.map((claim) => claim.resource), ...after.map((claim) => claim.resource)]);
  return [...resources].sort(compareCodePointStrings).map((resource) => {
    const prior = before.find((claim) => claim.resource === resource) ?? null;
    const next = byResource.get(resource) ?? null;
    const kind =
      prior === null && next !== null
        ? "added"
        : prior !== null && next === null
          ? "released"
          : prior !== null && next !== null && claimEquivalent(prior, next)
            ? "unchanged"
            : "changed";
    return Object.freeze({
      resource,
      before: prior === null ? null : cloneClaim(prior),
      after: next === null ? null : cloneClaim(next),
      kind,
    });
  });
}

function claimEquivalent(left: ResourceClaim, right: ResourceClaim): boolean {
  return (
    left.claimId === right.claimId &&
    left.mode === right.mode &&
    left.sharing?.kind === right.sharing?.kind &&
    left.sharing?.groupId === right.sharing?.groupId
  );
}

function claimEquivalentInput(claim: ResourceClaim, input: CanonicalClaim): boolean {
  return (
    claim.mode === input.mode &&
    claim.sharing?.kind === input.sharing?.kind &&
    claim.sharing?.groupId === input.sharing?.groupId
  );
}

function sameSharing(left: SharedWriteBinding, right: SharedWriteBinding): boolean {
  return left.kind === right.kind && left.groupId === right.groupId;
}

function cloneClaim(claim: ResourceClaim): ResourceClaim {
  return Object.freeze({
    ...claim,
    ...(claim.sharing === undefined ? {} : { sharing: Object.freeze({ ...claim.sharing }) }),
  });
}

function cloneChange(change: CoordinationTransactionChange): CoordinationTransactionChange {
  return Object.freeze({
    ...change,
    before: change.before === null ? null : cloneClaim(change.before),
    after: change.after === null ? null : cloneClaim(change.after),
  });
}

function freezeCommit(commit: CoordinationTransactionCommit): CoordinationTransactionCommit {
  return Object.freeze({
    ...commit,
    sessions: Object.freeze([...commit.sessions]),
    claims: Object.freeze(commit.claims.map(cloneClaim)),
    changes: Object.freeze(commit.changes.map(cloneChange)),
  });
}

function ownerContext(owner: SessionRecord): ClaimOwnerContext {
  return {
    sessionId: owner.sessionId,
    repositoryId: owner.repositoryId,
    worktreePath: owner.worktreePath,
    state: owner.state,
  };
}

function assertSnapshot(snapshot: CoordinationTransactionSnapshot): void {
  if (!isRecord(snapshot) || typeof snapshot.repositoryId !== "string" || snapshot.repositoryId.length === 0) {
    throw transactionError("INVALID_OPERATION", "Transaction snapshot repository identity is invalid");
  }
  if (!Number.isSafeInteger(snapshot.claimSetGeneration) || snapshot.claimSetGeneration < 0) {
    throw transactionError("INVALID_OPERATION", "Transaction snapshot generation is invalid");
  }
  if (!Array.isArray(snapshot.sessions) || !Array.isArray(snapshot.claims)) {
    throw transactionError("INVALID_OPERATION", "Transaction snapshot arrays are invalid");
  }
}

function assertRequest(request: CoordinationTransactionRequest): void {
  if (!isRecord(request) || typeof request.sessionId !== "string" || request.sessionId.length === 0) {
    throw transactionError("INVALID_OPERATION", "Transaction sessionId is required");
  }
  if (!["acquire", "replace", "delta", "release"].includes(request.kind)) {
    throw transactionError("INVALID_OPERATION", "Transaction kind is unsupported");
  }
  if (
    request.force === true &&
    request.expectedClaimSetGeneration !== undefined &&
    request.expectedClaimSetGeneration !== null
  ) {
    throw transactionError("INVALID_OPERATION", "Force and expected generation are mutually exclusive");
  }
}

function assertConcurrency(actual: number, request: CoordinationTransactionRequest): void {
  const expected = request.expectedClaimSetGeneration;
  const hasExpected = expected !== undefined && expected !== null;
  if (request.kind !== "acquire" && hasExpected === (request.force === true)) {
    throw transactionError(
      "INVALID_OPERATION",
      `Transaction kind ${request.kind} requires exactly one generation or force intent`,
    );
  }
  if (hasExpected) {
    if (!Number.isSafeInteger(expected) || expected < 0) {
      throw transactionError("INVALID_OPERATION", "Expected claim-set generation is invalid", { expected });
    }
    if (expected !== actual) {
      throw transactionError("STALE_CLAIM_SET", "Claim-set generation is stale", {
        expectedClaimSetGeneration: expected,
        actualClaimSetGeneration: actual,
      });
    }
  }
}

function deniedAuthorization(
  request: OperationAuthorizationRequest,
  requiredAccess: ResourceClaimMode | null,
  code: CoordinationOperationAuthorization["code"],
  details: RegistryErrorDetails,
): CoordinationOperationAuthorization {
  return Object.freeze({
    schemaVersion: COORDINATION_TRANSACTION_SCHEMA_VERSION,
    allowed: false,
    operation: request.operation,
    requiredAccess,
    sessionId: request.sessionId,
    resources: Object.freeze([]),
    code,
    details: Object.freeze(details),
  });
}

function transactionError(
  code: ConstructorParameters<typeof SessionRegistryError>[0],
  message: string,
  details: RegistryErrorDetails = {},
): SessionRegistryError {
  return new SessionRegistryError(code, message, details);
}

function claimKey(claim: Pick<CanonicalClaim, "resource" | "mode" | "sharing">): string {
  return `${claim.resource}\u0000${claim.mode}\u0000${claim.sharing?.kind ?? ""}\u0000${claim.sharing?.groupId ?? ""}`;
}

function uniqueCanonicalResources(resources: readonly string[]): readonly string[] {
  return [...new Set(resources)].sort(compareCodePointStrings);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function coordinationTransactionDigest(commit: CoordinationTransactionCommit): string {
  return createHash("sha256").update(serializeCoordinationTransaction(commit)).digest("hex");
}
