import { DomainError, failure, success, type DomainResult, type JsonValue } from "./domain/errors.js";
import type { RepositoryRuntimeObservation, RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";
import {
  projectFileSessionMatrix,
  type FileSessionMatrixRow,
  type ResourceCoordinationBlocker,
} from "./resource-coordination-view.js";
import { compareCodePointStrings } from "./resource-claims.js";

export const SESSION_ATTENTION_CODES = Object.freeze([
  "coordination-blocked",
  "coordination-unresolved",
  "profile-drift",
  "process-unknown",
  "policy-violation",
  "unmanaged-worktree",
  "runtime-drift",
] as const);

export type SessionAttentionCode = (typeof SESSION_ATTENTION_CODES)[number];
export type SessionAttentionSeverity = "error" | "warning" | "info";

export interface SessionAttention {
  readonly identity: string;
  readonly code: SessionAttentionCode;
  readonly severity: SessionAttentionSeverity;
  readonly session_id: string;
  readonly owner_session_id: string | null;
  readonly resource: string;
  readonly reason: string;
  readonly evidence_revision: string;
}

export interface AgentRuntimeStatus {
  readonly session_id: string;
  readonly lifecycle_state: string | null;
  readonly physical_state: string | null;
  readonly profile_status: ProfileStatus;
  readonly runtime_status: string;
  readonly process_status: ProcessStatus;
  readonly blocker: SessionAttentionBlocker | null;
  readonly truncated: boolean;
  readonly cursor: string | null;
}

export interface SessionAttentionBlocker {
  readonly code: SessionAttentionCode;
  readonly owner_session_id: string | null;
  readonly resource: string;
  readonly reason: string;
}

type ProfileStatus = "current" | "drift" | "unknown";
type ProcessStatus = "inactive" | "active" | "unknown";

const MAX_SESSION_OBSERVATIONS = 1_024;
const MAX_TEXT_CODE_POINTS = 4_096;
const MAX_ATTENTION_BUDGET = 4_096;
const SEVERITY_ORDER: Readonly<Record<SessionAttentionSeverity, number>> = Object.freeze({
  error: 0,
  warning: 1,
  info: 2,
});

interface ProfileObservation {
  readonly session_id: string;
  readonly status: ProfileStatus;
  readonly profile_id: string | null;
  readonly reason: string | null;
}

interface ProcessObservation {
  readonly session_id: string;
  readonly status: ProcessStatus;
  readonly reason: string | null;
}

interface FilesystemObservation {
  readonly session_id: string;
  readonly status: "clean" | "violation" | "unknown";
  readonly reason: string | null;
}

interface LifecycleObservation {
  readonly session_id: string;
  readonly state: string;
  readonly physical_state: string | null;
  readonly reason: string | null;
}

interface AttentionObservationIndex {
  readonly coordination: readonly FileSessionMatrixRow[];
  readonly profiles: readonly ProfileObservation[];
  readonly processes: readonly ProcessObservation[];
  readonly filesystem: readonly FilesystemObservation[];
  readonly lifecycle: readonly LifecycleObservation[];
}

/** Project bounded operator attention from the canonical snapshot facts. */
export function projectSessionAttention(
  snapshot: RepositoryRuntimeSnapshot,
): DomainResult<readonly SessionAttention[]> {
  const parsed = parseObservationIndex(snapshot);
  if (!parsed.ok) return parsed;
  const evidence_revision = String(snapshot.registry.revision);
  const attention: SessionAttention[] = [];

  for (const row of parsed.value.coordination) {
    const code = coordinationCode(row);
    if (code === null) continue;
    const severity = code === "coordination-blocked" ? "error" : "warning";
    const blocker = row.blockers[0];
    const sessions = affectedSessions(row, blocker);
    for (const session_id of sessions) {
      attention.push(
        createAttention({
          code,
          severity,
          session_id,
          owner_session_id: blocker?.session_id ?? null,
          resource: row.resource,
          reason: blocker?.reason ?? coordinationReason(row, code),
          evidence_revision,
        }),
      );
    }
  }

  for (const profile of parsed.value.profiles) {
    if (profile.status === "drift") {
      attention.push(
        createAttention({
          code: "profile-drift",
          severity: "info",
          session_id: profile.session_id,
          owner_session_id: null,
          resource: "",
          reason: profile.reason ?? "profile drift",
          evidence_revision,
        }),
      );
    }
  }

  for (const process of parsed.value.processes) {
    if (process.status === "unknown") {
      attention.push(
        createAttention({
          code: "process-unknown",
          severity: "warning",
          session_id: process.session_id,
          owner_session_id: null,
          resource: "",
          reason: process.reason ?? "process status is unknown",
          evidence_revision,
        }),
      );
    }
  }

  for (const filesystem of parsed.value.filesystem) {
    if (filesystem.status === "violation") {
      attention.push(
        createAttention({
          code: "policy-violation",
          severity: "error",
          session_id: filesystem.session_id,
          owner_session_id: null,
          resource: "",
          reason: filesystem.reason ?? "filesystem policy violation",
          evidence_revision,
        }),
      );
    }
  }

  for (const lifecycle of parsed.value.lifecycle) {
    const code =
      lifecycle.state === "unmanaged" || lifecycle.physical_state === "unmanaged"
        ? "unmanaged-worktree"
        : lifecycle.state === "stale-inconsistent" || lifecycle.state === "blocked-recoverable"
          ? "runtime-drift"
          : null;
    if (code === null) continue;
    attention.push(
      createAttention({
        code,
        severity: "warning",
        session_id: lifecycle.session_id,
        owner_session_id: null,
        resource: "",
        reason: lifecycle.reason ?? lifecycle.state,
        evidence_revision,
      }),
    );
  }

  const byIdentity = new Map<string, SessionAttention>();
  for (const item of attention) {
    if (!byIdentity.has(item.identity)) byIdentity.set(item.identity, item);
  }
  const result = [...byIdentity.values()];
  result.sort(compareAttention);
  return success(Object.freeze(result));
}

/** Project only the selected session's bounded runtime-health facts. */
export function projectAgentRuntimeStatus(
  snapshot: RepositoryRuntimeSnapshot,
  sessionId: string,
  budget: number,
): DomainResult<AgentRuntimeStatus> {
  if (typeof sessionId !== "string" || sessionId.length === 0 || [...sessionId].length > MAX_TEXT_CODE_POINTS) {
    return invalid("sessionId", "expected bounded text");
  }
  if (!Number.isSafeInteger(budget) || budget < 0 || budget > MAX_ATTENTION_BUDGET) {
    return invalid("budget", "expected an integer from 0 through 4096");
  }
  const parsed = parseObservationIndex(snapshot);
  if (!parsed.ok) return parsed;
  if (!snapshot.sessions.some((session) => session.sessionId === sessionId)) {
    return failure(
      new DomainError("SESSION_NOT_FOUND", `Session '${sessionId}' was not found.`, { session_id: sessionId }),
    );
  }
  const attention = projectSessionAttention(snapshot);
  if (!attention.ok) return attention;
  const ownAttention = attention.value.filter((item) => item.session_id === sessionId);
  const blocker = ownAttention.find((item) => item.severity !== "info");
  const profile = parsed.value.profiles.find((item) => item.session_id === sessionId);
  const process = parsed.value.processes.find((item) => item.session_id === sessionId);
  const lifecycle = parsed.value.lifecycle.find((item) => item.session_id === sessionId);
  const truncated = ownAttention.length > budget;
  const cursor = truncated
    ? encodeStatusCursor(snapshot.registry.revision, ownAttention[Math.max(0, budget - 1)]?.resource ?? "")
    : null;

  return success(
    Object.freeze({
      session_id: sessionId,
      lifecycle_state: lifecycle?.state ?? null,
      physical_state: lifecycle?.physical_state ?? null,
      profile_status: profile?.status ?? "unknown",
      runtime_status: lifecycle?.state ?? "unknown",
      process_status: process?.status ?? "unknown",
      blocker:
        blocker === undefined
          ? null
          : Object.freeze({
              code: blocker.code,
              owner_session_id: blocker.owner_session_id,
              resource: blocker.resource,
              reason: blocker.reason,
            }),
      truncated,
      cursor,
    }),
  );
}

function parseObservationIndex(snapshot: RepositoryRuntimeSnapshot): DomainResult<AttentionObservationIndex> {
  const matrix = projectFileSessionMatrix(snapshot, { limit: 4_096 });
  if (!matrix.ok) return matrix;
  const coordination = matrix.value.status === "available" ? matrix.value.rows : [];
  const profiles = parseProfiles(snapshot.observations.profiles);
  if (!profiles.ok) return profiles;
  const processes = parseProcesses(snapshot.observations.processes);
  if (!processes.ok) return processes;
  const filesystem = parseFilesystem(snapshot.observations.filesystem);
  if (!filesystem.ok) return filesystem;
  const lifecycle = parseLifecycle(snapshot.observations.lifecycle);
  if (!lifecycle.ok) return lifecycle;
  return success(
    Object.freeze({
      coordination,
      profiles: profiles.value,
      processes: processes.value,
      filesystem: filesystem.value,
      lifecycle: lifecycle.value,
    }),
  );
}

function parseProfiles(
  observation: RepositoryRuntimeObservation<JsonValue>,
): DomainResult<readonly ProfileObservation[]> {
  if (observation.status === "unknown") return success(Object.freeze([]));
  const root = exactObject(observation.value, ["contract_id", "schema_version", "sessions"], "profiles");
  if (!root.ok) return root;
  if (root.value.contract_id !== "nawabari.repository-profile-observation.v1")
    return invalid("profiles.contract_id", "expected the v1 profile contract");
  if (root.value.schema_version !== 1) return invalid("profiles.schema_version", "expected schema version 1");
  return parseSessionArray(root.value.sessions, "profiles", (item, field) => {
    const object = exactObject(item, ["session_id", "status", "profile_id", "reason"], field);
    if (!object.ok) return object;
    const session_id = boundedString(object.value.session_id, `${field}.session_id`);
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
  });
}

function parseProcesses(
  observation: RepositoryRuntimeObservation<JsonValue>,
): DomainResult<readonly ProcessObservation[]> {
  if (observation.status === "unknown") return success(Object.freeze([]));
  const root = exactObject(observation.value, ["contract_id", "schema_version", "sessions"], "processes");
  if (!root.ok) return root;
  if (root.value.contract_id !== "nawabari.repository-process-observation.v1")
    return invalid("processes.contract_id", "expected the v1 process contract");
  if (root.value.schema_version !== 1) return invalid("processes.schema_version", "expected schema version 1");
  return parseSessionArray(root.value.sessions, "processes", (item, field) => {
    const object = exactObject(item, ["session_id", "status", "reason"], field);
    if (!object.ok) return object;
    const session_id = boundedString(object.value.session_id, `${field}.session_id`);
    if (!session_id.ok) return session_id;
    const status = enumValue(object.value.status, ["inactive", "active", "unknown"] as const, `${field}.status`);
    if (!status.ok) return status;
    const reason = nullableString(object.value.reason, `${field}.reason`);
    if (!reason.ok) return reason;
    return success(Object.freeze({ session_id: session_id.value, status: status.value, reason: reason.value }));
  });
}

function parseFilesystem(
  observation: RepositoryRuntimeObservation<JsonValue>,
): DomainResult<readonly FilesystemObservation[]> {
  if (observation.status === "unknown") return success(Object.freeze([]));
  const root = exactObject(observation.value, ["contract_id", "schema_version", "sessions"], "filesystem");
  if (!root.ok) return root;
  if (root.value.contract_id !== "nawabari.repository-filesystem-observation.v1")
    return invalid("filesystem.contract_id", "expected the v1 filesystem contract");
  if (root.value.schema_version !== 1) return invalid("filesystem.schema_version", "expected schema version 1");
  return parseSessionArray(root.value.sessions, "filesystem", (item, field) => {
    const object = exactObject(item, ["session_id", "status", "reason"], field);
    if (!object.ok) return object;
    const session_id = boundedString(object.value.session_id, `${field}.session_id`);
    if (!session_id.ok) return session_id;
    const status = enumValue(object.value.status, ["clean", "violation", "unknown"] as const, `${field}.status`);
    if (!status.ok) return status;
    const reason = nullableString(object.value.reason, `${field}.reason`);
    if (!reason.ok) return reason;
    return success(Object.freeze({ session_id: session_id.value, status: status.value, reason: reason.value }));
  });
}

function parseLifecycle(
  observation: RepositoryRuntimeObservation<JsonValue>,
): DomainResult<readonly LifecycleObservation[]> {
  if (observation.status === "unknown") return success(Object.freeze([]));
  const root = exactObject(observation.value, ["contract_id", "schema_version", "sessions"], "lifecycle");
  if (!root.ok) return root;
  if (root.value.contract_id !== "nawabari.repository-lifecycle-observation.v1")
    return invalid("lifecycle.contract_id", "expected the v1 lifecycle contract");
  if (root.value.schema_version !== 1) return invalid("lifecycle.schema_version", "expected schema version 1");
  return parseSessionArray(root.value.sessions, "lifecycle", (item, field) => {
    const object = exactObject(item, ["session_id", "state", "physical_state", "reason"], field);
    if (!object.ok) return object;
    const session_id = boundedString(object.value.session_id, `${field}.session_id`);
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
        reason: reason.value,
      }),
    );
  });
}

