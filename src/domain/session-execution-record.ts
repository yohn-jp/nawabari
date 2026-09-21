import crypto from "node:crypto";
import fs from "node:fs";

import { deriveCgroupScopeName, type CgroupExecutionIdentity } from "./cgroups-v2.js";
import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";

/** Durable execution ownership is a domain contract, not an orchestration record. */
export const SESSION_EXECUTION_RECORD_CONTRACT_ID = "nawabari.session-execution-record.v1" as const;
export const SESSION_EXECUTION_RECORD_SCHEMA_VERSION = 1 as const;

export const SESSION_EXECUTION_STATES = Object.freeze([
  "starting",
  "attached",
  "running",
  "exited",
  "unresolved",
] as const);

export type SessionExecutionState = (typeof SESSION_EXECUTION_STATES)[number];

export const SESSION_EXECUTION_RELEASE_OUTCOMES = Object.freeze(["succeeded", "failed", "unresolved"] as const);

export type SessionExecutionReleaseOutcome = (typeof SESSION_EXECUTION_RELEASE_OUTCOMES)[number];

/** The registry and domain-session names are intentionally stable wire keys. */
export const SESSION_EXECUTION_SERIALIZATION_KEYS = Object.freeze({
  registry: "registry",
  domainSession: "domain-session",
} as const);

export type ExecutionSupervisorIdentity = Readonly<{
  readonly pid: number | null;
  /** Linux /proc starttime ticks; null is allowed only before attach. */
  readonly starttime: string | null;
}>;

export type SessionExecutionReleaseAttempt = Readonly<{
  /** Monotonic attempt number within one execution record. */
  readonly attempt: number;
  readonly outcome: SessionExecutionReleaseOutcome;
  readonly attempted_at: string;
  readonly reason?: string;
}>;

/**
 * The complete durable identity needed to distinguish one protected execution
 * from a later process that happens to reuse its PID.
 */
export type SessionExecutionRecord = Readonly<{
  readonly contract_id: typeof SESSION_EXECUTION_RECORD_CONTRACT_ID;
  readonly schema_version: typeof SESSION_EXECUTION_RECORD_SCHEMA_VERSION;
  readonly session_id: string;
  readonly execution_id: string;
  readonly state: SessionExecutionState;
  readonly profile_digest: string;
  readonly filesystem_token: string;
  readonly runtime_epoch: string | number;
  readonly boot_id: string;
  readonly supervisor_pid: number | null;
  readonly supervisor_starttime: string | null;
  readonly cgroup_identity: CgroupExecutionIdentity;
  readonly release_attempt: SessionExecutionReleaseAttempt | null;
  readonly created_at: string;
  readonly updated_at: string;
}>;

export type PersistedSessionExecutionRecord = Readonly<{
  readonly contract_id: typeof SESSION_EXECUTION_RECORD_CONTRACT_ID;
  readonly schema_version: typeof SESSION_EXECUTION_RECORD_SCHEMA_VERSION;
  readonly session_id: string;
  readonly execution_id: string;
  readonly state: SessionExecutionState;
  readonly profile_digest: string;
  readonly filesystem_token: string;
  readonly runtime_epoch: string | number;
  readonly boot_id: string;
  readonly supervisor_pid: number | null;
  readonly supervisor_starttime: string | null;
  readonly cgroup_identity: CgroupExecutionIdentity;
  readonly release_attempt: SessionExecutionReleaseAttempt | null;
  readonly created_at: string;
  readonly updated_at: string;
}>;

export type SessionExecutionReservationInput = Readonly<{
  readonly session_id: string;
  /** Supply the ID chosen by the cgroup authority, or let this boundary create it. */
  readonly execution_id?: string;
  readonly profile_digest: string;
  readonly filesystem_token: string;
  readonly runtime_epoch: string | number;
  readonly boot_id: string;
  readonly cgroup_identity?: CgroupExecutionIdentity;
  readonly now?: string;
  readonly id_generator?: () => string;
}>;

export type SessionExecutionStateInput = Readonly<{
  readonly state: SessionExecutionState;
  readonly now?: string;
  readonly supervisor?: Readonly<{ readonly pid: number; readonly starttime: string }>;
  readonly release_attempt?: SessionExecutionReleaseAttempt | null;
}>;

export type SessionExecutionObservationClassification =
  "matched" | "pid-reused" | "different-boot" | "different-cgroup" | "unresolved";

