import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import {
  materializeSessionRuntimeDirectories,
  validateSessionRuntimeDirectoryManifest,
  type CompiledSessionEnvironment,
} from "./session-environment.js";
import {
  decideExecutionAdmission,
  type ExecutionAdmissionFacts,
  type ExecutionAdmissionReservation,
} from "./session-admission-decision.js";
import {
  recordExecutionState,
  serializeSessionExecutionRecord,
  validateSessionExecutionRecord,
  type PersistedSessionExecutionRecord,
  type SessionExecutionDurableWriter,
  type SessionExecutionRecord,
} from "./session-execution-record.js";
import {
  runSessionLaunchSupervisor,
  SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID,
  SESSION_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
  type SessionLaunchSupervisorPacket,
  type SessionLaunchSupervisorResult,
  type SupervisorAttachedEvidence,
  type SupervisorReleaseAttemptEvidence,
  type SupervisorStdioValue,
  type TrustedSandboxPayload,
} from "./session-launch-supervisor.js";
import {
  compileSandboxInvocation,
  openSeccompProfile,
  type SandboxCommand,
  type SandboxExecutionResult,
  type SandboxInvocation,
} from "./sandbox-launcher.js";
import type { SandboxExecutionRequest } from "./sandbox.js";
import { validateWorktreeRuntimeProfile, type ResolvedWorktreeRuntimeProfile } from "./worktree-runtime-profile.js";
import { resolveSessionHookSet } from "./session-git-hooks.js";
import type { SessionBackend, SessionContext } from "./session.js";
import { enterSessionConsole, type SessionConsoleEnterOptions } from "./session-console.js";

export {
  resolveSandboxExecutionRequest,
  type SandboxExecutionRequest,
  type SandboxProbe,
  type SandboxRuntimeLayout,
} from "./sandbox.js";
export { runInteractiveSandboxedCommand, type SandboxLauncherOptions } from "./sandbox-launcher.js";
export {
  enterSessionConsole,
  listSessionProcesses,
  type SessionConsoleEnterOptions,
  type SessionConsoleProcessesOptions,
  type SessionConsoleRunner,
} from "./session-console.js";

/**
 * The one protected-launch input crossing the session/profile/environment
 * boundary.  The upper worktree profile remains separate from the lower
 * materialized runtime projection carried by the sandbox request.
 */
export type SessionProtectedLaunchInput = Readonly<{
  readonly profile: ResolvedWorktreeRuntimeProfile;
  readonly compiled_environment: CompiledSessionEnvironment;
  readonly request: SandboxExecutionRequest;
  readonly command: SandboxCommand;
  readonly stdio?: readonly [SupervisorStdioValue, SupervisorStdioValue, SupervisorStdioValue];
  readonly admission: ExecutionAdmissionFacts;
  readonly starting_record: SessionExecutionRecord;
  readonly supervisor: Omit<SessionLaunchSupervisorPacket, "admission" | "payload" | "durability">;
}>;

/** Factual and durable ports used by the protected composition. */
export type SessionProtectedLaunchDependencies = Readonly<{
  readonly materializeSessionRuntimeDirectories: typeof materializeSessionRuntimeDirectories;
  readonly compileSandboxInvocation: typeof compileSandboxInvocation;
  readonly runSessionLaunchSupervisor: typeof runSessionLaunchSupervisor;
  readonly persist_execution: SessionExecutionDurableWriter;
  readonly read_process_starttime: (pid: number) => string;
  readonly read_runtime_epoch: () => number;
}>;

export type SessionProtectedLaunchResult = Readonly<{
  readonly supervisor: SessionLaunchSupervisorResult;
  readonly execution: SessionExecutionRecord;
  /** Present only when the trusted worker proved a completed payload result. */
  readonly result?: SandboxExecutionResult;
}>;

function compositionFailure(
  code: "INVALID_ARGUMENT" | "REGISTRY_DURABILITY_UNCERTAIN" | "SANDBOX_EXECUTION_FAILED",
  message: string,
  details: JsonObject = {},
): DomainResult<never> {
  return failure(new DomainError(code, message, details));
}

function sameJson(left: unknown, right: unknown): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