function parseSessionArray<T>(
  value: unknown,
  name: string,
  parser: (value: unknown, field: string) => DomainResult<T>,
): DomainResult<readonly T[]> {
  if (!Array.isArray(value)) return invalid(`${name}.sessions`, "expected an array");
  if (value.length > MAX_SESSION_OBSERVATIONS) return invalid(`${name}.sessions`, "at most 1024 sessions are allowed");
  const seen = new Set<string>();
  const entries: T[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = parser(item, `${name}.sessions[${index}]`);
    if (!parsed.ok) return parsed;
    const sessionId = (parsed.value as { session_id: string }).session_id;
    if (seen.has(sessionId)) return invalid(`${name}.sessions[${index}].session_id`, "duplicate session_id");
    seen.add(sessionId);
    entries.push(parsed.value);
  }
  entries.sort((left, right) =>
    compare((left as { session_id: string }).session_id, (right as { session_id: string }).session_id),
  );
  return success(Object.freeze(entries));
}

function coordinationCode(row: FileSessionMatrixRow): SessionAttentionCode | null {
  if (row.permission === "blocked" || row.blockers.length > 0) return "coordination-blocked";
  if (row.permission === "unresolved" || row.conflict === "unknown" || row.mergeability === "unknown") {
    return "coordination-unresolved";
  }
  return null;
}

