import { claimsConflict, resourceMatchesClaim, type ResourceClaim, type ResourceClaimMode } from "./resource-claims.js";

/** The schema generation of the transport-neutral coordination projection. */
export const RESOURCE_COORDINATION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const RESOURCE_COORDINATION_SNAPSHOT_CONTRACT_ID = "resource-coordination-snapshot" as const;
export const RESOURCE_COORDINATION_SNAPSHOT_CONTRACT_VERSION = 1 as const;

/** A bounded session fact supplied by the session authority. */
export interface CoordinationSession {
  readonly sessionId: string;
  readonly worktreePath: string;
  readonly state: string;
  readonly branchName?: string;
  readonly repositoryId?: string;
}

/** A requested access declaration, not a mutation instruction. */
export interface CoordinationResourceIntent {
  readonly sessionId: string;
  readonly resource: string;
  readonly mode: ResourceClaimMode;
}

/** Git-observed path state. File contents are intentionally not accepted. */
export interface CoordinationObservedChange {
  readonly sessionId: string;
  readonly resource: string;
  readonly state: "clean" | "modified" | "unknown";
  readonly integrated: boolean | "unknown";
}

/** Mergeability is evidence, not an ownership or mutation authority. */
export interface CoordinationMergeabilityEvidence {
  readonly sessionId: string;
  readonly resource?: string;
  readonly state: "mergeable" | "conflicting" | "unknown";
}

export interface CoordinationRegistryInput {
  readonly repositoryId: string;
  readonly claimSetGeneration: number;
  readonly registryRevision?: number;
  readonly sessions: readonly CoordinationSession[];
  readonly claims: readonly ResourceClaim[];
}

export interface CoordinationContractInput {
  readonly resourceIntents?: readonly CoordinationResourceIntent[];
  readonly observedChanges?: readonly CoordinationObservedChange[];
  readonly mergeability?: readonly CoordinationMergeabilityEvidence[];
  /** A false value means that absence of a blocker cannot prove no conflict. */
  readonly complete?: boolean;
  readonly incompleteReasons?: readonly string[];
}

export interface ResourceCoordinationSnapshotInput {
  readonly registry: CoordinationRegistryInput;
  readonly contract: CoordinationContractInput;
  readonly bounds?: ResourceCoordinationSnapshotBounds;
}

export interface ResourceCoordinationSnapshotBounds {
  readonly maxResources?: number;
  readonly maxParticipantsPerResource?: number;
  readonly maxBlockersPerResource?: number;
}

export type CoordinationPermission = "allowed" | "denied" | "unknown";
export type CoordinationConflict = "none" | "conflict" | "unknown";
export type CoordinationPhysicalModification = "clean" | "modified" | "unknown";
export type CoordinationMergeability = "mergeable" | "conflicting" | "unknown";
export type CoordinationClassification = "available" | "blocked" | "unresolved";

export interface ResourceCoordinationParticipant {
  readonly sessionId: string;
  readonly worktreePath: string | null;
  readonly state: string | null;
  readonly claimId: string | null;
  readonly mode: ResourceClaimMode | null;
  readonly requestedMode: ResourceClaimMode | null;
  readonly observedChange: "clean" | "modified" | "unknown" | null;
  readonly integrated: boolean | "unknown" | null;
}

export type ResourceWaitReason =
  | {
      readonly kind: "claim-conflict";
      readonly ownerSessionId: string;
      readonly ownerClaimId: string;
      readonly resource: string;
      readonly requestedMode: ResourceClaimMode;
      readonly currentMode: ResourceClaimMode;
      readonly releaseCondition: "owner-releases-claim" | "owner-changes-claim" | "owner-session-closes";
    }
  | {
      readonly kind: "incomplete-evidence";
      readonly ownerSessionId: null;
      readonly ownerClaimId: null;
      readonly resource: string;
      readonly requestedMode: ResourceClaimMode | null;
      readonly currentMode: ResourceClaimMode | null;
      readonly releaseCondition: "refresh-authoritative-evidence";
    };

