import { DomainError, failure, success, type DomainResult, type JsonValue } from "./domain/errors.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";
import { compareCodePointStrings } from "./resource-claims.js";

export const REPOSITORY_PROFILE_OBSERVATION_V1 = "nawabari.repository-profile-observation.v1" as const;
export const REPOSITORY_PROCESS_OBSERVATION_V1 = "nawabari.repository-process-observation.v1" as const;
export const REPOSITORY_FILESYSTEM_OBSERVATION_V1 = "nawabari.repository-filesystem-observation.v1" as const;
export const REPOSITORY_FILESYSTEM_OBSERVATION_V2 = "nawabari.repository-filesystem-observation.v2" as const;
export const REPOSITORY_LIFECYCLE_OBSERVATION_V1 = "nawabari.repository-lifecycle-observation.v1" as const;
export const REPOSITORY_LIFECYCLE_OBSERVATION_V2 = "nawabari.repository-lifecycle-observation.v2" as const;

const MAX_ENTRIES = 1_024;
const MAX_TEXT_CODE_POINTS = 4_096;
const OBSERVATION_NAMES = ["profiles", "processes", "filesystem", "lifecycle"] as const;
type ObservationName = (typeof OBSERVATION_NAMES)[number];

export interface RepositoryRuntimeProfileObservation {
  readonly session_id: string;
  readonly status: "current" | "drift" | "unknown";
  readonly profile_id: string | null;
  readonly reason: string | null;
}

export interface RepositoryRuntimeProcessObservation {
  readonly session_id: string;
  readonly status: "inactive" | "active" | "unknown";
  readonly reason: string | null;
}

export interface RepositoryRuntimeFilesystemObservation {
  readonly session_id: string;
  readonly policy_status: "clean" | "violation" | "unknown";
  readonly runtime_status: "clean" | "runtime-residual" | "cleanup-incomplete" | "unknown";
  readonly owner: "proven" | "unproven" | "unknown";
  readonly reason: string | null;
}

export interface RepositoryRuntimeLifecycleObservation {
  readonly session_id: string;
  readonly state: string;
  readonly physical_state: string | null;
  readonly recoverable_work: "present" | "absent" | "unknown";
  readonly integration: "proven" | "unproven" | "unknown";
  readonly cleanup: "complete" | "incomplete" | "unknown";
  readonly reason: string | null;
}

export interface RepositoryRuntimeUnmanagedWorktree {
  readonly worktree_path: string;
  readonly reason: string | null;
}

export interface RepositoryRuntimeObservationIndexes {
  readonly profiles: ReadonlyMap<string, RepositoryRuntimeProfileObservation>;
  readonly processes: ReadonlyMap<string, RepositoryRuntimeProcessObservation>;
  readonly filesystem: ReadonlyMap<string, RepositoryRuntimeFilesystemObservation>;
  readonly lifecycle: ReadonlyMap<string, RepositoryRuntimeLifecycleObservation>;
  readonly unknown_sections: Readonly<Record<ObservationName, boolean>>;
  readonly profiles_unknown: boolean;
  readonly processes_unknown: boolean;
  readonly filesystem_unknown: boolean;
  readonly lifecycle_unknown: boolean;
  readonly unmanaged_worktrees: readonly RepositoryRuntimeUnmanagedWorktree[];
}

type ParsedSection<T> = Readonly<{ unknown: boolean; entries: ReadonlyMap<string, T> }>;

