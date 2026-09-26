import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  defaultSandboxProbe,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  type SandboxExecutionRequest,
} from "./sandbox.js";
import { compileSandboxInvocation } from "./sandbox-launcher.js";
import {
  compileSessionEnvironment,
  materializeSessionRuntimeDirectories,
  cleanupSessionRuntimeDirectories,
} from "./session-environment.js";
import { reserveExecution, type PersistedSessionExecutionRecord } from "./session-execution-record.js";
import { launchProtectedSessionExecution } from "./session-protected-launch.js";
import { runSessionLaunchSupervisor } from "./session-launch-supervisor.js";
import { resolveWorktreeProfileRuntime } from "./worktree-profile-runtime.js";
import { resolveProfileRuntimeScope } from "./worktree-profile-scope.js";
import { compileWorkingSetRuntimeProjection } from "./working-set-runtime-projection.js";
import { CANONICAL_EXECUTABLE_ROOT } from "./runtime-executable-projection.js";
import { observeOwnedExecution } from "./session-process-observation.js";
import { deriveCgroupScopeName, CGROUPS_V2_CONTRACT_ID } from "./cgroups-v2.js";
import { DomainError, failure, success, type DomainResult } from "./errors.js";
import type { EffectiveWorkingSet } from "../working-set.js";
import type { SessionBackend, SessionContext, SessionRecord, GuardDecision } from "./session.js";
import type { WorktreeBootstrapAction } from "./worktree-runtime-profile.js";

const MAX_EVIDENCE = 2048;

/** Sequential once-only orchestration. No failed or uncertain action is replayed. */
export async function runBootstrapActions(
  actions: readonly WorktreeBootstrapAction[],
  execute: (action: WorktreeBootstrapAction) => Promise<DomainResult<null>>,
  sessionId = "unknown",
): Promise<DomainResult<null>> {
  for (const action of actions) {
    try {
      const result = await execute(action);
      if (!result.ok) return result;
    } catch (error: unknown) {
      return evidence(sessionId, action, "Bootstrap action completion is uncertain", {
        cause: error instanceof Error ? error.message : "unknown",
      });
    }
  }
  return success(null);
}

function evidence(
  sessionId: string,
  action: WorktreeBootstrapAction,
  message: string,
  details: Record<string, unknown> = {},
): DomainResult<never> {
  return failure(
    new DomainError("SANDBOX_EXECUTION_FAILED", message.slice(0, MAX_EVIDENCE), {
      session_id: sessionId,
      action_id: action.id,
      ...Object.fromEntries(
        Object.entries(details).map(([key, value]) => [
          key,
          typeof value === "string" ? value.slice(0, MAX_EVIDENCE) : value,
        ]),
      ),
    }),
  );
}