/**
 * Closed, machine-readable actions. There is deliberately no free-form
 * safe_actions string list: consumers must handle every member explicitly.
 */
export type CoordinationNextAction =
  | {
      readonly actionId: "wait-for-owner-release";
      readonly kind: "wait";
      readonly resource: string;
      readonly ownerSessionId: string;
      readonly ownerClaimId: string;
      readonly requestedMode: ResourceClaimMode;
      readonly currentMode: ResourceClaimMode;
      readonly releaseCondition: "owner-releases-claim";
    }
  | {
      readonly actionId: "wait-for-owner-change";
      readonly kind: "wait";
      readonly resource: string;
      readonly ownerSessionId: string;
      readonly ownerClaimId: string;
      readonly requestedMode: ResourceClaimMode;
      readonly currentMode: ResourceClaimMode;
      readonly releaseCondition: "owner-changes-claim";
    }
  | {
      readonly actionId: "wait-for-owner-close";
      readonly kind: "wait";
      readonly resource: string;
      readonly ownerSessionId: string;
      readonly ownerClaimId: string;
      readonly requestedMode: ResourceClaimMode;
      readonly currentMode: ResourceClaimMode;
      readonly releaseCondition: "owner-session-closes";
    }
  | {
      readonly actionId: "refresh-coordination-evidence";
      readonly kind: "refresh";
      readonly resource: string;
    }
  | {
      readonly actionId: "inspect-observed-changes";
      readonly kind: "inspect";
      readonly resource: string;
      readonly sessionId: string;
    }
  | {
      readonly actionId: "proceed-without-claim";
      readonly kind: "proceed";
      readonly resource: string;
    }
  | {
      readonly actionId: "acquire-claim";
      readonly kind: "acquire";
      readonly resource: string;
      readonly requestedMode: "write" | "exclusive-write";
    };

export interface ResourceCoordinationRecord {
  readonly resource: string;
  readonly participants: readonly ResourceCoordinationParticipant[];
  readonly requestedModes: readonly ResourceClaimMode[];
  readonly permission: CoordinationPermission;
  readonly conflict: CoordinationConflict;
  readonly physicalModification: CoordinationPhysicalModification;
  readonly mergeability: CoordinationMergeability;
  readonly classification: CoordinationClassification;
  readonly blockers: readonly ResourceWaitReason[];
  readonly nextActions: readonly CoordinationNextAction[];
}

export interface ResourceCoordinationSnapshotContract {
  readonly id: typeof RESOURCE_COORDINATION_SNAPSHOT_CONTRACT_ID;
  readonly version: typeof RESOURCE_COORDINATION_SNAPSHOT_CONTRACT_VERSION;
  readonly persisted: false;
  readonly mutation: false;
  readonly fileContents: false;
}

export interface ResourceCoordinationSnapshotRegistry {
  readonly repositoryId: string;
  readonly claimSetGeneration: number;
  readonly registryRevision: number | null;
}

export interface ResourceCoordinationSnapshot {
  readonly schemaVersion: typeof RESOURCE_COORDINATION_SNAPSHOT_SCHEMA_VERSION;
  readonly registry: ResourceCoordinationSnapshotRegistry;
  readonly contract: ResourceCoordinationSnapshotContract;
  readonly complete: boolean;
  readonly incompleteReasons: readonly string[];
  readonly truncated: boolean;
  readonly resources: readonly ResourceCoordinationRecord[];
}

interface ResourceFacts {
  readonly resource: string;
  readonly claims: ResourceClaim[];
  readonly intents: CoordinationResourceIntent[];
  readonly changes: CoordinationObservedChange[];
  readonly mergeability: CoordinationMergeabilityEvidence[];
}

interface ResourceProjection {
  readonly record: ResourceCoordinationRecord;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
}

