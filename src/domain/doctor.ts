import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { defaultGit, resolveRepositoryContext, type RepositoryContext } from "../git.js";
import { isSessionRegistryError } from "../errors.js";
import { SessionRegistry } from "../session-registry.js";
import { projectSessionLifecycleActions } from "../session-lifecycle-actions.js";
import { availableLifecycleOperations } from "../session-lifecycle-classification.js";
import { success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";
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
        lifecycle_sessions: result.sessions.map((session) => ({
          session_id: session.session.sessionId,
          status: session.status,
          physical_state: session.physicalState,
          lifecycle_state: session.lifecycle?.state ?? null,
          lifecycle:
            session.lifecycle === undefined
              ? null
              : {
                  schema_version: session.lifecycle.schemaVersion,
                  state: session.lifecycle.state,
                  session_state: session.lifecycle.sessionState,
                  physical_state: session.lifecycle.physicalState,
                  close_readiness: session.lifecycle.closeReadiness,
                  blockers: session.lifecycle.blockers.map((blocker) => ({
                    code: blocker.code,
                    ...(blocker.classification === undefined ? {} : { classification: blocker.classification }),
                  })),
                  recoverability: session.lifecycle.recoverability,
                  age_suspicious: session.lifecycle.ageSuspicious,
                  gc_authorized: session.lifecycle.gcAuthorized,
                  destructive_cleanup_eligible: session.lifecycle.destructiveCleanupEligible,
                  available_operations: [...availableLifecycleOperations(session.lifecycle)],
                  transitions: session.lifecycle.transitions.map((transition) => ({ ...transition })),
                  next_actions: projectSessionLifecycleActions({
                    classification: session.lifecycle,
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
                },
        })),
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
