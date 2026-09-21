import path from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import {
  CGROUPS_V2_CONTRACT_ID,
  cleanupCgroupScope,
  readCgroupAccounting,
  readCgroupPopulation,
  type CgroupAccounting,
  type CgroupFileSystem,
  type CgroupPopulation,
  type CgroupScope,
} from "./cgroups-v2.js";

/** Versioned, bounded observation contract for one owned execution lease. */
export const SESSION_PROCESS_OBSERVATION_CONTRACT_ID = "nawabari.session-process-observation.v1" as const;

export type ExecutionLifecycleState = "active" | "terminating" | "terminal";

/**
 * The future execution-record producer is intentionally represented locally
 * as factual lease data.  It contains no registry authority and no caller
 * PID; the cgroup path is accepted only after identity validation below.
 */
export type SessionExecutionRecord = {
  readonly schema_version: 1;
  readonly session_id: string;
  readonly execution_id: string;
  readonly boot_id: string;
  readonly state: ExecutionLifecycleState;
  readonly cgroups: CgroupLeaseRecord | null;
};

export type CgroupLeaseRecord = {
  readonly contract_id: typeof CGROUPS_V2_CONTRACT_ID;
  readonly root: string;
  readonly parent: string;
  readonly path: string;
  readonly name: string;
  readonly boot_id: string;
  readonly identity: {
    readonly session_id: string;
    readonly execution_id: string;
  };
  /** Non-serialized injection used by hermetic tests and controlled runtimes. */
  readonly scope?: CgroupScope;
};

export type SessionProcessObservationOptions = {
  readonly filesystem?: CgroupFileSystem;
  /** Optional live boot observation supplied by the runtime owner. */
  readonly current_boot_id?: string;
};

export type OwnedExecutionObservation = {
  readonly contract_id: typeof SESSION_PROCESS_OBSERVATION_CONTRACT_ID;
  readonly session_id: string;
  readonly execution_id: string;
  readonly boot_id: string;
  readonly state: "active" | "empty" | "unknown";
  readonly cgroups: {
    readonly scope: string;
    readonly population: CgroupPopulation;
    readonly accounting: CgroupAccounting;
  } | null;
};

export type TerminationIntent = {
  readonly kind: "terminate";
  readonly session_id: string;
  readonly execution_id: string;
  readonly boot_id: string;
};

export type OwnedExecutionTermination = {
  readonly contract_id: typeof SESSION_PROCESS_OBSERVATION_CONTRACT_ID;
  readonly session_id: string;
  readonly execution_id: string;
  readonly boot_id: string;
  readonly killed: boolean;
  readonly population_before: CgroupPopulation;
  readonly population_after: CgroupPopulation;
  readonly scope_removed: boolean;
  /** Terminalization follows the observed zero-population and scope removal. */
  readonly record_terminalized: true;
  readonly record: SessionExecutionRecord;
  readonly retryable: boolean;
};

function observationError(message: string, details: JsonObject): DomainResult<never> {
  return failure(new DomainError("SANDBOX_CGROUP_CLEANUP_FAILED", message, details));
}

function validToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256 && !value.includes("\0");
}

function leaseScope(
  record: SessionExecutionRecord,
  options: SessionProcessObservationOptions,
): DomainResult<CgroupScope | null> {
  const lease = record.cgroups;
  if (lease === null) return success(null);
  if (options.current_boot_id !== undefined && options.current_boot_id !== record.boot_id) {
    return observationError("The execution record belongs to a different kernel boot.", {
      session_id: record.session_id,
      execution_id: record.execution_id,
    });
  }
  if (
    !validToken(record.session_id) ||
    !validToken(record.execution_id) ||
    !validToken(record.boot_id) ||
    !validToken(lease.boot_id) ||
    record.boot_id !== lease.boot_id ||
    lease.identity.session_id !== record.session_id ||
    lease.identity.execution_id !== record.execution_id
  ) {
    return observationError("The cgroups lease identity is not owned by this execution record.", {
      session_id: record.session_id,
      execution_id: record.execution_id,
      scope: lease.path,
    });
  }
  if (
    lease.contract_id !== CGROUPS_V2_CONTRACT_ID ||
    !path.isAbsolute(lease.root) ||
    !path.isAbsolute(lease.parent) ||
    !path.isAbsolute(lease.path) ||
    lease.root.includes("\0") ||
    lease.parent.includes("\0") ||
    lease.path.includes("\0") ||
    lease.path !== path.join(lease.root, "nawabari", lease.name) ||
    lease.parent !== path.join(lease.root, "nawabari") ||
    (lease.scope?.boot_id !== undefined && lease.scope.boot_id !== lease.boot_id) ||
    (lease.scope?.identity.session_id !== undefined && lease.scope.identity.session_id !== record.session_id) ||
    (lease.scope?.identity.execution_id !== undefined && lease.scope.identity.execution_id !== record.execution_id) ||
    (lease.scope?.path !== undefined && lease.scope.path !== lease.path)
  ) {
    return observationError("The cgroups lease path is not canonical for its identity.", {
      session_id: record.session_id,
      execution_id: record.execution_id,
      scope: lease.path,
    });
  }
  if (lease.scope !== undefined) return success(lease.scope);
  return success({
    contract_id: lease.contract_id,
    root: lease.root,
    parent: lease.parent,
    path: lease.path,
    name: lease.name,
    identity: lease.identity,
    boot_id: lease.boot_id,
    limits: {},
  });
}