interface ParticipantProjection {
  readonly participants: readonly ResourceCoordinationParticipant[];
  readonly truncated: boolean;
}

const DEFAULT_MAX_RESOURCES = 1_000;
const DEFAULT_MAX_PARTICIPANTS = 1_000;
const DEFAULT_MAX_BLOCKERS = 1_000;

/**
 * Compose a deterministic, read-only resource coordination projection.
 *
 * The input is a factual snapshot from existing authorities. This function
 * neither reads nor writes the registry, Git, worktrees, or session state.
 */
export function projectResourceCoordinationSnapshot(
  input: ResourceCoordinationSnapshotInput,
): ResourceCoordinationSnapshot {
  assertInput(input);
  const bounds = normalizeBounds(input.bounds);
  const evidence = input.contract;
  const facts = collectResourceFacts(input.registry, evidence);
  const orderedResources = [...facts.keys()].sort(compareStrings);
  const resourceTruncated = orderedResources.length > bounds.maxResources;
  const projections = orderedResources
    .slice(0, bounds.maxResources)
    .map((resource) => projectResource(facts.get(resource) as ResourceFacts, input.registry, evidence, bounds));
  const resources = projections.map((projection) => projection.record);
  const truncated = resourceTruncated || projections.some((projection) => projection.truncated);

  const incompleteReasons = new Set<string>(evidence.incompleteReasons ?? []);
  if (evidence.complete !== true) incompleteReasons.add("INCOMPLETE_AUTHORITY_EVIDENCE");
  if (resourceTruncated) incompleteReasons.add("RESOURCE_BOUND_EXCEEDED");
  if (projections.some((projection) => projection.truncationReasons.includes("BLOCKER_BOUND_EXCEEDED"))) {
    incompleteReasons.add("BLOCKER_BOUND_EXCEEDED");
  }
  if (projections.some((projection) => projection.truncationReasons.includes("PARTICIPANT_BOUND_EXCEEDED"))) {
    incompleteReasons.add("PARTICIPANT_BOUND_EXCEEDED");
  }
  const complete = evidence.complete === true && !truncated && incompleteReasons.size === 0;

  return freezeSnapshot({
    schemaVersion: RESOURCE_COORDINATION_SNAPSHOT_SCHEMA_VERSION,
    registry: {
      repositoryId: input.registry.repositoryId,
      claimSetGeneration: input.registry.claimSetGeneration,
      registryRevision: input.registry.registryRevision ?? null,
    },
    contract: {
      id: RESOURCE_COORDINATION_SNAPSHOT_CONTRACT_ID,
      version: RESOURCE_COORDINATION_SNAPSHOT_CONTRACT_VERSION,
      persisted: false,
      mutation: false,
      fileContents: false,
    },
    complete,
    incompleteReasons: [...incompleteReasons].sort(compareStrings),
    truncated,
    resources,
  });
}

/** Serialize the projection with stable key ordering for transport or tests. */
export function serializeResourceCoordinationSnapshot(snapshot: ResourceCoordinationSnapshot): string {
  assertSnapshot(snapshot);
  return stableJson(snapshot);
}

