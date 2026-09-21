import { validateSessionExecutionRecord, type SessionExecutionRecord } from "./session-execution-record.js";
import { deriveCgroupScopeName } from "./cgroups-v2.js";
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

/**
 * Canonical registry operation required to close launch admission. The
 * implementation owns the lock/CAS and must increment runtime_epoch in the
 * same mutation; a fence is never issued from a caller-local boolean.
 */
export type SessionDrainAdmissionRequest = Readonly<{
  readonly session_id: string;
  readonly expected_epoch: RuntimeEpoch;
  readonly fence_id: string;
  readonly operation: SessionDrainOperation;
}>;

export type SessionDrainAdmissionClosure = Readonly<{
  readonly admission: "closed";
  readonly runtime_epoch: RuntimeEpoch;
}>;

export type SessionDrainAdmissionAuthority = (
  request: SessionDrainAdmissionRequest,
) => DomainResult<SessionDrainAdmissionClosure>;

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
  /** Epoch returned by the atomic registry admission-close mutation. */
  readonly admission_epoch: RuntimeEpoch;
  /** Admission is closed from this point until the fence is finalized/retried. */
  readonly admission: "closed";
  readonly status: SessionDrainStatus;
  readonly executions: readonly SessionDrainExecution[];
  readonly active_execution_ids: readonly string[];
  readonly unknown_execution_ids: readonly string[];
  readonly missing_execution_ids: readonly string[];
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
  readonly missing_execution_ids: readonly string[];
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

function status(value: unknown): value is SessionDrainStatus {
  return (
    value === "draining" || value === "waiting" || value === "blocked" || value === "drained" || value === "terminated"
  );
}

function nextAction(value: unknown): value is SessionDrainNextAction {
  return (
    value === "wait-for-drain" ||
    value === "terminate-owned-executions" ||
    value === "reobserve-drain" ||
    value === "retry-drain" ||
    value === "finalize-lifecycle"
  );
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
  if (record.boot_id !== observation.boot_id) {
    return controlError("A drain observation belongs to a different kernel boot.", {
      index,
      session_id: normalizedRecord.session_id,
      execution_id: normalizedRecord.execution_id,
      expected_boot_id: normalizedRecord.boot_id,
      observed_boot_id: observation.boot_id,
    });
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
  if (observation.cgroups === null) {
    if (observation.state !== "unknown") {
      return controlError("A drain observation without a cgroups scope cannot prove occupancy.", { index });
    }
  } else {
    let expectedScope: string;
    try {
      expectedScope = deriveCgroupScopeName(normalizedRecord.cgroup_identity);
    } catch {
      return controlError("A drain execution record has an invalid cgroups identity.", { index });
    }
    if (observation.cgroups.scope !== expectedScope) {
      return controlError("A drain observation belongs to a different cgroups scope.", {
        index,
        execution_id: normalizedRecord.execution_id,
        expected_scope: expectedScope,
        observed_scope: observation.cgroups.scope,
      });
    }
    const populationState = observation.cgroups.population.state;
    const consistentState =
      (observation.state === "active" && populationState === "populated") ||
      (observation.state === "empty" && populationState === "empty") ||
      (observation.state === "unknown" && populationState === "unknown");
    if (!consistentState) {
      return controlError("A drain observation has stale or inconsistent cgroups occupancy evidence.", {
        index,
        execution_id: normalizedRecord.execution_id,
        state: observation.state,
        population_state: populationState,
      });
    }
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
  missing: readonly string[];
} {
  const active: string[] = [];
  const unknown: string[] = [];
  for (const execution of executions) {
    if (execution.observation.state === "active") active.push(execution.record.execution_id);
    if (execution.observation.state === "unknown") unknown.push(execution.record.execution_id);
  }
  return { active: Object.freeze(active), unknown: Object.freeze(unknown), missing: Object.freeze([]) };
}

function summarizeAgainstFence(
  fenceExecutions: readonly SessionDrainExecution[],
  observedExecutions: readonly SessionDrainExecution[],
): {
  active: readonly string[];
  unknown: readonly string[];
  missing: readonly string[];
} {
  const observed = summarize(observedExecutions);
  const observedIds = new Set(observedExecutions.map((execution) => execution.record.execution_id));
  const missing = fenceExecutions
    .map((execution) => execution.record.execution_id)
    .filter((executionId) => !observedIds.has(executionId));
  return {
    active: observed.active,
    unknown: observed.unknown,
    missing: Object.freeze(missing),
  };
}

function mergeExecutions(
  prior: readonly SessionDrainExecution[],
  observed: readonly SessionDrainExecution[],
): readonly SessionDrainExecution[] {
  const byId = new Map(observed.map((execution) => [execution.record.execution_id, execution]));
  const merged = prior.map((execution) => byId.get(execution.record.execution_id) ?? execution);
  const priorIds = new Set(prior.map((execution) => execution.record.execution_id));
  for (const execution of observed) {
    if (!priorIds.has(execution.record.execution_id)) merged.push(execution);
  }
  return Object.freeze(merged);
}

function validateFenceShape(value: unknown): DomainResult<SessionDrainFence> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid("A drain fence must be an object.");
  }
  const candidate = value as Partial<SessionDrainFence>;
  if (candidate.contract_id !== SESSION_EXECUTION_CONTROL_CONTRACT_ID) {
    return invalid("A drain fence contract is unsupported.", { contract_id: String(candidate.contract_id) });
  }
  if (candidate.schema_version !== SESSION_EXECUTION_CONTROL_SCHEMA_VERSION) {
    return invalid("A drain fence schema version is unsupported.", {
      schema_version: String(candidate.schema_version),
    });
  }
  if (!isBoundedText(candidate.session_id) || !isBoundedText(candidate.fence_id, MAX_FENCE_LENGTH)) {
    return invalid("A drain fence identity is invalid.");
  }
  if (!isEpoch(candidate.expected_epoch) || !isEpoch(candidate.observed_epoch) || !isEpoch(candidate.admission_epoch)) {
    return invalid("A drain fence epoch is invalid.");
  }
  if (!sameEpoch(candidate.observed_epoch, candidate.admission_epoch)) {
    return invalid("A drain fence observed epoch does not match its admission epoch.");
  }
  if (!operation(candidate.operation) || !policy(candidate.policy) || candidate.admission !== "closed") {
    return invalid("A drain fence operation or admission state is invalid.");
  }
  if (candidate.idempotency_key !== undefined && !isBoundedText(candidate.idempotency_key, MAX_FENCE_LENGTH)) {
    return invalid("A drain fence idempotency_key is invalid.");
  }
  if (!status(candidate.status) || !nextAction(candidate.next_action) || typeof candidate.kernel_empty !== "boolean") {
    return invalid("A drain fence status or kernel_empty value is invalid.");
  }
  if (!Array.isArray(candidate.active_execution_ids) || !Array.isArray(candidate.unknown_execution_ids)) {
    return invalid("A drain fence execution summary is invalid.");
  }
  if (!Array.isArray(candidate.missing_execution_ids)) {
    return invalid("A drain fence missing execution summary is invalid.");
  }
  if (!Array.isArray(candidate.executions)) {
    return invalid("A drain fence execution evidence is invalid.");
  }
  if (
    [...candidate.active_execution_ids, ...candidate.unknown_execution_ids, ...candidate.missing_execution_ids].some(
      (entry) => !isBoundedText(entry),
    )
  ) {
    return invalid("A drain fence execution summary contains an invalid identity.");
  }
  const executions = validateExecutions(candidate.executions);
  if (!executions.ok) return executions;
  return success(Object.freeze({ ...candidate, executions: executions.value }) as SessionDrainFence);
}

