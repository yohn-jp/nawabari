import { DomainError, failure, success, type DomainResult, type JsonValue } from "./domain/errors.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";
import { compareCodePointStrings } from "./resource-claims.js";

export const RESOURCE_COORDINATION_OBSERVATION_CONTRACT_ID =
  "nawabari.repository-coordination-observation.v1" as const;
export const RESOURCE_COORDINATION_OBSERVATION_SCHEMA_VERSION = 1 as const;

const MAX_TEXT_CODE_POINTS = 4_096;
const MAX_ROWS = 4_096;
const MAX_BLOCKERS_PER_ROW = 64;
const MAX_ACTIONS_PER_ROW = 32;
const MAX_PAGE_SIZE = MAX_ROWS;
const CURSOR_KEYS = ["last_resource", "snapshot_registry_revision"] as const;

export type ResourceCoordinationMode = "read" | "write" | "exclusive-write";
export type ResourceCoordinationRequestedMode = ResourceCoordinationMode | null;
export type ResourceCoordinationObservedChange = "modified" | "added" | "deleted" | "renamed" | "none" | "unknown";
export type ResourceCoordinationPermission = "allowed" | "blocked" | "unresolved";
export type ResourceCoordinationConflict = "none" | "read-write" | "write-write" | "exclusive" | "unknown";
export type ResourceCoordinationPhysicalModification = "none" | "observed" | "unknown";
export type ResourceCoordinationMergeability = "clean" | "conflict" | "not-applicable" | "unknown";

export interface ResourceCoordinationParticipant {
  readonly session_id: string;
  readonly worktree_path: string;
  readonly state: string;
  readonly claim_id: string;
  readonly mode: ResourceCoordinationMode;
  readonly requested_mode: ResourceCoordinationRequestedMode;
  readonly observed_change: ResourceCoordinationObservedChange;
  readonly integrated: boolean | null;
}

export interface ResourceCoordinationBlocker {
  readonly code: string;
  readonly session_id: string | null;
  readonly reason: string;
}

export interface FileSessionMatrixRow {
  readonly resource: string;
  readonly row_kind: "declared-selector" | "observed-path";
  readonly participants: readonly ResourceCoordinationParticipant[];
  readonly permission: ResourceCoordinationPermission;
  readonly conflict: ResourceCoordinationConflict;
  readonly physical_modification: ResourceCoordinationPhysicalModification;
  readonly mergeability: ResourceCoordinationMergeability;
  readonly classification: string;
  readonly blockers: readonly ResourceCoordinationBlocker[];
  readonly next_actions: readonly string[];
}

export interface FileSessionMatrixFilter {
  readonly limit?: number;
  readonly cursor?: string | null;
}

export type FileSessionMatrixProjection =
  | Readonly<{
      readonly status: "available";
      readonly rows: readonly FileSessionMatrixRow[];
      readonly truncated: boolean;
      readonly cursor: string | null;
    }>
  | Readonly<{
      readonly status: "unavailable";
      readonly reason: string;
      readonly rows: readonly [];
      readonly truncated: false;
      readonly cursor: null;
    }>;

interface CoordinationObservation {
  readonly rows: readonly FileSessionMatrixRow[];
}

interface ParsedCursor {
  readonly snapshot_registry_revision: number;
  readonly last_resource: string;
}

/**
 * Project only the accepted v1 coordination observation. Claims are
 * intentionally not consulted: the observation is the coordination
 * authority for this projection.
 */
