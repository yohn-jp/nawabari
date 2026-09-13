import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { defaultGit, resolveRepositoryContext, type RepositoryContext } from "../git.js";
import { isSessionRegistryError } from "../errors.js";
import { SessionRegistry, type ReconciliationSession } from "../session-registry.js";
import { projectSessionLifecycleActions } from "../session-lifecycle-actions.js";
import { availableLifecycleOperations } from "../session-lifecycle-classification.js";
import { success, type DomainResult, type ErrorCode, type JsonObject, type JsonValue } from "./errors.js";
import { supportsRuntime } from "./runtime.js";
import {
  defaultSandboxProbe,
  discoverSandboxRuntimeLayout,
  sandboxDoctorReport,
  type SandboxDoctorReport,
  type SandboxProbe,
  type SandboxRuntimeLayout,
} from "./sandbox.js";

export type DoctorCheckStatus = "ok" | "warning" | "error" | "not_configured" | "not_applicable";

export type DoctorCheck = {
  name: "git" | "repository" | "registry" | "reconciliation" | "runtime";
  status: DoctorCheckStatus;
  code: ErrorCode | null;
  message: string;
  details: JsonObject;
};

export type RepositoryInfo = {
  top_level: string;
  common_dir: string;
  registry_path: string;
};

export type DoctorReport = {
  ok: boolean;
  checks: DoctorCheck[];
  repository: RepositoryInfo | null;
  /** Runtime protected-execution readiness from the canonical sandbox probe. */
  sandbox: SandboxDoctorReport;
};

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compactReconciliationDetails(details: JsonObject): JsonObject {
  const sessions = Array.isArray(details.lifecycle_sessions) ? details.lifecycle_sessions.filter(isJsonObject) : [];
  const actionableSessions = sessions.filter((session) => session.status === "candidate" || session.status === "drift");
  const byStatus: JsonObject = {};
  const byLifecycleState: JsonObject = {};
  for (const session of sessions) {
    const status = typeof session.status === "string" ? session.status : "unknown";
    const statusCount = byStatus[status];
    byStatus[status] = typeof statusCount === "number" ? statusCount + 1 : 1;
    const lifecycleState = typeof session.lifecycle_state === "string" ? session.lifecycle_state : "unknown";
    const lifecycleStateCount = byLifecycleState[lifecycleState];
    byLifecycleState[lifecycleState] = typeof lifecycleStateCount === "number" ? lifecycleStateCount + 1 : 1;
  }

  return {
    clean: details.clean ?? null,
    sessions: details.sessions ?? sessions.length,
    worktrees: details.worktrees ?? 0,
    lifecycle_sessions: actionableSessions,
    lifecycle_sessions_summary: {
      total: sessions.length,
      included: actionableSessions.length,
      omitted: sessions.length - actionableSessions.length,
      by_status: byStatus,
      by_lifecycle_state: byLifecycleState,
    },
    issues: Array.isArray(details.issues) ? details.issues : [],
  };
}

function compactSandboxReport(sandbox: SandboxDoctorReport): JsonObject {
  const capabilityStatuses = Object.fromEntries(sandbox.capabilities.map(({ id, status }) => [id, status]));
  return {
    schema_version: sandbox.schema_version,
    contract_id: sandbox.contract_id,
    platform: sandbox.platform,
    platform_supported: sandbox.platform_supported,
    network_mode: sandbox.network_mode,
    ready: sandbox.ready,
    missing_required: [...sandbox.missing_required],
    capabilities: capabilityStatuses,
    landlock: {
      abi: sandbox.landlock.abi,
      supported: sandbox.landlock.supported,
      effective_state: sandbox.landlock.effective_state,
    },
    strict_ready: sandbox.strict_ready,
    strict_ready_reason: sandbox.strict_ready_reason,
    strict_ready_code: sandbox.strict_ready_code,
    runtime: {
      selected: sandbox.runtime.selected,
      available: [...sandbox.runtime.available],
      strict_ready: sandbox.runtime.strict_ready,
      reason: sandbox.runtime.reason,
      default_policy: sandbox.runtime.default_policy.mode,
      default_profile: { ...sandbox.runtime.default_profile },
      compatibility_available: sandbox.runtime.compatibility_available,
      compatibility_policy: sandbox.runtime.compatibility_policy.mode,
    },
  };
}

