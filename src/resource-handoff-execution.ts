import type { CgroupFileSystem } from "./domain/cgroups-v2.js";
import type { PersistedSessionExecutionRecord } from "./domain/session-execution-record.js";
import { observeOwnedExecution } from "./domain/session-process-observation.js";
import {
  RESOURCE_HANDOFF_SCHEMA_VERSION,
  type ResourceHandoffFence,
  type ResourceHandoffFenceController,
  type ResourceHandoffQuiescence,
} from "./resource-handoff.js";
import { ownedExecutionObservationRecord, readCurrentKernelBootId, type SessionRegistry } from "./session-registry.js";

/**
 * The #403 managed-runtime primitives consumed by the handoff fence. Each
 * registry read or admission write is independently lock-scoped; cgroup
 * observation happens outside RepositoryLock.
 */
export type ManagedResourceHandoffRuntime = Pick<
  SessionRegistry,
  | "readSessionRuntimeEpoch"
  | "closeSessionLaunchAdmission"
  | "getSessionLaunchAdmission"
  | "listSessionExecutions"
  | "cgroupObservationFilesystem"
>;

type ExecutionOccupancy = "active" | "empty" | "unknown";

/**
 * Adapt #403 launch admission, the durable execution ledger, and owned cgroup
 * observation to the resource-handoff fence contract. The adapter has no claim
 * mutation authority: the handoff producer still revalidates and commits.
 */
export function createManagedResourceHandoffExecution(
  runtime: ManagedResourceHandoffRuntime,
): ResourceHandoffFenceController {
  return {
    fence({ sessionId, operationId }): ResourceHandoffFence {
      const expectedEpoch = runtime.readSessionRuntimeEpoch(sessionId);
      const closed = runtime.closeSessionLaunchAdmission(sessionId, expectedEpoch);
      return {
        schemaVersion: RESOURCE_HANDOFF_SCHEMA_VERSION,
        sessionId,
        operationId,
        epoch: closed.runtimeEpoch,
        accepting: false,
        status: "fenced",
      };
    },
    awaitQuiescence(fence): ResourceHandoffQuiescence {
      const unknown = (executionIds: readonly string[], epoch = fence.epoch): ResourceHandoffQuiescence => ({
        sessionId: fence.sessionId,
        operationId: fence.operationId,
        epoch,
        status: "unknown",
        activeExecutionIds: [],
        unknownExecutionIds: executionIds,
      });

      const epoch = readEpoch(runtime, fence.sessionId);
      if (epoch === null) return unknown([]);
      if (epoch !== fence.epoch) return unknown([], epoch);
      const admission = runtime.getSessionLaunchAdmission(fence.sessionId);
      if (admission?.admission !== "closed" || admission.runtime_epoch !== fence.epoch) return unknown([]);

      let records: readonly PersistedSessionExecutionRecord[];
      try {
        records = runtime.listSessionExecutions(fence.sessionId);
      } catch {
        return unknown([]);
      }
      // Absence of durable execution evidence is never proof of quiescence.
      if (records.length === 0) return unknown([]);
      const executionIds = records.map((record) => record.execution_id);

      let currentBootId: string;
      try {
        currentBootId = readCurrentKernelBootId();
      } catch {
        return unknown(executionIds);
      }
      const filesystem = runtime.cgroupObservationFilesystem;
      const activeExecutionIds: string[] = [];
      const unknownExecutionIds: string[] = [];
      for (const record of records) {
        const occupancy = observeOccupancy(record, currentBootId, filesystem);
        if (occupancy === "active") activeExecutionIds.push(record.execution_id);
        if (occupancy === "unknown") unknownExecutionIds.push(record.execution_id);
      }

      // Bind the observation to the fence: any epoch advance while observing
      // makes the evidence stale for the producer.
      const observedEpoch = readEpoch(runtime, fence.sessionId);
      if (observedEpoch === null) return unknown(executionIds);
      return {
        sessionId: fence.sessionId,
        operationId: fence.operationId,
        epoch: observedEpoch,
        status: activeExecutionIds.length > 0 ? "active" : unknownExecutionIds.length > 0 ? "unknown" : "quiescent",
        activeExecutionIds,
        unknownExecutionIds,
      };
    },
  };
}

function readEpoch(runtime: ManagedResourceHandoffRuntime, sessionId: string): number | null {
  try {
    return runtime.readSessionRuntimeEpoch(sessionId);
  } catch {
    return null;
  }
}

function observeOccupancy(
  record: PersistedSessionExecutionRecord,
  currentBootId: string,
  filesystem: CgroupFileSystem | undefined,
): ExecutionOccupancy {
  try {
    const observed = observeOwnedExecution(ownedExecutionObservationRecord(record), {
      current_boot_id: currentBootId,
      ...(filesystem === undefined ? {} : { filesystem }),
    });
    if (!observed.ok || observed.value.cgroups === null) return "unknown";
    const population = observed.value.cgroups.population.state;
    if (observed.value.state === "active" || population === "populated") return "active";
    if (observed.value.state === "empty" && population === "empty") return "empty";
    return "unknown";
  } catch {
    return "unknown";
  }
}