function projectResource(
  facts: ResourceFacts,
  registry: CoordinationRegistryInput,
  evidence: CoordinationContractInput,
  bounds: Required<ResourceCoordinationSnapshotBounds>,
): ResourceProjection {
  const intents = [...facts.intents].sort(compareIntent);
  const claims = [...facts.claims].sort(compareClaim);
  const changes = [...facts.changes].sort(compareChange);
  const mergeability = [...facts.mergeability].sort(compareMergeability);
  const requestedModes = uniqueModes(intents.map((intent) => intent.mode));
  const authorityComplete = evidence.complete === true && (evidence.incompleteReasons?.length ?? 0) === 0;
  const claimBlockers = findClaimBlockers(claims, intents, facts.resource);
  const blockers = [...claimBlockers];
  if (!authorityComplete && claimBlockers.length === 0) {
    blockers.push({
      kind: "incomplete-evidence",
      ownerSessionId: null,
      ownerClaimId: null,
      resource: facts.resource,
      requestedMode: requestedModes[0] ?? null,
      currentMode: claims[0]?.mode ?? null,
      releaseCondition: "refresh-authoritative-evidence",
    });
  }
  const blockerTruncated = blockers.length > bounds.maxBlockersPerResource;
  const boundedBlockers = blockers.slice(0, bounds.maxBlockersPerResource);
  const conflict: CoordinationConflict = claimBlockers.length > 0 ? "conflict" : authorityComplete ? "none" : "unknown";
  const permission: CoordinationPermission =
    claimBlockers.length > 0 ? "denied" : authorityComplete ? "allowed" : "unknown";
  const physicalModification = projectPhysicalModification(changes);
  const projectedMergeability = projectMergeability(mergeability);
  const participantProjection = projectParticipants(facts, registry.sessions, bounds.maxParticipantsPerResource);
  const participants = participantProjection.participants;
  const classification: CoordinationClassification =
    conflict === "conflict" || permission === "denied"
      ? "blocked"
      : conflict === "unknown" ||
          permission === "unknown" ||
          physicalModification === "unknown" ||
          projectedMergeability === "unknown" ||
          blockerTruncated ||
          participantProjection.truncated
        ? "unresolved"
        : "available";
  const nextActions = projectNextActions(
    facts.resource,
    boundedBlockers,
    participants,
    requestedModes,
    classification,
    authorityComplete && !blockerTruncated && !participantProjection.truncated,
  );

  return Object.freeze({
    record: Object.freeze({
      resource: facts.resource,
      participants,
      requestedModes,
      permission,
      conflict,
      physicalModification,
      mergeability: projectedMergeability,
      classification,
      blockers: Object.freeze(boundedBlockers),
      nextActions: Object.freeze(nextActions),
    }),
    truncated: blockerTruncated || participantProjection.truncated,
    truncationReasons: Object.freeze([
      ...(blockerTruncated ? ["BLOCKER_BOUND_EXCEEDED"] : []),
      ...(participantProjection.truncated ? ["PARTICIPANT_BOUND_EXCEEDED"] : []),
    ]),
  });
}

function collectResourceFacts(
  registry: CoordinationRegistryInput,
  evidence: CoordinationContractInput,
): Map<string, ResourceFacts> {
  const facts = new Map<string, ResourceFacts>();
  const ensure = (resource: string): ResourceFacts => {
    const current = facts.get(resource);
    if (current !== undefined) return current;
    const created: ResourceFacts = { resource, claims: [], intents: [], changes: [], mergeability: [] };
    facts.set(resource, created);
    return created;
  };
  for (const claim of registry.claims) ensure(claim.resource).claims.push(claim);
  for (const intent of evidence.resourceIntents ?? []) ensure(intent.resource).intents.push(intent);
  for (const change of evidence.observedChanges ?? []) ensure(change.resource).changes.push(change);
  for (const item of evidence.mergeability ?? []) {
    if (item.resource !== undefined) ensure(item.resource).mergeability.push(item);
    else {
      for (const change of evidence.observedChanges ?? []) {
        if (change.sessionId === item.sessionId) ensure(change.resource).mergeability.push(item);
      }
    }
  }

  // A glob claim can cover a concrete evidence resource. Keep the concrete
  // resource record and add the matching claim without expanding the glob.
  for (const resource of [...facts.keys()]) {
    const current = facts.get(resource) as ResourceFacts;
    for (const claim of registry.claims) {
      if (claim.resource !== resource && resourceMatchesClaim(claim, resource) && !current.claims.includes(claim)) {
        current.claims.push(claim);
      }
    }
  }
  return facts;
}