export function projectFileSessionMatrix(
  snapshot: RepositoryRuntimeSnapshot,
  filter: FileSessionMatrixFilter = {},
): DomainResult<FileSessionMatrixProjection> {
  const parsedFilter = validateFilter(filter);
  if (!parsedFilter.ok) return parsedFilter;

  const observation = snapshot.observations.coordination;
  if (observation.status === "unknown") {
    return success(
      Object.freeze({
        status: "unavailable" as const,
        reason: observation.reason,
        rows: Object.freeze([]) as readonly [],
        truncated: false as const,
        cursor: null,
      }),
    );
  }

  const parsed = parseCoordinationValue(observation.value);
  if (!parsed.ok) return parsed;

  let cursor: ParsedCursor | null = null;
  if (parsedFilter.value.cursor !== null) {
    const decoded = decodeCursor(parsedFilter.value.cursor, snapshot.registry.revision);
    if (!decoded.ok) return decoded;
    cursor = decoded.value;
  }

  const rows = parsed.value.rows;
  const firstIndex = cursor === null ? 0 : rows.findIndex((row) => row.resource > cursor!.last_resource);
  const start = firstIndex < 0 ? rows.length : firstIndex;
  const page = rows.slice(start, start + parsedFilter.value.limit);
  const truncated = start + page.length < rows.length;
  const nextCursor = truncated === false || page.length === 0
    ? null
    : encodeCursor({
        snapshot_registry_revision: snapshot.registry.revision,
        last_resource: page.at(-1)!.resource,
      });

  return success(
    Object.freeze({
      status: "available" as const,
      rows: Object.freeze(page),
      truncated,
      cursor: nextCursor,
    }),
  );
}

function parseCoordinationValue(value: JsonValue): DomainResult<CoordinationObservation> {
  const root = exactObject(value, ["contract_id", "schema_version", "rows"], "coordination");
  if (!root.ok) return root;
  if (root.value.contract_id !== RESOURCE_COORDINATION_OBSERVATION_CONTRACT_ID) {
    return invalid("coordination.contract_id", "expected the v1 coordination contract");
  }
  if (root.value.schema_version !== RESOURCE_COORDINATION_OBSERVATION_SCHEMA_VERSION) {
    return invalid("coordination.schema_version", "expected schema version 1");
  }
  if (!Array.isArray(root.value.rows)) return invalid("coordination.rows", "expected an array");
  if (root.value.rows.length > MAX_ROWS) return invalid("coordination.rows", "at most 4096 rows are allowed");

  const resources = new Set<string>();
  const rows: FileSessionMatrixRow[] = [];
  for (const [index, value] of root.value.rows.entries()) {
    const row = parseRow(value, index);
    if (!row.ok) return row;
    if (resources.has(row.value.resource)) return invalid(`coordination.rows[${index}].resource`, "duplicate resource");
    resources.add(row.value.resource);
    rows.push(row.value);
  }
  rows.sort((left, right) => {
    const resource = compare(left.resource, right.resource);
    if (resource !== 0) return resource;
    return compareParticipants(left.participants, right.participants);
  });
  return success(Object.freeze({ rows: Object.freeze(rows) }));
}

function parseRow(value: JsonValue, index: number): DomainResult<FileSessionMatrixRow> {
  const field = `coordination.rows[${index}]`;
  const object = exactObject(
    value,
    [
      "resource",
      "participants",
      "permission",
      "conflict",
      "physical_modification",
      "mergeability",
      "classification",
      "blockers",
      "next_actions",
    ],
    field,
  );
  if (!object.ok) return object;
  const resource = boundedString(object.value.resource, `${field}.resource`);
  if (!resource.ok) return resource;
  const participants = parseParticipants(object.value.participants, `${field}.participants`);
  if (!participants.ok) return participants;
  const permission = enumValue(object.value.permission, ["allowed", "blocked", "unresolved"] as const, `${field}.permission`);
  if (!permission.ok) return permission;
  const conflict = enumValue(object.value.conflict, ["none", "read-write", "write-write", "exclusive", "unknown"] as const, `${field}.conflict`);
  if (!conflict.ok) return conflict;
  const physical = enumValue(object.value.physical_modification, ["none", "observed", "unknown"] as const, `${field}.physical_modification`);
  if (!physical.ok) return physical;
  const mergeability = enumValue(object.value.mergeability, ["clean", "conflict", "not-applicable", "unknown"] as const, `${field}.mergeability`);
  if (!mergeability.ok) return mergeability;
  const classification = boundedString(object.value.classification, `${field}.classification`);
  if (!classification.ok) return classification;
  const blockers = parseBlockers(object.value.blockers, `${field}.blockers`);
  if (!blockers.ok) return blockers;
  const actions = parseActions(object.value.next_actions, `${field}.next_actions`);
  if (!actions.ok) return actions;
  const rowKind = resource.value.includes("*") || resource.value.includes("?") || resource.value.includes("[") ||
    participants.value.every((participant) => !["modified", "added", "deleted", "renamed"].includes(participant.observed_change))
    ? "declared-selector"
    : "observed-path";
  return success(
    Object.freeze({
      resource: resource.value,
      row_kind: rowKind,
      participants: participants.value,
      permission: permission.value,
      conflict: conflict.value,
      physical_modification: physical.value,
      mergeability: mergeability.value,
      classification: classification.value,
      blockers: blockers.value,
      next_actions: actions.value,
    }),
  );
}

