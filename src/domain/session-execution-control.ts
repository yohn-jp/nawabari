import { validateSessionExecutionRecord, type SessionExecutionRecord } from "./session-execution-record.js";
import {
  SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
  type OwnedExecutionObservation,
} from "./session-process-observation.js";
import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";

/** Versioned contract for closing admission while a session drains. */
export const SESSION_EXECUTION_CONTROL_CONTRACT_ID = "nawabari.session-execution-control.v1" as const;
export const SESSION_EXECUTION_CONTROL_SCHEMA_VERSION = 1 as const;

export type RuntimeEpoch = string | number;
export type SessionDrainOperation = "close" | "discard" | "release-claims";
export type SessionDrainPolicy = "wait" | "terminate";
export type SessionDrainStatus = "draining" | "waiting" | "blocked" | "drained" | "terminated";

/** Factual observation supplied by the process/cgroup authority. */
export type SessionDrainExecution = Readonly<{
  readonly record: SessionExecutionRecord;
  readonly observation: OwnedExecutionObservation;
}>;

export type SessionDrainIntent = Readonly<{
  readonly operation: SessionDrainOperation;
  /** Termination is never inferred; callers must explicitly select it. */
  readonly policy: SessionDrainPolicy;
  /** The lifecycle epoch observed by the caller before requesting the fence. */
  readonly observed_epoch?: RuntimeEpoch;
  /** Initial owned execution observations captured before the registry gate. */
  readonly executions?: readonly SessionDrainExecution[];
  /** True only when the process authority proved all relevant scopes empty. */
  readonly kernel_empty?: boolean;
  /** Stable key supplied by a retrying caller for idempotent fencing. */
  readonly idempotency_key?: string;
}>;

export type SessionDrainNextAction =
  "wait-for-drain" | "terminate-owned-executions" | "reobserve-drain" | "retry-drain" | "finalize-lifecycle";

export type SessionDrainFence = Readonly<{
  readonly contract_id: typeof SESSION_EXECUTION_CONTROL_CONTRACT_ID;
  readonly schema_version: typeof SESSION_EXECUTION_CONTROL_SCHEMA_VERSION;
  readonly session_id: string;
  readonly fence_id: string;
  readonly expected_epoch: RuntimeEpoch;
  readonly observed_epoch: RuntimeEpoch;
  readonly operation: SessionDrainOperation;
  readonly policy: SessionDrainPolicy;
  /** Admission is closed from this point until the fence is finalized/retried. */
  readonly admission: "closed";
  readonly status: SessionDrainStatus;
  readonly executions: readonly SessionDrainExecution[];
  readonly active_execution_ids: readonly string[];
  readonly unknown_execution_ids: readonly string[];
  readonly kernel_empty: boolean;
  readonly next_action: SessionDrainNextAction;
  readonly idempotency_key?: string;
}>;

export type SessionDrainCompletion = Readonly<{
  readonly fence: SessionDrainFence;
  readonly completed: boolean;
  readonly safe_to_finalize: boolean;
  readonly next_action: SessionDrainNextAction;
  readonly active_execution_ids: readonly string[];
  readonly unknown_execution_ids: readonly string[];
}>;

export type SessionDrainFinalization = Readonly<{
  readonly contract_id: typeof SESSION_EXECUTION_CONTROL_CONTRACT_ID;
  readonly schema_version: typeof SESSION_EXECUTION_CONTROL_SCHEMA_VERSION;
  readonly session_id: string;
  readonly fence_id: string;
  readonly operation: SessionDrainOperation;
  readonly expected_epoch: RuntimeEpoch;
  readonly admission: "closed";
  readonly status: "ready";
  /** The caller may now invoke the canonical registry mutation. */
  readonly next_action: "finalize-lifecycle";
}>;

export type SessionDrainObservation = Readonly<{
  readonly observed_epoch?: RuntimeEpoch;
  readonly executions?: readonly SessionDrainExecution[];
  readonly kernel_empty?: boolean;
}>;

const MAX_ID_LENGTH = 256;
const MAX_FENCE_LENGTH = 512;

function controlError(message: string, details: JsonObject = {}): DomainResult<never> {
  return failure(new DomainError("OPERATION_REJECTED", message, details));
}

function invalid(message: string, details: JsonObject = {}): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, details));
}

