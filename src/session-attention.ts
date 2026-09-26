import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";
import {
  parseRepositoryRuntimeObservations,
  type RepositoryRuntimeFilesystemObservation,
  type RepositoryRuntimeLifecycleObservation,
  type RepositoryRuntimeProfileObservation,
  type RepositoryRuntimeProcessObservation,
} from "./repository-runtime-observations.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";
import type { SessionRuntimeHistory } from "./session-runtime-history.js";
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
  readonly history?: SessionRuntimeHistory;
}

export interface SessionAttentionBlocker {
  readonly code: SessionAttentionCode;
  readonly owner_session_id: string | null;
  readonly resource: string;
  readonly reason: string;
}

type ProfileStatus = "current" | "drift" | "unknown";
type ProcessStatus = "inactive" | "active" | "unknown";

const MAX_TEXT_CODE_POINTS = 4_096;
const MAX_ATTENTION_BUDGET = 4_096;
const SEVERITY_ORDER: Readonly<Record<SessionAttentionSeverity, number>> = Object.freeze({
  error: 0,
  warning: 1,
  info: 2,
});

interface AttentionObservationIndex {
  readonly coordination: readonly FileSessionMatrixRow[];
  readonly profiles: ReadonlyMap<string, RepositoryRuntimeProfileObservation>;
  readonly processes: ReadonlyMap<string, RepositoryRuntimeProcessObservation>;
  readonly filesystem: ReadonlyMap<string, RepositoryRuntimeFilesystemObservation>;
  readonly lifecycle: ReadonlyMap<string, RepositoryRuntimeLifecycleObservation>;
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

  for (const profile of parsed.value.profiles.values()) {
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

  for (const process of parsed.value.processes.values()) {
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

  for (const filesystem of parsed.value.filesystem.values()) {
    if (filesystem.policy_status === "violation") {
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

  for (const lifecycle of parsed.value.lifecycle.values()) {
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
  const profile = parsed.value.profiles.get(sessionId);
  const process = parsed.value.processes.get(sessionId);
  const lifecycle = parsed.value.lifecycle.get(sessionId);
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
      ...(snapshot.history?.[sessionId] === undefined ? {} : { history: snapshot.history[sessionId] }),
    }),
  );
}

function parseObservationIndex(snapshot: RepositoryRuntimeSnapshot): DomainResult<AttentionObservationIndex> {
  const matrix = projectFileSessionMatrix(snapshot, { limit: 4_096 });
  if (!matrix.ok) return matrix;
  const coordination = matrix.value.status === "available" ? matrix.value.rows : [];
  const observations = parseRepositoryRuntimeObservations(snapshot);
  if (!observations.ok) return observations;
  return success(
    Object.freeze({
      coordination,
      profiles: observations.value.profiles,
      processes: observations.value.processes,
      filesystem: observations.value.filesystem,
      lifecycle: observations.value.lifecycle,
    }),
  );
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
