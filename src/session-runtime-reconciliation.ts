import { DomainError, failure, success, type DomainResult, type JsonValue } from "./domain/errors.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";

export const RUNTIME_RECONCILIATION_CODES = Object.freeze([
  "managed-present", "managed-missing", "runtime-residual", "execution-active",
  "execution-unknown", "unmanaged-worktree", "safe-runtime-residual", "cleanup-incomplete",
] as const);
export type RuntimeReconciliationCode = (typeof RUNTIME_RECONCILIATION_CODES)[number];
export type RuntimeReconciliationDisposition = "observe" | "retain" | "reconcile-runtime-only" | "blocked";
export type RuntimeReconciliationAction =
  | "inspect-session" | "inspect-processes" | "retain-runtime-state"
  | "remove-owned-runtime-state" | "retry-runtime-cleanup" | "inspect-unmanaged-worktree";

export interface RuntimeReconciliationFinding {
  readonly session_id: string | null;
  readonly code: RuntimeReconciliationCode;
  readonly disposition: RuntimeReconciliationDisposition;
  readonly proposed_actions: readonly RuntimeReconciliationAction[];
  readonly reason: string | null;
  readonly worktree_path?: string;
}

export interface RuntimeReconciliationResult {
  readonly registry_revision: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly findings: readonly RuntimeReconciliationFinding[];
}

const MAX_ITEMS = 1024;
const MAX_FINDINGS = 2048;
const ACTIONS = new Set<RuntimeReconciliationAction>([
  "inspect-session", "inspect-processes", "retain-runtime-state", "remove-owned-runtime-state",
  "retry-runtime-cleanup", "inspect-unmanaged-worktree",
]);

type ProcessObservation = { session_id: string; status: "inactive" | "active" | "unknown"; reason: string | null };
type FilesystemObservation = { session_id: string; status: "clean" | "runtime-residual" | "cleanup-incomplete" | "unknown"; owner: "proven" | "unproven" | "unknown"; reason: string | null };
type LifecycleObservation = { session_id: string; state: "active" | "parking" | "parked" | "close-ready" | "blocked-recoverable" | "closed" | "discarded" | "stale-inconsistent"; physical_state: "present" | "missing" | "unmanaged" | "ambiguous" | null; recoverable_work: "present" | "absent" | "unknown"; integration: "proven" | "unproven" | "unknown"; cleanup: "complete" | "incomplete" | "unknown"; reason: string | null };

/** Purely classify the supplied repository observation; no repository I/O is performed. */
export function reconcileSessionRuntimeEvidence(
  snapshot: RepositoryRuntimeSnapshot,
): DomainResult<RuntimeReconciliationResult> {
  if (!snapshot || typeof snapshot !== "object") return invalid("snapshot", "expected an object");
  const processes = section(snapshot.observations.processes, "processes");
  const filesystem = section(snapshot.observations.filesystem, "filesystem");
  const lifecycle = section(snapshot.observations.lifecycle, "lifecycle");
  if (!processes.ok) return processes;
  if (!filesystem.ok) return filesystem;
  if (!lifecycle.ok) return lifecycle;

  const findings: RuntimeReconciliationFinding[] = [];
  for (const session of snapshot.sessions) {
    const process = processes.value?.get(session.sessionId) as ProcessObservation | undefined;
    const file = filesystem.value?.get(session.sessionId) as FilesystemObservation | undefined;
    const life = lifecycle.value?.get(session.sessionId) as LifecycleObservation | undefined;
    let finding: RuntimeReconciliationFinding;
    if (processes.value === null || filesystem.value === null || lifecycle.value === null || process === undefined) {
      finding = make(session.sessionId, "execution-unknown", "blocked", ["inspect-processes"], "required observation is unknown or missing");
    } else if (process.status === "active") {
      finding = make(session.sessionId, "execution-active", "blocked", ["inspect-processes"], process.reason);
    } else if (process.status === "unknown") {
      finding = make(session.sessionId, "execution-unknown", "blocked", ["inspect-processes"], process.reason);
    } else if (file !== undefined && file.status === "unknown") {
      finding = make(session.sessionId, "execution-unknown", "blocked", ["inspect-session"], file.reason);
    } else if (file === undefined || life === undefined) {
      finding = make(session.sessionId, "execution-unknown", "blocked", ["inspect-session"], "required observation is missing");
    } else if (file.status === "cleanup-incomplete") {
      const safe = process.status === "inactive" && file.owner === "proven";
      finding = safe
        ? make(session.sessionId, "cleanup-incomplete", "reconcile-runtime-only", ["retry-runtime-cleanup"], file.reason)
        : make(session.sessionId, "cleanup-incomplete", "blocked", ["inspect-session"], file.reason);
    } else if (file.status === "runtime-residual") {
      const safe = file.owner === "proven" && process.status === "inactive" &&
        (life.state === "parked" || life.state === "closed" || life.state === "discarded") &&
        life.recoverable_work === "absent" && life.integration === "proven";
      if (safe) finding = make(session.sessionId, "safe-runtime-residual", "reconcile-runtime-only", ["remove-owned-runtime-state"], file.reason);
      else if (file.owner === "proven" && process.status === "inactive") finding = make(session.sessionId, "runtime-residual", "retain", ["retain-runtime-state", "inspect-session"], file.reason);
      else finding = make(session.sessionId, "runtime-residual", "blocked", ["inspect-session"], file.reason);
    } else if (life.physical_state === "missing") {
      finding = make(session.sessionId, "managed-missing", "retain", ["inspect-session"], life.reason);
    } else {
      finding = make(session.sessionId, "managed-present", "observe", ["inspect-session"], file.reason ?? life.reason);
    }
    findings.push(finding);
  }
  if (filesystem.value !== null) {
    const raw = filesystem.raw_unmanaged;
    for (const entry of raw) findings.push(make(null, "unmanaged-worktree", "observe", ["inspect-unmanaged-worktree"], entry.reason, entry.worktree_path));
  }
  findings.sort((a, b) => (a.session_id ?? "\uffff").localeCompare(b.session_id ?? "\uffff") || a.code.localeCompare(b.code) || (a.worktree_path ?? "").localeCompare(b.worktree_path ?? ""));
  const truncated = findings.length > MAX_FINDINGS;
  const complete = snapshot.complete && processes.value !== null && filesystem.value !== null && lifecycle.value !== null && !truncated;
  return success(Object.freeze({ registry_revision: snapshot.registry.revision, complete, truncated, findings: Object.freeze(findings.slice(0, MAX_FINDINGS)) }));
}

