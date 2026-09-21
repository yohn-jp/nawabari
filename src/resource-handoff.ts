import {
  assertCanonicalClaimResource,
  claimsOverlap,
  resourceMatchesClaim,
  type ResourceClaim,
  type ResourceClaimMode,
} from "./resource-claims.js";
import { SessionRegistryError, type RegistryErrorDetails } from "./errors.js";
import type { EffectiveWorkingSetScope } from "./working-set.js";

/** The transport-neutral handoff contract. Persistence remains registry-owned. */
export const RESOURCE_HANDOFF_SCHEMA_VERSION = 1 as const;
export const RESOURCE_HANDOFF_OPERATION = "resource-handoff" as const;
export const RESOURCE_HANDOFF_CONTRACT_ID = "nawabari.resource-handoff.v1" as const;

export type ResourceHandoffStatus = "transferred" | "idempotent" | "blocked" | "unresolved";
export type ResourceHandoffValidationStatus = "allowed" | "idempotent" | "blocked" | "unresolved";

export type ResourceHandoffCode =
  | "ALLOWED"
  | "IDEMPOTENT"
  | "INVALID_OPERATION"
  | "OPERATION_REJECTED"
  | "SESSION_NOT_FOUND"
  | "SESSION_NOT_ACTIVE"
  | "REPOSITORY_MISMATCH"
  | "WORKTREE_MISMATCH"
  | "STALE_CLAIM_SET"
  | "MISSING_RESOURCE_CLAIM"
  | "RESOURCE_CLAIM_CONFLICT"
  | "CLAIM_SESSION_MISMATCH"
  | "INSUFFICIENT_CLAIM_MODE"
  | "PHYSICAL_OBSERVATION_UNAVAILABLE"
  | "REGISTRY_DURABILITY_UNCERTAIN";

export interface HandoffResourcesOptions {
  /** Source session whose exact claim is being transferred. */
  readonly fromSessionId?: string;
  readonly from_session_id?: string;
  /** Destination session receiving the claim. */
  readonly toSessionId?: string;
  readonly to_session_id?: string;
  /** One canonical, concrete repository-relative resource. */
  readonly resource: string;
  /** Mode to grant to the destination claim. */
  readonly mode: ResourceClaimMode;
  /** Required claim-set CAS token. `ifGeneration` is the CLI spelling. */
  readonly ifGeneration?: number | null;
  readonly if_generation?: number | null;
  readonly expectedClaimSetGeneration?: number | null;
  readonly expected_claim_set_generation?: number | null;
  /** Stable retry identity. When omitted, a deterministic identity is derived. */
  readonly operationId?: string;
  readonly operation_id?: string;
}

export interface ResourceHandoffSession {
  readonly sessionId: string;
  readonly repositoryId: string;
  readonly worktreePath: string;
  readonly state: string;
  /** Maximum destination scope established by the session authority. */
  readonly maxScope?: EffectiveWorkingSetScope | null;
}

export interface ResourceHandoffRegistrySnapshot {
  readonly repositoryId: string;
  readonly claimSetGeneration: number;
  readonly sessions: readonly ResourceHandoffSession[];
  readonly claims: readonly ResourceClaim[];
  /** Persisted operation identities make retries safe after a successful write. */
  readonly completedOperations?: readonly ResourceHandoffOperationRecord[];
}

export interface ResourceHandoffSnapshot {
  readonly schemaVersion: typeof RESOURCE_HANDOFF_SCHEMA_VERSION;
  readonly operation: typeof RESOURCE_HANDOFF_OPERATION;
  readonly registry: ResourceHandoffRegistrySnapshot;
}

export interface ResourceHandoffOperationRecord {
  readonly operationId: string;
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly claimSetGeneration: number;
}

export interface ResourceHandoffBlocker {
  readonly code: ResourceHandoffCode;
  readonly reason: string;
  readonly ownerSessionId?: string;
  readonly ownerClaimId?: string;
  readonly resource: string;
}

export interface ResourceHandoffValidation {
  readonly schemaVersion: typeof RESOURCE_HANDOFF_SCHEMA_VERSION;
  readonly operation: typeof RESOURCE_HANDOFF_OPERATION;
  readonly status: ResourceHandoffValidationStatus;
  readonly code: ResourceHandoffCode;
  readonly operationId: string;
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly claimSetGeneration: number;
  readonly sourceClaim: ResourceClaim | null;
  readonly destinationClaim: ResourceClaim | null;
  readonly blockers: readonly ResourceHandoffBlocker[];
  readonly sourceRetained: true;
  readonly safeActions: readonly string[];
}

