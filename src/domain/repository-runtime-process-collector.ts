import {
  REPOSITORY_PROCESS_OBSERVATION_V1,
  type RepositoryRuntimeProcessObservation,
} from "../repository-runtime-observations.js";
import type { RepositoryRuntimeObservation } from "../repository-runtime-snapshot.js";
import type { JsonValue } from "./errors.js";
import { observeOwnedExecution } from "./session-process-observation.js";
import { readCurrentKernelBootId, ownedExecutionObservationRecord, type SessionRegistry } from "../session-registry.js";
import { compareCodePointStrings } from "../resource-claims.js";

const PROCESS_OBSERVATION_MAX_SESSIONS = 1_024;

const REASONS = Object.freeze({
  bootUnavailable: "current kernel boot identity is unavailable",
  cgroupUnknown: "owned cgroup population is unavailable or inconsistent",
  executionIdentityMismatch: "owned execution identity does not match its durable record",
  executionsMissing: "no durable execution records are available",
  leaseMissing: "durable execution record has no owned cgroup lease",
  partialExecutions: "at least one owned execution is active; other executions are unknown",
  registryUnavailable: "durable execution registry is unavailable",
  registryChanged: "registry execution source changed during process observation",
  sessionBoundsExceeded: "process observation exceeds the supported session bound",
  timeUnavailable: "process observation time is unavailable",
} as const);

export type RepositoryRuntimeProcessCollectorOptions = Readonly<{
  /** A clock seam for deterministic observations; it supplies time, never authority. */
  readonly now?: () => Date;
  /** A boot-identity seam for deterministic or controlled runtimes. */
  readonly readBootId?: () => string;
}>;

type ExecutionSample = Readonly<{
  readonly repository_id: string;
  readonly session_id: string;
  readonly execution_id: string;
  readonly boot_id: string;
  readonly cgroup_name: string | null;
  readonly observed_at: string | null;
  readonly status: "active" | "inactive" | "unknown";
  readonly reason: string | null;
}>;

/**
 * Collect the parser-compatible process summary from current durable execution
 * records and their owned cgroups. This producer is read-only: physical
 * population is observed afresh even when the registry revision is unchanged.
 */
