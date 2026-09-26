import type { JsonObject, JsonValue } from "../domain/errors.js";
import { SessionRegistryError, type RegistryErrorCode, type RegistryErrorDetails } from "../errors.js";
import {
  parseFileOperationRegistry,
  serializeFileOperationRegistry,
  type PersistedFileOperationRecord,
} from "./file-operation-record.js";
import { parsePinnedProfileRecord } from "../domain/worktree-profile-pinning.js";
import { isResourceClaimMode, type ResourceClaimMode } from "../resource-claims.js";

/**
 * Optional registry areas are deliberately a closed, versioned vocabulary.
 * Later implementation leaves add support for one of these features together
 * with the authority that owns its records; this leaf only defines the gate.
 */
export const REGISTRY_FEATURES = Object.freeze([
  "pinned-profiles.v1",
  "runtime-sessions.v1",
  "executions.v1",
  "retentions.v1",
  "recent-events.v1",
  "file-operations.v1",
  "session-history.v1",
] as const);

export type RegistryFeature = (typeof REGISTRY_FEATURES)[number];

/**
 * Optional record authorities implemented by the runtime registry owner. The
 * resource-coordination integration owns exactly the handoff receipt area.
 */
export const SUPPORTED_REGISTRY_FEATURES = Object.freeze([
  "pinned-profiles.v1",
  "runtime-sessions.v1",
  "executions.v1",
  "recent-events.v1",
  "file-operations.v1",
  "session-history.v1",
] as const);

export const MAX_RUNTIME_RECORDS = 256 as const;
export const MAX_RUNTIME_RECORD_KEYS = 32 as const;
export const MAX_UNSUPPORTED_REGISTRY_FEATURES = 8 as const;

export type RuntimeRecord = Readonly<JsonObject>;

export type SessionAdmissionRecord = Readonly<{
  readonly kind: "session-admission";
  readonly schema_version: 1;
  readonly session_id: string;
  readonly admission: "open" | "closed";
  readonly runtime_epoch: number;
}>;

export interface RuntimeRecords {
  readonly pinned_profiles?: readonly RuntimeRecord[];
  readonly runtime_sessions?: readonly RuntimeRecord[];
  readonly executions?: readonly RuntimeRecord[];
  readonly retentions?: readonly RuntimeRecord[];
  readonly recent_events?: readonly RuntimeRecord[];
  readonly file_operations?: readonly PersistedFileOperationRecord[];
  readonly session_history?: readonly RuntimeRecord[];
}

export interface ResourceHandoffRecentEvent extends JsonObject {
  readonly kind: "resource-handoff";
  readonly schema_version: 1;
  readonly operation_id: string;
  readonly from_session_id: string;
  readonly to_session_id: string;
  readonly resource: string;
  readonly mode: ResourceClaimMode;
  readonly claim_set_generation: number;
}

export interface ParsedRuntimeRecords {
  readonly requiredFeatures: readonly RegistryFeature[];
  readonly records: RuntimeRecords;
}

type RuntimeRecordField = keyof RuntimeRecords;

const FEATURE_DEFINITIONS: readonly Readonly<{
  feature: RegistryFeature;
  field: RuntimeRecordField;
}>[] = Object.freeze([
  { feature: "pinned-profiles.v1", field: "pinned_profiles" },
  { feature: "runtime-sessions.v1", field: "runtime_sessions" },
  { feature: "executions.v1", field: "executions" },
  { feature: "retentions.v1", field: "retentions" },
  { feature: "recent-events.v1", field: "recent_events" },
  { feature: "file-operations.v1", field: "file_operations" },
  { feature: "session-history.v1", field: "session_history" },
]);

const FEATURE_BY_FIELD = new Map(FEATURE_DEFINITIONS.map((definition) => [definition.field, definition.feature]));

const EMPTY_RUNTIME_RECORDS: ParsedRuntimeRecords = Object.freeze({
  requiredFeatures: Object.freeze([]),
  records: Object.freeze({}),
});

/**
 * Parse the optional registry areas without accepting an opaque plugin bag.
 * `supportedFeatures` is supplied by the authority that owns the current
 * record implementations; the registry itself supports none yet.
 */