/** Execute one pinned repository action through the selected protected composition. */
export async function executeBootstrapAction(
  context: SessionContext,
  backend: SessionBackend,
  session: SessionRecord,
  action: WorktreeBootstrapAction,
  ports: Readonly<{
    verify: () => SessionRecord;
    persist: (record: PersistedSessionExecutionRecord) => Promise<DomainResult<PersistedSessionExecutionRecord>>;
  }>,
): Promise<DomainResult<null>> {
  const sessionId = session.session_id;
  const executionId = `bootstrap:${sessionId}:${action.id}`;
  try {
    const owned = ports.verify();
    if (owned.session_id !== sessionId || owned.state !== "new" || owned.worktree !== session.worktree) {
      return evidence(sessionId, action, "Bootstrap ownership changed");
    }
    if (
      backend.getSessionManagedRuntime === undefined ||
      backend.persistSessionExecution === undefined ||
      backend.readSessionRuntimeEpoch === undefined ||
      backend.listClaims === undefined ||
      backend.getManagedCgroupRoot === undefined
    ) {
      return evidence(sessionId, action, "Protected execution authority is unavailable");
    }
    const initial = await backend.getSessionManagedRuntime(context, sessionId, executionId);
    if (!initial.ok) return evidence(sessionId, action, initial.error.message);
    const pin = initial.value.profile;
    if (
      pin === null ||
      !("path" in pin.provenance.catalog) ||
      !pin.resolved.bootstrap?.some(
        (entry) =>
          entry.id === action.id &&
          entry.tool === action.tool &&
          JSON.stringify(entry.argv) === JSON.stringify(action.argv),
      ) ||
      !pin.resolved.tools.some((tool) => tool.entrypoint === action.tool) ||
      initial.value.admission?.admission !== "open" ||
      initial.value.admission.runtime_epoch !== initial.value.runtime_epoch ||
      initial.value.runtime_environment_identity === undefined
    ) {
      return evidence(sessionId, action, "Pinned bootstrap authority is unavailable");
    }
    const root = backend.getManagedCgroupRoot();
    if (!root.ok) return evidence(sessionId, action, root.error.message);
    const probe = defaultSandboxProbe;
    if (!probe.hasCgroupsV2()) return evidence(sessionId, action, "Managed cgroups v2 is unavailable");
    const claimsResult = await backend.listClaims(context, sessionId);
    if (!claimsResult.ok) return evidence(sessionId, action, claimsResult.error.message);
    const claims = claimsResult.value.claims.map((claim) => ({
      resource: claim.resource,
      repositoryId: claim.repository,
      mode: claim.mode,
    }));
    const workingSet =
      session.working_set === undefined
        ? undefined
        : compileWorkingSetRuntimeProjection(session.working_set as unknown as EffectiveWorkingSet);
    if (workingSet !== undefined && !workingSet.ok) return evidence(sessionId, action, workingSet.error.message);
    const requests = claims
      .filter((claim) => !claim.resource.includes("*") && !claim.resource.includes("?"))
      .map((claim) => ({
        path: claim.resource,
        operation: claim.mode === "read" ? ("READONLY" as const) : ("WRITE" as const),
      }));
    const scope = resolveProfileRuntimeScope(
      pin.resolved,
      {
        repositoryId: pin.provenance.repository.id,
        claims,
        ...(workingSet === undefined ? {} : { workingSet: workingSet.value, externalArtifact: true }),
      },
      { paths: requests.map((item) => item.path), requests },
    );
    if (!scope.ok || scope.value.status !== "ready")
      return evidence(sessionId, action, "Profile filesystem scope is unavailable");
    const layout = discoverSandboxRuntimeLayout();
    const runtime = resolveWorktreeProfileRuntime(pin.resolved, layout);
    if (!runtime.ok) return evidence(sessionId, action, runtime.error.message);
    const bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
    // The ordinary guard remains active-only. Only this local adapter exposes the
    // physically verified pending owner to the existing sandbox request compiler.
    const scopedBackend = new Proxy(backend, {
      get(target, key) {
        if (key === "guard")
          return async (
            _context: SessionContext,
            options: { session_id: string | null },
          ): Promise<DomainResult<GuardDecision>> => {
            const verified = ports.verify();
            if (
              options.session_id !== sessionId ||
              verified.state !== "new" ||
              verified.worktree !== session.worktree
            ) {
              return evidence(sessionId, action, "Bootstrap guard ownership changed");
            }
            return success({
              allowed: true,
              code: "ALLOWED",
              repository: session.repository,
              worktree: session.worktree,
              branch: session.branch,
              session_id: sessionId,
              owner_session_id: sessionId,
              requested_session_id: sessionId,
              state: "new",
              details: {},
            });
          };
        return Reflect.get(target, key, target);
      },
    });
    const request = await resolveSandboxExecutionRequest(
      scopedBackend,
      context,
      {
        session_id: sessionId,
        enforce: true,
        runtime_policy: runtime.value.policy,
        runtime_projection: runtime.value.projection,
        cgroups: { required: true, execution_id: executionId },
      },
      probe,
      layout,
    );
    if (!request.ok) return evidence(sessionId, action, request.error.message);
    if (request.value.worktree !== session.worktree)
      return evidence(sessionId, action, "Sandbox worktree differs from owner");
    const fresh = await backend.getSessionManagedRuntime(context, sessionId, executionId);
    if (!fresh.ok) return evidence(sessionId, action, fresh.error.message);
    if (
      fresh.value.profile?.digest !== pin.digest ||
      fresh.value.admission?.admission !== "open" ||
      fresh.value.admission.runtime_epoch !== fresh.value.runtime_epoch ||
      fresh.value.runtime_epoch !== initial.value.runtime_epoch ||
      fresh.value.claim_set_generation !== initial.value.claim_set_generation ||
      fresh.value.registry_revision !== initial.value.registry_revision ||
      fresh.value.runtime_environment_identity?.execution_id !== executionId
    ) {
      return evidence(sessionId, action, "Bootstrap authority changed during protected preparation");
    }
    ports.verify();
    const filesystemToken = crypto
      .createHash("sha256")
      .update(JSON.stringify({ scope: scope.value, claim_set_generation: fresh.value.claim_set_generation }))
      .digest("hex");
    const snapshot = {
      lifecycle: "new" as const,
      launch_permitted: true,
      profile_token: pin.digest,
      profile_revision: fresh.value.registry_revision,
      filesystem_token: filesystemToken,
      filesystem_revision: fresh.value.claim_set_generation,
      generation: fresh.value.claim_set_generation,
      epoch: fresh.value.runtime_epoch,
    };
    const reserved = reserveExecution({
      session_id: sessionId,
      execution_id: executionId,
      profile_digest: pin.digest,
      filesystem_token: filesystemToken,
      runtime_epoch: fresh.value.runtime_epoch,
      boot_id: bootId,
      cgroup_root: root.value,
      now: new Date().toISOString(),
    });
    if (!reserved.ok) return evidence(sessionId, action, reserved.error.message);
    const environment = compileSessionEnvironment(pin.resolved, fresh.value.runtime_environment_identity);
    if (!environment.ok) return evidence(sessionId, action, environment.error.message);
    const protectedRequest: SandboxExecutionRequest = {
      ...request.value,
      git_profile: pin.resolved,
      hook_material: fresh.value.hook_material,
      runtime_resolution: {
        policy: runtime.value.policy,
        profile: runtime.value.profile,
        materializer: runtime.value.materializer,
      },
    };
    const launched = await launchProtectedSessionExecution(
      {
        profile: pin.resolved,
        compiled_environment: environment.value,
        request: protectedRequest,
        command: { command: `${CANONICAL_EXECUTABLE_ROOT}/${action.tool}`, args: action.argv },
        admission: {
          purpose: "bootstrap",
          session_id: sessionId,
          execution_id: executionId,
          current: snapshot,
          expected: snapshot,
        },
        starting_record: reserved.value,
        supervisor: {
          trusted: { entrypoint: process.execPath, cwd: path.dirname(process.execPath) },
          cgroup: { required: true, retain_scope: true, root: root.value },
        },
      },
      {
        materializeSessionRuntimeDirectories,
        compileSandboxInvocation,
        runSessionLaunchSupervisor,
        persist_execution: async (record) => {
          const saved = await ports.persist(record);
          if (!saved.ok) throw saved.error;
        },
        read_process_starttime: (pid) => {
          const raw = fs.readFileSync(`/proc/${pid}/stat`, "utf8");
          const value = raw
            .slice(raw.lastIndexOf(")") + 1)
            .trim()
            .split(/\s+/u)[19];
          if (value === undefined || !/^\d+$/u.test(value)) throw new Error("Process starttime unavailable");
          return value;
        },
        read_runtime_epoch: () => backend.readSessionRuntimeEpoch!(context, sessionId),
      },
    );
    if (!launched.ok) return evidence(sessionId, action, launched.error.message, { execution_id: executionId });
    const result = launched.value.result;
    if (
      !launched.value.supervisor.started ||
      launched.value.supervisor.status !== "completed" ||
      launched.value.execution.state !== "exited" ||
      result?.exit_code !== 0 ||
      result.signal !== null
    ) {
      return evidence(sessionId, action, "Bootstrap action did not complete successfully", {
        execution_id: executionId,
        status: launched.value.supervisor.status,
        exit_code: result?.exit_code ?? null,
        stdout: result?.stdout ?? "",
        stderr: result?.stderr ?? "",
      });
    }
    const execution = launched.value.execution;
    const name = deriveCgroupScopeName(execution.cgroup_identity);
    const observation = observeOwnedExecution(
      {
        schema_version: 1,
        session_id: sessionId,
        execution_id: executionId,
        boot_id: bootId,
        state: "terminal",
        cgroups: {
          contract_id: CGROUPS_V2_CONTRACT_ID,
          root: root.value,
          parent: `${root.value}/nawabari`,
          path: `${root.value}/nawabari/${name}`,
          name,
          boot_id: bootId,
          identity: execution.cgroup_identity,
        },
      },
      { current_boot_id: bootId },
    );
    if (
      !observation.ok ||
      observation.value.state !== "empty" ||
      observation.value.cgroups?.population.state !== "empty"
    ) {
      return evidence(sessionId, action, "Bootstrap process cleanup is uncertain", { execution_id: executionId });
    }
    const cleaned = cleanupSessionRuntimeDirectories(environment.value.manifest);
    if (!cleaned.ok) return evidence(sessionId, action, cleaned.error.message);
    return success(null);
  } catch (error: unknown) {
    return evidence(sessionId, action, "Bootstrap action completion is uncertain", {
      execution_id: executionId,
      cause: error instanceof Error ? error.message : "unknown",
    });
  }
}