function findClaimBlockers(
  claims: readonly ResourceClaim[],
  intents: readonly CoordinationResourceIntent[],
  resource: string,
): ResourceWaitReason[] {
  const blockers: ResourceWaitReason[] = [];
  const requested = intents.length === 0 ? [] : intents;
  for (const intent of requested) {
    for (const claim of claims) {
      if (claim.sessionId === intent.sessionId || !resourceMatchesClaim(claim, resource)) continue;
      if (!claimsConflict(claim, claimForIntent(intent, claim), undefined)) continue;
      blockers.push({
        kind: "claim-conflict",
        ownerSessionId: claim.sessionId,
        ownerClaimId: claim.claimId,
        resource,
        requestedMode: intent.mode,
        currentMode: claim.mode,
        releaseCondition: releaseConditionFor(claim.mode, intent.mode),
      });
    }
  }
  // Existing incompatible claims are also a conflict even when no new intent
  // is present. This keeps the projection truthful for parked sessions.
  for (let left = 0; left < claims.length; left += 1) {
    for (let right = left + 1; right < claims.length; right += 1) {
      const first = claims[left] as ResourceClaim;
      const second = claims[right] as ResourceClaim;
      if (first.sessionId === second.sessionId || !claimsConflict(first, second, undefined)) continue;
      blockers.push({
        kind: "claim-conflict",
        ownerSessionId: first.sessionId,
        ownerClaimId: first.claimId,
        resource,
        requestedMode: second.mode,
        currentMode: first.mode,
        releaseCondition: releaseConditionFor(first.mode, second.mode),
      });
    }
  }
  return dedupeWaitReasons(blockers);
}

function claimForIntent(intent: CoordinationResourceIntent, owner: ResourceClaim): ResourceClaim {
  return {
    schemaVersion: owner.schemaVersion,
    claimId: `intent:${intent.sessionId}:${intent.resource}:${intent.mode}`,
    sessionId: intent.sessionId,
    repositoryId: owner.repositoryId,
    worktreePath: owner.worktreePath,
    resource: intent.resource,
    mode: intent.mode,
    createdAt: owner.createdAt,
    updatedAt: owner.updatedAt,
  };
}

function projectParticipants(
  facts: ResourceFacts,
  sessions: readonly CoordinationSession[],
  maxParticipants: number,
): ParticipantProjection {
  const sessionById = new Map(sessions.map((session) => [session.sessionId, session]));
  const rows: ResourceCoordinationParticipant[] = [];
  const keys = new Set<string>();
  const push = (row: ResourceCoordinationParticipant): void => {
    const key = `${row.sessionId}\u0000${row.claimId ?? ""}\u0000${row.requestedMode ?? ""}`;
    if (keys.has(key)) return;
    keys.add(key);
    rows.push(row);
  };
  for (const claim of facts.claims) {
    const session = sessionById.get(claim.sessionId);
    const intent = facts.intents.find((candidate) => candidate.sessionId === claim.sessionId);
    const change = facts.changes.find((candidate) => candidate.sessionId === claim.sessionId);
    push({
      sessionId: claim.sessionId,
      worktreePath: session?.worktreePath ?? claim.worktreePath ?? null,
      state: session?.state ?? null,
      claimId: claim.claimId,
      mode: claim.mode,
      requestedMode: intent?.mode ?? null,
      observedChange: change?.state ?? null,
      integrated: change?.integrated ?? null,
    });
  }
  for (const intent of facts.intents) {
    const session = sessionById.get(intent.sessionId);
    const change = facts.changes.find((candidate) => candidate.sessionId === intent.sessionId);
    push({
      sessionId: intent.sessionId,
      worktreePath: session?.worktreePath ?? null,
      state: session?.state ?? null,
      claimId: null,
      mode: null,
      requestedMode: intent.mode,
      observedChange: change?.state ?? null,
      integrated: change?.integrated ?? null,
    });
  }
  for (const change of facts.changes) {
    const session = sessionById.get(change.sessionId);
    push({
      sessionId: change.sessionId,
      worktreePath: session?.worktreePath ?? null,
      state: session?.state ?? null,
      claimId: null,
      mode: null,
      requestedMode: null,
      observedChange: change.state,
      integrated: change.integrated,
    });
  }
  rows.sort((left, right) =>
    compareStrings(`${left.sessionId}\u0000${left.claimId ?? ""}`, `${right.sessionId}\u0000${right.claimId ?? ""}`),
  );
  return Object.freeze({
    participants: Object.freeze(rows.slice(0, maxParticipants).map((row) => Object.freeze(row))),
    truncated: rows.length > maxParticipants,
  });
}