function completionFor(fence: SessionDrainFence): SessionDrainCompletion {
  const current = summarize(fence.executions);
  const summary = { ...current, missing: fence.missing_execution_ids };
  const complete =
    summary.active.length === 0 && summary.unknown.length === 0 && summary.missing.length === 0 && fence.kernel_empty;
  const nextAction: SessionDrainNextAction = complete
    ? "finalize-lifecycle"
    : summary.unknown.length > 0 || summary.missing.length > 0
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
  const status: SessionDrainStatus = complete
    ? "drained"
    : summary.unknown.length > 0 || summary.missing.length > 0
      ? "blocked"
      : "waiting";
  const updatedFence = Object.freeze({
    ...fence,
    status,
    active_execution_ids: summary.active,
    unknown_execution_ids: summary.unknown,
    missing_execution_ids: summary.missing,
    next_action: nextAction,
  });
  return Object.freeze({
    fence: updatedFence,
    completed: complete,
    safe_to_finalize: complete,
    next_action: nextAction,
    active_execution_ids: summary.active,
    unknown_execution_ids: summary.unknown,
    missing_execution_ids: summary.missing,
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
  admissionAuthority?: SessionDrainAdmissionAuthority,
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
  if (admissionAuthority === undefined) {
    return controlError("The canonical registry admission authority is required before a drain fence can be issued.", {
      session_id: sessionId,
      expected_epoch: expectedEpoch,
      next_action: "retry-drain",
    });
  }
  const id = fenceId(sessionId, expectedEpoch, checkedIntent.value);
  let closure: DomainResult<SessionDrainAdmissionClosure>;
  try {
    closure = admissionAuthority({
      session_id: sessionId,
      expected_epoch: expectedEpoch,
      fence_id: id,
      operation: checkedIntent.value.operation,
    });
  } catch (error: unknown) {
    return controlError("The canonical registry admission authority could not close launch admission.", {
      session_id: sessionId,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
  if (!closure.ok) return closure;
  if (
    typeof closure.value !== "object" ||
    closure.value === null ||
    closure.value.admission !== "closed" ||
    !isEpoch(closure.value.runtime_epoch)
  ) {
    return controlError("The canonical registry admission authority returned invalid closure evidence.", {
      session_id: sessionId,
    });
  }
  if (
    (typeof expectedEpoch === "number" &&
      (typeof closure.value.runtime_epoch !== "number" || closure.value.runtime_epoch <= expectedEpoch)) ||
    (typeof expectedEpoch === "string" && sameEpoch(closure.value.runtime_epoch, expectedEpoch))
  ) {
    return controlError("The canonical registry admission authority did not advance runtime_epoch.", {
      session_id: sessionId,
      expected_epoch: expectedEpoch,
      observed_epoch: closure.value.runtime_epoch,
    });
  }
  const summary = summarize(checkedIntent.value.executions ?? []);
  const fence: SessionDrainFence = Object.freeze({
    contract_id: SESSION_EXECUTION_CONTROL_CONTRACT_ID,
    schema_version: SESSION_EXECUTION_CONTROL_SCHEMA_VERSION,
    session_id: sessionId,
    fence_id: id,
    expected_epoch: expectedEpoch,
    observed_epoch: closure.value.runtime_epoch,
    operation: checkedIntent.value.operation,
    policy: checkedIntent.value.policy,
    admission_epoch: closure.value.runtime_epoch,
    admission: "closed",
    status: "draining",
    executions: checkedIntent.value.executions ?? Object.freeze([]),
    active_execution_ids: summary.active,
    unknown_execution_ids: summary.unknown,
    missing_execution_ids: summary.missing,
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
  const validatedFence = validateFenceShape(fence);
  if (!validatedFence.ok) return validatedFence;
  const canonicalFence = validatedFence.value;
  if (typeof observation !== "object" || observation === null || Array.isArray(observation)) {
    return invalid("A drain completion observation must be an object.");
  }
  if (observation.kernel_empty !== undefined && typeof observation.kernel_empty !== "boolean") {
    return invalid("A drain completion kernel_empty value must be boolean.");
  }
  const checkedExecutions = validateExecutions(observation.executions ?? canonicalFence.executions);
  if (!checkedExecutions.ok) return checkedExecutions;
  const observedEpoch = observation.observed_epoch ?? canonicalFence.observed_epoch;
  if (!isEpoch(observedEpoch)) return invalid("A drain completion epoch is invalid.");
  if (!sameEpoch(observedEpoch, canonicalFence.admission_epoch)) {
    return controlError("The lifecycle epoch changed while the session was draining.", {
      session_id: canonicalFence.session_id,
      expected_epoch: canonicalFence.admission_epoch,
      observed_epoch: observedEpoch,
      next_action: "retry-drain",
    });
  }
  const summary = summarizeAgainstFence(canonicalFence.executions, checkedExecutions.value);
  const refreshed = Object.freeze({
    ...canonicalFence,
    observed_epoch: observedEpoch,
    executions: mergeExecutions(canonicalFence.executions, checkedExecutions.value),
    missing_execution_ids: summary.missing,
    kernel_empty: observation.kernel_empty ?? canonicalFence.kernel_empty,
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
  const validatedFence = validateFenceShape(candidate);
  if (!validatedFence.ok) return validatedFence;
  const canonicalFence = validatedFence.value;
  const completion = completionFor(canonicalFence);
  if (!completion.safe_to_finalize) {
    return controlError("Execution drain is not proven complete; lifecycle cleanup remains fenced.", {
      session_id: canonicalFence.session_id,
      fence_id: canonicalFence.fence_id,
      active_execution_ids: [...completion.active_execution_ids],
      unknown_execution_ids: [...completion.unknown_execution_ids],
      missing_execution_ids: [...completion.missing_execution_ids],
      next_action: completion.next_action,
    });
  }
  return success(
    Object.freeze({
      contract_id: SESSION_EXECUTION_CONTROL_CONTRACT_ID,
      schema_version: SESSION_EXECUTION_CONTROL_SCHEMA_VERSION,
      session_id: canonicalFence.session_id,
      fence_id: canonicalFence.fence_id,
      operation: canonicalFence.operation,
      expected_epoch: canonicalFence.expected_epoch,
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
      admission_epoch: fence.admission_epoch,
    },
    lifecycle: {
      contract_id: fence.contract_id,
      schema_version: fence.schema_version,
      observed_epoch: fence.observed_epoch,
      status: fence.status,
      active_execution_ids: [...fence.active_execution_ids],
      unknown_execution_ids: [...fence.unknown_execution_ids],
      missing_execution_ids: [...fence.missing_execution_ids],
      kernel_empty: fence.kernel_empty,
      next_action: fence.next_action,
    },
  };
}