/** Parse the observation values shared by runtime reconciliation and attention. */
export function parseRepositoryRuntimeObservations(
  snapshot: RepositoryRuntimeSnapshot,
): DomainResult<RepositoryRuntimeObservationIndexes> {
  if (!isRecord(snapshot) || !isRecord(snapshot.observations)) return invalid("observations", "expected an object");

  const profiles = parseSection(snapshot.observations.profiles, "profiles", parseProfiles);
  if (!profiles.ok) return profiles;
  const processes = parseSection(snapshot.observations.processes, "processes", parseProcesses);
  if (!processes.ok) return processes;
  const filesystem = parseFilesystem(snapshot.observations.filesystem);
  if (!filesystem.ok) return filesystem;
  const lifecycle = parseSection(snapshot.observations.lifecycle, "lifecycle", parseLifecycle);
  if (!lifecycle.ok) return lifecycle;

  const unknown_sections = Object.freeze({
    profiles: profiles.value.unknown,
    processes: processes.value.unknown,
    filesystem: filesystem.value.unknown,
    lifecycle: lifecycle.value.unknown,
  });
  return success(
    Object.freeze({
      profiles: profiles.value.entries,
      processes: processes.value.entries,
      filesystem: filesystem.value.entries,
      lifecycle: lifecycle.value.entries,
      unknown_sections,
      profiles_unknown: unknown_sections.profiles,
      processes_unknown: unknown_sections.processes,
      filesystem_unknown: unknown_sections.filesystem,
      lifecycle_unknown: unknown_sections.lifecycle,
      unmanaged_worktrees: filesystem.value.unmanaged_worktrees,
    }),
  );
}

function parseSection<T>(
  observation: unknown,
  name: ObservationName,
  parser: (value: JsonValue, field: string) => DomainResult<ReadonlyMap<string, T>>,
): DomainResult<ParsedSection<T>> {
  if (observation === undefined) return success({ unknown: true, entries: new Map() });
  if (!isRecord(observation)) return invalid(name, "expected an observation envelope");
  if (observation.status === "unknown") {
    if (!validString(observation.reason, false)) return invalid(`${name}.reason`, "expected bounded text");
    return success({ unknown: true, entries: new Map() });
  }
  if (observation.status !== "available" || !Object.hasOwn(observation, "value") || !isJsonValue(observation.value)) {
    return invalid(name, "expected an available observation with a JSON value");
  }
  const entries = parser(observation.value, name);
  if (!entries.ok) return entries;
  return success({ unknown: false, entries: entries.value });
}

function parseFilesystem(observation: unknown): DomainResult<
  ParsedSection<RepositoryRuntimeFilesystemObservation> & {
    readonly unmanaged_worktrees: readonly RepositoryRuntimeUnmanagedWorktree[];
  }
> {
  if (observation === undefined)
    return success({ unknown: true, entries: new Map(), unmanaged_worktrees: Object.freeze([]) });
  if (!isRecord(observation)) return invalid("filesystem", "expected an observation envelope");
  if (observation.status === "unknown") {
    if (!validString(observation.reason, false)) return invalid("filesystem.reason", "expected bounded text");
    return success({ unknown: true, entries: new Map(), unmanaged_worktrees: Object.freeze([]) });
  }
  if (observation.status !== "available" || !Object.hasOwn(observation, "value") || !isJsonValue(observation.value)) {
    return invalid("filesystem", "expected an available observation with a JSON value");
  }
  const root = exactObject(
    observation.value,
    ["contract_id", "schema_version", "sessions", "unmanaged_worktrees"],
    "filesystem",
  );
  if (!root.ok) {
    const legacyRoot = exactObject(observation.value, ["contract_id", "schema_version", "sessions"], "filesystem");
    if (!legacyRoot.ok) return root;
    if (
      legacyRoot.value.contract_id !== REPOSITORY_FILESYSTEM_OBSERVATION_V1 ||
      legacyRoot.value.schema_version !== 1
    ) {
      return invalid("filesystem", "invalid contract_id or schema_version");
    }
    const parsed = parseSessions(legacyRoot.value.sessions, "filesystem", parseFilesystemV1);
    if (!parsed.ok) return parsed;
    return success({ unknown: false, entries: parsed.value, unmanaged_worktrees: Object.freeze([]) });
  }
  if (root.value.contract_id !== REPOSITORY_FILESYSTEM_OBSERVATION_V2 || root.value.schema_version !== 2) {
    return invalid("filesystem", "invalid contract_id or schema_version");
  }
  const entries = parseSessions(root.value.sessions, "filesystem", parseFilesystemV2);
  if (!entries.ok) return entries;
  const unmanaged = parseUnmanagedWorktrees(root.value.unmanaged_worktrees);
  if (!unmanaged.ok) return unmanaged;
  return success({ unknown: false, entries: entries.value, unmanaged_worktrees: unmanaged.value });
}