export interface ResourceHandoffFence {
  readonly schemaVersion: typeof RESOURCE_HANDOFF_SCHEMA_VERSION;
  readonly sessionId: string;
  readonly operationId: string;
  readonly epoch: number;
  readonly accepting: false;
  readonly status: "fenced";
}

export interface ResourceHandoffFenceController {
  /** Stop accepting new managed execution for the source session. */
  fence(input: {
    readonly sessionId: string;
    readonly operationId: string;
  }): ResourceHandoffFence | Promise<ResourceHandoffFence>;
  /** Wait without holding the repository lock for kernel-backed drain evidence. */
  awaitQuiescence(fence: ResourceHandoffFence): ResourceHandoffQuiescence | Promise<ResourceHandoffQuiescence>;
}

export interface ResourceHandoffQuiescence {
  readonly sessionId: string;
  readonly operationId: string;
  readonly epoch: number;
  readonly status: "quiescent" | "active" | "unknown";
  readonly activeExecutionIds: readonly string[];
  readonly unknownExecutionIds: readonly string[];
}

export interface ResourceHandoffCommitInput {
  readonly options: HandoffResourcesOptions;
  readonly normalized: NormalizedHandoffOptions;
  readonly snapshot: ResourceHandoffSnapshot;
  readonly fence: ResourceHandoffFence;
  readonly quiescence: ResourceHandoffQuiescence;
}

export interface ResourceHandoffCommitResult {
  readonly status: "transferred" | "idempotent";
  readonly operationId: string;
  readonly claimSetGeneration: number;
  readonly sourceClaim: ResourceClaim | null;
  readonly destinationClaim: ResourceClaim | null;
}

/**
 * The registry adapter supplied by the integration surface. Each read and
 * commit is independently lock-scoped; the controller wait is deliberately
 * outside this interface so it cannot accidentally retain RepositoryLock.
 */
export interface ResourceHandoffAuthority {
  readResourceHandoffSnapshot(): ResourceHandoffSnapshot | Promise<ResourceHandoffSnapshot>;
  commitResourceHandoff(
    input: ResourceHandoffCommitInput,
  ): ResourceHandoffCommitResult | Promise<ResourceHandoffCommitResult>;
}

export interface ResourceHandoffResult {
  readonly schemaVersion: typeof RESOURCE_HANDOFF_SCHEMA_VERSION;
  readonly operation: typeof RESOURCE_HANDOFF_OPERATION;
  readonly status: ResourceHandoffStatus;
  readonly code: ResourceHandoffCode;
  readonly idempotent: boolean;
  readonly operationId: string;
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly previousClaimSetGeneration: number;
  readonly claimSetGeneration: number;
  readonly sourceClaim: ResourceClaim | null;
  readonly destinationClaim: ResourceClaim | null;
  readonly blockers: readonly ResourceHandoffBlocker[];
  /** A failed handoff never claims that the source has been released. */
  readonly sourceRetained: boolean;
  readonly fenceEpoch?: number;
  readonly safeActions: readonly string[];
}

export interface NormalizedHandoffOptions {
  readonly fromSessionId: string;
  readonly toSessionId: string;
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly claimSetGeneration: number;
  readonly operationId: string;
}

const MAX_OPERATION_ID_LENGTH = 128;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_RESOURCE_LENGTH = 4_096;

/**
 * Validate one immutable registry snapshot. This function has no mutation or
 * scheduling authority and is safe to use before acquiring a repository lock.
 */