export type LegacyUntrackedExecutionObservation = Readonly<{
  readonly session_id: string;
  readonly execution_id: null;
  readonly classification: "legacy-untracked";
  readonly matches: false;
  readonly active: false;
  readonly expected: null;
  readonly observed: null;
}>;

export type SessionExecutionProcessObservation = Readonly<{
  readonly pid: number;
  readonly starttime: string;
  readonly boot_id: string;
  readonly cgroup_path: string;
}>;

export type SessionExecutionIdentityObservation = Readonly<{
  readonly session_id: string;
  readonly execution_id: string;
  readonly classification: SessionExecutionObservationClassification;
  readonly matches: boolean;
  /** Only attached/running records are active; absence never implies active. */
  readonly active: boolean;
  readonly expected: Readonly<{
    readonly pid: number;
    readonly starttime: string;
    readonly boot_id: string;
    readonly cgroup_name: string;
  }>;
  readonly observed: SessionExecutionProcessObservation | null;
}>;

/** Injectable only as a factual observation seam; it is never an authority. */
export type SessionExecutionIdentityReader = Readonly<{
  readonly read_boot_id: () => string;
  readonly read_process_starttime: (pid: number) => string;
  readonly read_process_cgroup: (pid: number) => string;
}>;

export type SessionExecutionDurableWriter = (record: PersistedSessionExecutionRecord) => void | Promise<void>;

export type SessionExecutionReservationResult<T> = Readonly<{
  readonly record: SessionExecutionRecord;
  readonly payload: T;
}>;

const SAFE_TEXT = /^[^\u0000\u0001-\u001f\u007f]+$/u;
const PID_MIN = 1;
const PID_MAX = 4_194_304;
const MAX_RELEASE_REASON = 1_024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSafeText(value: unknown, maximum = 512): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maximum && SAFE_TEXT.test(value);
}

function isPid(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= PID_MIN && value <= PID_MAX;
}

function isStarttime(value: unknown): value is string {
  return typeof value === "string" && /^\d+$/u.test(value) && value.length <= 64;
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.length <= 64 && Number.isFinite(Date.parse(value));
}

function nowTimestamp(): string {
  return new Date().toISOString();
}

function executionError(message: string, details: JsonObject = {}): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, details));
}

function registryError(message: string, details: JsonObject = {}): DomainResult<never> {
  return failure(new DomainError("REGISTRY_DURABILITY_UNCERTAIN", message, details));
}

function observationError(message: string, details: JsonObject = {}): DomainResult<never> {
  return failure(new DomainError("PHYSICAL_OBSERVATION_UNAVAILABLE", message, details));
}

function normalizeText(value: string): string {
  return value.normalize("NFC");
}

function validRuntimeEpoch(value: unknown): value is string | number {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    (typeof value === "string" && isSafeText(value, 256))
  );
}

function validateIdentity(identity: unknown, field: string): DomainResult<CgroupExecutionIdentity> {
  if (!isRecord(identity)) return executionError(`${field} must be an execution identity object.`, { field });
  if (!isSafeText(identity.session_id) || !isSafeText(identity.execution_id)) {
    return executionError(`${field} must contain bounded session_id and execution_id values.`, { field });
  }
  return success(
    Object.freeze({
      session_id: normalizeText(identity.session_id),
      execution_id: normalizeText(identity.execution_id),
    }),
  );
}

function validateReleaseAttempt(value: unknown, field: string): DomainResult<SessionExecutionReleaseAttempt | null> {
  if (value === null || value === undefined) return success(null);
  if (!isRecord(value)) return executionError(`${field} must be an object or null.`, { field });
  if (
    typeof value.attempt !== "number" ||
    !Number.isSafeInteger(value.attempt) ||
    value.attempt < 1 ||
    !SESSION_EXECUTION_RELEASE_OUTCOMES.includes(value.outcome as SessionExecutionReleaseOutcome) ||
    !isTimestamp(value.attempted_at)
  ) {
    return executionError(`${field} contains invalid release-attempt evidence.`, { field });
  }
  if (value.reason !== undefined && !isSafeText(value.reason, MAX_RELEASE_REASON)) {
    return executionError(`${field}.reason must be bounded text.`, { field: `${field}.reason` });
  }
  return success(
    Object.freeze({
      attempt: value.attempt,
      outcome: value.outcome as SessionExecutionReleaseOutcome,
      attempted_at: value.attempted_at,
      ...(value.reason === undefined ? {} : { reason: normalizeText(value.reason) }),
    }),
  );
}

