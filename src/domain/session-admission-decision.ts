import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";

/** Stable identity for the pre-spawn admission contract. */
export const SESSION_ADMISSION_CONTRACT_ID = "nawabari.session-admission.v1" as const;
export const SESSION_ADMISSION_SCHEMA_VERSION = 1 as const;

const MAX_ID_LENGTH = 256;
const MAX_TOKEN_LENGTH = 512;

export type AdmissionLifecycleState = "new" | "active" | "closing" | "closed" | "stale";

/** The exact lifecycle/profile/filesystem snapshot checked by the parent. */
export type ExecutionAdmissionSnapshot = {
  readonly lifecycle: AdmissionLifecycleState;
  /** Canonical lifecycle authority has explicitly permitted one protected launch. */
  readonly launch_permitted: boolean;
  readonly profile_token: string;
  readonly profile_revision: number;
  readonly filesystem_token: string;
  readonly filesystem_revision: number;
  /** Session-owned mutation generation, not a process id or timestamp. */
  readonly generation: number;
  /** Monotonic launch epoch used to reject a stale parent observation. */
  readonly epoch: number;
};

/**
 * Factual inputs supplied by the parent authority.  `current` is the fresh
 * canonical observation and `expected` is the observation that was read while
 * reserving `starting`; every field is compared before a launch is admitted.
 */
export type ExecutionAdmissionFacts = {
  readonly session_id: string;
  readonly execution_id: string;
  readonly current: ExecutionAdmissionSnapshot;
  readonly expected: ExecutionAdmissionSnapshot;
};

export type ExecutionAdmissionDenialReason =
  | "invalid-identity"
  | "lifecycle-not-permitted"
  | "lifecycle-changed"
  | "profile-token-changed"
  | "profile-revision-changed"
  | "filesystem-token-changed"
  | "filesystem-revision-changed"
  | "generation-changed"
  | "stale-epoch"
  | "epoch-changed";

export type ExecutionAdmissionReservation = {
  readonly contract_id: typeof SESSION_ADMISSION_CONTRACT_ID;
  readonly schema_version: typeof SESSION_ADMISSION_SCHEMA_VERSION;
  readonly session_id: string;
  readonly execution_id: string;
  readonly status: "starting";
  readonly profile_token: string;
  readonly profile_revision: number;
  readonly filesystem_token: string;
  readonly filesystem_revision: number;
  readonly generation: number;
  readonly epoch: number;
};

export type ExecutionAdmissionDecision =
  | {
      readonly admitted: true;
      readonly status: "starting";
      readonly reservation: ExecutionAdmissionReservation;
    }
  | {
      readonly admitted: false;
      readonly status: "denied";
      readonly reason: ExecutionAdmissionDenialReason;
      readonly retryable: boolean;
      readonly session_id: string;
      readonly execution_id: string;
      readonly observed_epoch: number | null;
    };

function invalid(message: string, details: JsonObject): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, details));
}

function isBoundedText(value: unknown, maxLength = MAX_TOKEN_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validateIdentity(value: unknown, field: "session_id" | "execution_id"): DomainResult<string> {
  if (!isBoundedText(value, MAX_ID_LENGTH)) {
    return invalid(`The admission ${field} must be a bounded non-empty string.`, { [field]: String(value) });
  }
  return success(value);
}

function validateSnapshot(value: unknown, field: "current" | "expected"): DomainResult<ExecutionAdmissionSnapshot> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return invalid(`The admission ${field} snapshot is invalid.`, { field });
  }
  const snapshot = value as Partial<ExecutionAdmissionSnapshot>;
  if (
    snapshot.lifecycle !== "new" &&
    snapshot.lifecycle !== "active" &&
    snapshot.lifecycle !== "closing" &&
    snapshot.lifecycle !== "closed" &&
    snapshot.lifecycle !== "stale"
  ) {
    return invalid(`The admission ${field} lifecycle is invalid.`, { field, lifecycle: String(snapshot.lifecycle) });
  }
  if (typeof snapshot.launch_permitted !== "boolean") {
    return invalid(`The admission ${field} permission is invalid.`, { field });
  }
  if (!isBoundedText(snapshot.profile_token) || !isBoundedText(snapshot.filesystem_token)) {
    return invalid(`The admission ${field} token is invalid.`, { field });
  }
  if (
    !isPositiveSafeInteger(snapshot.profile_revision) ||
    !isPositiveSafeInteger(snapshot.filesystem_revision) ||
    !isPositiveSafeInteger(snapshot.generation) ||
    !isPositiveSafeInteger(snapshot.epoch)
  ) {
    return invalid(`The admission ${field} revision, generation, or epoch is invalid.`, { field });
  }
  return success({
    lifecycle: snapshot.lifecycle,
    launch_permitted: snapshot.launch_permitted,
    profile_token: snapshot.profile_token,
    profile_revision: snapshot.profile_revision,
    filesystem_token: snapshot.filesystem_token,
    filesystem_revision: snapshot.filesystem_revision,
    generation: snapshot.generation,
    epoch: snapshot.epoch,
  });
}