export function validateResourceHandoff(
  snapshot: ResourceHandoffSnapshot,
  options: HandoffResourcesOptions,
): ResourceHandoffValidation {
  const normalized = normalizeHandoffOptions(options);
  assertSnapshot(snapshot);
  const registry = snapshot.registry;
  const completed = registry.completedOperations?.find((entry) => entry.operationId === normalized.operationId);
  if (completed !== undefined) {
    const sameOperation =
      completed.fromSessionId === normalized.fromSessionId &&
      completed.toSessionId === normalized.toSessionId &&
      completed.resource === normalized.resource &&
      completed.mode === normalized.mode;
    if (!sameOperation) {
      return validation(
        normalized,
        registry.claimSetGeneration,
        "blocked",
        "OPERATION_REJECTED",
        null,
        null,
        [blocker("OPERATION_REJECTED", "Operation ID is already bound to a different handoff", normalized.resource)],
        ["inspect-handoff-operation"],
      );
    }
    return validation(
      normalized,
      registry.claimSetGeneration,
      "idempotent",
      "IDEMPOTENT",
      findClaim(registry.claims, normalized.fromSessionId, normalized.resource),
      findClaim(registry.claims, normalized.toSessionId, normalized.resource),
      [],
      ["retain-handoff-result"],
    );
  }

  if (normalized.claimSetGeneration !== registry.claimSetGeneration) {
    return validation(
      normalized,
      registry.claimSetGeneration,
      "blocked",
      "STALE_CLAIM_SET",
      null,
      null,
      [
        blocker(
          "STALE_CLAIM_SET",
          "Claim-set generation no longer matches the required CAS generation",
          normalized.resource,
        ),
      ],
      ["refresh-resource-claims"],
    );
  }

  const source = registry.sessions.find((session) => session.sessionId === normalized.fromSessionId);
  const destination = registry.sessions.find((session) => session.sessionId === normalized.toSessionId);
  if (source === undefined || destination === undefined) {
    const missing = source === undefined ? normalized.fromSessionId : normalized.toSessionId;
    return validation(
      normalized,
      registry.claimSetGeneration,
      "blocked",
      "SESSION_NOT_FOUND",
      null,
      null,
      [blocker("SESSION_NOT_FOUND", `Session was not found: ${missing}`, normalized.resource)],
      ["inspect-sessions"],
    );
  }

  const identityBlocker = validateSessionIdentities(registry, source, destination, normalized.resource);
  if (identityBlocker !== undefined) {
    return validation(
      normalized,
      registry.claimSetGeneration,
      "blocked",
      identityBlocker.code,
      null,
      null,
      [identityBlocker],
      ["refresh-session-identity"],
    );
  }
  if (source.state !== "active" || destination.state !== "active") {
    return validation(
      normalized,
      registry.claimSetGeneration,
      "blocked",
      "SESSION_NOT_ACTIVE",
      null,
      null,
      [
        blocker(
          "SESSION_NOT_ACTIVE",
          `Handoff requires active source and destination sessions (source=${source.state}, destination=${destination.state})`,
          normalized.resource,
        ),
      ],
      ["inspect-sessions", "retain-source-claim"],
    );
  }

  const sourceClaim = findClaim(registry.claims, normalized.fromSessionId, normalized.resource);
  if (sourceClaim === null) {
    return validation(
      normalized,
      registry.claimSetGeneration,
      "blocked",
      "MISSING_RESOURCE_CLAIM",
      null,
      findClaim(registry.claims, normalized.toSessionId, normalized.resource),
      [blocker("MISSING_RESOURCE_CLAIM", "Source does not own the exact resource claim", normalized.resource)],
      ["refresh-resource-claims", "retain-source-claim"],
    );
  }
  if (sourceClaim.repositoryId !== registry.repositoryId || sourceClaim.worktreePath !== source.worktreePath) {
    return validation(
      normalized,
      registry.claimSetGeneration,
      "blocked",
      "WORKTREE_MISMATCH",
      sourceClaim,
      null,
      [blocker("WORKTREE_MISMATCH", "Source claim identity does not match its session", normalized.resource)],
      ["refresh-session-identity", "retain-source-claim"],
    );
  }

  const destinationClaim = findClaim(registry.claims, normalized.toSessionId, normalized.resource);
  const overlappingDestinationClaims = registry.claims.filter(
    (claim) => claim.sessionId === normalized.toSessionId && claimsOverlap(claim, sourceClaim),
  );
  if (overlappingDestinationClaims.length > 0) {
    const conflict = overlappingDestinationClaims[0] as ResourceClaim;
    return validation(
      normalized,
      registry.claimSetGeneration,
      "blocked",
      "RESOURCE_CLAIM_CONFLICT",
      sourceClaim,
      destinationClaim,
      [
        blocker(
          "RESOURCE_CLAIM_CONFLICT",
          "Destination already owns an overlapping claim",
          normalized.resource,
          conflict.sessionId,
          conflict.claimId,
        ),
      ],
      ["release-destination-claim", "retain-source-claim"],
    );
  }

  const scopeBlocker = validateDestinationScope(destination, normalized.resource, normalized.mode);
  if (scopeBlocker !== undefined) {
    return validation(
      normalized,
      registry.claimSetGeneration,
      "blocked",
      scopeBlocker.code,
      sourceClaim,
      null,
      [scopeBlocker],
      ["request-scope-expansion", "retain-source-claim"],
    );
  }

  return validation(
    normalized,
    registry.claimSetGeneration,
    "allowed",
    "ALLOWED",
    sourceClaim,
    null,
    [],
    ["fence-source-execution", "commit-resource-handoff"],
  );
}

