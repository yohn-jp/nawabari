import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import {
  defaultSandboxProbe,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  type SandboxCommand,
  type SandboxExecutionRequest,
  type SandboxExecutionResult,
  type SandboxProbe,
  type SandboxRuntimeLayout,
} from "./sandbox.js";
import {
  compileSandboxInvocation,
  runInteractiveSandboxedCommand,
  type SandboxLauncherOptions,
} from "./sandbox-launcher.js";
import {
  observeExecutionIdentity,
  parseSessionExecutionRecord,
  recordExecutionState,
  reserveExecution,
  serializeSessionExecutionRecord,
  type PersistedSessionExecutionRecord,
  type SessionExecutionDurableWriter,
  type SessionExecutionIdentityObservation,
  type SessionExecutionIdentityReader,
  type SessionExecutionRecord,
} from "./session-execution-record.js";
import { CGROUPS_V2_CONTRACT_ID, CGROUPS_V2_ROOT, deriveCgroupScopeName, type CgroupFileSystem } from "./cgroups-v2.js";
import {
  observeOwnedExecution,
  SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
  type OwnedExecutionObservation,
  type SessionProcessObservationOptions,
} from "./session-process-observation.js";
import type {
  ExplicitCompatibilityRuntimePolicy,
  RuntimePolicy,
  SessionRuntimeProjection,
  StrictRuntimePolicy,
} from "./runtime-projection.js";
import type { ResolvedRuntimeProfile, RuntimeProfileSelection } from "./runtime-profile.js";
import type { RuntimeResolutionFhsOptions } from "./runtime-resolution.js";
import type { NixRuntimeClosureOptions } from "./nix-runtime-closure.js";
import type { SessionBackend, SessionContext, SessionManagedRuntimeState, SessionRecord } from "./session.js";
import {
  cleanupSessionRuntimeDirectories,
  compileSessionEnvironment,
  materializeSessionRuntimeDirectories,
} from "./session-environment.js";
import { compileWorkingSetRuntimeProjection } from "./working-set-runtime-projection.js";
import type { EffectiveWorkingSet } from "../working-set.js";
import { resolveProfileRuntimeScope } from "./worktree-profile-scope.js";
import { resolveWorktreeProfileRuntime } from "./worktree-profile-runtime.js";
import { runSessionLaunchSupervisor } from "./session-launch-supervisor.js";
import type { SessionLaunchSupervisorResult, SupervisorStdioValue } from "./session-launch-supervisor.js";
import { BASH_REQUIREMENT, BASH_STARTUP_ARGS } from "./shell-runtime.js";
import { CANONICAL_EXECUTABLE_ROOT } from "./runtime-executable-projection.js";
import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";

/** Versioned identity for the interactive session console producer. */
export const SESSION_CONSOLE_CONTRACT_ID = "nawabari.session-console.v1" as const;
export const SESSION_CONSOLE_SCHEMA_VERSION = 1 as const;

/** The serialization names reserved for the later CLI/domain/contract wiring. */
export const SESSION_CONSOLE_SERIALIZATION_KEYS = Object.freeze({
  cli: "cli",
  domainSession: "domain-session",
  contract: "contract",
} as const);

export const SESSION_CONSOLE_OPERATION_ENTER = "enter" as const;
export const SESSION_CONSOLE_OPERATION_PROCESSES = "processes" as const;

const CANONICAL_SHELL = BASH_REQUIREMENT.name;
const CANONICAL_SHELL_REQUIREMENT_ID = BASH_REQUIREMENT.id;
const CANONICAL_SHELL_TARGET = `${CANONICAL_EXECUTABLE_ROOT}/${CANONICAL_SHELL}`;

export type SessionConsoleRuntimePolicy = StrictRuntimePolicy | ExplicitCompatibilityRuntimePolicy;

export type SessionConsoleRunner = (
  request: SandboxExecutionRequest,
  command: SandboxCommand,
  options: SandboxLauncherOptions,
) => Promise<DomainResult<SandboxExecutionResult>>;