function validateRecordShape(value: unknown): DomainResult<SessionExecutionRecord> {
  if (!isRecord(value)) return executionError("Execution record must be an object.", { field: "record" });
  const allowedKeys = new Set([
    "contract_id",
    "schema_version",
    "session_id",
    "execution_id",
    "state",
    "profile_digest",
    "filesystem_token",
    "runtime_epoch",
    "boot_id",
    "supervisor_pid",
    "supervisor_starttime",
    "cgroup_identity",
    "release_attempt",
    "created_at",
    "updated_at",
  ]);
  const unexpectedKey = Object.keys(value).find((key) => !allowedKeys.has(key));
  if (unexpectedKey !== undefined) {
    return executionError("Execution record contains an unsupported field.", { field: unexpectedKey });
  }
  if (value.contract_id !== SESSION_EXECUTION_RECORD_CONTRACT_ID) {
    return executionError("Execution record contract_id is unsupported.", { field: "contract_id" });
  }
  if (value.schema_version !== SESSION_EXECUTION_RECORD_SCHEMA_VERSION) {
    return executionError("Execution record schema_version is unsupported.", { field: "schema_version" });
  }
  if (!isSafeText(value.session_id) || !isSafeText(value.execution_id)) {
    return executionError("Execution record identity is invalid.", { field: "session_id" });
  }
  if (!SESSION_EXECUTION_STATES.includes(value.state as SessionExecutionState)) {
    return executionError("Execution record state is unsupported.", { field: "state" });
  }
  if (!isSafeText(value.profile_digest, 256) || !isSafeText(value.filesystem_token, 512)) {
    return executionError("Execution record profile/filesystem evidence is invalid.", { field: "profile_digest" });
  }
  if (!validRuntimeEpoch(value.runtime_epoch) || !isSafeText(value.boot_id, 256)) {
    return executionError("Execution record runtime evidence is invalid.", { field: "runtime_epoch" });
  }
  if (value.supervisor_pid !== null && !isPid(value.supervisor_pid)) {
    return executionError("Execution record supervisor_pid is invalid.", { field: "supervisor_pid" });
  }
  if (value.supervisor_starttime !== null && !isStarttime(value.supervisor_starttime)) {
    return executionError("Execution record supervisor_starttime is invalid.", { field: "supervisor_starttime" });
  }
  if ((value.supervisor_pid === null) !== (value.supervisor_starttime === null)) {
    return executionError("Execution record supervisor identity must be complete or absent.", {
      field: "supervisor",
    });
  }
  if (!isTimestamp(value.created_at) || !isTimestamp(value.updated_at)) {
    return executionError("Execution record timestamps are invalid.", { field: "created_at" });
  }
  if (Date.parse(value.updated_at) < Date.parse(value.created_at)) {
    return executionError("Execution record updated_at precedes created_at.", { field: "updated_at" });
  }
  const identity = validateIdentity(value.cgroup_identity, "cgroup_identity");
  if (!identity.ok) return identity;
  if (identity.value.session_id !== value.session_id || identity.value.execution_id !== value.execution_id) {
    return executionError("cgroup_identity must match the record's session and execution identity.", {
      field: "cgroup_identity",
    });
  }
  const releaseAttempt = validateReleaseAttempt(value.release_attempt, "release_attempt");
  if (!releaseAttempt.ok) return releaseAttempt;
  return success(
    Object.freeze({
      contract_id: SESSION_EXECUTION_RECORD_CONTRACT_ID,
      schema_version: SESSION_EXECUTION_RECORD_SCHEMA_VERSION,
      session_id: normalizeText(value.session_id),
      execution_id: normalizeText(value.execution_id),
      state: value.state as SessionExecutionState,
      profile_digest: normalizeText(value.profile_digest),
      filesystem_token: normalizeText(value.filesystem_token),
      runtime_epoch: typeof value.runtime_epoch === "string" ? normalizeText(value.runtime_epoch) : value.runtime_epoch,
      boot_id: normalizeText(value.boot_id),
      supervisor_pid: value.supervisor_pid,
      supervisor_starttime: value.supervisor_starttime,
      cgroup_identity: identity.value,
      release_attempt: releaseAttempt.value,
      created_at: value.created_at,
      updated_at: value.updated_at,
    }),
  );
}