function affectedSessions(
  row: FileSessionMatrixRow,
  blocker: ResourceCoordinationBlocker | undefined,
): readonly string[] {
  const blockedSession = blocker?.session_id;
  if (blockedSession !== undefined && blockedSession !== null) return [blockedSession];
  const sessions = row.participants.map((participant) => participant.session_id);
  return sessions.length === 0 ? [""] : sessions;
}

function coordinationReason(row: FileSessionMatrixRow, code: SessionAttentionCode): string {
  if (code === "coordination-blocked")
    return row.permission === "blocked" ? "coordination permission is blocked" : "coordination has blockers";
  if (row.permission === "unresolved") return "coordination permission is unresolved";
  if (row.conflict === "unknown") return "coordination conflict is unknown";
  return "coordination mergeability is unknown";
}

function createAttention(input: Omit<SessionAttention, "identity">): SessionAttention {
  const identity = JSON.stringify([input.code, input.session_id, input.resource, input.evidence_revision]);
  return Object.freeze({ identity, ...input });
}

function compareAttention(left: SessionAttention, right: SessionAttention): number {
  const severity = SEVERITY_ORDER[left.severity] - SEVERITY_ORDER[right.severity];
  if (severity !== 0) return severity;
  const code = compare(left.code, right.code);
  if (code !== 0) return code;
  const session = compare(left.session_id, right.session_id);
  if (session !== 0) return session;
  return compare(left.resource, right.resource);
}