function isBoundedText(value: unknown, maximum = MAX_ID_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && !value.includes("\0");
}

function isEpoch(value: unknown): value is RuntimeEpoch {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && isBoundedText(value, MAX_ID_LENGTH))
  );
}

function sameEpoch(left: RuntimeEpoch, right: RuntimeEpoch): boolean {
  return typeof left === typeof right && left === right;
}

function operation(value: unknown): value is SessionDrainOperation {
  return value === "close" || value === "discard" || value === "release-claims";
}

function policy(value: unknown): value is SessionDrainPolicy {
  return value === "wait" || value === "terminate";
}

function validateExecution(value: unknown, index: number): DomainResult<SessionDrainExecution> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("A drain execution observation must be an object.", { index });
  }
  const candidate = value as Partial<SessionDrainExecution>;
  if (typeof candidate.record !== "object" || candidate.record === null || Array.isArray(candidate.record)) {
    return invalid("A drain execution is missing its durable execution record.", { index });
  }
  if (
    typeof candidate.observation !== "object" ||
    candidate.observation === null ||
    Array.isArray(candidate.observation)
  ) {
    return invalid("A drain execution is missing its owned process observation.", { index });
  }
  const record = candidate.record as SessionExecutionRecord;
  const observation = candidate.observation as OwnedExecutionObservation;
  const validatedRecord = validateSessionExecutionRecord(record);
  if (!validatedRecord.ok) return validatedRecord;
  const normalizedRecord = validatedRecord.value;
  if (!isBoundedText(observation.session_id) || !isBoundedText(observation.execution_id)) {
    return invalid("A drain process observation has invalid ownership identity.", { index });
  }
  if (observation.contract_id !== SESSION_PROCESS_OBSERVATION_CONTRACT_ID) {
    return invalid("A drain process observation contract is unsupported.", { index });
  }
  if (
    normalizedRecord.session_id !== observation.session_id ||
    normalizedRecord.execution_id !== observation.execution_id
  ) {
    return controlError("A drain observation does not belong to its durable execution record.", {
      index,
      session_id: normalizedRecord.session_id,
      execution_id: normalizedRecord.execution_id,
    });
  }
  if (observation.state !== "active" && observation.state !== "empty" && observation.state !== "unknown") {
    return invalid("A drain process observation has an unsupported state.", { index });
  }
  return success(Object.freeze({ record: normalizedRecord, observation }));
}

function validateExecutions(
  value: readonly SessionDrainExecution[] | undefined,
): DomainResult<readonly SessionDrainExecution[]> {
  if (value === undefined) return success(Object.freeze([]));
  if (!Array.isArray(value)) return invalid("Drain executions must be an array.");
  const seen = new Set<string>();
  const normalized: SessionDrainExecution[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const checked = validateExecution(value[index], index);
    if (!checked.ok) return checked;
    if (seen.has(checked.value.record.execution_id)) {
      return invalid("A drain request contains a duplicate execution identity.", {
        execution_id: checked.value.record.execution_id,
      });
    }
    seen.add(checked.value.record.execution_id);
    normalized.push(checked.value);
  }
  return success(Object.freeze(normalized));
}

function validateIntent(value: SessionDrainIntent | string): DomainResult<SessionDrainIntent> {
  const candidate: SessionDrainIntent =
    typeof value === "string" ? { operation: value as SessionDrainOperation, policy: "wait" } : value;
  if (typeof candidate !== "object" || candidate === null || Array.isArray(candidate)) {
    return invalid("A drain intent must be an operation or intent object.");
  }
  if (!operation(candidate.operation))
    return invalid("A drain operation is unsupported.", { operation: String(candidate.operation) });
  if (!policy(candidate.policy))
    return invalid("A drain policy must explicitly be wait or terminate.", { policy: String(candidate.policy) });
  if (candidate.observed_epoch !== undefined && !isEpoch(candidate.observed_epoch)) {
    return invalid("A drain observed_epoch is invalid.", { observed_epoch: String(candidate.observed_epoch) });
  }
  if (candidate.idempotency_key !== undefined && !isBoundedText(candidate.idempotency_key, MAX_FENCE_LENGTH)) {
    return invalid("A drain idempotency_key is invalid.");
  }
  const executions = validateExecutions(candidate.executions);
  if (!executions.ok) return executions;
  if (candidate.kernel_empty !== undefined && typeof candidate.kernel_empty !== "boolean") {
    return invalid("A drain kernel_empty observation must be boolean.");
  }
  return success(
    Object.freeze({
      operation: candidate.operation,
      policy: candidate.policy,
      ...(candidate.observed_epoch === undefined ? {} : { observed_epoch: candidate.observed_epoch }),
      executions: executions.value,
      kernel_empty: candidate.kernel_empty === true,
      ...(candidate.idempotency_key === undefined ? {} : { idempotency_key: candidate.idempotency_key }),
    }),
  );
}