function parseProfiles(
  value: JsonValue,
  field: string,
): DomainResult<ReadonlyMap<string, RepositoryRuntimeProfileObservation>> {
  const root = exactObject(value, ["contract_id", "schema_version", "sessions"], field);
  if (!root.ok) return root;
  if (root.value.contract_id !== REPOSITORY_PROFILE_OBSERVATION_V1 || root.value.schema_version !== 1) {
    return invalid(field, "invalid contract_id or schema_version");
  }
  return parseSessions(root.value.sessions, field, parseProfile);
}

function parseProcesses(
  value: JsonValue,
  field: string,
): DomainResult<ReadonlyMap<string, RepositoryRuntimeProcessObservation>> {
  const root = exactObject(value, ["contract_id", "schema_version", "sessions"], field);
  if (!root.ok) return root;
  if (root.value.contract_id !== REPOSITORY_PROCESS_OBSERVATION_V1 || root.value.schema_version !== 1) {
    return invalid(field, "invalid contract_id or schema_version");
  }
  return parseSessions(root.value.sessions, field, parseProcess);
}

function parseLifecycle(
  value: JsonValue,
  field: string,
): DomainResult<ReadonlyMap<string, RepositoryRuntimeLifecycleObservation>> {
  const root = exactObject(value, ["contract_id", "schema_version", "sessions"], field);
  if (!root.ok) return root;
  if (root.value.contract_id === REPOSITORY_LIFECYCLE_OBSERVATION_V1 && root.value.schema_version === 1) {
    return parseSessions(root.value.sessions, field, parseLifecycleV1);
  }
  if (root.value.contract_id === REPOSITORY_LIFECYCLE_OBSERVATION_V2 && root.value.schema_version === 2) {
    return parseSessions(root.value.sessions, field, parseLifecycleV2);
  }
  return invalid(field, "invalid contract_id or schema_version");
}

function parseSessions<T extends { readonly session_id: string }>(
  value: unknown,
  field: string,
  parser: (value: unknown, field: string) => DomainResult<T>,
): DomainResult<ReadonlyMap<string, T>> {
  if (!Array.isArray(value)) return invalid(`${field}.sessions`, "expected an array");
  if (value.length > MAX_ENTRIES) return invalid(`${field}.sessions`, "at most 1024 entries are allowed");
  const parsed: Array<readonly [string, T]> = [];
  const seen = new Set<string>();
  for (const [index, item] of value.entries()) {
    const entry = parser(item, `${field}.sessions[${index}]`);
    if (!entry.ok) return entry;
    const session_id = entry.value.session_id;
    if (seen.has(session_id)) return invalid(`${field}.sessions[${index}].session_id`, "duplicate session_id");
    seen.add(session_id);
    parsed.push([session_id, entry.value]);
  }
  parsed.sort((left, right) => compareCodePointStrings(left[0], right[0]));
  return success(new Map(parsed));
}

function parseProfile(value: unknown, field: string): DomainResult<RepositoryRuntimeProfileObservation> {
  const object = exactObject(value, ["session_id", "status", "profile_id", "reason"], field);
  if (!object.ok) return object;
  const session_id = sessionId(object.value.session_id, `${field}.session_id`);
  if (!session_id.ok) return session_id;
  const status = enumValue(object.value.status, ["current", "drift", "unknown"] as const, `${field}.status`);
  if (!status.ok) return status;
  const profile_id = nullableString(object.value.profile_id, `${field}.profile_id`);
  if (!profile_id.ok) return profile_id;
  const reason = nullableString(object.value.reason, `${field}.reason`);
  if (!reason.ok) return reason;
  return success(
    Object.freeze({
      session_id: session_id.value,
      status: status.value,
      profile_id: profile_id.value,
      reason: reason.value,
    }),
  );
}

function parseProcess(value: unknown, field: string): DomainResult<RepositoryRuntimeProcessObservation> {
  const object = exactObject(value, ["session_id", "status", "reason"], field);
  if (!object.ok) return object;
  const session_id = sessionId(object.value.session_id, `${field}.session_id`);
  if (!session_id.ok) return session_id;
  const status = enumValue(object.value.status, ["inactive", "active", "unknown"] as const, `${field}.status`);
  if (!status.ok) return status;
  const reason = nullableString(object.value.reason, `${field}.reason`);
  if (!reason.ok) return reason;
  return success(Object.freeze({ session_id: session_id.value, status: status.value, reason: reason.value }));
}