export function parseRuntimeRecords(
  input: unknown,
  supportedFeatures: readonly string[] = SUPPORTED_REGISTRY_FEATURES,
): ParsedRuntimeRecords {
  if (!isRecord(input)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry root must be an object");
  }

  const requiredFeatures = parseRequiredFeatures(input.required_features);
  const supported = new Set(supportedFeatures);
  const unsupported = requiredFeatures.filter((feature) => !supported.has(feature));
  if (unsupported.length > 0) {
    throw unsupportedFeatureError(unsupported);
  }

  const records: Record<string, readonly unknown[]> = {};
  for (const definition of FEATURE_DEFINITIONS) {
    const present = Object.hasOwn(input, definition.field);
    const required = requiredFeatures.includes(definition.feature);
    if (present !== required) {
      if (present && !supported.has(definition.feature)) {
        throw unsupportedFeatureError([definition.feature]);
      }
      throw new SessionRegistryError(
        "REGISTRY_CORRUPT",
        `Registry feature presence does not match required_features: ${definition.feature}`,
        { feature: definition.feature, field: definition.field },
      );
    }
    if (!present) continue;
    if (definition.field === "file_operations") {
      records[definition.field] = parsePersistedFileOperationRecords(input[definition.field]);
      continue;
    }
    records[definition.field] = parseRecordList(input[definition.field], definition.field);
  }

  return Object.freeze({
    requiredFeatures: Object.freeze([...requiredFeatures]),
    records: Object.freeze(records) as RuntimeRecords,
  });
}

/** Convert parsed optional areas back to their bounded persisted fields. */
export function toPersistedRuntimeRecords(parsed: ParsedRuntimeRecords): RuntimeRecords {
  const fileOperations = parsed.records.file_operations;
  return Object.freeze(
    Object.fromEntries(
      FEATURE_DEFINITIONS.flatMap(({ feature, field }) =>
        parsed.requiredFeatures.includes(feature) && parsed.records[field] !== undefined
          ? [
              [
                field,
                field === "file_operations"
                  ? serializePersistedFileOperationRecords(fileOperations)
                  : parsed.records[field],
              ],
            ]
          : [],
      ),
    ),
  ) as RuntimeRecords;
}

function parsePersistedFileOperationRecords(value: unknown): readonly PersistedFileOperationRecord[] {
  try {
    return Object.freeze(
      serializeFileOperationRegistry(
        parseFileOperationRegistry({ schema_version: 1, file_operations: value }),
      ).file_operations.map((record) => Object.freeze({ ...record })),
    );
  } catch (error: unknown) {
    if (error instanceof SessionRegistryError) throw error;
    const code = typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
    const fileOperationCodes = new Set([
      "FILE_OPERATION_INVALID",
      "FILE_OPERATION_ID_CONFLICT",
      "FILE_OPERATION_INVALID_TRANSITION",
      "FILE_OPERATION_LIMIT",
      "FILE_OPERATION_AUTHORITY_DENIED",
      "FILE_OPERATION_UNSUPPORTED_SCHEMA",
      "FILE_OPERATION_CORRUPT",
    ]);
    if (fileOperationCodes.has(String(code))) {
      const details =
        typeof error === "object" && error !== null && "details" in error && isRecord(error.details)
          ? (error.details as Record<string, unknown>)
          : {};
      throw new SessionRegistryError(
        String(code) as RegistryErrorCode,
        error instanceof Error ? error.message : "Registry file-operation records are invalid",
        details as RegistryErrorDetails,
        error,
      );
    }
    throw new SessionRegistryError(
      "REGISTRY_CORRUPT",
      "Registry file-operation records are invalid",
      { field: "file_operations" },
      error,
    );
  }
}

function serializePersistedFileOperationRecords(
  value: readonly PersistedFileOperationRecord[] | undefined,
): readonly PersistedFileOperationRecord[] {
  if (value === undefined) return [];
  return parsePersistedFileOperationRecords(value);
}

export function emptyRuntimeRecords(): ParsedRuntimeRecords {
  return EMPTY_RUNTIME_RECORDS;
}

function parseRequiredFeatures(value: unknown): RegistryFeature[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry required_features must be an array");
  }
  if (value.length > REGISTRY_FEATURES.length) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry required_features exceeds the bounded feature set");
  }

  const seen = new Set<string>();
  const features: RegistryFeature[] = [];
  for (const candidate of value) {
    if (typeof candidate !== "string" || !isRegistryFeature(candidate)) {
      const feature = typeof candidate === "string" ? candidate : "<invalid>";
      throw unsupportedFeatureError([feature]);
    }
    if (seen.has(candidate)) {
      throw new SessionRegistryError(
        "REGISTRY_CORRUPT",
        `Registry required_features contains a duplicate: ${candidate}`,
      );
    }
    seen.add(candidate);
    features.push(candidate);
  }

  const order = new Map(REGISTRY_FEATURES.map((feature, index) => [feature, index]));
  features.sort((left, right) => (order.get(left) ?? 0) - (order.get(right) ?? 0));
  return features;
}

