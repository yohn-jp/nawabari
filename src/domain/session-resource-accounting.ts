import {
  CGROUPS_V2_ROOT,
  deriveCgroupScopeName,
  readCgroupAccounting,
  readCgroupPopulation,
  type CgroupAccounting,
  type CgroupFileSystem,
  type CgroupScope,
} from "./cgroups-v2.js";
import {
  observeExecutionIdentity,
  type SessionExecutionIdentityObservation,
  type SessionExecutionIdentityReader,
  type PersistedSessionExecutionRecord,
} from "./session-execution-record.js";

export type SessionExecutionResourceEvidence = Readonly<{
  readonly execution_id: string;
  readonly status: "available" | "unavailable";
  readonly accounting: CgroupAccounting | null;
  readonly reason: null | "identity-unverified" | "cgroup-unavailable" | "accounting-unreadable";
}>;

export type SessionResourceAccountingProjection = Readonly<{
  readonly session_id: string;
  readonly entries: readonly SessionExecutionResourceEvidence[];
  readonly truncated: boolean;
  readonly aggregate: Readonly<{
    readonly complete: boolean;
    readonly cpu_usage_usec: number | null;
    readonly cpu_user_usec: number | null;
    readonly cpu_system_usec: number | null;
    readonly cpu_throttled_usec: number | null;
    readonly memory_current_bytes: number | null;
    readonly memory_peak_bytes: null;
    readonly pids_current: number | null;
    readonly pids_max_events: number | null;
    readonly memory_oom_kill_events: number | null;
    readonly memory_max_events: number | null;
    readonly cpu_throttled: boolean | null;
    readonly memory_limit_exceeded: boolean | null;
    readonly pids_limit_exceeded: boolean | null;
  }>;
}>;

export type SessionResourceAccountingOptions = Readonly<{
  readonly session_id?: string;
  readonly filesystem?: CgroupFileSystem;
  readonly root?: string;
  readonly identity_reader?: SessionExecutionIdentityReader;
  readonly observations?: ReadonlyMap<string, SessionExecutionIdentityObservation>;
  readonly scopes?: ReadonlyMap<string, CgroupScope>;
}>;

const NUMERIC_FIELDS = [
  "cpu_usage_usec",
  "cpu_user_usec",
  "cpu_system_usec",
  "cpu_throttled_usec",
  "memory_current_bytes",
  "pids_current",
  "pids_max_events",
  "memory_oom_kill_events",
  "memory_max_events",
] as const;

function scopeFor(record: PersistedSessionExecutionRecord, root: string): CgroupScope {
  const name = deriveCgroupScopeName(record.cgroup_identity);
  return {
    contract_id: "nawabari.cgroups-v2.v1",
    root,
    parent: `${root}/nawabari`,
    path: `${root}/nawabari/${name}`,
    name,
    identity: record.cgroup_identity,
    boot_id: record.boot_id,
    limits: {},
  };
}

function emptyAggregate(complete: boolean) {
  return {
    complete,
    cpu_usage_usec: null,
    cpu_user_usec: null,
    cpu_system_usec: null,
    cpu_throttled_usec: null,
    memory_current_bytes: null,
    memory_peak_bytes: null,
    pids_current: null,
    pids_max_events: null,
    memory_oom_kill_events: null,
    memory_max_events: null,
    cpu_throttled: null,
    memory_limit_exceeded: null,
    pids_limit_exceeded: null,
  } as const;
}

/** Project verified, bounded execution accounting. This function has no lifecycle authority. */
export function projectSessionResourceAccounting(
  executions: readonly PersistedSessionExecutionRecord[],
  options: SessionResourceAccountingOptions = {},
): SessionResourceAccountingProjection {
  const sessionId = options.session_id ?? executions[0]?.session_id ?? "";
  const ordered = executions
    .filter((entry) => entry.session_id === sessionId)
    .slice()
    .sort((a, b) => a.execution_id.localeCompare(b.execution_id));
  const truncated = ordered.length > 256;
  const selected = ordered.slice(0, 256);
  const entries = selected.map((record): SessionExecutionResourceEvidence => {
    const observation = options.observations?.get(record.execution_id);
    const observed =
      observation === undefined ? observeExecutionIdentity(record, { reader: options.identity_reader }) : undefined;
    const identity = observation ?? (observed?.ok === true ? observed.value : undefined);
    if (
      identity === undefined ||
      !identity.matches ||
      identity.session_id !== sessionId ||
      identity.execution_id !== record.execution_id
    ) {
      return {
        execution_id: record.execution_id,
        status: "unavailable",
        accounting: null,
        reason: "identity-unverified",
      };
    }
    const scope = options.scopes?.get(record.execution_id) ?? scopeFor(record, options.root ?? CGROUPS_V2_ROOT);
    if (
      scope.identity.session_id !== record.session_id ||
      scope.identity.execution_id !== record.execution_id ||
      scope.name !== deriveCgroupScopeName(record.cgroup_identity) ||
      scope.path !== `${scope.root}/nawabari/${scope.name}`
    ) {
      return {
        execution_id: record.execution_id,
        status: "unavailable",
        accounting: null,
        reason: "identity-unverified",
      };
    }
    try {
      if (options.filesystem !== undefined && !options.filesystem.statSync(scope.path).isDirectory()) {
        return {
          execution_id: record.execution_id,
          status: "unavailable",
          accounting: null,
          reason: "cgroup-unavailable",
        };
      }
    } catch {
      return {
        execution_id: record.execution_id,
        status: "unavailable",
        accounting: null,
        reason: "cgroup-unavailable",
      };
    }
    if (readCgroupPopulation(scope, options.filesystem).state === "unknown") {
      return {
        execution_id: record.execution_id,
        status: "unavailable",
        accounting: null,
        reason: "cgroup-unavailable",
      };
    }
    const accounting = readCgroupAccounting(scope, options.filesystem);
    if (NUMERIC_FIELDS.every((field) => accounting[field] === null)) {
      return {
        execution_id: record.execution_id,
        status: "unavailable",
        accounting: null,
        reason: "accounting-unreadable",
      };
    }
    return { execution_id: record.execution_id, status: "available", accounting, reason: null };
  });
  const available = entries.filter(
    (entry): entry is SessionExecutionResourceEvidence & { accounting: CgroupAccounting } =>
      entry.status === "available" && entry.accounting !== null,
  );
  const complete = !truncated && entries.every((entry) => entry.status === "available") && available.length > 0;
  const aggregate = emptyAggregate(complete) as any;
  for (const field of NUMERIC_FIELDS) {
    aggregate[field] =
      available.length > 0 && available.every((entry) => entry.accounting[field] !== null)
        ? available.reduce((sum, entry) => sum + (entry.accounting[field] as number), 0)
        : null;
  }
  for (const field of ["cpu_throttled", "memory_limit_exceeded", "pids_limit_exceeded"] as const) {
    aggregate[field] = complete ? available.some((entry) => entry.accounting[field]) : null;
  }
  return { session_id: sessionId, entries, truncated, aggregate };
}