function isSupervisorStdioValue(value: unknown): value is SupervisorStdioValue {
  return (
    (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
    value === "ignore" ||
    value === "inherit" ||
    value === "pipe"
  );
}

function validatedProtectedStdio(
  stdio: unknown,
): DomainResult<readonly [SupervisorStdioValue, SupervisorStdioValue, SupervisorStdioValue]> {
  if (
    !Array.isArray(stdio) ||
    stdio.length !== 3 ||
    !isSupervisorStdioValue(stdio[0]) ||
    !isSupervisorStdioValue(stdio[1]) ||
    !isSupervisorStdioValue(stdio[2])
  ) {
    return compositionFailure(
      "INVALID_ARGUMENT",
      "Protected launch stdio must contain three valid standard descriptor modes.",
    );
  }
  return success([stdio[0], stdio[1], stdio[2]]);
}

type AdmissionDenial = {
  readonly admitted: false;
  readonly status: "denied";
  readonly reason: string;
  readonly retryable: boolean;
  readonly session_id: string;
  readonly execution_id: string;
  readonly observed_epoch: number | null;
};

function noStartFromDenial(denied: AdmissionDenial): SessionLaunchSupervisorResult {
  return {
    contract_id: SESSION_LAUNCH_SUPERVISOR_CONTRACT_ID,
    schema_version: SESSION_LAUNCH_SUPERVISOR_SCHEMA_VERSION,
    status: "not-started",
    started: false,
    retryable: true,
    reason: "admission-denied",
    session_id: denied.session_id,
    execution_id: denied.execution_id,
    epoch: denied.observed_epoch,
    supervisor_pid: null,
    cgroup_scope: null,
    admission_reason: denied.reason,
  };
}

async function persistRecord(
  writer: SessionExecutionDurableWriter,
  record: SessionExecutionRecord,
  operation: string,
): Promise<DomainResult<SessionExecutionRecord>> {
  const persisted: PersistedSessionExecutionRecord = serializeSessionExecutionRecord(record);
  try {
    await writer(persisted);
  } catch (error: unknown) {
    return compositionFailure(
      "REGISTRY_DURABILITY_UNCERTAIN",
      "The protected session execution record was not durably persisted.",
      {
        operation,
        session_id: record.session_id,
        execution_id: record.execution_id,
        cause: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      },
    );
  }
  return success(record);
}

function validateInputIdentities(input: SessionProtectedLaunchInput): DomainResult<{
  readonly profile: ResolvedWorktreeRuntimeProfile;
  readonly environment: CompiledSessionEnvironment;
  readonly record: SessionExecutionRecord;
  readonly stdio: readonly [SupervisorStdioValue, SupervisorStdioValue, SupervisorStdioValue];
}> {
  const stdio = validatedProtectedStdio(input.stdio === undefined ? ["ignore", "pipe", "pipe"] : input.stdio);
  if (!stdio.ok) return stdio;
  const profile = validateWorktreeRuntimeProfile(input.profile);
  if (!profile.ok) return failure(profile.error);
  if (input.request.git_profile !== undefined && !sameJson(input.request.git_profile, profile.value)) {
    return compositionFailure("INVALID_ARGUMENT", "The protected Git profile differs from the pinned upper profile.");
  }
  const hooks = resolveSessionHookSet(profile.value, input.request.hook_material);
  if (!hooks.ok) return hooks;
  const manifest = validateSessionRuntimeDirectoryManifest(input.compiled_environment.manifest);
  if (!manifest.ok) return failure(manifest.error);
  if (manifest.value.profile.id !== profile.value.id || manifest.value.profile.version !== profile.value.version) {
    return compositionFailure(
      "INVALID_ARGUMENT",
      "The compiled environment is not issued for the upper runtime profile.",
      {
        profile_id: profile.value.id,
        profile_version: profile.value.version,
        environment_profile_id: manifest.value.profile.id,
        environment_profile_version: manifest.value.profile.version,
      },
    );
  }
  const expectedShell = `/nawabari/bin/${profile.value.shell.entrypoint}`;
  if (input.compiled_environment.environment.SHELL !== expectedShell) {
    return compositionFailure("INVALID_ARGUMENT", "The compiled environment shell does not match the upper profile.", {
      expected_shell: expectedShell,
      shell: input.compiled_environment.environment.SHELL ?? null,
    });
  }

  const record = validateSessionExecutionRecord(input.starting_record);
  if (!record.ok) return failure(record.error);
  if (
    record.value.state !== "starting" ||
    record.value.supervisor_pid !== null ||
    record.value.release_attempt !== null
  ) {
    return compositionFailure("INVALID_ARGUMENT", "The protected launch requires a fresh starting execution record.", {
      state: record.value.state,
      execution_id: record.value.execution_id,
    });
  }
  const admission = input.admission;
  if (
    input.request.session_id !== admission.session_id ||
    manifest.value.session_id !== admission.session_id ||
    record.value.session_id !== admission.session_id
  ) {
    return compositionFailure("INVALID_ARGUMENT", "Protected launch session identities do not agree.", {
      request_session_id: input.request.session_id,
      admission_session_id: admission.session_id,
      manifest_session_id: manifest.value.session_id,
      record_session_id: record.value.session_id,
    });
  }
  if (
    manifest.value.execution_id !== admission.execution_id ||
    record.value.execution_id !== admission.execution_id ||
    record.value.cgroup_identity.execution_id !== admission.execution_id
  ) {
    return compositionFailure("INVALID_ARGUMENT", "Protected launch execution identities do not agree.", {
      admission_execution_id: admission.execution_id,
      manifest_execution_id: manifest.value.execution_id,
      record_execution_id: record.value.execution_id,
    });
  }
  if (input.request.cgroups !== undefined && input.request.cgroups.execution_id !== admission.execution_id) {
    return compositionFailure("INVALID_ARGUMENT", "The sandbox request execution identity differs from admission.", {
      request_execution_id: input.request.cgroups.execution_id,
      admission_execution_id: admission.execution_id,
    });
  }
  if (String(record.value.runtime_epoch) !== String(admission.expected.epoch)) {
    return compositionFailure("INVALID_ARGUMENT", "The starting record epoch differs from admission.", {
      record_epoch: record.value.runtime_epoch,
      admission_epoch: admission.expected.epoch,
    });
  }
  if (
    input.request.compiled_session_environment !== undefined &&
    !sameJson(input.request.compiled_session_environment, input.compiled_environment)
  ) {
    return compositionFailure("INVALID_ARGUMENT", "The sandbox request carries a different compiled environment.", {
      session_id: admission.session_id,
      execution_id: admission.execution_id,
    });
  }
  return success({
    profile: profile.value,
    environment: Object.freeze({
      environment: Object.freeze({ ...input.compiled_environment.environment }),
      manifest: manifest.value,
    }),
    record: record.value,
    stdio: stdio.value,
  });
}

/**
 * Compose the accepted environment, existing sandbox compiler, seccomp
 * descriptor, and repaired trusted supervisor without allowing the payload to
 * cross a durable or freshness gate.
 */
export async function launchProtectedSessionExecution(
  input: SessionProtectedLaunchInput,
  deps: SessionProtectedLaunchDependencies,
): Promise<DomainResult<SessionProtectedLaunchResult>> {
  const identities = validateInputIdentities(input);
  if (!identities.ok) return identities;
  const admission = decideExecutionAdmission(input.admission);
  if (!admission.ok) return admission;
  if (!admission.value.admitted) {
    return success({
      supervisor: noStartFromDenial(admission.value),
      execution: identities.value.record,
    });
  }
  const reservation: ExecutionAdmissionReservation = admission.value.reservation;
  if (
    reservation.session_id !== identities.value.record.session_id ||
    reservation.execution_id !== identities.value.record.execution_id
  ) {
    return compositionFailure(
      "INVALID_ARGUMENT",
      "The admission reservation identity differs from the starting record.",
      {},
    );
  }

  let current = identities.value.record;
  const starting = await persistRecord(deps.persist_execution, current, "starting");
  if (!starting.ok) return starting;
  current = starting.value;

  let materialized;
  try {
    materialized = deps.materializeSessionRuntimeDirectories(identities.value.environment.manifest);
  } catch (error: unknown) {
    return compositionFailure(
      "SANDBOX_EXECUTION_FAILED",
      "The accepted session environment could not be materialized.",
      {
        session_id: current.session_id,
        execution_id: current.execution_id,
        cause: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      },
    );
  }
  if (!materialized.ok) return materialized;

  const request: SandboxExecutionRequest = {
    ...input.request,
    git_profile: identities.value.profile,
    compiled_session_environment: identities.value.environment,
  };
  let invocation: DomainResult<SandboxInvocation>;
  try {
    invocation = deps.compileSandboxInvocation(request, input.command);
  } catch (error: unknown) {
    return compositionFailure("SANDBOX_EXECUTION_FAILED", "The protected sandbox invocation could not be compiled.", {
      session_id: current.session_id,
      execution_id: current.execution_id,
      cause: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
  if (!invocation.ok) return invocation;

  const profile = openSeccompProfile(
    invocation.value.seccomp_profile,
    identities.value.environment.manifest.execution.tmp.path,
  );
  if (!profile.ok) return profile;

  const payload: TrustedSandboxPayload = {
    executable: invocation.value.executable,
    args: invocation.value.args,
    cwd: invocation.value.cwd,
    env: invocation.value.env,
    stdio: [identities.value.stdio[0], identities.value.stdio[1], identities.value.stdio[2], profile.value.fd],
    seccomp_fd: profile.value.fd,
  };

  const durability = {
    mark_attached: async (evidence: SupervisorAttachedEvidence) => {
      let starttime: string;
      try {
        starttime = deps.read_process_starttime(evidence.supervisor_pid);
      } catch (error: unknown) {
        throw new Error(
          `supervisor starttime observation failed: ${error instanceof Error ? error.message : "unknown"}`,
        );
      }
      const attached = recordExecutionState(current, {
        state: "attached",
        supervisor: { pid: evidence.supervisor_pid, starttime },
      });
      if (!attached.ok) throw attached.error;
      const persisted = await persistRecord(deps.persist_execution, attached.value, "attached");
      if (!persisted.ok) throw persisted.error;
      current = persisted.value;
    },
    record_release_attempt: async (_evidence: SupervisorReleaseAttemptEvidence) => {
      const attempt = (current.release_attempt?.attempt ?? 0) + 1;
      const released = recordExecutionState(current, {
        state: "attached",
        release_attempt: {
          attempt,
          outcome: "unresolved",
          attempted_at: new Date().toISOString(),
          reason: "pre-GO release attempt after fresh epoch validation",
        },
      });
      if (!released.ok) throw released.error;
      const persisted = await persistRecord(deps.persist_execution, released.value, "release-attempt");
      if (!persisted.ok) throw persisted.error;
      current = persisted.value;
    },
    revalidate_epoch: () => {
      try {
        const observed = deps.read_runtime_epoch();
        return typeof observed === "number" && Number.isSafeInteger(observed) && observed === reservation.epoch;
      } catch {
        return false;
      }
    },
  };

  let supervised: DomainResult<SessionLaunchSupervisorResult>;
  try {
    supervised = await deps.runSessionLaunchSupervisor({
      ...input.supervisor,
      admission: reservation,
      payload,
      durability,
    });
  } catch (error: unknown) {
    supervised = compositionFailure("SANDBOX_EXECUTION_FAILED", "The trusted supervisor composition failed closed.", {
      session_id: current.session_id,
      execution_id: current.execution_id,
      cause: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  } finally {
    profile.value.close();
  }
  if (!supervised.ok) return supervised;

  if (!supervised.value.started) {
    return success({ supervisor: supervised.value, execution: current });
  }

  const terminalState = supervised.value.status === "unresolved" ? "unresolved" : "exited";
  const terminal = recordExecutionState(current, { state: terminalState });
  if (!terminal.ok) return terminal;
  const persistedTerminal = await persistRecord(
    deps.persist_execution,
    terminal.value,
    terminalState === "exited" ? "terminal" : "unresolved",
  );
  if (!persistedTerminal.ok) return persistedTerminal;

  if (supervised.value.status === "completed" && supervised.value.result !== undefined) {
    return success({
      supervisor: supervised.value,
      execution: persistedTerminal.value,
      result: supervised.value.result as SandboxExecutionResult,
    });
  }
  return success({ supervisor: supervised.value, execution: persistedTerminal.value });
}

/** Protected launch composition consumed by the session-enter integration. */
export async function enterProtectedSession(
  context: SessionContext,
  backend: SessionBackend,
  options: SessionConsoleEnterOptions,
) {
  if (backend.persistSessionExecution === undefined) {
    throw new Error("Protected session launch requires durable execution persistence");
  }
  return enterSessionConsole(context, backend, {
    ...options,
    persist_execution:
      options.persist_execution ??
      (async (record) => {
        const result = await backend.persistSessionExecution!(context, record);
        if (!result.ok) throw result.error;
      }),
  });
}