function parseParticipants(value: JsonValue, field: string): DomainResult<readonly ResourceCoordinationParticipant[]> {
  if (!Array.isArray(value)) return invalid(field, "expected an array");
  const sessions = new Set<string>();
  const participants: ResourceCoordinationParticipant[] = [];
  for (const [index, item] of value.entries()) {
    const child = `${field}[${index}]`;
    const object = exactObject(item, ["session_id", "worktree_path", "state", "claim_id", "mode", "requested_mode", "observed_change", "integrated"], child);
    if (!object.ok) return object;
    const session = boundedString(object.value.session_id, `${child}.session_id`);
    if (!session.ok) return session;
    if (sessions.has(session.value)) return invalid(`${child}.session_id`, "duplicate session_id");
    sessions.add(session.value);
    const worktree = boundedString(object.value.worktree_path, `${child}.worktree_path`);
    if (!worktree.ok) return worktree;
    const state = boundedString(object.value.state, `${child}.state`);
    if (!state.ok) return state;
    const claim = boundedString(object.value.claim_id, `${child}.claim_id`);
    if (!claim.ok) return claim;
    const mode = enumValue(object.value.mode, ["read", "write", "exclusive-write"] as const, `${child}.mode`);
    if (!mode.ok) return mode;
    const requested = nullableEnum(object.value.requested_mode, ["read", "write", "exclusive-write"] as const, `${child}.requested_mode`);
    if (!requested.ok) return requested;
    const observed = enumValue(object.value.observed_change, ["modified", "added", "deleted", "renamed", "none", "unknown"] as const, `${child}.observed_change`);
    if (!observed.ok) return observed;
    if (typeof object.value.integrated !== "boolean" && object.value.integrated !== null) {
      return invalid(`${child}.integrated`, "expected boolean or null");
    }
    participants.push(Object.freeze({
      session_id: session.value,
      worktree_path: worktree.value,
      state: state.value,
      claim_id: claim.value,
      mode: mode.value,
      requested_mode: requested.value,
      observed_change: observed.value,
      integrated: object.value.integrated,
    }));
  }
  participants.sort((left, right) => compare(left.session_id, right.session_id));
  return success(Object.freeze(participants));
}

function parseBlockers(value: JsonValue, field: string): DomainResult<readonly ResourceCoordinationBlocker[]> {
  if (!Array.isArray(value)) return invalid(field, "expected an array");
  if (value.length > MAX_BLOCKERS_PER_ROW) return invalid(field, "at most 64 blockers are allowed");
  const blockers: ResourceCoordinationBlocker[] = [];
  for (const [index, item] of value.entries()) {
    const child = `${field}[${index}]`;
    const object = exactObject(item, ["code", "session_id", "reason"], child);
    if (!object.ok) return object;
    const code = boundedString(object.value.code, `${child}.code`);
    if (!code.ok) return code;
    const session = nullableString(object.value.session_id, `${child}.session_id`);
    if (!session.ok) return session;
    const reason = boundedString(object.value.reason, `${child}.reason`);
    if (!reason.ok) return reason;
    blockers.push(Object.freeze({ code: code.value, session_id: session.value, reason: reason.value }));
  }
  return success(Object.freeze(blockers));
}