/**
 * Project the full doctor report into a bounded, actionable summary. The
 * established full report remains available by default; this explicit
 * projection omits healthy/closed history rows while retaining all drift and
 * error diagnostics and their recovery details.
 */
export function summarizeDoctorReport(report: DoctorReport): JsonObject {
  const reconciliation = report.checks.find((candidate) => candidate.name === "reconciliation");
  const reconciliationDetails =
    reconciliation === undefined ? null : compactReconciliationDetails(reconciliation.details);
  const checkCounts: JsonObject = {};
  for (const check of report.checks) {
    const checkCount = checkCounts[check.status];
    checkCounts[check.status] = typeof checkCount === "number" ? checkCount + 1 : 1;
  }

  return {
    ok: report.ok,
    summary: {
      schema_version: 1,
      representation: "compact",
      check_counts: checkCounts,
      reconciliation:
        reconciliationDetails === null
          ? null
          : {
              clean: reconciliationDetails.clean,
              sessions: reconciliationDetails.sessions,
              worktrees: reconciliationDetails.worktrees,
              lifecycle_sessions_total: (reconciliationDetails.lifecycle_sessions_summary as JsonObject).total,
              lifecycle_sessions_included: (reconciliationDetails.lifecycle_sessions_summary as JsonObject).included,
              lifecycle_sessions_omitted: (reconciliationDetails.lifecycle_sessions_summary as JsonObject).omitted,
            },
    },
    checks: report.checks.map((check) => ({
      name: check.name,
      status: check.status,
      code: check.code,
      message: check.message,
      ...(check.name === "reconciliation"
        ? { details: compactReconciliationDetails(check.details) }
        : check.status === "ok"
          ? {}
          : { details: { ...check.details } }),
    })),
    repository: report.repository,
    sandbox: compactSandboxReport(report.sandbox),
  };
}

function check(
  name: DoctorCheck["name"],
  status: DoctorCheckStatus,
  code: ErrorCode | null,
  message: string,
  details: JsonObject = {},
): DoctorCheck {
  return { name, status, code, message, details };
}

function repositoryInfo(context: RepositoryContext): RepositoryInfo {
  return {
    top_level: context.worktreePath,
    common_dir: context.commonGitDirectory,
    registry_path: path.join(context.commonGitDirectory, "nawabari", "session-registry.json"),
  };
}

function doctorReconciliationSession(session: ReconciliationSession): JsonObject {
  const lifecycle = session.lifecycle;
  const summary: JsonObject = {
    session_id: session.session.sessionId,
    status: session.status,
    physical_state: session.physicalState,
    lifecycle_state: lifecycle?.state ?? null,
  };

  // Closed history is useful for reconciliation counts and drift diagnosis,
  // but it has no actionable lifecycle branch. Keep its stable identity and
  // physical summary while omitting the repeated transition/action graph.
  if (session.session.state === "closed") {
    if (session.blockers.length > 0) {
      summary.blockers = session.blockers.map((blocker) => ({
        code: blocker.code,
        message: blocker.message,
        details: { ...blocker.details },
        recovery_hints: [...blocker.recoveryHints],
      }));
    }
    return summary;
  }

  if (lifecycle === undefined) {
    summary.lifecycle = null;
    return summary;
  }
  summary.lifecycle = {
    schema_version: lifecycle.schemaVersion,
    state: lifecycle.state,
    session_state: lifecycle.sessionState,
    physical_state: lifecycle.physicalState,
    close_readiness: lifecycle.closeReadiness,
    blockers: lifecycle.blockers.map((blocker) => ({
      code: blocker.code,
      ...(blocker.classification === undefined ? {} : { classification: blocker.classification }),
    })),
    recoverability: lifecycle.recoverability,
    age_suspicious: lifecycle.ageSuspicious,
    gc_authorized: lifecycle.gcAuthorized,
    destructive_cleanup_eligible: lifecycle.destructiveCleanupEligible,
    available_operations: [...availableLifecycleOperations(lifecycle)],
    transitions: lifecycle.transitions.map((transition) => ({ ...transition })),
    next_actions: projectSessionLifecycleActions({
      classification: lifecycle,
      sessionId: session.session.sessionId,
      blockers: session.blockers.map((blocker) => ({ code: blocker.code, details: blocker.details })),
    }).map((action) => ({
      schema_version: action.schemaVersion,
      action_id: action.actionId,
      kind: action.kind,
      command: action.command,
      ...(action.kind === "integrated-revision"
        ? { integrated_revision: action.integratedRevision }
        : action.kind === "bounded-integration-fetch"
          ? {
              integrated_revision: action.integratedRevision,
              fetch_remote: action.fetchRemote,
              fetch_branch: action.fetchBranch,
            }
          : action.kind === "explicit-discard"
            ? { session_id: action.sessionId, requires_explicit_intent: action.requiresExplicitIntent }
            : action.kind === "reconcile"
              ? { session_id: action.sessionId, mutates: action.mutates }
              : { reason: action.reason }),
    })),
  };
  return summary;
}