function parseRecordList(value: unknown, field: string): readonly RuntimeRecord[] {
  if (!Array.isArray(value)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry ${field} must be an array`, { field });
  }
  if (value.length > MAX_RUNTIME_RECORDS) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry ${field} exceeds its bounded record count`, {
      field,
      maximum: MAX_RUNTIME_RECORDS,
    });
  }
  const records = value.map((candidate, index) =>
    field === "runtime_sessions"
      ? parseSessionAdmissionRecord(candidate, index)
      : field === "pinned_profiles"
        ? parsePinnedProfileRuntimeRecord(candidate, index)
        : field === "recent_events"
          ? parseResourceHandoffRecentEvent(candidate, field, index)
          : field === "session_history"
            ? parseSessionHistoryEvent(candidate, index)
            : parseRuntimeRecord(candidate, field, index),
  );
  if (field === "session_history") {
    let previous = 0;
    for (const record of records) {
      const sequence = (record as RuntimeRecord).sequence as number;
      if (sequence <= previous || (previous !== 0 && sequence !== previous + 1)) {
        throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry history is not contiguous and ordered");
      }
      previous = sequence;
    }
  }
  if (field === "runtime_sessions") {
    const owners = new Set<string>();
    for (const record of records as SessionAdmissionRecord[]) {
      if (owners.has(record.session_id)) {
        throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry runtime_sessions contains a duplicate session", {
          sessionId: record.session_id,
        });
      }
      owners.add(record.session_id);
    }
  }
  if (field === "pinned_profiles") {
    const owners = new Set<string>();
    for (const record of records) {
      const owner = record.session_id;
      if (typeof owner !== "string") continue;
      if (owners.has(owner)) {
        throw new SessionRegistryError("REGISTRY_CORRUPT", "Registry pinned_profiles contains a duplicate session", {
          sessionId: owner,
        });
      }
      owners.add(owner);
    }
  }
  return Object.freeze(records);
}

function parsePinnedProfileRuntimeRecord(value: unknown, index: number): RuntimeRecord {
  if (!isRecord(value)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry pinned_profiles[${index}] must be an object`, {
      field: "pinned_profiles",
      index,
    });
  }
  if (
    Object.hasOwn(value, "session_id") &&
    (typeof value.session_id !== "string" ||
      value.session_id.length === 0 ||
      value.session_id.length > 256 ||
      value.session_id.includes("\0"))
  ) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry pinned_profiles[${index}] has an invalid owner`, {
      field: "pinned_profiles",
      index,
    });
  }
  try {
    parsePinnedProfileRecord(value);
  } catch (error: unknown) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry pinned_profiles[${index}] is invalid`, {
      field: "pinned_profiles",
      index,
      cause: error instanceof Error ? error.message : String(error),
    });
  }
  return parseRuntimeRecord(value, "pinned_profiles", index);
}

export function parseSessionAdmissionRecord(value: unknown, index = 0): SessionAdmissionRecord {
  if (!isRecord(value)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry runtime_sessions[${index}] must be an object`, {
      field: "runtime_sessions",
      index,
    });
  }
  const keys = Object.keys(value).sort();
  const expected = ["admission", "kind", "runtime_epoch", "schema_version", "session_id"];
  if (
    keys.length !== expected.length ||
    keys.some((key, keyIndex) => key !== expected[keyIndex]) ||
    value.kind !== "session-admission" ||
    value.schema_version !== 1 ||
    typeof value.session_id !== "string" ||
    value.session_id.length === 0 ||
    value.session_id.length > 256 ||
    value.session_id.includes("\0") ||
    (value.admission !== "open" && value.admission !== "closed") ||
    typeof value.runtime_epoch !== "number" ||
    !Number.isSafeInteger(value.runtime_epoch) ||
    value.runtime_epoch < 0
  ) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry runtime_sessions[${index}] is invalid`, {
      field: "runtime_sessions",
      index,
    });
  }
  return Object.freeze({
    kind: "session-admission",
    schema_version: 1,
    session_id: value.session_id,
    admission: value.admission,
    runtime_epoch: value.runtime_epoch,
  });
}

function parseResourceHandoffRecentEvent(value: unknown, field: string, index: number): ResourceHandoffRecentEvent {
  if (!isRecord(value)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry ${field}[${index}] must be an object`, {
      field,
      index,
    });
  }
  const expected = [
    "kind",
    "schema_version",
    "operation_id",
    "from_session_id",
    "to_session_id",
    "resource",
    "mode",
    "claim_set_generation",
  ];
  if (Object.keys(value).length !== expected.length || expected.some((key) => !Object.hasOwn(value, key))) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry ${field}[${index}] is not a supported recent event`, {
      field,
      index,
    });
  }
  if (
    value.kind !== "resource-handoff" ||
    value.schema_version !== 1 ||
    !boundedText(value.operation_id) ||
    !boundedText(value.from_session_id) ||
    !boundedText(value.to_session_id) ||
    !boundedText(value.resource) ||
    !isResourceClaimMode(value.mode) ||
    !Number.isSafeInteger(value.claim_set_generation) ||
    (value.claim_set_generation as number) < 0
  ) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry ${field}[${index}] is invalid`, { field, index });
  }
  return Object.freeze({
    kind: "resource-handoff",
    schema_version: 1,
    operation_id: value.operation_id,
    from_session_id: value.from_session_id,
    to_session_id: value.to_session_id,
    resource: value.resource,
    mode: value.mode,
    claim_set_generation: value.claim_set_generation as number,
  });
}