export type SessionConsoleEnterOptions = Readonly<{
  /** Interactive entry always requires an explicit machine session id. */
  readonly session_id: string | null;
  readonly runtime_policy?: RuntimePolicy;
  readonly runtime_projection?: SessionRuntimeProjection;
  readonly runtime_profile?: ResolvedRuntimeProfile;
  readonly runtime_profile_selection?: RuntimeProfileSelection;
  readonly runtime_nix_options?: NixRuntimeClosureOptions;
  readonly runtime_fhs_options?: RuntimeResolutionFhsOptions;
  readonly sandbox_probe?: SandboxProbe;
  readonly sandbox_runtime_layout?: SandboxRuntimeLayout;
  readonly sandbox_runner?: SessionConsoleRunner;
  /** Canonical durable execution-record writer owned by the integration layer. */
  readonly persist_execution?: SessionExecutionDurableWriter;
  /** Optional identity inputs supplied by the execution-record owner. */
  readonly execution_id?: string;
  readonly boot_id?: string;
  readonly profile_digest?: string;
  readonly filesystem_token?: string;
  readonly runtime_epoch?: string | number;
  readonly now?: () => string;
  /** The selected shell is profile-derived; only the canonical Bash projection is accepted. */
  readonly shell?: string;
}>;

export type SessionConsolePromptRevision = string | number;

export type SessionConsoleEnterResult = Readonly<{
  contract_id: typeof SESSION_CONSOLE_CONTRACT_ID;
  schema_version: typeof SESSION_CONSOLE_SCHEMA_VERSION;
  operation: typeof SESSION_CONSOLE_OPERATION_ENTER;
  session_id: string;
  execution_id: string;
  session: SessionRecord;
  cwd: string;
  shell: Readonly<{ command: string; args: readonly string[] }>;
  prompt: string;
  effective_revision: SessionConsolePromptRevision;
  execution: PersistedSessionExecutionRecord;
  result: SandboxExecutionResult;
  /** The Nawabari session remains open when the console exits. */
  session_closed: false;
}>;

export type SessionConsoleProcessEntry = Readonly<{
  execution: PersistedSessionExecutionRecord;
  observation: SessionExecutionIdentityObservation;
  /** Bounded cgroup occupancy/accounting evidence for active executions. */
  cgroups: OwnedExecutionObservation | null;
}>;

export type SessionConsoleOwnedExecutionObserver = (
  record: Parameters<typeof observeOwnedExecution>[0],
  options?: SessionProcessObservationOptions,
) => DomainResult<OwnedExecutionObservation>;

export type SessionConsoleProcessesResult = Readonly<{
  contract_id: typeof SESSION_CONSOLE_CONTRACT_ID;
  schema_version: typeof SESSION_CONSOLE_SCHEMA_VERSION;
  operation: typeof SESSION_CONSOLE_OPERATION_PROCESSES;
  session_id: string;
  session: SessionRecord;
  processes: readonly SessionConsoleProcessEntry[];
}>;

export type SessionConsoleProcessesOptions = Readonly<{
  readonly session_id: string | null;
  readonly read_executions?: (
    sessionId: string,
  ) =>
    | readonly (SessionExecutionRecord | PersistedSessionExecutionRecord)[]
    | Promise<readonly (SessionExecutionRecord | PersistedSessionExecutionRecord)[]>;
  readonly identity_reader?: SessionExecutionIdentityReader;
  readonly observe_owned_execution?: SessionConsoleOwnedExecutionObserver;
  readonly cgroup_filesystem?: CgroupFileSystem;
  readonly current_boot_id?: string;
}>;

function invalid(message: string, details: JsonObject = {}): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, details));
}

function durabilityUnavailable(operation: string): DomainResult<never> {
  return failure(
    new DomainError(
      "REGISTRY_DURABILITY_UNCERTAIN",
      "The session console requires the canonical execution-record writer.",
      { operation },
    ),
  );
}

function boundedIdentity(value: string | null | undefined, field: string): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > 512 || value.includes("\0")) {
    return invalid(`${field} must be a bounded non-empty string.`, { field });
  }
  return success(value);
}

function bootId(): DomainResult<string> {
  try {
    const value = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    return boundedIdentity(value, "boot_id");
  } catch (error: unknown) {
    return failure(
      new DomainError("PHYSICAL_OBSERVATION_UNAVAILABLE", "The kernel boot identity could not be observed.", {
        reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      }),
    );
  }
}