async function inspectRegistry(repository: RepositoryInfo, context: RepositoryContext): Promise<DoctorCheck> {
  try {
    const contents = await readFile(repository.registry_path, "utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents) as unknown;
    } catch {
      return check("registry", "error", "REGISTRY_CORRUPT", "The Nawabari registry is not valid JSON.", {
        path: repository.registry_path,
      });
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return check("registry", "error", "INVALID_REGISTRY", "The Nawabari registry must contain a JSON object.", {
        path: repository.registry_path,
      });
    }
    try {
      const sessions = new SessionRegistry({ repository: context, git: defaultGit }).list();
      return check("registry", "ok", null, "The Nawabari registry is readable and valid.", {
        path: repository.registry_path,
        bytes: contents.length,
        sessions: sessions.length,
      });
    } catch (error: unknown) {
      const code = doctorErrorCode(error, "REGISTRY_UNREADABLE");
      return check("registry", "error", code, "The Nawabari registry failed authoritative validation.", {
        path: repository.registry_path,
        ...(isSessionRegistryError(error) ? { reason: error.code, ...error.details } : {}),
      });
    }
  } catch (error: unknown) {
    if (isFileNotFound(error)) {
      return check("registry", "not_configured", null, "The Nawabari session registry is not initialized.", {
        path: repository.registry_path,
      });
    }
    return check("registry", "error", "REGISTRY_UNREADABLE", "The Nawabari registry cannot be read.", {
      path: repository.registry_path,
    });
  }
}

async function inspectReconciliation(context: RepositoryContext): Promise<DoctorCheck> {
  try {
    const result = new SessionRegistry({ repository: context, git: defaultGit }).reconcile();
    const issues = result.issues.map((issue) => ({
      code: issue.code,
      message: issue.message,
      session_id: issue.sessionId,
      worktree: issue.worktreePath,
      branch: issue.branchName,
      details: { ...issue.details },
      recovery_hints: [...issue.recoveryHints],
    }));
    return check(
      "reconciliation",
      result.clean ? "ok" : "warning",
      result.clean ? null : "RECONCILIATION_DRIFT",
      result.clean
        ? "Registry session ownership matches the observed Git worktree state."
        : "Registry/Git ownership drift is present; no destructive repair was performed.",
      {
        clean: result.clean,
        sessions: result.sessions.length,
        lifecycle_sessions: result.sessions.map(doctorReconciliationSession),
        worktrees: result.worktrees.length,
        issues,
      },
    );
  } catch (error: unknown) {
    return check(
      "reconciliation",
      "error",
      doctorErrorCode(error, "REGISTRY_UNREADABLE"),
      "Authoritative registry/Git reconciliation could not be completed.",
      { ...(isSessionRegistryError(error) ? { reason: error.code, ...error.details } : {}) },
    );
  }
}