export function collectRepositoryRuntimeProcessObservation(
  registry: SessionRegistry,
  options: RepositoryRuntimeProcessCollectorOptions = {},
): RepositoryRuntimeObservation<JsonValue> {
  const now = options.now ?? (() => new Date());
  let initialView;
  try {
    initialView = registry.readRepositoryView();
  } catch {
    return unknownObservation(now, REASONS.registryUnavailable);
  }

  if (initialView.sessions.length > PROCESS_OBSERVATION_MAX_SESSIONS) {
    return unknownObservation(now, REASONS.sessionBoundsExceeded);
  }

  let bootId: string;
  try {
    bootId = (options.readBootId ?? readCurrentKernelBootId)();
  } catch {
    return unknownObservation(now, REASONS.bootUnavailable);
  }
  if (typeof bootId !== "string" || bootId.length === 0 || bootId.length > 256 || bootId.includes("\0")) {
    return unknownObservation(now, REASONS.bootUnavailable);
  }

  const samples: RepositoryRuntimeProcessObservation[] = [];
  const sessions = [...initialView.sessions].sort((left, right) =>
    compareCodePointStrings(left.sessionId, right.sessionId),
  );

  for (const session of sessions) {
    let records;
    try {
      records = registry.listSessionExecutions(session.sessionId);
    } catch {
      samples.push(unknownSession(session.sessionId, REASONS.registryUnavailable));
      continue;
    }

    if (records.length === 0) {
      samples.push(unknownSession(session.sessionId, REASONS.executionsMissing));
      continue;
    }

    const executionSamples: ExecutionSample[] = records.map((record) => {
      if (record.session_id !== session.sessionId) {
        return unknownExecution(
          initialView.repositoryId,
          session.sessionId,
          record.execution_id,
          record.boot_id,
          null,
          null,
          REASONS.executionIdentityMismatch,
        );
      }

      const ownedRecord = ownedExecutionObservationRecord(record);
      const expectedCgroupName = ownedRecord.cgroups?.name ?? null;
      if (ownedRecord.cgroups === null) {
        return unknownExecution(
          initialView.repositoryId,
          session.sessionId,
          record.execution_id,
          record.boot_id,
          null,
          null,
          REASONS.leaseMissing,
        );
      }

      const observation = observeOwnedExecution(ownedRecord, {
        current_boot_id: bootId,
        ...(registry.cgroupObservationFilesystem === undefined
          ? {}
          : { filesystem: registry.cgroupObservationFilesystem }),
      });
      const observedAt = readTimestamp(now);
      if (observedAt === null) {
        return unknownExecution(
          initialView.repositoryId,
          session.sessionId,
          record.execution_id,
          record.boot_id,
          expectedCgroupName,
          null,
          REASONS.timeUnavailable,
        );
      }
      if (!observation.ok) {
        return unknownExecution(
          initialView.repositoryId,
          session.sessionId,
          record.execution_id,
          record.boot_id,
          expectedCgroupName,
          observedAt,
          REASONS.cgroupUnknown,
        );
      }
      if (
        observation.value.contract_id !== "nawabari.session-process-observation.v1" ||
        observation.value.session_id !== session.sessionId ||
        observation.value.execution_id !== record.execution_id ||
        observation.value.boot_id !== record.boot_id ||
        observation.value.cgroups === null ||
        observation.value.cgroups.scope !== expectedCgroupName
      ) {
        return unknownExecution(
          initialView.repositoryId,
          session.sessionId,
          record.execution_id,
          record.boot_id,
          expectedCgroupName,
          observedAt,
          REASONS.executionIdentityMismatch,
        );
      }

      const population = observation.value.cgroups.population;
      if (observation.value.state === "active" && population.state === "populated") {
        return {
          repository_id: initialView.repositoryId,
          session_id: session.sessionId,
          execution_id: record.execution_id,
          boot_id: record.boot_id,
          cgroup_name: expectedCgroupName,
          observed_at: observedAt,
          status: "active",
          reason: null,
        };
      }
      if (
        observation.value.state === "empty" &&
        population.state === "empty" &&
        population.populated === false &&
        population.processes?.length === 0 &&
        population.events.populated === 0
      ) {
        return {
          repository_id: initialView.repositoryId,
          session_id: session.sessionId,
          execution_id: record.execution_id,
          boot_id: record.boot_id,
          cgroup_name: expectedCgroupName,
          observed_at: observedAt,
          status: "inactive",
          reason: null,
        };
      }
      return unknownExecution(
        initialView.repositoryId,
        session.sessionId,
        record.execution_id,
        record.boot_id,
        expectedCgroupName,
        observedAt,
        REASONS.cgroupUnknown,
      );
    });

    samples.push(summarizeSession(session.sessionId, executionSamples));
  }

  let finalView;
  try {
    finalView = registry.readRepositoryView();
  } catch {
    return unknownObservation(now, REASONS.registryUnavailable);
  }
  if (registrySourceFingerprint(initialView) !== registrySourceFingerprint(finalView)) {
    return unknownObservation(now, REASONS.registryChanged);
  }

  const observedAt = readTimestamp(now);
  if (observedAt === null)
    return Object.freeze({ status: "unknown", observed_at: null, reason: REASONS.timeUnavailable });
  const value = {
    contract_id: REPOSITORY_PROCESS_OBSERVATION_V1,
    schema_version: 1,
    sessions: samples,
  } as unknown as JsonValue;
  return Object.freeze({ status: "available", observed_at: observedAt, value });
}

function summarizeSession(sessionId: string, samples: readonly ExecutionSample[]): RepositoryRuntimeProcessObservation {
  if (samples.some((sample) => sample.status === "active")) {
    return Object.freeze({
      session_id: sessionId,
      status: "active",
      reason: samples.some((sample) => sample.status === "unknown") ? REASONS.partialExecutions : null,
    });
  }
  if (samples.every((sample) => sample.status === "inactive")) {
    return Object.freeze({ session_id: sessionId, status: "inactive", reason: null });
  }
  return Object.freeze({
    session_id: sessionId,
    status: "unknown",
    reason: samples.find((sample) => sample.status === "unknown")?.reason ?? REASONS.cgroupUnknown,
  });
}

function unknownExecution(
  repositoryId: string,
  sessionId: string,
  executionId: string,
  bootId: string,
  cgroupName: string | null,
  observedAt: string | null,
  reason: string,
): ExecutionSample {
  return {
    repository_id: repositoryId,
    session_id: sessionId,
    execution_id: executionId,
    boot_id: bootId,
    cgroup_name: cgroupName,
    observed_at: observedAt,
    status: "unknown",
    reason,
  };
}

function unknownSession(sessionId: string, reason: string): RepositoryRuntimeProcessObservation {
  return Object.freeze({ session_id: sessionId, status: "unknown", reason });
}

function unknownObservation(now: () => Date, reason: string): RepositoryRuntimeObservation<JsonValue> {
  return Object.freeze({ status: "unknown", observed_at: readTimestamp(now), reason });
}

function readTimestamp(now: () => Date): string | null {
  try {
    const value = now();
    if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) return null;
    return value.toISOString();
  } catch {
    return null;
  }
}

function registrySourceFingerprint(view: ReturnType<SessionRegistry["readRepositoryView"]>): string {
  return JSON.stringify({
    repository_id: view.repositoryId,
    registry_revision: view.registryRevision,
    runtime_epoch: view.runtimeEpoch,
    sessions: view.sessions.map((session) => session.sessionId).sort(compareCodePointStrings),
    executions: view.runtimeRecords.records.executions ?? [],
  });
}