/**
 * Execute the bounded handoff lifecycle. Registry reads and the final commit
 * are delegated to the authority; quiescence is awaited between them, so the
 * caller cannot accidentally hold RepositoryLock while executions drain.
 */
export async function handoffResources(
  authority: ResourceHandoffAuthority,
  execution: ResourceHandoffFenceController,
  options: HandoffResourcesOptions,
): Promise<ResourceHandoffResult> {
  const normalized = normalizeHandoffOptions(options);
  const initial = await authority.readResourceHandoffSnapshot();
  const initialValidation = validateResourceHandoff(initial, options);
  if (initialValidation.status === "idempotent") {
    return resultFromValidation(initialValidation, initialValidation.claimSetGeneration, true);
  }
  if (initialValidation.status !== "allowed") {
    return resultFromValidation(initialValidation, initialValidation.claimSetGeneration, false);
  }

  let fence: ResourceHandoffFence;
  try {
    fence = await execution.fence({
      sessionId: normalized.fromSessionId,
      operationId: normalized.operationId,
    });
  } catch (error: unknown) {
    return unresolvedResult(
      normalized,
      initial.registry.claimSetGeneration,
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Source execution fence could not be established",
      undefined,
    );
  }
  if (
    fence.sessionId !== normalized.fromSessionId ||
    fence.operationId !== normalized.operationId ||
    !Number.isSafeInteger(fence.epoch) ||
    fence.epoch < 0 ||
    fence.accepting !== false ||
    fence.status !== "fenced"
  ) {
    return unresolvedResult(
      normalized,
      initial.registry.claimSetGeneration,
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Execution fence evidence is missing or inconsistent",
      typeof fence?.epoch === "number" ? fence.epoch : undefined,
    );
  }

  let quiescence: ResourceHandoffQuiescence;
  try {
    quiescence = await execution.awaitQuiescence(fence);
  } catch (error: unknown) {
    return unresolvedResult(
      normalized,
      initial.registry.claimSetGeneration,
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Managed execution drain evidence is unavailable",
      fence.epoch,
    );
  }
  if (!isQuiescenceFor(fence, quiescence)) {
    return unresolvedResult(
      normalized,
      initial.registry.claimSetGeneration,
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Managed execution drain evidence does not match the fence epoch",
      fence.epoch,
    );
  }
  if (quiescence.status === "active") {
    return blockedResult(
      normalized,
      initial.registry.claimSetGeneration,
      "OPERATION_REJECTED",
      "Managed execution is still active; source claim is retained",
      fence.epoch,
      quiescence.activeExecutionIds,
    );
  }
  if (
    quiescence.status === "unknown" ||
    quiescence.activeExecutionIds.length > 0 ||
    quiescence.unknownExecutionIds.length > 0
  ) {
    return unresolvedResult(
      normalized,
      initial.registry.claimSetGeneration,
      "PHYSICAL_OBSERVATION_UNAVAILABLE",
      "Unknown or unproven managed execution remains",
      fence.epoch,
      quiescence.unknownExecutionIds,
    );
  }

  const current = await authority.readResourceHandoffSnapshot();
  const currentValidation = validateResourceHandoff(current, options);
  if (current.registry.claimSetGeneration !== initial.registry.claimSetGeneration) {
    return blockedResult(
      normalized,
      current.registry.claimSetGeneration,
      "STALE_CLAIM_SET",
      "Claim-set generation changed while the source was draining",
      fence.epoch,
    );
  }
  if (currentValidation.status === "idempotent") {
    return resultFromValidation(currentValidation, current.registry.claimSetGeneration, true, fence.epoch);
  }
  if (currentValidation.status !== "allowed") {
    return resultFromValidation(currentValidation, current.registry.claimSetGeneration, false, fence.epoch);
  }

  let committed: ResourceHandoffCommitResult;
  try {
    committed = await authority.commitResourceHandoff({
      options,
      normalized,
      snapshot: current,
      fence,
      quiescence,
    });
  } catch (error: unknown) {
    const registryError = error instanceof SessionRegistryError ? error : undefined;
    const code: ResourceHandoffCode =
      registryError?.code === "REGISTRY_DURABILITY_UNCERTAIN"
        ? "REGISTRY_DURABILITY_UNCERTAIN"
        : registryError?.code === "STALE_CLAIM_SET"
          ? "STALE_CLAIM_SET"
          : registryError?.code === "RESOURCE_CLAIM_CONFLICT"
            ? "RESOURCE_CLAIM_CONFLICT"
            : "PHYSICAL_OBSERVATION_UNAVAILABLE";
    return code === "STALE_CLAIM_SET" || code === "RESOURCE_CLAIM_CONFLICT"
      ? blockedResult(
          normalized,
          current.registry.claimSetGeneration,
          code,
          registryError?.message ?? "Atomic handoff commit was rejected",
          fence.epoch,
        )
      : unresolvedResult(
          normalized,
          current.registry.claimSetGeneration,
          code,
          registryError?.message ?? "Atomic handoff durability could not be proven",
          fence.epoch,
        );
  }
  assertCommitResult(committed, normalized, initial.registry.claimSetGeneration);
  return {
    schemaVersion: RESOURCE_HANDOFF_SCHEMA_VERSION,
    operation: RESOURCE_HANDOFF_OPERATION,
    status: committed.status,
    code: committed.status === "idempotent" ? "IDEMPOTENT" : "ALLOWED",
    idempotent: committed.status === "idempotent",
    operationId: normalized.operationId,
    fromSessionId: normalized.fromSessionId,
    toSessionId: normalized.toSessionId,
    resource: normalized.resource,
    mode: normalized.mode,
    previousClaimSetGeneration: initial.registry.claimSetGeneration,
    claimSetGeneration: committed.claimSetGeneration,
    sourceClaim: committed.sourceClaim,
    destinationClaim: committed.destinationClaim,
    blockers: [],
    sourceRetained: committed.status === "idempotent" && committed.sourceClaim !== null,
    fenceEpoch: fence.epoch,
    safeActions: ["record-handoff-result"],
  };
}