function parseFilesystemV1(value: unknown, field: string): DomainResult<RepositoryRuntimeFilesystemObservation> {
  const object = exactObject(value, ["session_id", "status", "reason"], field);
  if (!object.ok) return object;
  const session_id = sessionId(object.value.session_id, `${field}.session_id`);
  if (!session_id.ok) return session_id;
  const status = enumValue(object.value.status, ["clean", "violation", "unknown"] as const, `${field}.status`);
  if (!status.ok) return status;
  const reason = nullableString(object.value.reason, `${field}.reason`);
  if (!reason.ok) return reason;
  return success(
    Object.freeze({
      session_id: session_id.value,
      policy_status: status.value,
      runtime_status: "unknown" as const,
      owner: "unknown" as const,
      reason: reason.value,
    }),
  );
}

function parseFilesystemV2(value: unknown, field: string): DomainResult<RepositoryRuntimeFilesystemObservation> {
  const object = exactObject(value, ["session_id", "policy_status", "runtime_status", "owner", "reason"], field);
  if (!object.ok) return object;
  const session_id = sessionId(object.value.session_id, `${field}.session_id`);
  if (!session_id.ok) return session_id;
  const policy_status = enumValue(
    object.value.policy_status,
    ["clean", "violation", "unknown"] as const,
    `${field}.policy_status`,
  );
  if (!policy_status.ok) return policy_status;
  const runtime_status = enumValue(
    object.value.runtime_status,
    ["clean", "runtime-residual", "cleanup-incomplete", "unknown"] as const,
    `${field}.runtime_status`,
  );
  if (!runtime_status.ok) return runtime_status;
  const owner = enumValue(object.value.owner, ["proven", "unproven", "unknown"] as const, `${field}.owner`);
  if (!owner.ok) return owner;
  const reason = nullableString(object.value.reason, `${field}.reason`);
  if (!reason.ok) return reason;
  return success(
    Object.freeze({
      session_id: session_id.value,
      policy_status: policy_status.value,
      runtime_status: runtime_status.value,
      owner: owner.value,
      reason: reason.value,
    }),
  );
}

function parseLifecycleV1(value: unknown, field: string): DomainResult<RepositoryRuntimeLifecycleObservation> {
  const object = exactObject(value, ["session_id", "state", "physical_state", "reason"], field);
  if (!object.ok) return object;
  const session_id = sessionId(object.value.session_id, `${field}.session_id`);
  if (!session_id.ok) return session_id;
  const state = boundedString(object.value.state, `${field}.state`);
  if (!state.ok) return state;
  const physical_state = nullableString(object.value.physical_state, `${field}.physical_state`);
  if (!physical_state.ok) return physical_state;
  const reason = nullableString(object.value.reason, `${field}.reason`);
  if (!reason.ok) return reason;
  return success(
    Object.freeze({
      session_id: session_id.value,
      state: state.value,
      physical_state: physical_state.value,
      recoverable_work: "unknown" as const,
      integration: "unknown" as const,
      cleanup: "unknown" as const,
      reason: reason.value,
    }),
  );
}