function encodeStatusCursor(snapshot_registry_revision: number, last_resource: string): string {
  return Buffer.from(JSON.stringify({ snapshot_registry_revision, last_resource }), "utf8").toString("base64url");
}

function exactObject(value: unknown, keys: readonly string[], field: string): DomainResult<Record<string, unknown>> {
  if (!isRecord(value)) return invalid(field, "expected an object");
  const expected = new Set(keys);
  if (Object.keys(value).some((key) => !expected.has(key))) return invalid(field, "contains an unknown field");
  if (keys.some((key) => !Object.hasOwn(value, key))) return invalid(field, "is missing a required field");
  return success(value);
}

function boundedString(value: unknown, field: string): DomainResult<string> {
  if (typeof value !== "string") return invalid(field, "expected text");
  if ([...value].length > MAX_TEXT_CODE_POINTS) return invalid(field, "exceeds 4096 code points");
  return success(value);
}

function nullableString(value: unknown, field: string): DomainResult<string | null> {
  if (value === null) return success(null);
  return boundedString(value, field);
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

function compare(left: string, right: string): number {
  return compareCodePointStrings(left, right);
}

function invalid(field: string, reason: string): DomainResult<never> {
  return failure(
    new DomainError("INVALID_ARGUMENT", `Repository runtime observation field '${field}' is invalid: ${reason}.`, {
      field,
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