function releaseConditionFor(
  currentMode: ResourceClaimMode,
  requestedMode: ResourceClaimMode,
): "owner-releases-claim" | "owner-changes-claim" {
  // A read or write owner can only unblock an exclusive request by releasing.
  if (requestedMode === "exclusive-write") return "owner-releases-claim";
  if (currentMode === "exclusive-write") return "owner-changes-claim";
  return "owner-changes-claim";
}

function projectPhysicalModification(changes: readonly CoordinationObservedChange[]): CoordinationPhysicalModification {
  if (changes.some((change) => change.state === "modified" && change.integrated !== true)) return "modified";
  if (changes.some((change) => change.state === "unknown" || change.integrated === "unknown")) return "unknown";
  return "clean";
}

function projectMergeability(evidence: readonly CoordinationMergeabilityEvidence[]): CoordinationMergeability {
  if (evidence.some((item) => item.state === "conflicting")) return "conflicting";
  if (evidence.some((item) => item.state === "unknown")) return "unknown";
  return evidence.length === 0 ? "unknown" : "mergeable";
}

function projectNextActions(
  resource: string,
  blockers: readonly ResourceWaitReason[],
  participants: readonly ResourceCoordinationParticipant[],
  requestedModes: readonly ResourceClaimMode[],
  classification: CoordinationClassification,
  complete: boolean,
): CoordinationNextAction[] {
  const actions: CoordinationNextAction[] = [];
  for (const blocker of blockers) {
    if (blocker.kind === "claim-conflict") {
      actions.push(projectWaitAction(resource, blocker));
    }
  }
  const changed = participants.find((participant) => participant.observedChange === "modified");
  if (changed !== undefined) {
    actions.push({ actionId: "inspect-observed-changes", kind: "inspect", resource, sessionId: changed.sessionId });
  }
  if (!complete || classification === "unresolved") {
    actions.push({ actionId: "refresh-coordination-evidence", kind: "refresh", resource });
  }
  if (actions.length === 0 && classification === "available") {
    const mutationMode = requestedModes.find((mode) => mode !== "read");
    if (mutationMode === "write" || mutationMode === "exclusive-write") {
      actions.push({ actionId: "acquire-claim", kind: "acquire", resource, requestedMode: mutationMode });
    } else {
      actions.push({ actionId: "proceed-without-claim", kind: "proceed", resource });
    }
  }
  return dedupeActions(actions);
}

function projectWaitAction(
  resource: string,
  blocker: Extract<ResourceWaitReason, { readonly kind: "claim-conflict" }>,
): CoordinationNextAction {
  const details = {
    kind: "wait" as const,
    resource,
    ownerSessionId: blocker.ownerSessionId,
    ownerClaimId: blocker.ownerClaimId,
    requestedMode: blocker.requestedMode,
    currentMode: blocker.currentMode,
  };
  if (blocker.releaseCondition === "owner-releases-claim") {
    return { actionId: "wait-for-owner-release", ...details, releaseCondition: blocker.releaseCondition };
  }
  if (blocker.releaseCondition === "owner-changes-claim") {
    return { actionId: "wait-for-owner-change", ...details, releaseCondition: blocker.releaseCondition };
  }
  return { actionId: "wait-for-owner-close", ...details, releaseCondition: blocker.releaseCondition };
}