function parseSessionHistoryEvent(value: unknown, index: number): RuntimeRecord {
  const fields = [
    "kind",
    "schema_version",
    "event_id",
    "sequence",
    "session_id",
    "execution_id",
    "source",
    "operation",
    "before_revision",
    "after_revision",
    "observed_at",
  ];
  if (
    !isRecord(value) ||
    Object.keys(value).length !== fields.length ||
    fields.some((field) => !Object.hasOwn(value, field)) ||
    (value.kind !== "lifecycle" && value.kind !== "execution") ||
    value.schema_version !== 1 ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    value.event_id !== `history:${value.sequence}` ||
    !boundedText(value.session_id) ||
    (value.execution_id !== null && !boundedText(value.execution_id)) ||
    value.source !== "session-registry" ||
    !boundedText(value.operation) ||
    !Number.isSafeInteger(value.before_revision) ||
    (value.before_revision as number) < 0 ||
    !Number.isSafeInteger(value.after_revision) ||
    (value.after_revision as number) <= (value.before_revision as number) ||
    typeof value.observed_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value.observed_at) ||
    !Number.isFinite(Date.parse(value.observed_at)) ||
    new Date(value.observed_at).toISOString() !== value.observed_at
  ) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry session_history[${index}] is invalid`);
  }
  return cloneRecord(value);
}

function boundedText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value);
}

function parseRuntimeRecord(value: unknown, field: string, index: number): RuntimeRecord {
  if (!isRecord(value)) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry ${field}[${index}] must be an object`, {
      field,
      index,
    });
  }
  const keys = Object.keys(value);
  if (keys.length > MAX_RUNTIME_RECORD_KEYS) {
    throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry ${field}[${index}] has too many fields`, {
      field,
      index,
      maximum: MAX_RUNTIME_RECORD_KEYS,
    });
  }
  for (const key of keys) {
    if (!isJsonValue(value[key])) {
      throw new SessionRegistryError("REGISTRY_CORRUPT", `Registry ${field}[${index}] contains non-JSON data`, {
        field,
        index,
      });
    }
  }
  return cloneRecord(value);
}

function unsupportedFeatureError(features: readonly string[]): SessionRegistryError {
  const bounded = [...new Set(features)].slice(0, MAX_UNSUPPORTED_REGISTRY_FEATURES);
  return new SessionRegistryError(
    "REGISTRY_FEATURE_UNSUPPORTED",
    "Registry requires a feature that this runtime does not support",
    {
      unsupportedFeatures: bounded,
      requiredFeatures: bounded,
    },
  );
}

function isRegistryFeature(value: string): value is RegistryFeature {
  return (REGISTRY_FEATURES as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  if (!isRecord(value)) return false;
  return Object.values(value).every(isJsonValue);
}

function cloneRecord(value: Record<string, unknown>): RuntimeRecord {
  return Object.freeze(JSON.parse(JSON.stringify(value)) as JsonObject);
}

export function registryFeatureForField(field: string): RegistryFeature | undefined {
  return FEATURE_BY_FIELD.get(field as RuntimeRecordField);
}