/** Stable fallback operation identity for callers that do not provide one. */
export function canonicalResourceHandoffOperationId(
  fromSessionId: string,
  toSessionId: string,
  resource: string,
  mode: ResourceClaimMode,
): string {
  return `handoff:${fromSessionId}:${toSessionId}:${resource}:${mode}`;
}

function normalizeHandoffOptions(options: HandoffResourcesOptions): NormalizedHandoffOptions {
  if (options === null || typeof options !== "object") {
    throw new SessionRegistryError("INVALID_OPERATION", "Resource handoff options must be an object");
  }
  const fromSessionId = options.fromSessionId ?? options.from_session_id;
  const toSessionId = options.toSessionId ?? options.to_session_id;
  const expected =
    options.ifGeneration ??
    options.if_generation ??
    options.expectedClaimSetGeneration ??
    options.expected_claim_set_generation;
  const operationId = options.operationId ?? options.operation_id;
  assertBoundedText(fromSessionId, "from session ID", MAX_SESSION_ID_LENGTH);
  assertBoundedText(toSessionId, "to session ID", MAX_SESSION_ID_LENGTH);
  if (fromSessionId === toSessionId) {
    throw new SessionRegistryError("INVALID_OPERATION", "Resource handoff source and destination must differ");
  }
  if (!Number.isSafeInteger(expected) || (expected as number) < 0) {
    throw new SessionRegistryError("INVALID_OPERATION", "Resource handoff requires a non-negative claim generation");
  }
  if (
    typeof options.resource !== "string" ||
    options.resource.length === 0 ||
    options.resource.length > MAX_RESOURCE_LENGTH
  ) {
    throw new SessionRegistryError("INVALID_RESOURCE", "Resource handoff resource is invalid");
  }
  if (/[*?]/u.test(options.resource)) {
    throw new SessionRegistryError("INVALID_RESOURCE", "Resource handoff requires one concrete resource");
  }
  try {
    assertCanonicalClaimResource(options.resource);
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    throw new SessionRegistryError("INVALID_RESOURCE", "Resource handoff resource is not canonical", {}, error);
  }
  if (!["read", "write", "exclusive-write"].includes(options.mode)) {
    throw new SessionRegistryError("INVALID_OPERATION", "Resource handoff mode is unsupported");
  }
  const normalizedOperationId =
    operationId ??
    canonicalResourceHandoffOperationId(fromSessionId as string, toSessionId as string, options.resource, options.mode);
  assertBoundedText(normalizedOperationId, "handoff operation ID", MAX_OPERATION_ID_LENGTH);
  return Object.freeze({
    fromSessionId: fromSessionId as string,
    toSessionId: toSessionId as string,
    resource: options.resource,
    mode: options.mode,
    claimSetGeneration: expected as number,
    operationId: normalizedOperationId,
  });
}

