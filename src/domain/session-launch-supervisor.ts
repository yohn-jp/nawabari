import { spawn } from "node:child_process";
import process from "node:process";

import {
  attachProcessToCgroup,
  cleanupCgroupScope,
  createCgroupScope,
  type CgroupFileSystem,
  type CgroupLimitProfile,
  type CgroupScope,
} from "./cgroups-v2.js";
import {
  decideExecutionAdmission,
  SESSION_ADMISSION_CONTRACT_ID,
  validateExecutionAdmissionReservation,
  type ExecutionAdmissionFacts,
  type ExecutionAdmissionDecision,
  type ExecutionAdmissionReservation,
} from "./session-admission-decision.js";
import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";

export const SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID = "nawabari.session-launch-supervisor.v1" as const;
export const SESSION_LAUNCH_SUPERVISOR_SCHEMA_VERSION = 1 as const;

const DEFAULT_RESULT_TIMEOUT_MS = 5 * 60 * 1_000;
const MAX_TEXT_LENGTH = 4_096;

export type SupervisorStdioValue = "ignore" | "inherit" | "pipe" | number;

/** The compiled bwrap launch handed to the trusted package after GO. */
export type TrustedSandboxPayload = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Exact stdio topology expected by the existing launcher. Index 3 is seccomp. */
  readonly stdio: readonly [SupervisorStdioValue, SupervisorStdioValue, SupervisorStdioValue, number];
  /** Descriptor passed to the trusted supervisor as fd 3. */
  readonly seccomp_fd: number;
};

/** Absolute entrypoint belonging to the pinned, repository-trusted supervisor package. */
export type TrustedSupervisorSpec = {
  readonly entrypoint: string;
  readonly args?: readonly string[];
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly node_executable?: string;
};

export type SupervisorParentConnection = {
  readonly is_connected: () => boolean;
  /** Resolves when the parent has disconnected; it is only observed after GO. */
  readonly wait_for_disconnect?: Promise<void>;
};

export type SupervisorAttachedEvidence = {
  readonly contract_id: typeof SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID;
  readonly session_id: string;
  readonly execution_id: string;
  readonly supervisor_pid: number;
  readonly cgroup_scope: string | null;
  readonly epoch: number;
};

export type SupervisorReleaseAttemptEvidence = SupervisorAttachedEvidence & {
  readonly operation: "release-attempt";
};

export type SupervisorDurability = {
  /** Durable `attached` transition; GO is forbidden until this resolves. */
  readonly mark_attached?: (evidence: SupervisorAttachedEvidence) => void | Promise<void>;
  /** Durable release-attempt record; called after epoch revalidation and before GO. */
  readonly record_release_attempt?: (evidence: SupervisorReleaseAttemptEvidence) => void | Promise<void>;
  /** Re-observe the canonical epoch immediately before GO. */
  readonly revalidate_epoch?: () => boolean | number | Promise<boolean | number>;
};

export type SupervisorCgroupOptions = {
  readonly required?: boolean;
  readonly root?: string;
  readonly limits?: CgroupLimitProfile;
  readonly filesystem?: CgroupFileSystem;
  readonly create_scope?: typeof createCgroupScope;
  readonly attach_process?: typeof attachProcessToCgroup;
  readonly cleanup_scope?: typeof cleanupCgroupScope;
};

export type SupervisorStartRequest = {
  readonly reservation: ExecutionAdmissionReservation;
  readonly trusted: TrustedSupervisorSpec;
  readonly payload: TrustedSandboxPayload;
};

export type SupervisorChildResult =
  { readonly status: "completed"; readonly result?: unknown } | { readonly status: "failed"; readonly error?: string };

export type TrustedSupervisorProcess = {
  readonly pid: number;
  readonly send_go: () => void | Promise<void>;
  readonly terminate: () => void;
  readonly wait: () => Promise<SupervisorChildResult>;
};

export type TrustedSupervisorFactory = (
  request: SupervisorStartRequest,
) => TrustedSupervisorProcess | Promise<TrustedSupervisorProcess>;

