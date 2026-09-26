import {
  CGROUPS_V2_CONTRACT_ID,
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
  validateSessionExecutionRecord,
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

type MutableSessionResourceAggregate = {
  -readonly [
    Field in keyof SessionResourceAccountingProjection["aggregate"]
  ]: SessionResourceAccountingProjection["aggregate"][Field];
};

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

function emptyAggregate(complete: boolean): MutableSessionResourceAggregate {
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
  };
}

function identityMatchesRecord(
  record: PersistedSessionExecutionRecord,
  sessionId: string,
  observation: SessionExecutionIdentityObservation | undefined,
): observation is SessionExecutionIdentityObservation {
  if (
    observation === undefined ||
    !observation.matches ||
    observation.classification !== "matched" ||
    observation.session_id !== sessionId ||
    observation.execution_id !== record.execution_id ||
    record.session_id !== sessionId ||
    record.supervisor_pid === null ||
    record.supervisor_starttime === null
  ) {
    return false;
  }
  const cgroupName = deriveCgroupScopeName(record.cgroup_identity);
  const { expected, observed } = observation;
  return (
    expected.pid === record.supervisor_pid &&
    expected.starttime === record.supervisor_starttime &&
    expected.boot_id === record.boot_id &&
    expected.cgroup_name === cgroupName &&
    observed !== null &&
    observed.pid === expected.pid &&
    observed.starttime === expected.starttime &&
    observed.boot_id === expected.boot_id &&
    observed.cgroup_path === `/nawabari/${expected.cgroup_name}`
  );
}

type AvailableResourceEvidence = SessionExecutionResourceEvidence & { readonly accounting: CgroupAccounting };
type LimitEventField = "cpu_throttled" | "memory_limit_exceeded" | "pids_limit_exceeded";
type LimitCounterField = "cpu_throttled_usec" | "memory_oom_kill_events" | "memory_max_events" | "pids_max_events";

function aggregateLimitEvent(
  complete: boolean,
  available: readonly AvailableResourceEvidence[],
  eventField: LimitEventField,
  requiredCounters: readonly LimitCounterField[],
): boolean | null {
  if (available.some((entry) => entry.accounting[eventField])) return true;
  if (!complete) return null;
  return available.every((entry) => requiredCounters.every((field) => entry.accounting[field] === 0)) ? false : null;
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
    const validated = validateSessionExecutionRecord(record);
    if (!validated.ok) {
      return {
        execution_id: record.execution_id,
        status: "unavailable",
        accounting: null,
        reason: "identity-unverified",
      };
    }
    const verifiedRecord = validated.value;
    const observation = options.observations?.get(record.execution_id);
    const observed =
      observation === undefined
        ? observeExecutionIdentity(verifiedRecord, { reader: options.identity_reader })
        : undefined;
    const identity = observation ?? (observed?.ok === true ? observed.value : undefined);
    if (!identityMatchesRecord(verifiedRecord, sessionId, identity)) {
      return {
        execution_id: record.execution_id,
        status: "unavailable",
        accounting: null,
        reason: "identity-unverified",
      };
    }
    const scope = options.scopes?.get(record.execution_id) ?? scopeFor(verifiedRecord, options.root ?? CGROUPS_V2_ROOT);
    if (
      scope.contract_id !== CGROUPS_V2_CONTRACT_ID ||
      scope.identity.session_id !== verifiedRecord.session_id ||
      scope.identity.execution_id !== verifiedRecord.execution_id ||
      (scope.boot_id !== undefined && scope.boot_id !== verifiedRecord.boot_id) ||
      scope.name !== deriveCgroupScopeName(verifiedRecord.cgroup_identity) ||
      scope.parent !== `${scope.root}/nawabari` ||
      scope.path !== `${scope.parent}/${scope.name}`
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
    (entry): entry is AvailableResourceEvidence => entry.status === "available" && entry.accounting !== null,
  );
  const complete = !truncated && entries.every((entry) => entry.status === "available") && available.length > 0;
  const aggregate = emptyAggregate(complete);
  for (const field of NUMERIC_FIELDS) {
    let sum = 0;
    let found = false;
    for (const entry of available) {
      const value = entry.accounting[field];
      if (value !== null) {
        sum += value;
        found = true;
      }
    }
    aggregate[field] = found ? sum : null;
  }
  aggregate.cpu_throttled = aggregateLimitEvent(complete, available, "cpu_throttled", ["cpu_throttled_usec"]);
  aggregate.memory_limit_exceeded = aggregateLimitEvent(complete, available, "memory_limit_exceeded", [
    "memory_oom_kill_events",
    "memory_max_events",
  ]);
  aggregate.pids_limit_exceeded = aggregateLimitEvent(complete, available, "pids_limit_exceeded", ["pids_max_events"]);
  return { session_id: sessionId, entries, truncated, aggregate };
}