function assertSnapshot(snapshot: ResourceHandoffSnapshot): void {
  if (
    snapshot === null ||
    typeof snapshot !== "object" ||
    snapshot.schemaVersion !== RESOURCE_HANDOFF_SCHEMA_VERSION ||
    snapshot.operation !== RESOURCE_HANDOFF_OPERATION
  ) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Resource handoff snapshot contract is unsupported");
  }
  const registry = snapshot.registry;
  if (registry === null || typeof registry !== "object") {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Resource handoff snapshot has no registry evidence");
  }
  if (
    typeof registry.repositoryId !== "string" ||
    registry.repositoryId.length === 0 ||
    !Number.isSafeInteger(registry.claimSetGeneration) ||
    registry.claimSetGeneration < 0 ||
    !Array.isArray(registry.sessions) ||
    !Array.isArray(registry.claims)
  ) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Resource handoff snapshot registry evidence is invalid");
  }
  for (const session of registry.sessions) {
    if (
      !isRecord(session) ||
      !boundedText(session.sessionId, MAX_SESSION_ID_LENGTH) ||
      !boundedText(session.repositoryId, MAX_SESSION_ID_LENGTH) ||
      !boundedText(session.worktreePath, MAX_RESOURCE_LENGTH) ||
      !boundedText(session.state, MAX_SESSION_ID_LENGTH)
    ) {
      throw new SessionRegistryError("REGISTRY_CORRUPT", "Resource handoff snapshot contains an invalid session");
    }
  }
  for (const claim of registry.claims) {
    if (
      !isRecord(claim) ||
      !boundedText(claim.claimId, MAX_OPERATION_ID_LENGTH) ||
      !boundedText(claim.sessionId, MAX_SESSION_ID_LENGTH) ||
      !boundedText(claim.repositoryId, MAX_SESSION_ID_LENGTH) ||
      !boundedText(claim.worktreePath, MAX_RESOURCE_LENGTH) ||
      !boundedText(claim.resource, MAX_RESOURCE_LENGTH)
    ) {
      throw new SessionRegistryError("REGISTRY_CORRUPT", "Resource handoff snapshot contains an invalid claim");
    }
  }
  if (registry.completedOperations !== undefined) {
    if (!Array.isArray(registry.completedOperations)) {
      throw new SessionRegistryError("REGISTRY_CORRUPT", "Resource handoff operation history is invalid");
    }
    const operationIds = new Set<string>();
    for (const operation of registry.completedOperations) {
      if (
        !isRecord(operation) ||
        !boundedText(operation.operationId, MAX_OPERATION_ID_LENGTH) ||
        !boundedText(operation.fromSessionId, MAX_SESSION_ID_LENGTH) ||
        !boundedText(operation.toSessionId, MAX_SESSION_ID_LENGTH) ||
        !boundedText(operation.resource, MAX_RESOURCE_LENGTH) ||
        operationIds.has(operation.operationId)
      ) {
        throw new SessionRegistryError("REGISTRY_CORRUPT", "Resource handoff operation history is invalid");
      }
      operationIds.add(operation.operationId);
    }
  }
}