/** Validate and freeze one record read from a registry or a domain adapter. */
export function validateSessionExecutionRecord(value: unknown): DomainResult<SessionExecutionRecord> {
  return validateRecordShape(value);
}

/** Create the durable `starting` record that must precede any payload start. */
export function reserveExecution(input: SessionExecutionReservationInput): DomainResult<SessionExecutionRecord> {
  if (!isSafeText(input.session_id)) return executionError("session_id must be bounded text.", { field: "session_id" });
  if (!isSafeText(input.profile_digest, 256)) {
    return executionError("profile_digest must be bounded text.", { field: "profile_digest" });
  }
  if (!isSafeText(input.filesystem_token, 512)) {
    return executionError("filesystem_token must be bounded text.", { field: "filesystem_token" });
  }
  if (!validRuntimeEpoch(input.runtime_epoch)) {
    return executionError("runtime_epoch must be a non-negative integer or bounded token.", { field: "runtime_epoch" });
  }
  if (!isSafeText(input.boot_id, 256)) return executionError("boot_id must be bounded text.", { field: "boot_id" });
  const executionId = input.execution_id ?? input.id_generator?.() ?? crypto.randomUUID();
  if (!isSafeText(executionId)) return executionError("execution_id must be bounded text.", { field: "execution_id" });
  const cgroupIdentity = validateIdentity(
    input.cgroup_identity ?? { session_id: input.session_id, execution_id: executionId },
    "cgroup_identity",
  );
  if (!cgroupIdentity.ok) return cgroupIdentity;
  if (cgroupIdentity.value.session_id !== input.session_id || cgroupIdentity.value.execution_id !== executionId) {
    return executionError("cgroup_identity must match session_id and execution_id.", { field: "cgroup_identity" });
  }
  const timestamp = input.now ?? nowTimestamp();
  if (!isTimestamp(timestamp)) return executionError("now must be a valid timestamp.", { field: "now" });
  return success(
    Object.freeze({
      contract_id: SESSION_EXECUTION_RECORD_CONTRACT_ID,
      schema_version: SESSION_EXECUTION_RECORD_SCHEMA_VERSION,
      session_id: normalizeText(input.session_id),
      execution_id: normalizeText(executionId),
      state: "starting",
      profile_digest: normalizeText(input.profile_digest),
      filesystem_token: normalizeText(input.filesystem_token),
      runtime_epoch: typeof input.runtime_epoch === "string" ? normalizeText(input.runtime_epoch) : input.runtime_epoch,
      boot_id: normalizeText(input.boot_id),
      supervisor_pid: null,
      supervisor_starttime: null,
      cgroup_identity: cgroupIdentity.value,
      release_attempt: null,
      created_at: timestamp,
      updated_at: timestamp,
    }),
  );
}

const ALLOWED_TRANSITIONS: Readonly<Record<SessionExecutionState, readonly SessionExecutionState[]>> = Object.freeze({
  starting: ["starting", "attached", "running", "exited", "unresolved"],
  attached: ["attached", "running", "exited", "unresolved"],
  running: ["running", "exited", "unresolved"],
  exited: ["exited"],
  unresolved: ["unresolved", "exited"],
});

function validateSupervisor(value: unknown): DomainResult<ExecutionSupervisorIdentity> {
  if (!isRecord(value) || !isPid(value.pid) || !isStarttime(value.starttime)) {
    return executionError("supervisor identity must contain a valid pid and starttime.", { field: "supervisor" });
  }
  return success(Object.freeze({ pid: value.pid, starttime: value.starttime }));
}

/**
 * Apply one lifecycle observation to a record. This is deliberately pure: the
 * registry adapter persists the returned value under its own lock.
 */