function make(session_id: string | null, code: RuntimeReconciliationCode, disposition: RuntimeReconciliationDisposition, proposed_actions: readonly RuntimeReconciliationAction[], reason: string | null, worktree_path?: string): RuntimeReconciliationFinding {
  return Object.freeze({ session_id, code, disposition, proposed_actions: Object.freeze([...proposed_actions]), reason, ...(worktree_path === undefined ? {} : { worktree_path }) });
}

type ParsedSections = { value: Map<string, Record<string, unknown>> | null; raw_unmanaged: { worktree_path: string; reason: string | null }[] };
function section(observation: unknown, name: string): DomainResult<ParsedSections> {
  if (!observation || typeof observation !== "object") return success({ value: null, raw_unmanaged: [] });
  const o = observation as { status?: string; value?: JsonValue };
  if (o.status === "unknown") {
    const reason = (o as any).reason;
    return typeof reason === "string" && text(reason) ? success({ value: null, raw_unmanaged: [] }) : invalid(name, "unknown observation requires a bounded reason");
  }
  if (o.status !== "available" || !o.value || typeof o.value !== "object" || Array.isArray(o.value)) return invalid(name, "malformed observation");
  const value = o.value as Record<string, unknown>;
  const contract = { processes: "nawabari.repository-process-observation.v1", filesystem: "nawabari.repository-filesystem-observation.v1", lifecycle: "nawabari.repository-lifecycle-observation.v1" }[name as "processes" | "filesystem" | "lifecycle"];
  if (value.contract_id !== contract || value.schema_version !== 1) return invalid(name, "invalid contract_id or schema_version");
  const list = value.sessions;
  if (!Array.isArray(list) || list.length > MAX_ITEMS) return invalid(name, "sessions must be an array of at most 1024 entries");
  const map = new Map<string, Record<string, unknown>>();
  for (const item of list) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return invalid(name, "session entry must be an object");
    const id = (item as Record<string, unknown>).session_id;
    if (typeof id !== "string" || !text(id) || map.has(id)) return invalid(name, "session ids must be unique bounded text");
    const obj = item as Record<string, unknown>;
    if (typeof obj.reason !== "string" && obj.reason !== null) return invalid(name, "reason must be text or null");
    if (name === "processes" && !["inactive", "active", "unknown"].includes(String(obj.status))) return invalid(name, "invalid process status");
    if (name === "filesystem" && (!["clean", "runtime-residual", "cleanup-incomplete", "unknown"].includes(String(obj.status)) || !["proven", "unproven", "unknown"].includes(String(obj.owner)))) return invalid(name, "invalid filesystem status or owner");
    if (name === "lifecycle" && (!["active", "parking", "parked", "close-ready", "blocked-recoverable", "closed", "discarded", "stale-inconsistent"].includes(String(obj.state)) || (obj.physical_state !== null && !["present", "missing", "unmanaged", "ambiguous"].includes(String(obj.physical_state))) || !["present", "absent", "unknown"].includes(String(obj.recoverable_work)) || !["proven", "unproven", "unknown"].includes(String(obj.integration)) || !["complete", "incomplete", "unknown"].includes(String(obj.cleanup)))) return invalid(name, "invalid lifecycle observation");
    map.set(id, obj);
  }
  const unmanaged: { worktree_path: string; reason: string | null }[] = [];
  if (name === "filesystem") {
    const entries = value.unmanaged_worktrees;
    if (!Array.isArray(entries) || entries.length > MAX_ITEMS) return invalid(name, "unmanaged_worktrees must be an array of at most 1024 entries");
    const seen = new Set<string>();
    for (const item of entries) {
      if (!item || typeof item !== "object" || typeof (item as any).worktree_path !== "string" || !text((item as any).worktree_path) || seen.has((item as any).worktree_path) || ((item as any).reason !== null && typeof (item as any).reason !== "string")) return invalid(name, "invalid unmanaged worktree entry");
      seen.add((item as any).worktree_path); unmanaged.push({ worktree_path: (item as any).worktree_path, reason: (item as any).reason });
    }
  }
  return success({ value: map, raw_unmanaged: unmanaged });
}
function text(value: string): boolean { return value.length > 0 && [...value].length <= 4096 && !/[\u0000-\u001f\u007f]/u.test(value); }
function invalid(field: string, reason: string): DomainResult<never> { return failure(new DomainError("INVALID_ARGUMENT", `Runtime reconciliation field '${field}' is invalid: ${reason}.`, { field })); }