function denial(facts: ExecutionAdmissionFacts, reason: ExecutionAdmissionDenialReason): ExecutionAdmissionDecision {
  return {
    admitted: false,
    status: "denied",
    reason,
    // A stale/changed observation must be reacquired by the parent.  This is
    // not permission to replay the payload automatically.
    retryable: reason !== "lifecycle-not-permitted" && reason !== "invalid-identity",
    session_id: facts.session_id,
    execution_id: facts.execution_id,
    observed_epoch: Number.isSafeInteger(facts.current.epoch) ? facts.current.epoch : null,
  };
}

function sameSnapshot(left: ExecutionAdmissionSnapshot, right: ExecutionAdmissionSnapshot): boolean {
  return (
    left.lifecycle === right.lifecycle &&
    left.launch_permitted === right.launch_permitted &&
    left.profile_token === right.profile_token &&
    left.profile_revision === right.profile_revision &&
    left.filesystem_token === right.filesystem_token &&
    left.filesystem_revision === right.filesystem_revision &&
    left.generation === right.generation &&
    left.epoch === right.epoch
  );
}

/**
 * Revalidate the parent-owned launch facts immediately before any child is
 * spawned.  This function is pure: reserving `starting` and publishing its
 * durable record remain operations of the canonical parent authority.
 */
export function decideExecutionAdmission(facts: ExecutionAdmissionFacts): DomainResult<ExecutionAdmissionDecision> {
  const session = validateIdentity(facts.session_id, "session_id");
  if (!session.ok) return session;
  const execution = validateIdentity(facts.execution_id, "execution_id");
  if (!execution.ok) return execution;
  const current = validateSnapshot(facts.current, "current");
  if (!current.ok) return current;
  const expected = validateSnapshot(facts.expected, "expected");
  if (!expected.ok) return expected;

  const normalized: ExecutionAdmissionFacts = {
    session_id: session.value,
    execution_id: execution.value,
    current: current.value,
    expected: expected.value,
  };
  if (current.value.lifecycle !== "active" || !current.value.launch_permitted) {
    return success(denial(normalized, "lifecycle-not-permitted"));
  }
  if (current.value.epoch < expected.value.epoch) {
    return success(denial(normalized, "stale-epoch"));
  }
  if (current.value.epoch !== expected.value.epoch) {
    return success(denial(normalized, "epoch-changed"));
  }
  if (
    current.value.lifecycle !== expected.value.lifecycle ||
    current.value.launch_permitted !== expected.value.launch_permitted
  ) {
    return success(denial(normalized, "lifecycle-changed"));
  }
  if (current.value.profile_token !== expected.value.profile_token) {
    return success(denial(normalized, "profile-token-changed"));
  }
  if (current.value.profile_revision !== expected.value.profile_revision) {
    return success(denial(normalized, "profile-revision-changed"));
  }
  if (current.value.filesystem_token !== expected.value.filesystem_token) {
    return success(denial(normalized, "filesystem-token-changed"));
  }
  if (current.value.filesystem_revision !== expected.value.filesystem_revision) {
    return success(denial(normalized, "filesystem-revision-changed"));
  }
  if (current.value.generation !== expected.value.generation) {
    return success(denial(normalized, "generation-changed"));
  }
  if (!sameSnapshot(current.value, expected.value)) {
    return success(denial(normalized, "epoch-changed"));
  }

  return success({
    admitted: true,
    status: "starting",
    reservation: {
      contract_id: SESSION_ADMISSION_CONTRACT_ID,
      schema_version: SESSION_ADMISSION_SCHEMA_VERSION,
      session_id: session.value,
      execution_id: execution.value,
      status: "starting",
      profile_token: current.value.profile_token,
      profile_revision: current.value.profile_revision,
      filesystem_token: current.value.filesystem_token,
      filesystem_revision: current.value.filesystem_revision,
      generation: current.value.generation,
      epoch: current.value.epoch,
    },
  });
}

/** Validate a reservation before handing it to a trusted supervisor. */
export function validateExecutionAdmissionReservation(
  reservation: ExecutionAdmissionReservation,
): DomainResult<ExecutionAdmissionReservation> {
  const decision = decideExecutionAdmission({
    session_id: reservation.session_id,
    execution_id: reservation.execution_id,
    current: {
      lifecycle: "active",
      launch_permitted: true,
      profile_token: reservation.profile_token,
      profile_revision: reservation.profile_revision,
      filesystem_token: reservation.filesystem_token,
      filesystem_revision: reservation.filesystem_revision,
      generation: reservation.generation,
      epoch: reservation.epoch,
    },
    expected: {
      lifecycle: "active",
      launch_permitted: true,
      profile_token: reservation.profile_token,
      profile_revision: reservation.profile_revision,
      filesystem_token: reservation.filesystem_token,
      filesystem_revision: reservation.filesystem_revision,
      generation: reservation.generation,
      epoch: reservation.epoch,
    },
  });
  if (!decision.ok) return decision;
  if (!decision.value.admitted) {
    return failure(
      new DomainError("OPERATION_REJECTED", "The execution admission reservation is invalid.", {
        reason: decision.value.reason,
      }),
    );
  }
  if (
    reservation.contract_id !== SESSION_ADMISSION_CONTRACT_ID ||
    reservation.schema_version !== SESSION_ADMISSION_SCHEMA_VERSION ||
    reservation.status !== "starting"
  ) {
    return failure(new DomainError("OPERATION_REJECTED", "The execution admission contract is incompatible.", {}));
  }
  return success(reservation);
}