export function recordExecutionState(
  record: SessionExecutionRecord,
  input: SessionExecutionStateInput,
): DomainResult<SessionExecutionRecord> {
  const current = validateRecordShape(record);
  if (!current.ok) return current;
  if (!SESSION_EXECUTION_STATES.includes(input.state)) {
    return executionError("state is unsupported.", { field: "state" });
  }
  if (!ALLOWED_TRANSITIONS[current.value.state].includes(input.state)) {
    return executionError("execution lifecycle transition is not allowed.", {
      from: current.value.state,
      to: input.state,
    });
  }
  const timestamp = input.now ?? nowTimestamp();
  if (!isTimestamp(timestamp) || Date.parse(timestamp) < Date.parse(current.value.created_at)) {
    return executionError("state transition timestamp is invalid.", { field: "now" });
  }
  let supervisor: ExecutionSupervisorIdentity = Object.freeze({
    pid: current.value.supervisor_pid,
    starttime: current.value.supervisor_starttime,
  });
  if (input.supervisor !== undefined) {
    const supplied = validateSupervisor(input.supervisor);
    if (!supplied.ok) return supplied;
    supervisor = supplied.value;
  }
  if ((input.state === "attached" || input.state === "running") && supervisor.pid === null) {
    return executionError(`${input.state} state requires supervisor identity.`, { field: "supervisor" });
  }
  if (input.state === "starting" && input.supervisor !== undefined) {
    return executionError("starting state cannot carry supervisor identity.", { field: "supervisor" });
  }
  const releaseAttemptResult =
    input.release_attempt === undefined
      ? success(current.value.release_attempt)
      : validateReleaseAttempt(input.release_attempt, "release_attempt");
  if (!releaseAttemptResult.ok) return releaseAttemptResult;
  const releaseAttempt = releaseAttemptResult.value;
  if (
    releaseAttempt !== null &&
    current.value.release_attempt !== null &&
    releaseAttempt.attempt < current.value.release_attempt.attempt
  ) {
    return executionError("release-attempt numbers must be monotonic.", { field: "release_attempt.attempt" });
  }
  return success(
    Object.freeze({
      ...current.value,
      state: input.state,
      supervisor_pid: supervisor.pid,
      supervisor_starttime: supervisor.starttime,
      release_attempt: releaseAttempt,
      updated_at: timestamp,
    }),
  );
}

/** Convert a validated domain record to the registry's stable JSON shape. */
export function toPersistedSessionExecutionRecord(record: SessionExecutionRecord): PersistedSessionExecutionRecord {
  const validated = validateRecordShape(record);
  if (!validated.ok) throw validated.error;
  return Object.freeze({
    ...validated.value,
    cgroup_identity: Object.freeze({ ...validated.value.cgroup_identity }),
    release_attempt:
      validated.value.release_attempt === null ? null : Object.freeze({ ...validated.value.release_attempt }),
  });
}

export const serializeSessionExecutionRecord = toPersistedSessionExecutionRecord;

/** Parse a registry value without adopting malformed or legacy state. */
export function parseSessionExecutionRecord(value: unknown): DomainResult<SessionExecutionRecord> {
  return validateRecordShape(value);
}

/**
 * Old registries may contain a session but no execution record. That absence
 * is an explicit legacy-untracked observation, never an active execution.
 */
export function observeMissingExecutionRecord(sessionId: string): DomainResult<LegacyUntrackedExecutionObservation> {
  if (!isSafeText(sessionId)) return executionError("session_id must be bounded text.", { field: "session_id" });
  return success(
    Object.freeze({
      session_id: normalizeText(sessionId),
      execution_id: null,
      classification: "legacy-untracked",
      matches: false,
      active: false,
      expected: null,
      observed: null,
    }),
  );
}

function parseProcessStarttime(raw: string): string | null {
  const commandEnd = raw.lastIndexOf(")");
  if (commandEnd === -1) return null;
  const fields = raw
    .slice(commandEnd + 1)
    .trim()
    .split(/\s+/u);
  const starttime = fields[19];
  return isStarttime(starttime) ? starttime : null;
}

function readBootId(): string {
  const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  if (!isSafeText(value, 256)) throw new Error("boot ID is unavailable");
  return value;
}

function readProcessStarttime(pid: number): string {
  const value = parseProcessStarttime(fs.readFileSync(`/proc/${pid}/stat`, "utf8"));
  if (value === null) throw new Error("process starttime is unavailable");
  return value;
}

function readProcessCgroup(pid: number): string {
  const raw = fs.readFileSync(`/proc/${pid}/cgroup`, "utf8");
  const unified = raw
    .split(/\r?\n/u)
    .find((line) => line.startsWith("0::"))
    ?.slice(3);
  if (unified === undefined || unified.length === 0 || unified.includes("\0")) {
    throw new Error("unified cgroup identity is unavailable");
  }
  return unified;
}

