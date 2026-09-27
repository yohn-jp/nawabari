import type { JsonObject, JsonValue } from "./domain/errors.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";
import {
  RESOURCE_COORDINATION_OBSERVATION_CONTRACT_ID,
  RESOURCE_COORDINATION_OBSERVATION_SCHEMA_VERSION,
} from "./resource-coordination-view.js";

const RAW_COORDINATION_CONTRACT_ID = "resource-coordination-snapshot";
const RAW_COORDINATION_SCHEMA_VERSION = 1;
const MATRIX_UNAVAILABLE = "coordination facts are not completely representable by matrix v1";
const MATRIX_IDENTITY_UNAVAILABLE = "coordination source identity does not match the snapshot registry";
const MATRIX_EVIDENCE_UNAVAILABLE = "coordination evidence is incomplete or truncated";
const MAX_MATRIX_TEXT_CODE_POINTS = 4_096;
const MAX_MATRIX_ROWS = 4_096;

type Projection =
  | Readonly<{ readonly status: "mapped"; readonly value: JsonObject }>
  | Readonly<{ readonly status: "unavailable"; readonly reason: string }>;

/**
 * Adapt the canonical coordination value only for the legacy matrix projector.
 * The returned snapshot is a projection copy; the public snapshot keeps the
 * original producer value and contract unchanged.
 */
export function adaptRepositoryRuntimeSnapshotForMatrixV1(
  snapshot: RepositoryRuntimeSnapshot,
): RepositoryRuntimeSnapshot {
  const observation = snapshot.observations.coordination;
  if (observation.status === "unknown") return snapshot;
  if (isLegacyMatrixValue(observation.value)) return snapshot;

  const projected = projectRawCoordination(observation.value, snapshot);
  const coordination =
    projected.status === "mapped"
      ? Object.freeze({ ...observation, value: projected.value })
      : Object.freeze({ status: "unknown" as const, observed_at: observation.observed_at, reason: projected.reason });

  return Object.freeze({
    ...snapshot,
    observations: Object.freeze({ ...snapshot.observations, coordination }),
  });
}

function projectRawCoordination(value: JsonValue, snapshot: RepositoryRuntimeSnapshot): Projection {
  if (
    !isExactObject(value, [
      "schemaVersion",
      "registry",
      "contract",
      "complete",
      "incompleteReasons",
      "truncated",
      "resources",
    ])
  ) {
    return unavailable(MATRIX_UNAVAILABLE);
  }
  if (
    value.schemaVersion !== RAW_COORDINATION_SCHEMA_VERSION ||
    !isExactObject(value.registry, ["repositoryId", "claimSetGeneration", "registryRevision"]) ||
    !isExactObject(value.contract, ["id", "version", "persisted", "mutation", "fileContents"]) ||
    value.contract.id !== RAW_COORDINATION_CONTRACT_ID ||
    value.contract.version !== RAW_COORDINATION_SCHEMA_VERSION ||
    value.contract.persisted !== false ||
    value.contract.mutation !== false ||
    value.contract.fileContents !== false
  ) {
    return unavailable(MATRIX_UNAVAILABLE);
  }
  if (
    value.registry.repositoryId !== snapshot.repository_id ||
    value.registry.registryRevision !== snapshot.registry.revision ||
    value.registry.claimSetGeneration !== snapshot.registry.claim_set_generation
  ) {
    return unavailable(MATRIX_IDENTITY_UNAVAILABLE);
  }
  if (
    value.complete !== true ||
    value.truncated !== false ||
    !Array.isArray(value.incompleteReasons) ||
    value.incompleteReasons.length !== 0
  ) {
    return unavailable(MATRIX_EVIDENCE_UNAVAILABLE);
  }
  if (!Array.isArray(value.resources) || value.resources.length > MAX_MATRIX_ROWS) {
    return unavailable(MATRIX_UNAVAILABLE);
  }

  const rows: JsonValue[] = [];
  const seenResources = new Set<string>();
  for (const rawRow of value.resources) {
    const row = projectRow(rawRow);
    if (row === null || seenResources.has(row.resource as string)) return unavailable(MATRIX_UNAVAILABLE);
    seenResources.add(row.resource as string);
    rows.push(row);
  }

  return {
    status: "mapped",
    value: {
      contract_id: RESOURCE_COORDINATION_OBSERVATION_CONTRACT_ID,
      schema_version: RESOURCE_COORDINATION_OBSERVATION_SCHEMA_VERSION,
      rows,
    },
  };
}