function dedupeWaitReasons(reasons: readonly ResourceWaitReason[]): ResourceWaitReason[] {
  const seen = new Set<string>();
  return reasons.filter((reason) => {
    const key = JSON.stringify(reason);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function dedupeActions(actions: readonly CoordinationNextAction[]): CoordinationNextAction[] {
  const seen = new Set<string>();
  return actions.filter((action) => {
    const key = JSON.stringify(action);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function uniqueModes(modes: readonly ResourceClaimMode[]): ResourceClaimMode[] {
  return [...new Set(modes)].sort(compareStrings) as ResourceClaimMode[];
}

function normalizeBounds(
  input: ResourceCoordinationSnapshotBounds | undefined,
): Required<ResourceCoordinationSnapshotBounds> {
  return {
    maxResources: positiveBound(input?.maxResources, DEFAULT_MAX_RESOURCES),
    maxParticipantsPerResource: positiveBound(input?.maxParticipantsPerResource, DEFAULT_MAX_PARTICIPANTS),
    maxBlockersPerResource: positiveBound(input?.maxBlockersPerResource, DEFAULT_MAX_BLOCKERS),
  };
}

function positiveBound(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1)
    throw new TypeError("Coordination snapshot bounds must be positive integers");
  return value;
}

function assertInput(input: ResourceCoordinationSnapshotInput): void {
  if (!isRecord(input) || !isRecord(input.registry) || !isRecord(input.contract)) {
    throw new TypeError("Coordination snapshot input must contain registry and contract objects");
  }
  if (typeof input.registry.repositoryId !== "string" || input.registry.repositoryId.length === 0) {
    throw new TypeError("Coordination snapshot repository identity is required");
  }
  if (!Number.isSafeInteger(input.registry.claimSetGeneration) || input.registry.claimSetGeneration < 0) {
    throw new TypeError("Coordination snapshot claim-set generation is invalid");
  }
  if (!Array.isArray(input.registry.sessions) || !Array.isArray(input.registry.claims)) {
    throw new TypeError("Coordination snapshot registry sessions and claims must be arrays");
  }
}

function assertSnapshot(snapshot: ResourceCoordinationSnapshot): void {
  if (!isRecord(snapshot) || snapshot.schemaVersion !== RESOURCE_COORDINATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new TypeError("Unsupported resource coordination snapshot schema");
  }
}

function freezeSnapshot(snapshot: ResourceCoordinationSnapshot): ResourceCoordinationSnapshot {
  Object.freeze(snapshot.registry);
  Object.freeze(snapshot.contract);
  Object.freeze(snapshot.incompleteReasons);
  Object.freeze(snapshot.resources);
  return Object.freeze(snapshot);
}

function compareClaim(left: ResourceClaim, right: ResourceClaim): number {
  return compareStrings(`${left.sessionId}\u0000${left.claimId}`, `${right.sessionId}\u0000${right.claimId}`);
}

function compareIntent(left: CoordinationResourceIntent, right: CoordinationResourceIntent): number {
  return compareStrings(`${left.sessionId}\u0000${left.mode}`, `${right.sessionId}\u0000${right.mode}`);
}

function compareChange(left: CoordinationObservedChange, right: CoordinationObservedChange): number {
  return compareStrings(`${left.sessionId}\u0000${left.state}`, `${right.sessionId}\u0000${right.state}`);
}

function compareMergeability(left: CoordinationMergeabilityEvidence, right: CoordinationMergeabilityEvidence): number {
  return compareStrings(`${left.sessionId}\u0000${left.state}`, `${right.sessionId}\u0000${right.state}`);
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(",")}]`;
  if (!isRecord(value)) return JSON.stringify(value);
  return `{${Object.keys(value)
    .sort(compareStrings)
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(",")}}`;
}