/** Observe one owned execution without trusting a caller-supplied PID. */
export function observeOwnedExecution(
  record: SessionExecutionRecord,
  options: SessionProcessObservationOptions = {},
): DomainResult<OwnedExecutionObservation> {
  const scope = leaseScope(record, options);
  if (!scope.ok) return scope;
  if (scope.value === null) {
    return success({
      contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
      session_id: record.session_id,
      execution_id: record.execution_id,
      boot_id: record.boot_id,
      state: "unknown",
      cgroups: null,
    });
  }
  const population = readCgroupPopulation(scope.value, options.filesystem);
  const accounting = readCgroupAccounting(scope.value, options.filesystem);
  return success({
    contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
    session_id: record.session_id,
    execution_id: record.execution_id,
    boot_id: record.boot_id,
    state: population.state === "populated" ? "active" : population.state,
    cgroups: {
      scope: scope.value.name,
      population,
      accounting,
    },
  });
}

/**
 * Terminate only after an explicit identity/boot proof.  The cgroup kernel
 * control is the sole destructive operation; individual PIDs are never
 * signalled.  Cleanup returns retryable evidence when any postcondition is
 * not proven, preserving the lease for a later reconciliation attempt.
 */
export function terminateOwnedExecution(
  record: SessionExecutionRecord,
  intent: TerminationIntent,
  options: SessionProcessObservationOptions = {},
): DomainResult<OwnedExecutionTermination> {
  if (
    intent.kind !== "terminate" ||
    intent.session_id !== record.session_id ||
    intent.execution_id !== record.execution_id ||
    intent.boot_id !== record.boot_id
  ) {
    return observationError("The termination intent does not prove execution ownership.", {
      session_id: record.session_id,
      execution_id: record.execution_id,
    });
  }
  const scope = leaseScope(record, options);
  if (!scope.ok) return scope;
  if (scope.value === null) {
    return observationError("The execution has no cgroups lease to terminate.", {
      session_id: record.session_id,
      execution_id: record.execution_id,
    });
  }
  const populationBefore = readCgroupPopulation(scope.value, options.filesystem);
  if (populationBefore.state === "unknown") {
    return observationError("The cgroups scope occupancy is unknown; termination is not safe.", {
      scope: scope.value.name,
    });
  }
  const cleaned = cleanupCgroupScope(scope.value, options.filesystem);
  if (!cleaned.ok) return cleaned;
  const populationAfter = cleaned.value.after_population;
  if (populationAfter.state !== "empty") {
    return observationError("The cgroups scope did not prove empty after termination.", {
      scope: scope.value.name,
    });
  }
  return success({
    contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
    session_id: record.session_id,
    execution_id: record.execution_id,
    boot_id: record.boot_id,
    killed: populationBefore.state === "populated",
    population_before: populationBefore,
    population_after: populationAfter,
    scope_removed: cleaned.value.removed,
    record_terminalized: true,
    record: { ...record, state: "terminal" },
    retryable: false,
  });
}

/** Preserve the canonical `cgroups` serialization key and omit test seams. */
export function serializeSessionExecutionRecord(record: SessionExecutionRecord): JsonObject {
  const cgroups = record.cgroups;
  return {
    schema_version: record.schema_version,
    session_id: record.session_id,
    execution_id: record.execution_id,
    boot_id: record.boot_id,
    state: record.state,
    cgroups:
      cgroups === null
        ? null
        : {
            contract_id: cgroups.contract_id,
            root: cgroups.root,
            parent: cgroups.parent,
            path: cgroups.path,
            name: cgroups.name,
            boot_id: cgroups.boot_id,
            identity: {
              session_id: cgroups.identity.session_id,
              execution_id: cgroups.identity.execution_id,
            },
          },
  };
}