function validateSessionIdentities(
  registry: ResourceHandoffRegistrySnapshot,
  source: ResourceHandoffSession,
  destination: ResourceHandoffSession,
  resource: string,
): ResourceHandoffBlocker | undefined {
  if (source.repositoryId !== registry.repositoryId || destination.repositoryId !== registry.repositoryId) {
    return blocker("REPOSITORY_MISMATCH", "Handoff sessions do not share repository identity", resource);
  }
  if (source.worktreePath.length === 0 || destination.worktreePath.length === 0) {
    return blocker("WORKTREE_MISMATCH", "Handoff sessions must have concrete worktree identities", resource);
  }
  if (source.worktreePath === destination.worktreePath) {
    return blocker("WORKTREE_MISMATCH", "Handoff source and destination worktrees must differ", resource);
  }
  return undefined;
}

function validateDestinationScope(
  destination: ResourceHandoffSession,
  resource: string,
  mode: ResourceClaimMode,
): ResourceHandoffBlocker | undefined {
  const scope = destination.maxScope;
  if (
    scope === undefined ||
    scope === null ||
    !Array.isArray(scope.readOnly) ||
    !Array.isArray(scope.write) ||
    !Array.isArray(scope.create) ||
    !Array.isArray(scope.delete) ||
    !Array.isArray(scope.deny)
  ) {
    return blocker("OPERATION_REJECTED", "Destination maximum scope is unavailable", resource);
  }
  if (scope.deny.some((selector) => selectorMatches(selector, resource))) {
    return blocker("OPERATION_REJECTED", "Destination maximum scope denies the resource", resource);
  }
  const selectors = mode === "read" ? scope.readOnly : scope.write;
  if (!selectors.some((selector) => selectorMatches(selector, resource))) {
    return blocker(
      "INSUFFICIENT_CLAIM_MODE",
      "Destination maximum scope does not authorize the requested mode",
      resource,
    );
  }
  return undefined;
}

function selectorMatches(selector: string, resource: string): boolean {
  return resourceMatchesClaim({ resource: selector }, resource);
}

function findClaim(claims: readonly ResourceClaim[], sessionId: string, resource: string): ResourceClaim | null {
  const matches = claims.filter((claim) => claim.sessionId === sessionId && claim.resource === resource);
  if (matches.length > 1) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Resource handoff snapshot contains duplicate exact claims", {
      sessionId,
      resource,
    });
  }
  return matches[0] ?? null;
}

function validation(
  normalized: NormalizedHandoffOptions,
  generation: number,
  status: ResourceHandoffValidationStatus,
  code: ResourceHandoffCode,
  sourceClaim: ResourceClaim | null,
  destinationClaim: ResourceClaim | null,
  blockers: readonly ResourceHandoffBlocker[],
  safeActions: readonly string[],
): ResourceHandoffValidation {
  return Object.freeze({
    schemaVersion: RESOURCE_HANDOFF_SCHEMA_VERSION,
    operation: RESOURCE_HANDOFF_OPERATION,
    status,
    code,
    operationId: normalized.operationId,
    fromSessionId: normalized.fromSessionId,
    toSessionId: normalized.toSessionId,
    resource: normalized.resource,
    mode: normalized.mode,
    claimSetGeneration: generation,
    sourceClaim,
    destinationClaim,
    blockers: Object.freeze([...blockers]),
    sourceRetained: true as const,
    safeActions: Object.freeze([...safeActions]),
  });
}

function resultFromValidation(
  validationResult: ResourceHandoffValidation,
  generation: number,
  idempotent: boolean,
  fenceEpoch?: number,
): ResourceHandoffResult {
  const status: ResourceHandoffStatus =
    validationResult.status === "idempotent"
      ? "idempotent"
      : validationResult.status === "allowed"
        ? "transferred"
        : validationResult.status;
  return {
    schemaVersion: RESOURCE_HANDOFF_SCHEMA_VERSION,
    operation: RESOURCE_HANDOFF_OPERATION,
    status,
    code: validationResult.code,
    idempotent,
    operationId: validationResult.operationId,
    fromSessionId: validationResult.fromSessionId,
    toSessionId: validationResult.toSessionId,
    resource: validationResult.resource,
    mode: validationResult.mode,
    previousClaimSetGeneration: generation,
    claimSetGeneration: generation,
    sourceClaim: validationResult.sourceClaim,
    destinationClaim: validationResult.destinationClaim,
    blockers: validationResult.blockers,
    sourceRetained: validationResult.sourceRetained,
    ...(fenceEpoch === undefined ? {} : { fenceEpoch }),
    safeActions: validationResult.safeActions,
  };
}