const nativeIdentityReader: SessionExecutionIdentityReader = Object.freeze({
  read_boot_id: readBootId,
  read_process_starttime: readProcessStarttime,
  read_process_cgroup: readProcessCgroup,
});

function cgroupPathMatches(cgroupPath: string, expectedName: string): boolean {
  if (!isSafeText(cgroupPath, 4_096)) return false;
  const normalized = cgroupPath;
  return normalized === `/${expectedName}` || normalized.endsWith(`/${expectedName}`);
}

/**
 * Observe all process-generation facts needed to prove ownership. A mismatch
 * is a successful negative observation; an unavailable observation is a
 * failure and must remain unresolved to callers.
 */
export function observeExecutionIdentity(
  record: SessionExecutionRecord,
  options: Readonly<{ readonly reader?: SessionExecutionIdentityReader }> = {},
): DomainResult<SessionExecutionIdentityObservation> {
  const validated = validateRecordShape(record);
  if (!validated.ok) return validated;
  if (validated.value.supervisor_pid === null || validated.value.supervisor_starttime === null) {
    return success(
      Object.freeze({
        session_id: validated.value.session_id,
        execution_id: validated.value.execution_id,
        classification: "unresolved",
        matches: false,
        active: false,
        expected: {
          pid: 0,
          starttime: "",
          boot_id: validated.value.boot_id,
          cgroup_name: deriveCgroupScopeName(validated.value.cgroup_identity),
        },
        observed: null,
      }),
    );
  }

  const expected = Object.freeze({
    pid: validated.value.supervisor_pid,
    starttime: validated.value.supervisor_starttime,
    boot_id: validated.value.boot_id,
    cgroup_name: deriveCgroupScopeName(validated.value.cgroup_identity),
  });
  const reader = options.reader ?? nativeIdentityReader;
  let observed: SessionExecutionProcessObservation;
  try {
    const bootId = reader.read_boot_id();
    const starttime = reader.read_process_starttime(expected.pid);
    const cgroupPath = reader.read_process_cgroup(expected.pid);
    if (!isSafeText(bootId, 256) || !isStarttime(starttime) || !isSafeText(cgroupPath, 4_096)) {
      return observationError("Execution identity observation returned malformed evidence.", {
        session_id: validated.value.session_id,
        execution_id: validated.value.execution_id,
      });
    }
    observed = Object.freeze({ pid: expected.pid, starttime, boot_id: bootId, cgroup_path: cgroupPath });
  } catch (error: unknown) {
    return observationError("Execution identity could not be observed.", {
      session_id: validated.value.session_id,
      execution_id: validated.value.execution_id,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }

  const classification: SessionExecutionObservationClassification =
    observed.boot_id !== expected.boot_id
      ? "different-boot"
      : observed.starttime !== expected.starttime
        ? "pid-reused"
        : !cgroupPathMatches(observed.cgroup_path, expected.cgroup_name)
          ? "different-cgroup"
          : "matched";
  return success(
    Object.freeze({
      session_id: validated.value.session_id,
      execution_id: validated.value.execution_id,
      classification,
      matches: classification === "matched",
      active: classification === "matched" && ["attached", "running"].includes(validated.value.state),
      expected,
      observed,
    }),
  );
}

/**
 * Persist `starting` before invoking the protected payload. If the registry
 * write is uncertain or fails, the callback is never called.
 */
export async function reserveExecutionBeforePayload<T>(
  input: SessionExecutionReservationInput,
  persist: SessionExecutionDurableWriter,
  startPayload: (record: SessionExecutionRecord) => T | Promise<T>,
): Promise<DomainResult<SessionExecutionReservationResult<T>>> {
  const reserved = reserveExecution(input);
  if (!reserved.ok) return reserved;
  try {
    await persist(toPersistedSessionExecutionRecord(reserved.value));
  } catch (error: unknown) {
    return registryError("Execution reservation was not durably persisted; payload start is suppressed.", {
      session_id: reserved.value.session_id,
      execution_id: reserved.value.execution_id,
      cause: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
    });
  }
  try {
    const payload = await startPayload(reserved.value);
    return success(Object.freeze({ record: reserved.value, payload }));
  } catch (error: unknown) {
    return failure(
      new DomainError("SANDBOX_EXECUTION_FAILED", "Protected payload failed after execution reservation.", {
        session_id: reserved.value.session_id,
        execution_id: reserved.value.execution_id,
        cause: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      }),
    );
  }
}