function parseLifecycleV2(value: unknown, field: string): DomainResult<RepositoryRuntimeLifecycleObservation> {
  const object = exactObject(
    value,
    ["session_id", "state", "physical_state", "recoverable_work", "integration", "cleanup", "reason"],
    field,
  );
  if (!object.ok) return object;
  const session_id = sessionId(object.value.session_id, `${field}.session_id`);
  if (!session_id.ok) return session_id;
  const state = enumValue(
    object.value.state,
    [
      "active",
      "parking",
      "parked",
      "close-ready",
      "blocked-recoverable",
      "closed",
      "discarded",
      "stale-inconsistent",
    ] as const,
    `${field}.state`,
  );
  if (!state.ok) return state;
  const physical_state = nullableEnum(
    object.value.physical_state,
    ["present", "missing", "unmanaged", "ambiguous"] as const,
    `${field}.physical_state`,
  );
  if (!physical_state.ok) return physical_state;
  const recoverable_work = enumValue(
    object.value.recoverable_work,
    ["present", "absent", "unknown"] as const,
    `${field}.recoverable_work`,
  );
  if (!recoverable_work.ok) return recoverable_work;
  const integration = enumValue(
    object.value.integration,
    ["proven", "unproven", "unknown"] as const,
    `${field}.integration`,
  );
  if (!integration.ok) return integration;
  const cleanup = enumValue(object.value.cleanup, ["complete", "incomplete", "unknown"] as const, `${field}.cleanup`);
  if (!cleanup.ok) return cleanup;
  const reason = nullableString(object.value.reason, `${field}.reason`);
  if (!reason.ok) return reason;
  return success(
    Object.freeze({
      session_id: session_id.value,
      state: state.value,
      physical_state: physical_state.value,
      recoverable_work: recoverable_work.value,
      integration: integration.value,
      cleanup: cleanup.value,
      reason: reason.value,
    }),
  );
}

function parseUnmanagedWorktrees(value: unknown): DomainResult<readonly RepositoryRuntimeUnmanagedWorktree[]> {
  if (!Array.isArray(value)) return invalid("filesystem.unmanaged_worktrees", "expected an array");
  if (value.length > MAX_ENTRIES) return invalid("filesystem.unmanaged_worktrees", "at most 1024 entries are allowed");
  const parsed: RepositoryRuntimeUnmanagedWorktree[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of value.entries()) {
    const field = `filesystem.unmanaged_worktrees[${index}]`;
    const object = exactObject(entry, ["worktree_path", "reason"], field);
    if (!object.ok) return object;
    const worktree_path = boundedString(object.value.worktree_path, `${field}.worktree_path`);
    if (!worktree_path.ok || worktree_path.value.length === 0)
      return invalid(`${field}.worktree_path`, "expected non-empty bounded text");
    if (seen.has(worktree_path.value)) return invalid(`${field}.worktree_path`, "duplicate worktree_path");
    seen.add(worktree_path.value);
    const reason = nullableString(object.value.reason, `${field}.reason`);
    if (!reason.ok) return reason;
    parsed.push(Object.freeze({ worktree_path: worktree_path.value, reason: reason.value }));
  }
  parsed.sort((left, right) => compareCodePointStrings(left.worktree_path, right.worktree_path));
  return success(Object.freeze(parsed));
}

function exactObject(value: unknown, keys: readonly string[], field: string): DomainResult<Record<string, unknown>> {
  if (!isRecord(value)) return invalid(field, "expected an object");
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) return invalid(field, "contains an unknown field");
  if (keys.some((key) => !Object.hasOwn(value, key))) return invalid(field, "is missing a required field");
  return success(value);
}

function sessionId(value: unknown, field: string): DomainResult<string> {
  const parsed = boundedString(value, field);
  if (!parsed.ok) return parsed;
  if (parsed.value.length === 0) return invalid(field, "expected non-empty bounded text");
  return parsed;
}

function boundedString(value: unknown, field: string): DomainResult<string> {
  if (!validString(value, true)) return invalid(field, "expected bounded text");
  return success(value as string);
}

function validString(value: unknown, allowEmpty: boolean): value is string {
  return (
    typeof value === "string" &&
    (allowEmpty || value.length > 0) &&
    [...value].length <= MAX_TEXT_CODE_POINTS &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function nullableString(value: unknown, field: string): DomainResult<string | null> {
  if (value === null) return success(null);
  return boundedString(value, field);
}

function nullableEnum<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): DomainResult<T[number] | null> {
  if (value === null) return success(null);
  return enumValue(value, values, field);
}

function enumValue<const T extends readonly string[]>(
  value: unknown,
  values: T,
  field: string,
): DomainResult<T[number]> {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value))
    return invalid(field, "contains an unsupported value");
  return success(value as T[number]);
}

function invalid(field: string, reason: string): DomainResult<never> {
  return failure(
    new DomainError("INVALID_ARGUMENT", `Repository runtime observation field '${field}' is invalid: ${reason}.`, {
      field,
    }),
  );
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