export type SessionLaunchSupervisorPacket = {
  readonly admission: ExecutionAdmissionReservation | ExecutionAdmissionFacts;
  readonly trusted: TrustedSupervisorSpec;
  readonly payload: TrustedSandboxPayload;
  readonly parent?: SupervisorParentConnection;
  readonly durability?: SupervisorDurability;
  readonly cgroup?: SupervisorCgroupOptions;
  readonly result_timeout_ms?: number;
  /** Test/runtime seam; production uses the host-Node implementation below. */
  readonly process_factory?: TrustedSupervisorFactory;
};

export type SupervisorNotStartedReason =
  "admission-denied" | "parent-disconnected-before-go" | "stale-epoch" | "supervisor-setup-failed";

export type SessionLaunchSupervisorResult =
  | {
      readonly contract_id: typeof SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID;
      readonly schema_version: typeof SESSION_LAUNCH_SUPERVISOR_SCHEMA_VERSION;
      readonly status: "not-started";
      readonly started: false;
      readonly retryable: true;
      readonly reason: SupervisorNotStartedReason;
      readonly session_id: string;
      readonly execution_id: string;
      readonly epoch: number | null;
      readonly supervisor_pid: number | null;
      readonly cgroup_scope: string | null;
      readonly admission_reason?: string;
    }
  | {
      readonly contract_id: typeof SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID;
      readonly schema_version: typeof SESSION_LAUNCH_SUPERVISOR_SCHEMA_VERSION;
      readonly status: "completed" | "failed";
      readonly started: true;
      readonly retryable: false;
      readonly result?: unknown;
      readonly error?: string;
      readonly session_id: string;
      readonly execution_id: string;
      readonly epoch: number | null;
      readonly supervisor_pid: number;
      readonly cgroup_scope: string | null;
    }
  | {
      readonly contract_id: typeof SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID;
      readonly schema_version: typeof SESSION_LAUNCH_SUPERVISOR_SCHEMA_VERSION;
      readonly status: "unresolved";
      readonly started: true;
      readonly retryable: false;
      readonly reason: "parent-disconnected-after-go" | "timeout" | "go-send-failed" | "result-unknown";
      readonly session_id: string;
      readonly execution_id: string;
      readonly epoch: number | null;
      readonly supervisor_pid: number;
      readonly cgroup_scope: string | null;
    };

function invalid(message: string, details: JsonObject): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, details));
}

function isBoundedText(value: unknown, maxLength = MAX_TEXT_LENGTH): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength && !value.includes("\0");
}

function isAbsolutePath(value: unknown): value is string {
  return isBoundedText(value) && value.startsWith("/");
}

