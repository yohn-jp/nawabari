import { DomainError, failure, success, type DomainResult, type JsonObject, type JsonValue } from "./domain/errors.js";
import { compareCodePointStrings, type ResourceClaim } from "./resource-claims.js";
import type { RepositoryRegistryView, SessionRecord } from "./session-registry.js";

export const REPOSITORY_RUNTIME_SNAPSHOT_CONTRACT_ID = "nawabari.repository-runtime-snapshot.v1" as const;
export const REPOSITORY_RUNTIME_SNAPSHOT_SCHEMA_VERSION = 1 as const;

const MAX_SESSIONS = 1_024 as const;
const MAX_CLAIMS = 4_096 as const;
const MAX_REASON_CODE_POINTS = 512 as const;
const MISSING_OBSERVATION_REASON = "observation not supplied" as const;
const OBSERVATION_NAMES = ["coordination", "profiles", "filesystem", "processes", "lifecycle"] as const;
const ISO_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ASCII_CONTROL = /[\u0000-\u001f\u007f]/u;

export type RepositoryRuntimeObservation<T> =
  | Readonly<{ status: "available"; observed_at: string; value: T }>
  | Readonly<{ status: "unknown"; observed_at: string | null; reason: string }>;

export type RepositoryRuntimeSnapshotInput = Readonly<{
  registry: RepositoryRegistryView;
  captured_at: string;
  coordination?: RepositoryRuntimeObservation<JsonValue>;
  profiles?: RepositoryRuntimeObservation<JsonValue>;
  filesystem?: RepositoryRuntimeObservation<JsonValue>;
  processes?: RepositoryRuntimeObservation<JsonValue>;
  lifecycle?: RepositoryRuntimeObservation<JsonValue>;
}>;

export type RepositoryRuntimeSnapshot = Readonly<{
  contract_id: typeof REPOSITORY_RUNTIME_SNAPSHOT_CONTRACT_ID;
  schema_version: typeof REPOSITORY_RUNTIME_SNAPSHOT_SCHEMA_VERSION;
  repository_id: string;
  registry: Readonly<{
    schema_version: number;
    revision: number;
    runtime_epoch: number;
    claim_set_generation: number;
  }>;
  captured_at: string;
  complete: boolean;
  incomplete_reasons: readonly string[];
  sessions: readonly SessionRecord[];
  claims: readonly ResourceClaim[];
  observations: Readonly<{
    coordination: RepositoryRuntimeObservation<JsonValue>;
    profiles: RepositoryRuntimeObservation<JsonValue>;
    filesystem: RepositoryRuntimeObservation<JsonValue>;
    processes: RepositoryRuntimeObservation<JsonValue>;
    lifecycle: RepositoryRuntimeObservation<JsonValue>;
  }>;
}>;

type ObservationName = (typeof OBSERVATION_NAMES)[number];

/** Project the accepted registry view and caller-supplied facts without I/O. */
export function getNawabariRepositoryRuntimeSnapshot(
  input: RepositoryRuntimeSnapshotInput,
): DomainResult<RepositoryRuntimeSnapshot> {
  if (!isRecord(input)) return invalid("input", "expected an object");

  const capturedAt = canonicalTimestamp(input.captured_at, "captured_at");
  if (!capturedAt.ok) return capturedAt;
  if (!isRecord(input.registry)) return invalid("registry", "expected an object");
  if (typeof input.registry.repositoryId !== "string" || input.registry.repositoryId.length === 0) {
    return invalid("registry.repositoryId", "expected non-empty text");
  }

  const observations: Partial<Record<ObservationName, RepositoryRuntimeObservation<JsonValue>>> = {};
  const incompleteReasons: string[] = [];
  for (const name of OBSERVATION_NAMES) {
    const projected = projectObservation(input[name], name);
    if (!projected.ok) return projected;
    observations[name] = projected.value;
    if (projected.value.status === "unknown") incompleteReasons.push(projected.value.reason);
  }

  const sessions = [...input.registry.sessions].sort((left, right) =>
    compareCodePointStrings(left.sessionId, right.sessionId),
  );
  const claims = [...input.registry.claims].sort((left, right) => {
    const resource = compareCodePointStrings(left.resource, right.resource);
    if (resource !== 0) return resource;
    const session = compareCodePointStrings(left.sessionId, right.sessionId);
    if (session !== 0) return session;
    return compareCodePointStrings(left.claimId, right.claimId);
  });

  if (sessions.length > MAX_SESSIONS) incompleteReasons.push("sessions truncated at 1024");
  if (claims.length > MAX_CLAIMS) incompleteReasons.push("claims truncated at 4096");

  const snapshot: RepositoryRuntimeSnapshot = Object.freeze({
    contract_id: REPOSITORY_RUNTIME_SNAPSHOT_CONTRACT_ID,
    schema_version: REPOSITORY_RUNTIME_SNAPSHOT_SCHEMA_VERSION,
    repository_id: input.registry.repositoryId,
    registry: Object.freeze({
      schema_version: input.registry.registrySchemaVersion,
      revision: input.registry.registryRevision,
      runtime_epoch: input.registry.runtimeEpoch,
      claim_set_generation: input.registry.claimSetGeneration,
    }),
    captured_at: capturedAt.value,
    complete: incompleteReasons.length === 0,
    incomplete_reasons: Object.freeze(incompleteReasons),
    sessions: Object.freeze(sessions.slice(0, MAX_SESSIONS).map(cloneSessionProjection)),
    claims: Object.freeze(claims.slice(0, MAX_CLAIMS).map(cloneClaimProjection)),
    observations: Object.freeze({
      coordination: observations.coordination as RepositoryRuntimeObservation<JsonValue>,
      profiles: observations.profiles as RepositoryRuntimeObservation<JsonValue>,
      filesystem: observations.filesystem as RepositoryRuntimeObservation<JsonValue>,
      processes: observations.processes as RepositoryRuntimeObservation<JsonValue>,
      lifecycle: observations.lifecycle as RepositoryRuntimeObservation<JsonValue>,
    }),
  });
  return success(snapshot);
}