function parseActions(value: JsonValue, field: string): DomainResult<readonly string[]> {
  if (!Array.isArray(value)) return invalid(field, "expected an array");
  if (value.length > MAX_ACTIONS_PER_ROW) return invalid(field, "at most 32 actions are allowed");
  const actions: string[] = [];
  for (const [index, item] of value.entries()) {
    const action = boundedString(item, `${field}[${index}]`);
    if (!action.ok) return action;
    actions.push(action.value);
  }
  return success(Object.freeze(actions));
}

function validateFilter(filter: FileSessionMatrixFilter): DomainResult<Readonly<{ limit: number; cursor: string | null }>> {
  if (!isRecord(filter)) return invalid("filter", "expected an object");
  const allowed = new Set(["limit", "cursor"]);
  if (Object.keys(filter).some((key) => !allowed.has(key))) return invalid("filter", "contains an unknown field");
  const limit = filter.limit === undefined ? MAX_PAGE_SIZE : filter.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_PAGE_SIZE) {
    return invalid("filter.limit", "expected an integer from 1 through 4096");
  }
  const cursor = filter.cursor === undefined || filter.cursor === null ? null : filter.cursor;
  if (cursor !== null && typeof cursor !== "string") return invalid("filter.cursor", "expected text or null");
  return success(Object.freeze({ limit, cursor }));
}

function decodeCursor(value: string, revision: number): DomainResult<ParsedCursor> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    return invalid("filter.cursor", "expected an opaque cursor");
  }
  const object = exactObject(parsed, CURSOR_KEYS, "filter.cursor");
  if (!object.ok) return object;
  if (!Number.isSafeInteger(object.value.snapshot_registry_revision) || object.value.snapshot_registry_revision < 0) {
    return invalid("filter.cursor.snapshot_registry_revision", "expected a non-negative integer");
  }
  const resource = boundedString(object.value.last_resource, "filter.cursor.last_resource");
  if (!resource.ok) return resource;
  if (object.value.snapshot_registry_revision !== revision) {
    return failure(new DomainError("STALE_REGISTRY", "The file/session matrix cursor is stale.", {
      cursor_revision: object.value.snapshot_registry_revision,
      snapshot_revision: revision,
    }));
  }
  return success(Object.freeze({
    snapshot_registry_revision: object.value.snapshot_registry_revision,
    last_resource: resource.value,
  }));
}

function encodeCursor(cursor: ParsedCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
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

function enumValue<const T extends readonly string[]>(value: unknown, values: T, field: string): DomainResult<T[number]> {
  if (typeof value !== "string" || !(values as readonly string[]).includes(value)) return invalid(field, "contains an unsupported value");
  return success(value as T[number]);
}

function nullableEnum<const T extends readonly string[]>(value: unknown, values: T, field: string): DomainResult<T[number] | null> {
  if (value === null) return success(null);
  return enumValue(value, values, field);
}

function compare(left: string, right: string): number {
  return compareCodePointStrings(left, right);
}

function compareParticipants(left: readonly ResourceCoordinationParticipant[], right: readonly ResourceCoordinationParticipant[]): number {
  const count = Math.min(left.length, right.length);
  for (let index = 0; index < count; index += 1) {
    const result = compare(left[index]!.session_id, right[index]!.session_id);
    if (result !== 0) return result;
  }
  return left.length - right.length;
}

function invalid(field: string, reason: string): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", `Repository coordination observation field '${field}' is invalid: ${reason}.`, { field }));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