function isSafeFd(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function validateArgs(args: readonly string[] | undefined, field: string): DomainResult<readonly string[]> {
  const values = args ?? [];
  if (values.some((value) => !isBoundedText(value))) {
    return invalid(`The trusted supervisor ${field} contains an invalid argument.`, { field });
  }
  return success([...values]);
}

function validateTrustedSpec(spec: TrustedSupervisorSpec): DomainResult<TrustedSupervisorSpec> {
  if (!isAbsolutePath(spec.entrypoint) || !isAbsolutePath(spec.cwd)) {
    return invalid("The trusted supervisor entrypoint and cwd must be absolute paths.", {});
  }
  const args = validateArgs(spec.args, "argument list");
  if (!args.ok) return args;
  if (spec.node_executable !== undefined && !isAbsolutePath(spec.node_executable)) {
    return invalid("The trusted supervisor Node executable must be an absolute path.", {});
  }
  const env = spec.env ?? {};
  for (const [key, value] of Object.entries(env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !isBoundedText(value)) {
      return invalid("The trusted supervisor environment contains an invalid entry.", { key });
    }
  }
  return success({
    entrypoint: spec.entrypoint,
    args: args.value,
    cwd: spec.cwd,
    env: { ...env },
    ...(spec.node_executable === undefined ? {} : { node_executable: spec.node_executable }),
  });
}

function validatePayload(payload: TrustedSandboxPayload): DomainResult<TrustedSandboxPayload> {
  if (!isAbsolutePath(payload.executable) || !isAbsolutePath(payload.cwd)) {
    return invalid("The trusted sandbox executable and cwd must be absolute paths.", {});
  }
  const args = validateArgs(payload.args, "sandbox argument list");
  if (!args.ok) return args;
  if (!isSafeFd(payload.seccomp_fd) || payload.stdio.length !== 4 || payload.stdio[3] !== payload.seccomp_fd) {
    return invalid("The trusted sandbox seccomp descriptor and stdio topology are invalid.", {});
  }
  for (const value of payload.stdio.slice(0, 3)) {
    if (typeof value === "number" && !isSafeFd(value)) {
      return invalid("The trusted sandbox stdio descriptor is invalid.", {});
    }
    if (typeof value === "string" && value !== "ignore" && value !== "inherit" && value !== "pipe") {
      return invalid("The trusted sandbox stdio mode is invalid.", {});
    }
  }
  for (const [key, value] of Object.entries(payload.env)) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !isBoundedText(value)) {
      return invalid("The trusted sandbox environment contains an invalid entry.", { key });
    }
  }
  return success({
    executable: payload.executable,
    args: args.value,
    cwd: payload.cwd,
    env: { ...payload.env },
    stdio: [...payload.stdio] as [SupervisorStdioValue, SupervisorStdioValue, SupervisorStdioValue, number],
    seccomp_fd: payload.seccomp_fd,
  });
}

function scrubHostNodeEnvironment(environment: Readonly<Record<string, string>> | undefined): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment ?? {})) {
    if (
      key === "NODE_OPTIONS" ||
      key === "NODE_PATH" ||
      key === "NODE_EXTRA_CA_CERTS" ||
      key === "NODE_V8_COVERAGE" ||
      key.startsWith("TS_NODE") ||
      key.startsWith("TSX_")
    ) {
      continue;
    }
    safe[key] = value;
  }
  return safe;
}