export function serializeRepositoryRuntimeSnapshot(snapshot: RepositoryRuntimeSnapshot): string {
  return `${JSON.stringify(snapshot)}\n`;
}

function projectObservation(
  input: RepositoryRuntimeObservation<JsonValue> | undefined,
  field: ObservationName,
): DomainResult<RepositoryRuntimeObservation<JsonValue>> {
  if (input === undefined) {
    return success(Object.freeze({ status: "unknown", observed_at: null, reason: MISSING_OBSERVATION_REASON }));
  }
  if (!isRecord(input) || (input.status !== "available" && input.status !== "unknown")) {
    return invalid(field, "status must be available or unknown");
  }
  if (input.status === "available") {
    const observedAt = canonicalTimestamp(input.observed_at, `${field}.observed_at`);
    if (!observedAt.ok) return observedAt;
    if (!Object.hasOwn(input, "value") || !isJsonValue(input.value)) {
      return invalid(`${field}.value`, "expected a JSON value");
    }
    return success(
      Object.freeze({
        status: "available",
        observed_at: observedAt.value,
        value: cloneJsonValue(input.value),
      }),
    );
  }

  const observedAt = observationTimestamp(input.observed_at, `${field}.observed_at`);
  if (!observedAt.ok) return observedAt;
  if (!Object.hasOwn(input, "reason") || !validReason(input.reason)) {
    return invalid(
      `${field}.reason`,
      "expected non-empty text without ASCII control characters and at most 512 code points",
    );
  }
  return success(Object.freeze({ status: "unknown", observed_at: observedAt.value, reason: input.reason }));
}

function canonicalTimestamp(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string" || !ISO_TIMESTAMP_PATTERN.test(value)) {
    return invalid(field, "expected a canonical UTC ISO timestamp");
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed) || new Date(parsed).toISOString() !== value) {
    return invalid(field, "expected a canonical UTC ISO timestamp");
  }
  return success(value);
}

function observationTimestamp(value: unknown, field: string): DomainResult<string | null> {
  if (value === null) return success(null);
  return canonicalTimestamp(value, field);
}

function validReason(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !ASCII_CONTROL.test(value) &&
    [...value].length <= MAX_REASON_CODE_POINTS
  );
}

function invalid(field: string, reason: string): DomainResult<never> {
  return failure(
    new DomainError("INVALID_ARGUMENT", `Repository runtime snapshot field '${field}' is invalid: ${reason}.`, {
      field,
    }),
  );
}

function cloneSessionProjection(session: SessionRecord): SessionRecord {
  return cloneJsonValue(session as unknown as JsonValue) as unknown as SessionRecord;
}

function cloneClaimProjection(claim: ResourceClaim): ResourceClaim {
  return cloneJsonValue(claim as unknown as JsonValue) as unknown as ResourceClaim;
}

function cloneJsonValue(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return Object.freeze(value.map(cloneJsonValue)) as unknown as JsonValue;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value).map(([key, child]) => [key, cloneJsonValue(child)] as const);
    return Object.freeze(Object.fromEntries(entries) as JsonObject);
  }
  return value;
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