function projectRow(value: unknown): JsonObject | null {
  if (
    !isExactObject(value, [
      "resource",
      "participants",
      "requestedModes",
      "permission",
      "conflict",
      "physicalModification",
      "mergeability",
      "classification",
      "blockers",
      "nextActions",
    ]) ||
    !boundedText(value.resource) ||
    !Array.isArray(value.participants) ||
    !Array.isArray(value.requestedModes) ||
    !Array.isArray(value.blockers) ||
    !Array.isArray(value.nextActions) ||
    value.blockers.length !== 0 ||
    value.nextActions.length !== 0
  ) {
    return null;
  }

  const conflict = mapConflict(value.conflict);
  const permission = mapPermission(value.permission);
  const physicalModification = mapPhysicalModification(value.physicalModification);
  const mergeability = mapMergeability(value.mergeability);
  if (
    conflict === null ||
    permission === null ||
    physicalModification === null ||
    mergeability === null ||
    !["available", "blocked", "unresolved"].includes(String(value.classification))
  ) {
    return null;
  }

  const participants: JsonValue[] = [];
  const participantIds = new Set<string>();
  const representedRequestedModes = new Set<string>();
  for (const rawParticipant of value.participants) {
    const participant = projectParticipant(rawParticipant);
    if (participant === null || participantIds.has(participant.session_id as string)) return null;
    participantIds.add(participant.session_id as string);
    if (participant.requested_mode !== null) representedRequestedModes.add(participant.requested_mode as string);
    participants.push(participant);
  }

  const requestedModes = value.requestedModes;
  if (
    requestedModes.some((mode) => !isMode(mode)) ||
    new Set(requestedModes).size !== requestedModes.length ||
    requestedModes.length !== representedRequestedModes.size ||
    requestedModes.some((mode) => !representedRequestedModes.has(mode as string))
  ) {
    return null;
  }

  return {
    resource: value.resource,
    participants,
    permission,
    conflict,
    physical_modification: physicalModification,
    mergeability,
    classification: value.classification as string,
    blockers: [],
    next_actions: [],
  };
}

function projectParticipant(value: unknown): JsonObject | null {
  if (
    !isExactObject(value, [
      "sessionId",
      "worktreePath",
      "state",
      "claimId",
      "mode",
      "requestedMode",
      "observedChange",
      "integrated",
    ]) ||
    !boundedText(value.sessionId) ||
    !boundedText(value.worktreePath) ||
    !boundedText(value.state) ||
    !boundedText(value.claimId) ||
    !isMode(value.mode) ||
    (value.requestedMode !== null && !isMode(value.requestedMode)) ||
    (value.integrated !== null && typeof value.integrated !== "boolean")
  ) {
    return null;
  }

  const observedChange =
    value.observedChange === "clean"
      ? "none"
      : value.observedChange === "unknown"
        ? "unknown"
        : value.observedChange === "modified"
          ? "modified"
          : null;
  if (observedChange === null) return null;

  return {
    session_id: value.sessionId,
    worktree_path: value.worktreePath,
    state: value.state,
    claim_id: value.claimId,
    mode: value.mode,
    requested_mode: value.requestedMode,
    observed_change: observedChange,
    integrated: value.integrated,
  };
}

function mapPermission(value: unknown): string | null {
  switch (value) {
    case "allowed":
      return "allowed";
    case "denied":
      return "blocked";
    case "unknown":
      return "unresolved";
    default:
      return null;
  }
}

function mapConflict(value: unknown): string | null {
  if (value === "none" || value === "unknown") return value;
  // The canonical source says only `conflict`; matrix v1 requires a subtype.
  return null;
}

function mapPhysicalModification(value: unknown): string | null {
  switch (value) {
    case "clean":
      return "none";
    case "modified":
      return "observed";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

function mapMergeability(value: unknown): string | null {
  switch (value) {
    case "mergeable":
      return "clean";
    case "conflicting":
      return "conflict";
    case "unknown":
      return "unknown";
    default:
      return null;
  }
}

function isLegacyMatrixValue(value: JsonValue): boolean {
  return (
    isExactObject(value, ["contract_id", "schema_version", "rows"]) &&
    value.contract_id === RESOURCE_COORDINATION_OBSERVATION_CONTRACT_ID &&
    value.schema_version === RESOURCE_COORDINATION_OBSERVATION_SCHEMA_VERSION
  );
}

function unavailable(reason: string): Projection {
  return { status: "unavailable", reason };
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && [...value].length <= MAX_MATRIX_TEXT_CODE_POINTS;
}

function isMode(value: unknown): value is "read" | "write" | "exclusive-write" {
  return value === "read" || value === "write" || value === "exclusive-write";
}

function isExactObject<const T extends readonly string[]>(
  value: unknown,
  keys: T,
): value is Record<T[number], unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const object = value as Record<string, unknown>;
  const expected = new Set(keys);
  return Object.keys(object).length === expected.size && Object.keys(object).every((key) => expected.has(key));
}