function fenceId(sessionId: string, epoch: RuntimeEpoch, intent: SessionDrainIntent): string {
  const key = intent.idempotency_key ?? `${sessionId}:${String(epoch)}:${intent.operation}`;
  return `drain-${key}`.slice(0, MAX_FENCE_LENGTH);
}

function summarize(executions: readonly SessionDrainExecution[]): {
  active: readonly string[];
  unknown: readonly string[];
} {
  const active: string[] = [];
  const unknown: string[] = [];
  for (const execution of executions) {
    if (execution.observation.state === "active") active.push(execution.record.execution_id);
    if (execution.observation.state === "unknown") unknown.push(execution.record.execution_id);
  }
  return { active: Object.freeze(active), unknown: Object.freeze(unknown) };
}

function completionFor(fence: SessionDrainFence): SessionDrainCompletion {
  const summary = summarize(fence.executions);
  const complete = summary.active.length === 0 && summary.unknown.length === 0 && fence.kernel_empty;
  const nextAction: SessionDrainNextAction = complete
    ? "finalize-lifecycle"
    : summary.unknown.length > 0
      ? "reobserve-drain"
      : summary.active.length > 0
        ? fence.policy === "terminate"
          ? "terminate-owned-executions"
          : "wait-for-drain"
        : !fence.kernel_empty
          ? "reobserve-drain"
          : fence.policy === "terminate"
            ? "terminate-owned-executions"
            : "wait-for-drain";
  const status: SessionDrainStatus = complete ? "drained" : summary.unknown.length > 0 ? "blocked" : "waiting";
  const updatedFence = Object.freeze({
    ...fence,
    status,
    active_execution_ids: summary.active,
    unknown_execution_ids: summary.unknown,
    next_action: nextAction,
  });
  return Object.freeze({
    fence: updatedFence,
    completed: complete,
    safe_to_finalize: complete,
    next_action: nextAction,
    active_execution_ids: summary.active,
    unknown_execution_ids: summary.unknown,
  });
}

/**
 * Close launch admission and create an immutable fence.  This function only
 * returns the gate token; the canonical registry owns persisting the epoch
 * and lifecycle mutation. Callers must persist the returned fence before
 * waiting or performing any destructive operation.
 */
export function beginExecutionDrain(
  sessionId: string,
  expectedEpoch: RuntimeEpoch,
  intent: SessionDrainIntent | string,
): DomainResult<SessionDrainFence> {
  if (!isBoundedText(sessionId))
    return invalid("A drain session_id must be bounded text.", { session_id: String(sessionId) });
  if (!isEpoch(expectedEpoch))
    return invalid("A drain expected epoch is invalid.", { expected_epoch: String(expectedEpoch) });
  const checkedIntent = validateIntent(intent);
  if (!checkedIntent.ok) return checkedIntent;
  if (
    checkedIntent.value.observed_epoch !== undefined &&
    !sameEpoch(checkedIntent.value.observed_epoch, expectedEpoch)
  ) {
    return controlError("The drain request was observed at a different lifecycle epoch.", {
      session_id: sessionId,
      expected_epoch: expectedEpoch,
      observed_epoch: checkedIntent.value.observed_epoch,
    });
  }
  const summary = summarize(checkedIntent.value.executions ?? []);
  const fence: SessionDrainFence = Object.freeze({
    contract_id: SESSION_EXECUTION_CONTROL_CONTRACT_ID,
    schema_version: SESSION_EXECUTION_CONTROL_SCHEMA_VERSION,
    session_id: sessionId,
    fence_id: fenceId(sessionId, expectedEpoch, checkedIntent.value),
    expected_epoch: expectedEpoch,
    observed_epoch: checkedIntent.value.observed_epoch ?? expectedEpoch,
    operation: checkedIntent.value.operation,
    policy: checkedIntent.value.policy,
    admission: "closed",
    status: "draining",
    executions: checkedIntent.value.executions ?? Object.freeze([]),
    active_execution_ids: summary.active,
    unknown_execution_ids: summary.unknown,
    kernel_empty: checkedIntent.value.kernel_empty === true,
    next_action: "reobserve-drain",
    ...(checkedIntent.value.idempotency_key === undefined
      ? {}
      : { idempotency_key: checkedIntent.value.idempotency_key }),
  });
  return success(fence);
}