function defaultSupervisorFactory(request: SupervisorStartRequest): TrustedSupervisorProcess {
  const trusted = request.trusted;
  const child = spawn(trusted.node_executable ?? process.execPath, [trusted.entrypoint, ...(trusted.args ?? [])], {
    cwd: trusted.cwd,
    env: scrubHostNodeEnvironment(trusted.env),
    shell: false,
    // fd 3 is deliberately passed through to the trusted package.  The
    // package receives the GO message on stdin and must not expose a public
    // command server.
    stdio: ["pipe", "pipe", "pipe", request.payload.seccomp_fd],
  });

  let settled = false;
  const waitPromise = new Promise<SupervisorChildResult>((resolve) => {
    const finish = (result: SupervisorChildResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.once("error", (error: Error) => finish({ status: "failed", error: error.message.slice(0, 240) }));
    child.once("close", (code, signal) => {
      if (code === 0) finish({ status: "completed" });
      else finish({ status: "failed", error: `supervisor exited with ${signal ?? `code ${code ?? "unknown"}`}` });
    });
  });
  const wait = (): Promise<SupervisorChildResult> => waitPromise;
  return {
    pid: child.pid ?? -1,
    send_go: () => {
      if (child.stdin === null || child.stdin.destroyed) throw new Error("trusted supervisor stdin is unavailable");
      const message = JSON.stringify({
        type: "GO",
        contract_id: SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID,
        admission_contract_id: SESSION_ADMISSION_CONTRACT_ID,
        reservation: request.reservation,
        payload: {
          executable: request.payload.executable,
          args: request.payload.args,
          cwd: request.payload.cwd,
          env: request.payload.env,
          stdio: request.payload.stdio,
          seccomp_fd: 3,
        },
      });
      child.stdin.write(`${message}\n`);
      child.stdin.end();
    },
    terminate: () => {
      if (!child.killed) child.kill("SIGKILL");
    },
    wait,
  };
}

function isAdmissionFacts(value: SessionLaunchSupervisorPacket["admission"]): value is ExecutionAdmissionFacts {
  return "current" in value && "expected" in value;
}

type AdmissionDenial = Extract<ExecutionAdmissionDecision, { readonly admitted: false }>;
type AdmissionResolution = ExecutionAdmissionReservation | AdmissionDenial;

function reservationFor(value: SessionLaunchSupervisorPacket["admission"]): DomainResult<AdmissionResolution> {
  if (isAdmissionFacts(value)) {
    const decision = decideExecutionAdmission(value);
    if (!decision.ok) return decision;
    if (!decision.value.admitted) return success(decision.value);
    return success(decision.value.reservation);
  }
  return validateExecutionAdmissionReservation(value);
}

type SupervisorResultBase = {
  readonly contract_id: typeof SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID;
  readonly schema_version: typeof SESSION_LAUNCH_SUPERVISOR_SCHEMA_VERSION;
  readonly session_id: string;
  readonly execution_id: string;
  readonly epoch: number | null;
  readonly supervisor_pid: number | null;
  readonly cgroup_scope: string | null;
};

function outcomeBase(
  reservation: ExecutionAdmissionReservation,
  supervisorPid: number | null,
  cgroupScope: string | null,
): SupervisorResultBase {
  return outcomeBaseFields(
    reservation.session_id,
    reservation.execution_id,
    reservation.epoch,
    supervisorPid,
    cgroupScope,
  );
}

function outcomeBaseFields(
  sessionId: string,
  executionId: string,
  epoch: number | null,
  supervisorPid: number | null,
  cgroupScope: string | null,
): SupervisorResultBase {
  return {
    contract_id: SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID,
    schema_version: SESSION_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    session_id: sessionId,
    execution_id: executionId,
    epoch,
    supervisor_pid: supervisorPid,
    cgroup_scope: cgroupScope,
  };
}

function notStarted(
  reservation: ExecutionAdmissionReservation,
  reason: SupervisorNotStartedReason,
  supervisorPid: number | null,
  cgroupScope: string | null,
  admissionReason?: string,
): Extract<SessionLaunchSupervisorResult, { readonly status: "not-started" }> {
  return {
    ...outcomeBase(reservation, supervisorPid, cgroupScope),
    status: "not-started",
    started: false,
    retryable: true,
    reason,
    ...(admissionReason === undefined ? {} : { admission_reason: admissionReason }),
  };
}

function deniedResult(
  denied: AdmissionDenial,
): Extract<SessionLaunchSupervisorResult, { readonly status: "not-started" }> {
  return {
    ...outcomeBaseFields(denied.session_id, denied.execution_id, denied.observed_epoch, null, null),
    status: "not-started",
    started: false,
    retryable: true,
    reason: "admission-denied",
    admission_reason: denied.reason,
  };
}

function unresolved(
  reservation: ExecutionAdmissionReservation,
  reason: Extract<SessionLaunchSupervisorResult, { readonly status: "unresolved" }>["reason"],
  supervisorPid: number,
  cgroupScope: string | null,
): Extract<SessionLaunchSupervisorResult, { readonly status: "unresolved" }> {
  return {
    ...outcomeBase(reservation, supervisorPid, cgroupScope),
    supervisor_pid: supervisorPid,
    status: "unresolved",
    started: true,
    retryable: false,
    reason,
  };
}

async function callMaybe(value: (() => void | Promise<void>) | undefined): Promise<void> {
  await value?.();
}

async function epochIsCurrent(
  reservation: ExecutionAdmissionReservation,
  durability: SupervisorDurability | undefined,
): Promise<boolean> {
  const observed = await (durability?.revalidate_epoch?.() ?? true);
  return typeof observed === "boolean" ? observed : observed === reservation.epoch;
}

function cgroupErrorDetails(error: unknown): string {
  return error instanceof DomainError
    ? error.message.slice(0, 240)
    : error instanceof Error
      ? error.message.slice(0, 240)
      : "unknown";
}

function cleanupSupervisorScope(
  scope: CgroupScope | null,
  cleanup: typeof cleanupCgroupScope | undefined,
): string | null {
  if (scope === null) return null;
  const result = (cleanup ?? cleanupCgroupScope)(scope);
  return result.ok ? null : cgroupErrorDetails(result.error);
}

/**
 * Start one trusted supervisor and release its one-shot GO gate.  The parent
 * performs no user launch itself: the supervisor is attached first, its
 * attachment is durable, the epoch is checked again, and only then is GO sent.
 */
export async function runSessionLaunchSupervisor(
  packet: SessionLaunchSupervisorPacket,
): Promise<DomainResult<SessionLaunchSupervisorResult>> {
  const reservationResult = reservationFor(packet.admission);
  if (!reservationResult.ok) return reservationResult;
  if ("admitted" in reservationResult.value && !reservationResult.value.admitted) {
    const denied = reservationResult.value;
    return success(deniedResult(denied));
  }
  const reservation = reservationResult.value as ExecutionAdmissionReservation;
  const trusted = validateTrustedSpec(packet.trusted);
  if (!trusted.ok) return trusted;
  const payload = validatePayload(packet.payload);
  if (!payload.ok) return payload;
  const parent = packet.parent ?? { is_connected: () => true };
  const durability = packet.durability;
  const timeoutMs = packet.result_timeout_ms ?? DEFAULT_RESULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1) {
    return invalid("The supervisor result timeout must be a positive safe integer.", { result_timeout_ms: timeoutMs });
  }
  if (!parent.is_connected()) {
    return success(notStarted(reservation, "parent-disconnected-before-go", null, null));
  }

  const cgroup = packet.cgroup;
  if (
    cgroup?.required === true &&
    cgroup.create_scope === undefined &&
    cgroup.root === undefined &&
    cgroup.filesystem === undefined
  ) {
    return invalid("A required supervisor cgroup must provide a cgroups v2 root or creation seam.", {});
  }
  let scope: CgroupScope | null = null;
  if (cgroup !== undefined && cgroup.required !== false) {
    const create = cgroup.create_scope ?? createCgroupScope;
    const created = create(
      { session_id: reservation.session_id, execution_id: reservation.execution_id },
      { root: cgroup.root, limits: cgroup.limits, filesystem: cgroup.filesystem },
    );
    if (!created.ok) return created;
    scope = created.value;
  }

  const factory = packet.process_factory ?? defaultSupervisorFactory;
  let supervisor: TrustedSupervisorProcess;
  try {
    supervisor = await factory({ reservation, trusted: trusted.value, payload: payload.value });
  } catch (error: unknown) {
    const cleanupError = cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return failure(
      new DomainError("SANDBOX_EXECUTION_FAILED", "The trusted supervisor could not be started.", {
        reason: error instanceof Error ? error.message.slice(0, 240) : "unknown",
        ...(cleanupError === null ? {} : { cleanup_error: cleanupError }),
      }),
    );
  }
  if (!Number.isSafeInteger(supervisor.pid) || supervisor.pid < 1) {
    supervisor.terminate();
    cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return failure(
      new DomainError("SANDBOX_EXECUTION_FAILED", "The trusted supervisor did not expose a valid pid.", {}),
    );
  }

  if (scope !== null) {
    const attach = (cgroup?.attach_process ?? attachProcessToCgroup)(scope, supervisor.pid);
    if (!attach.ok) {
      supervisor.terminate();
      cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
      return attach;
    }
  }

  const attachedEvidence: SupervisorAttachedEvidence = {
    contract_id: SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID,
    session_id: reservation.session_id,
    execution_id: reservation.execution_id,
    supervisor_pid: supervisor.pid,
    cgroup_scope: scope?.name ?? null,
    epoch: reservation.epoch,
  };
  try {
    await callMaybe(
      durability?.mark_attached === undefined ? undefined : () => durability.mark_attached?.(attachedEvidence),
    );
  } catch (error: unknown) {
    supervisor.terminate();
    cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return failure(
      new DomainError("SANDBOX_EXECUTION_FAILED", "The durable attached transition failed.", {
        reason: cgroupErrorDetails(error),
      }),
    );
  }

  // A disconnect before GO proves that no user payload has started.  The
  // supervisor is terminated before this function returns that fact.
  if (!parent.is_connected()) {
    supervisor.terminate();
    cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return success(notStarted(reservation, "parent-disconnected-before-go", supervisor.pid, scope?.name ?? null));
  }
  if (!(await epochIsCurrent(reservation, durability))) {
    supervisor.terminate();
    cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return success(notStarted(reservation, "stale-epoch", supervisor.pid, scope?.name ?? null));
  }

  const releaseAttempt: SupervisorReleaseAttemptEvidence = { ...attachedEvidence, operation: "release-attempt" };
  try {
    await callMaybe(
      durability?.record_release_attempt === undefined
        ? undefined
        : () => durability.record_release_attempt?.(releaseAttempt),
    );
  } catch (error: unknown) {
    supervisor.terminate();
    cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return failure(
      new DomainError("SANDBOX_EXECUTION_FAILED", "The durable release-attempt record failed.", {
        reason: cgroupErrorDetails(error),
      }),
    );
  }
  if (!parent.is_connected()) {
    supervisor.terminate();
    cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return success(notStarted(reservation, "parent-disconnected-before-go", supervisor.pid, scope?.name ?? null));
  }

  try {
    await supervisor.send_go();
  } catch (error: unknown) {
    supervisor.terminate();
    cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return success(unresolved(reservation, "go-send-failed", supervisor.pid, scope?.name ?? null));
  }

  const resultPromise = supervisor.wait();
  const timeoutPromise = new Promise<"timeout">((resolve) => {
    setTimeout(() => resolve("timeout"), timeoutMs);
  });
  const disconnectPromise =
    parent.wait_for_disconnect === undefined
      ? new Promise<never>(() => undefined)
      : parent.wait_for_disconnect.then(() => "disconnected" as const);
  const observed = await Promise.race([
    resultPromise.then((result) => ({ kind: "result" as const, result })),
    timeoutPromise.then((result) => ({ kind: result })),
    disconnectPromise.then((result) => ({ kind: result })),
  ]);

  if (observed.kind === "timeout") {
    supervisor.terminate();
    cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return success(unresolved(reservation, "timeout", supervisor.pid, scope?.name ?? null));
  }
  if (observed.kind === "disconnected") {
    supervisor.terminate();
    cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
    return success(unresolved(reservation, "parent-disconnected-after-go", supervisor.pid, scope?.name ?? null));
  }

  const cleanupError = cleanupSupervisorScope(scope, cgroup?.cleanup_scope);
  if (cleanupError !== null) {
    return failure(
      new DomainError("SANDBOX_CGROUP_CLEANUP_FAILED", "The supervisor cgroup could not be cleaned up.", {
        reason: cleanupError,
      }),
    );
  }
  if (observed.result.status === "completed") {
    return success({
      ...outcomeBase(reservation, supervisor.pid, scope?.name ?? null),
      supervisor_pid: supervisor.pid,
      status: "completed" as const,
      started: true,
      retryable: false,
      ...(observed.result.result === undefined ? {} : { result: observed.result.result }),
    });
  }
  return success({
    ...outcomeBase(reservation, supervisor.pid, scope?.name ?? null),
    supervisor_pid: supervisor.pid,
    status: "failed" as const,
    started: true,
    retryable: false,
    ...(observed.result.error === undefined ? {} : { error: observed.result.error }),
  });
}

/** Expose the default host-Node factory for production composition tests. */
export const createTrustedSupervisorProcess: TrustedSupervisorFactory = defaultSupervisorFactory;