function blockedResult(
  normalized: NormalizedHandoffOptions,
  generation: number,
  code: ResourceHandoffCode,
  reason: string,
  fenceEpoch?: number,
  executionIds: readonly string[] = [],
): ResourceHandoffResult {
  const details: RegistryErrorDetails = executionIds.length === 0 ? {} : { executionIds: [...executionIds] };
  return {
    schemaVersion: RESOURCE_HANDOFF_SCHEMA_VERSION,
    operation: RESOURCE_HANDOFF_OPERATION,
    status: "blocked",
    code,
    idempotent: false,
    operationId: normalized.operationId,
    fromSessionId: normalized.fromSessionId,
    toSessionId: normalized.toSessionId,
    resource: normalized.resource,
    mode: normalized.mode,
    previousClaimSetGeneration: generation,
    claimSetGeneration: generation,
    sourceClaim: null,
    destinationClaim: null,
    blockers: [
      {
        code,
        reason: `${reason}${Object.keys(details).length === 0 ? "" : ` (${JSON.stringify(details)})`}`,
        ownerSessionId: normalized.fromSessionId,
        resource: normalized.resource,
      },
    ],
    sourceRetained: true,
    ...(fenceEpoch === undefined ? {} : { fenceEpoch }),
    safeActions: ["retain-source-claim", "refresh-resource-handoff"],
  };
}

function unresolvedResult(
  normalized: NormalizedHandoffOptions,
  generation: number,
  code: ResourceHandoffCode,
  reason: string,
  fenceEpoch?: number,
  executionIds: readonly string[] = [],
): ResourceHandoffResult {
  const result = blockedResult(normalized, generation, code, reason, fenceEpoch, executionIds);
  return { ...result, status: "unresolved", safeActions: ["retain-source-claim", "refresh-execution-evidence"] };
}

function isQuiescenceFor(fence: ResourceHandoffFence, value: ResourceHandoffQuiescence): boolean {
  return (
    value !== null &&
    typeof value === "object" &&
    value.sessionId === fence.sessionId &&
    value.operationId === fence.operationId &&
    value.epoch === fence.epoch &&
    ["quiescent", "active", "unknown"].includes(value.status) &&
    Array.isArray(value.activeExecutionIds) &&
    Array.isArray(value.unknownExecutionIds)
  );
}

function assertCommitResult(
  result: ResourceHandoffCommitResult,
  normalized: NormalizedHandoffOptions,
  initialGeneration: number,
): void {
  const destinationMatches =
    result.destinationClaim !== null &&
    result.destinationClaim.sessionId === normalized.toSessionId &&
    result.destinationClaim.resource === normalized.resource &&
    result.destinationClaim.mode === normalized.mode;
  if (
    result === null ||
    typeof result !== "object" ||
    !["transferred", "idempotent"].includes(result.status) ||
    result.operationId !== normalized.operationId ||
    !Number.isSafeInteger(result.claimSetGeneration) ||
    result.claimSetGeneration < normalized.claimSetGeneration ||
    (result.status === "transferred" && (result.sourceClaim !== null || !destinationMatches)) ||
    (result.status === "transferred" && result.claimSetGeneration !== initialGeneration + 1)
  ) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Atomic handoff authority returned invalid commit evidence");
  }
}

function blocker(
  code: ResourceHandoffCode,
  reason: string,
  resource: string,
  ownerSessionId?: string,
  ownerClaimId?: string,
): ResourceHandoffBlocker {
  return {
    code,
    reason,
    resource,
    ...(ownerSessionId === undefined ? {} : { ownerSessionId }),
    ...(ownerClaimId === undefined ? {} : { ownerClaimId }),
  };
}

function assertBoundedText(value: unknown, label: string, maxLength: number): asserts value is string {
  if (!boundedText(value, maxLength)) {
    throw new SessionRegistryError("INVALID_OPERATION", `${label} is invalid`);
  }
}

function boundedText(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= maxLength && !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