function digest(value: unknown): string {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function prompt(sessionId: string, effectiveRevision: SessionConsolePromptRevision): string {
  return `nawabari[${sessionId}@${String(effectiveRevision)}]$ `;
}

/** Generate the deterministic prompt from only session identity and effective revision. */
export function sessionConsolePrompt(sessionId: string, effectiveRevision: SessionConsolePromptRevision): string {
  const validated = boundedIdentity(sessionId, "session_id");
  if (!validated.ok) throw validated.error;
  if (
    (typeof effectiveRevision !== "string" && typeof effectiveRevision !== "number") ||
    (typeof effectiveRevision === "string" && (effectiveRevision.length === 0 || effectiveRevision.includes("\0"))) ||
    (typeof effectiveRevision === "number" && !Number.isSafeInteger(effectiveRevision))
  ) {
    throw new DomainError("INVALID_ARGUMENT", "effective_revision must be bounded text or a safe integer.", {});
  }
  return prompt(validated.value, effectiveRevision);
}

function selectedShell(
  projection: SessionRuntimeProjection | undefined,
  shell: string | undefined,
): DomainResult<{
  command: string;
  args: readonly string[];
}> {
  if (shell !== undefined && shell !== CANONICAL_SHELL) {
    return failure(
      new DomainError("RUNTIME_MATERIALIZATION_MISSING", "The selected interactive shell is not supported.", {
        shell,
        requirement_id: CANONICAL_SHELL_REQUIREMENT_ID,
      }),
    );
  }
  if (projection === undefined) {
    return failure(
      new DomainError("RUNTIME_MATERIALIZATION_MISSING", "Interactive entry requires a validated runtime projection.", {
        requirement_id: CANONICAL_SHELL_REQUIREMENT_ID,
      }),
    );
  }
  const requirement = projection.requirements.find((candidate) => candidate.id === CANONICAL_SHELL_REQUIREMENT_ID);
  const executable = projection.executables.find(
    (candidate) =>
      candidate.name === CANONICAL_SHELL &&
      candidate.provider.requirement_id === CANONICAL_SHELL_REQUIREMENT_ID &&
      candidate.target !== CANONICAL_SHELL_TARGET,
  );
  if (
    requirement === undefined ||
    requirement.kind !== "runtime" ||
    requirement.name !== CANONICAL_SHELL ||
    requirement.version !== BASH_REQUIREMENT.version ||
    executable === undefined
  ) {
    return failure(
      new DomainError("RUNTIME_MATERIALIZATION_MISSING", "The selected runtime does not project Bash.", {
        requirement_id: CANONICAL_SHELL_REQUIREMENT_ID,
      }),
    );
  }
  return success({ command: CANONICAL_SHELL_TARGET, args: BASH_STARTUP_ARGS });
}

function updateExecution(
  record: SessionExecutionRecord,
  state: "exited" | "unresolved",
  now: () => string,
): DomainResult<SessionExecutionRecord> {
  return recordExecutionState(record, { state, now: now() });
}

function processStarttime(pid: number): string {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
  const starttime = raw
    .slice(raw.lastIndexOf(")") + 1)
    .trim()
    .split(/\s+/u)[19];
  if (starttime === undefined || !/^\d+$/u.test(starttime)) throw new Error("process starttime is unavailable");
  return starttime;
}

function managedRuntimeUnavailable(sessionId: string): DomainResult<never> {
  return failure(
    new DomainError("BACKEND_UNAVAILABLE", "The managed protected execution authority is unavailable.", {
      session_id: sessionId,
    }),
  );
}

/** Launch one pinned managed command through the durable #498 composition. */
export async function launchManagedSessionCommand(
  context: SessionContext,
  backend: SessionBackend,
  input: Readonly<{
    session_id: string;
    command: SandboxCommand;
    stdio?: readonly [SupervisorStdioValue, SupervisorStdioValue, SupervisorStdioValue];
    execution_id?: string;
    runtime_policy?: RuntimePolicy;
    sandbox_probe?: SandboxProbe;
    sandbox_runtime_layout?: SandboxRuntimeLayout;
    now?: () => string;
  }>,
): Promise<
  DomainResult<Readonly<{
    supervisor: SessionLaunchSupervisorResult;
    execution: SessionExecutionRecord;
    effective_revision: number;
    result?: SandboxExecutionResult;
  }> | null>
> {
  const executionId = input.execution_id ?? crypto.randomUUID();
  if (backend.getSessionManagedRuntime === undefined) return success(null);
  const observed = await backend.getSessionManagedRuntime(context, input.session_id, executionId);
  if (!observed.ok) return observed;
  if (observed.value.profile === null && observed.value.admission === null) return success(null);
  if (
    backend.listClaims === undefined ||
    backend.persistSessionExecution === undefined ||
    backend.readSessionRuntimeEpoch === undefined
  )
    return managedRuntimeUnavailable(input.session_id);
  const initial = observed.value;
  const pin = initial.profile;
  if (pin === null || initial.admission === null) {
    return failure(
      new DomainError("REGISTRY_CORRUPT", "Managed session profile and admission authority disagree.", {
        session_id: input.session_id,
      }),
    );
  }
  if (
    initial.admission.admission !== "open" ||
    initial.admission.runtime_epoch !== initial.runtime_epoch ||
    initial.runtime_environment_identity === undefined
  ) {
    return failure(
      new DomainError("OPERATION_REJECTED", "Managed session launch admission is not open at its current epoch.", {
        session_id: input.session_id,
        runtime_epoch: initial.runtime_epoch,
        admission_epoch: initial.admission.runtime_epoch,
        admission: initial.admission.admission,
      }),
    );
  }
  const probe = input.sandbox_probe ?? defaultSandboxProbe;
  if (!probe.hasCgroupsV2()) {
    return failure(
      new DomainError(
        "SANDBOX_CAPABILITY_UNAVAILABLE",
        "Managed execution requires cgroups v2 for durable process ownership and quiescence.",
        { session_id: input.session_id, capability: "cgroups_v2" },
      ),
    );
  }

  const session = await backend.getSession(context, input.session_id);
  if (!session.ok) return session;
  if (session.value.state !== "active") {
    return failure(
      new DomainError("SESSION_NOT_ACTIVE", `Session is not active: ${input.session_id}`, {
        session_id: input.session_id,
        state: session.value.state,
      }),
    );
  }
  const claimsResult = await backend.listClaims(context, input.session_id);
  if (!claimsResult.ok) return claimsResult;
  const workingSet =
    session.value.working_set === undefined
      ? undefined
      : compileWorkingSetRuntimeProjection(session.value.working_set as unknown as EffectiveWorkingSet);
  if (workingSet !== undefined && !workingSet.ok) return workingSet;
  const profile = pin.resolved;
  const claims = claimsResult.value.claims.map((claim) => ({
    resource: claim.resource,
    repositoryId: claim.repository,
    mode: claim.mode,
  }));
  const pathRequests = [
    ...profile.filesystem.readOnly.map((path) => ({ path, operation: "READONLY" as const })),
    ...profile.filesystem.write.map((path) => ({ path, operation: "WRITE" as const })),
  ];
  const scope = resolveProfileRuntimeScope(
    profile,
    {
      repositoryId: pin.provenance.repository.id,
      claims,
      ...(workingSet === undefined ? {} : { workingSet: workingSet.value, externalArtifact: true }),
    },
    { paths: pathRequests.map((request) => request.path), requests: pathRequests },
  );
  if (!scope.ok) return scope;
  if (scope.value.status !== "ready") {
    return failure(
      new DomainError("RUNTIME_PROFILE_REQUIREMENT_MISSING", "Managed profile filesystem scope is unavailable.", {
        session_id: input.session_id,
        diagnostic: scope.value.diagnostics[0] ?? null,
      }),
    );
  }

  const layout = input.sandbox_runtime_layout ?? discoverSandboxRuntimeLayout();
  const runtime = resolveWorktreeProfileRuntime(profile, layout);
  if (!runtime.ok) return runtime;
  if (input.stdio !== undefined) {
    const shell = selectedShell(runtime.value.projection, undefined);
    if (!shell.ok) return shell;
    if (input.command.command !== shell.value.command) {
      return failure(
        new DomainError(
          "RUNTIME_MATERIALIZATION_MISSING",
          "Managed interactive entry requires the pinned Bash shell.",
          {
            session_id: input.session_id,
            requirement_id: CANONICAL_SHELL_REQUIREMENT_ID,
          },
        ),
      );
    }
  }
  if (input.runtime_policy !== undefined && input.runtime_policy.mode !== runtime.value.policy.mode) {
    return failure(
      new DomainError("RUNTIME_PROJECTION_INVALID", "Requested runtime policy differs from the pinned profile.", {
        requested_policy: input.runtime_policy.mode,
        pinned_policy: runtime.value.policy.mode,
      }),
    );
  }
  const boot = bootId();
  if (!boot.ok) return boot;
  const request = await resolveSandboxExecutionRequest(
    backend,
    context,
    {
      session_id: input.session_id,
      enforce: true,
      runtime_policy: runtime.value.policy,
      runtime_projection: runtime.value.projection,
      cgroups: { required: true, execution_id: executionId },
    },
    input.sandbox_probe,
    layout,
  );
  if (!request.ok) return request;
  if (request.value.worktree !== session.value.worktree) {
    return failure(
      new DomainError("WORKTREE_MISMATCH", "The protected request worktree differs from the selected session.", {
        session_id: input.session_id,
        session_worktree: session.value.worktree,
        request_worktree: request.value.worktree,
      }),
    );
  }

  const fresh = await backend.getSessionManagedRuntime(context, input.session_id, executionId);
  if (!fresh.ok) return fresh;
  if (
    fresh.value.profile?.digest !== pin.digest ||
    fresh.value.admission?.admission !== "open" ||
    fresh.value.admission.runtime_epoch !== fresh.value.runtime_epoch ||
    fresh.value.runtime_epoch !== initial.runtime_epoch ||
    fresh.value.claim_set_generation !== initial.claim_set_generation ||
    fresh.value.registry_revision !== initial.registry_revision ||
    fresh.value.runtime_environment_identity?.execution_id !== executionId
  ) {
    return failure(
      new DomainError("OPERATION_REJECTED", "Managed session authority changed during protected launch preparation.", {
        session_id: input.session_id,
        execution_id: executionId,
      }),
    );
  }
  const live = fresh.value;
  const filesystemToken = digest({ scope: scope.value, claim_set_generation: live.claim_set_generation });
  const snapshot = {
    lifecycle: "active" as const,
    launch_permitted: true,
    profile_token: pin.digest,
    profile_revision: live.registry_revision,
    filesystem_token: filesystemToken,
    filesystem_revision: live.claim_set_generation,
    generation: live.claim_set_generation,
    epoch: live.runtime_epoch,
  };
  const reservation = reserveExecution({
    session_id: input.session_id,
    execution_id: executionId,
    profile_digest: pin.digest,
    filesystem_token: filesystemToken,
    runtime_epoch: live.runtime_epoch,
    boot_id: boot.value,
    now: (input.now ?? (() => new Date().toISOString()))(),
  });
  if (!reservation.ok) return reservation;
  const compiled = compileSessionEnvironment(profile, live.runtime_environment_identity);
  if (!compiled.ok) return compiled;
  const protectedRequest: SandboxExecutionRequest = {
    ...request.value,
    runtime_resolution: {
      policy: runtime.value.policy,
      profile: runtime.value.profile,
      materializer: runtime.value.materializer,
    },
  };
  const { launchProtectedSessionExecution } = await import("./session-protected-launch.js");
  const launched = await launchProtectedSessionExecution(
    {
      profile,
      compiled_environment: compiled.value,
      request: protectedRequest,
      command: input.command,
      ...(input.stdio === undefined ? {} : { stdio: input.stdio }),
      admission: { session_id: input.session_id, execution_id: executionId, current: snapshot, expected: snapshot },
      starting_record: reservation.value,
      supervisor: {
        trusted: { entrypoint: process.execPath, cwd: path.dirname(process.execPath) },
        cgroup: { required: true, retain_scope: true },
      },
    },
    {
      materializeSessionRuntimeDirectories,
      compileSandboxInvocation,
      runSessionLaunchSupervisor,
      persist_execution: async (record) => {
        const persisted = await backend.persistSessionExecution!(context, record);
        if (!persisted.ok) throw persisted.error;
      },
      read_process_starttime: processStarttime,
      read_runtime_epoch: () => backend.readSessionRuntimeEpoch!(context, input.session_id),
    },
  );
  if (!launched.ok) return launched;
  if (launched.value.execution.state === "exited" && launched.value.supervisor.started) {
    const owned = observeOwnedExecution(cgroupObservationRecord(launched.value.execution), {
      current_boot_id: boot.value,
    });
    if (!owned.ok) return owned;
    if (owned.value.state !== "empty" || owned.value.cgroups?.population.state !== "empty") {
      return failure(
        new DomainError(
          "SANDBOX_CGROUP_CLEANUP_FAILED",
          "The completed managed execution did not provide fresh owned-scope emptiness for runtime cleanup.",
          { session_id: input.session_id, execution_id: executionId, state: owned.value.state },
        ),
      );
    }
    const cleaned = cleanupSessionRuntimeDirectories(compiled.value.manifest);
    if (!cleaned.ok) return cleaned;
  }
  return success({ ...launched.value, effective_revision: live.registry_revision });
}

function cgroupObservationRecord(record: SessionExecutionRecord): Parameters<typeof observeOwnedExecution>[0] {
  const name = deriveCgroupScopeName(record.cgroup_identity);
  return {
    schema_version: 1,
    session_id: record.session_id,
    execution_id: record.execution_id,
    boot_id: record.boot_id,
    state: record.state === "attached" || record.state === "running" ? "active" : "terminal",
    cgroups: {
      contract_id: CGROUPS_V2_CONTRACT_ID,
      root: CGROUPS_V2_ROOT,
      parent: `${CGROUPS_V2_ROOT}/nawabari`,
      path: `${CGROUPS_V2_ROOT}/nawabari/${name}`,
      name,
      boot_id: record.boot_id,
      identity: record.cgroup_identity,
    },
  };
}

async function persist(
  writer: SessionExecutionDurableWriter,
  record: SessionExecutionRecord,
  operation: string,
): Promise<DomainResult<PersistedSessionExecutionRecord>> {
  const persisted = serializeSessionExecutionRecord(record);
  try {
    await writer(persisted);
  } catch (error: unknown) {
    return failure(
      new DomainError("REGISTRY_DURABILITY_UNCERTAIN", "The execution record was not durably persisted.", {
        operation,
        session_id: record.session_id,
        execution_id: record.execution_id,
        cause: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      }),
    );
  }
  return success(persisted);
}

/**
 * Enter one explicitly selected session through the canonical protected
 * runtime. The execution record is persisted before the interactive child is
 * started; no host-shell or ambient-environment fallback exists.
 */
export async function enterSessionConsole(
  context: SessionContext,
  backend: SessionBackend,
  options: SessionConsoleEnterOptions,
): Promise<DomainResult<SessionConsoleEnterResult>> {
  const sessionId = boundedIdentity(options.session_id, "session_id");
  if (!sessionId.ok) return sessionId;
  if (options.persist_execution === undefined) return durabilityUnavailable("session enter");

  const session = await backend.getSession(context, sessionId.value);
  if (!session.ok) return session;
  if (session.value.state !== "active") {
    return failure(
      new DomainError("SESSION_NOT_ACTIVE", `Session is not active: ${sessionId.value}`, {
        session_id: sessionId.value,
        state: session.value.state,
      }),
    );
  }

  const executionId = options.execution_id ?? crypto.randomUUID();
  if (backend.getSessionManagedRuntime !== undefined) {
    const managedRuntime = await backend.getSessionManagedRuntime(context, sessionId.value, executionId);
    if (!managedRuntime.ok) return managedRuntime;
    if (managedRuntime.value.profile !== null || managedRuntime.value.admission !== null) {
      const managed = await launchManagedSessionCommand(context, backend, {
        session_id: sessionId.value,
        command: { command: CANONICAL_SHELL_TARGET, args: BASH_STARTUP_ARGS },
        stdio: ["inherit", "inherit", "inherit"],
        execution_id: executionId,
        ...(options.sandbox_probe === undefined ? {} : { sandbox_probe: options.sandbox_probe }),
        ...(options.sandbox_runtime_layout === undefined
          ? {}
          : { sandbox_runtime_layout: options.sandbox_runtime_layout }),
        ...(options.now === undefined ? {} : { now: options.now }),
      });
      if (!managed.ok) return managed;
      if (managed.value === null) {
        return failure(
          new DomainError("OPERATION_REJECTED", "Managed session authority changed before protected entry.", {
            session_id: sessionId.value,
          }),
        );
      }
      if (managed.value.supervisor.status !== "completed" || managed.value.result === undefined) {
        return failure(
          new DomainError("SANDBOX_EXECUTION_FAILED", "The managed interactive console did not complete.", {
            session_id: sessionId.value,
            execution_id: executionId,
            status: managed.value.supervisor.status,
          }),
        );
      }
      const shell = { command: CANONICAL_SHELL_TARGET, args: BASH_STARTUP_ARGS };
      return success({
        contract_id: SESSION_CONSOLE_CONTRACT_ID,
        schema_version: SESSION_CONSOLE_SCHEMA_VERSION,
        operation: SESSION_CONSOLE_OPERATION_ENTER,
        session_id: sessionId.value,
        execution_id: executionId,
        session: session.value,
        cwd: session.value.worktree,
        shell,
        prompt: prompt(sessionId.value, managed.value.effective_revision),
        effective_revision: managed.value.effective_revision,
        execution: serializeSessionExecutionRecord(managed.value.execution),
        result: managed.value.result,
        session_closed: false,
      });
    }
  }

  const boot = options.boot_id === undefined ? bootId() : boundedIdentity(options.boot_id, "boot_id");
  if (!boot.ok) return boot;

  const request = await resolveSandboxExecutionRequest(
    backend,
    context,
    {
      session_id: sessionId.value,
      enforce: true,
      ...(options.runtime_policy === undefined ? {} : { runtime_policy: options.runtime_policy }),
      ...(options.runtime_projection === undefined ? {} : { runtime_projection: options.runtime_projection }),
      ...(options.runtime_profile === undefined ? {} : { runtime_profile: options.runtime_profile }),
      ...(options.runtime_profile_selection === undefined
        ? {}
        : { runtime_profile_selection: options.runtime_profile_selection }),
      ...(options.runtime_nix_options === undefined ? {} : { runtime_nix_options: options.runtime_nix_options }),
      ...(options.runtime_fhs_options === undefined ? {} : { runtime_fhs_options: options.runtime_fhs_options }),
      cgroups: { required: true, execution_id: executionId },
    },
    options.sandbox_probe,
    options.sandbox_runtime_layout,
  );
  if (!request.ok) return request;
  if (request.value.worktree !== session.value.worktree) {
    return failure(
      new DomainError("WORKTREE_MISMATCH", "The protected request worktree differs from the selected session.", {
        session_id: sessionId.value,
        session_worktree: session.value.worktree,
        request_worktree: request.value.worktree,
      }),
    );
  }
  const projectedShell = selectedShell(request.value.runtime_projection, options.shell);
  if (!projectedShell.ok) return projectedShell;

  const now = options.now ?? (() => new Date().toISOString());
  const reservation = reserveExecution({
    session_id: sessionId.value,
    execution_id: executionId,
    profile_digest:
      options.profile_digest ?? digest(request.value.runtime_projection?.profile ?? request.value.runtime_resolution),
    filesystem_token: options.filesystem_token ?? digest(request.value.filesystem),
    runtime_epoch:
      options.runtime_epoch ??
      request.value.runtime_resolution?.profile.version ??
      request.value.runtime_projection?.profile.version ??
      "unknown",
    boot_id: boot.value,
    now: now(),
  });
  if (!reservation.ok) return reservation;
  const persistedStarting = await persist(options.persist_execution, reservation.value, "reserve");
  if (!persistedStarting.ok) return persistedStarting;

  const runner = options.sandbox_runner ?? runInteractiveSandboxedCommand;
  const launched = await (async (): Promise<DomainResult<SandboxExecutionResult>> => {
    try {
      return await runner(request.value, projectedShell.value, { interactive: true });
    } catch (error: unknown) {
      return failure(
        new DomainError("SANDBOX_EXECUTION_FAILED", "The interactive protected console could not be started.", {
          session_id: sessionId.value,
          execution_id: executionId,
          cause: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
        }),
      );
    }
  })();

  const terminal = updateExecution(reservation.value, launched.ok ? "exited" : "unresolved", now);
  if (!terminal.ok) return terminal;
  const persistedTerminal = await persist(
    options.persist_execution,
    terminal.value,
    launched.ok ? "exit" : "unresolved",
  );
  if (!persistedTerminal.ok) return persistedTerminal;
  if (!launched.ok) return launched;

  const effectiveRevision = options.runtime_epoch ?? request.value.runtime_resolution?.profile.version ?? "unknown";
  return success({
    contract_id: SESSION_CONSOLE_CONTRACT_ID,
    schema_version: SESSION_CONSOLE_SCHEMA_VERSION,
    operation: SESSION_CONSOLE_OPERATION_ENTER,
    session_id: sessionId.value,
    execution_id: executionId,
    session: session.value,
    cwd: request.value.worktree,
    shell: projectedShell.value,
    prompt: prompt(sessionId.value, effectiveRevision),
    effective_revision: effectiveRevision,
    execution: persistedTerminal.value,
    result: launched.value,
    session_closed: false,
  });
}

/** Observe all durable executions owned by one explicit session. */
export async function listSessionProcesses(
  context: SessionContext,
  backend: SessionBackend,
  options: SessionConsoleProcessesOptions,
): Promise<DomainResult<SessionConsoleProcessesResult>> {
  const sessionId = boundedIdentity(options.session_id, "session_id");
  if (!sessionId.ok) return sessionId;
  if (options.read_executions === undefined) return durabilityUnavailable("session processes");
  const session = await backend.getSession(context, sessionId.value);
  if (!session.ok) return session;
  let records: readonly (SessionExecutionRecord | PersistedSessionExecutionRecord)[];
  try {
    records = await options.read_executions(sessionId.value);
  } catch (error: unknown) {
    return failure(
      new DomainError("REGISTRY_UNREADABLE", "The session execution records could not be read.", {
        session_id: sessionId.value,
        cause: error instanceof Error ? error.message.slice(0, 200) : String(error).slice(0, 200),
      }),
    );
  }
  const processes: SessionConsoleProcessEntry[] = [];
  for (const raw of records) {
    const record = parseSessionExecutionRecord(raw);
    if (!record.ok) return record;
    if (record.value.session_id !== sessionId.value) {
      return failure(
        new DomainError("REGISTRY_CORRUPT", "An execution record is owned by a different session.", {
          requested_session_id: sessionId.value,
          record_session_id: record.value.session_id,
          execution_id: record.value.execution_id,
        }),
      );
    }
    const observation = observeExecutionIdentity(record.value, {
      ...(options.identity_reader === undefined ? {} : { reader: options.identity_reader }),
    });
    if (!observation.ok) return observation;
    const observe = options.observe_owned_execution ?? observeOwnedExecution;
    const cgroupRecord = cgroupObservationRecord(record.value);
    const cgroupObservation = observe(cgroupRecord, {
      ...(options.cgroup_filesystem === undefined ? {} : { filesystem: options.cgroup_filesystem }),
      ...(options.current_boot_id === undefined ? {} : { current_boot_id: options.current_boot_id }),
    });
    const cgroups = cgroupObservation.ok ? cgroupObservation.value : unknownOwnedObservation(record.value);
    processes.push({
      execution: serializeSessionExecutionRecord(record.value),
      observation: observation.value,
      cgroups,
    });
  }
  processes.sort((left, right) => left.execution.execution_id.localeCompare(right.execution.execution_id));
  return success({
    contract_id: SESSION_CONSOLE_CONTRACT_ID,
    schema_version: SESSION_CONSOLE_SCHEMA_VERSION,
    operation: SESSION_CONSOLE_OPERATION_PROCESSES,
    session_id: sessionId.value,
    session: session.value,
    processes,
  });
}

function unknownOwnedObservation(record: SessionExecutionRecord): OwnedExecutionObservation {
  return {
    contract_id: SESSION_PROCESS_OBSERVATION_CONTRACT_ID,
    session_id: record.session_id,
    execution_id: record.execution_id,
    boot_id: record.boot_id,
    state: "unknown",
    cgroups: null,
  };
}

export function serializeSessionConsoleResult(
  result: SessionConsoleEnterResult | SessionConsoleProcessesResult,
): string {
  return JSON.stringify(result);
}