export async function runDoctor(
  cwd = process.cwd(),
  sandboxProbe: SandboxProbe = defaultSandboxProbe,
  runtimeVersion = process.versions.node,
  runtimeLayout: SandboxRuntimeLayout = discoverSandboxRuntimeLayout(),
): Promise<DomainResult<DoctorReport>> {
  const checks: DoctorCheck[] = [];
  const sandbox = sandboxDoctorReport(sandboxProbe, runtimeLayout);
  const runtimeOk = supportsRuntime(runtimeVersion);
  checks.push(
    runtimeOk
      ? check("runtime", "ok", null, "The Nawabari runtime meets the supported Node.js version.", {
          node: runtimeVersion,
          sandbox: sandbox as unknown as JsonObject,
        })
      : check("runtime", "error", "UNSUPPORTED_RUNTIME", "The Node.js runtime is below the supported version.", {
          node: runtimeVersion,
          sandbox: sandbox as unknown as JsonObject,
        }),
  );

  try {
    const version = defaultGit.run(["--version"], cwd);
    checks.push(check("git", "ok", null, "Git is available.", { version }));
  } catch (error: unknown) {
    checks.push(
      check("git", "error", doctorErrorCode(error, "GIT_UNAVAILABLE"), "Git is not available to the local CLI.", {
        command: "git --version",
        ...(isSessionRegistryError(error) ? { reason: error.code } : {}),
      }),
    );
    checks.push(
      check("repository", "not_applicable", null, "Repository resolution was skipped because Git is unavailable."),
    );
    checks.push(
      check("registry", "not_applicable", null, "Registry inspection was skipped because Git is unavailable."),
    );
    return success({ ok: false, checks, repository: null, sandbox });
  }

  let repository: RepositoryInfo | null = null;
  try {
    const context = resolveRepositoryContext({ cwd, git: defaultGit });
    repository = repositoryInfo(context);
    checks.push(
      check("repository", "ok", null, "Repository and common Git directory resolved.", {
        top_level: repository.top_level,
        common_dir: repository.common_dir,
      }),
    );
    const registryCheck = await inspectRegistry(repository, context);
    checks.push(registryCheck);
    checks.push(
      registryCheck.status === "ok"
        ? await inspectReconciliation(context)
        : check(
            "reconciliation",
            "not_applicable",
            null,
            "Reconciliation was skipped because the registry is invalid.",
          ),
    );
  } catch (error: unknown) {
    checks.push(
      check(
        "repository",
        "error",
        doctorErrorCode(error, "NOT_GIT_REPOSITORY"),
        "The current directory is not a valid Git repository context.",
        {
          ...(isSessionRegistryError(error) ? { reason: error.code, ...error.details } : {}),
        },
      ),
    );
    checks.push(check("registry", "not_applicable", null, "Registry inspection was skipped outside a Git repository."));
  }

  const hasError = checks.some((item) => item.status === "error");
  return success({ ok: !hasError, checks, repository, sandbox });
}

function doctorErrorCode(error: unknown, fallback: ErrorCode): ErrorCode {
  if (!isSessionRegistryError(error)) return fallback;
  const code = error.code;
  if (code === "GIT_SPAWN_FAILED") return "GIT_SPAWN_FAILED";
  if (code === "GIT_TIMEOUT") return "GIT_TIMEOUT";
  if (code === "GIT_OUTPUT_LIMIT") return "GIT_OUTPUT_LIMIT";
  if (code === "GIT_COMMAND_FAILED") return "GIT_COMMAND_FAILED";
  if (code === "NOT_A_GIT_REPOSITORY") return "NOT_GIT_REPOSITORY";
  if (code === "MISSING_WORKTREE") return "MISSING_WORKTREE";
  if (code === "PHYSICAL_OBSERVATION_UNAVAILABLE") return "PHYSICAL_OBSERVATION_UNAVAILABLE";
  if (code === "REPOSITORY_IDENTITY_AMBIGUOUS") return "GIT_STATE_AMBIGUOUS";
  if (code === "REGISTRY_CORRUPT" || code === "UNSUPPORTED_SCHEMA_VERSION") return "REGISTRY_CORRUPT";
  if (code === "UNSUPPORTED_CLAIM_SCHEMA_VERSION") return "UNSUPPORTED_CLAIM_SCHEMA_VERSION";
  if (code === "REGISTRY_REPOSITORY_MISMATCH") return "INVALID_REGISTRY";
  if (code === "INVALID_BRANCH_ID") return "INVALID_BRANCH";
  if (code === "INVALID_WORKTREE_PATH") return "INVALID_WORKTREE";
  if (code === "WORKTREE_IDENTITY_AMBIGUOUS") return "GIT_STATE_AMBIGUOUS";
  if (code === "RECONCILIATION_DRIFT") return "RECONCILIATION_DRIFT";
  return fallback;
}

function isFileNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