/** Re-observe process occupancy after waiting or an explicit termination. */
export function observeDrainCompletion(
  fence: SessionDrainFence,
  observation: SessionDrainObservation = {},
): DomainResult<SessionDrainCompletion> {
  if (!isBoundedText(fence.session_id) || fence.admission !== "closed") {
    return invalid("A drain fence is invalid or does not close admission.");
  }
  if (!isEpoch(fence.expected_epoch) || !isEpoch(fence.observed_epoch)) {
    return invalid("A drain fence contains an invalid lifecycle epoch.");
  }
  const checkedExecutions = validateExecutions(observation.executions ?? fence.executions);
  if (!checkedExecutions.ok) return checkedExecutions;
  const observedEpoch = observation.observed_epoch ?? fence.observed_epoch;
  if (!isEpoch(observedEpoch)) return invalid("A drain completion epoch is invalid.");
  if (!sameEpoch(observedEpoch, fence.expected_epoch)) {
    return controlError("The lifecycle epoch changed while the session was draining.", {
      session_id: fence.session_id,
      expected_epoch: fence.expected_epoch,
      observed_epoch: observedEpoch,
      next_action: "retry-drain",
    });
  }
  const refreshed = Object.freeze({
    ...fence,
    observed_epoch: observedEpoch,
    executions: checkedExecutions.value,
    kernel_empty: observation.kernel_empty ?? fence.kernel_empty,
  });
  return success(completionFor(refreshed));
}

/**
 * Authorize the canonical close/discard/claim mutation only after process
 * drain and kernel emptiness are proven. This never performs that mutation.
 */
export function finalizeExecutionDrain(
  fence: SessionDrainFence | SessionDrainCompletion,
): DomainResult<SessionDrainFinalization> {
  const candidate = "fence" in fence ? fence.fence : fence;
  if (!isBoundedText(candidate.session_id) || candidate.admission !== "closed") {
    return invalid("A drain fence is invalid or does not close admission.");
  }
  const completion = completionFor(candidate);
  if (!completion.safe_to_finalize) {
    return controlError("Execution drain is not proven complete; lifecycle cleanup remains fenced.", {
      session_id: candidate.session_id,
      fence_id: candidate.fence_id,
      active_execution_ids: [...completion.active_execution_ids],
      unknown_execution_ids: [...completion.unknown_execution_ids],
      next_action: completion.next_action,
    });
  }
  return success(
    Object.freeze({
      contract_id: SESSION_EXECUTION_CONTROL_CONTRACT_ID,
      schema_version: SESSION_EXECUTION_CONTROL_SCHEMA_VERSION,
      session_id: candidate.session_id,
      fence_id: candidate.fence_id,
      operation: candidate.operation,
      expected_epoch: candidate.expected_epoch,
      admission: "closed",
      status: "ready",
      next_action: "finalize-lifecycle",
    }),
  );
}

/** Stable wire projection; test seams and producer objects are not serialized. */
export function serializeExecutionDrainFence(fence: SessionDrainFence): JsonObject {
  return {
    registry: {
      session_id: fence.session_id,
      fence_id: fence.fence_id,
      admission: fence.admission,
      operation: fence.operation,
      expected_epoch: fence.expected_epoch,
    },
    lifecycle: {
      contract_id: fence.contract_id,
      schema_version: fence.schema_version,
      observed_epoch: fence.observed_epoch,
      status: fence.status,
      active_execution_ids: [...fence.active_execution_ids],
      unknown_execution_ids: [...fence.unknown_execution_ids],
      kernel_empty: fence.kernel_empty,
      next_action: fence.next_action,
    },
  };
}
