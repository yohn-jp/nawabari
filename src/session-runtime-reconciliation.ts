import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";
import { parseRepositoryRuntimeObservations } from "./repository-runtime-observations.js";
import type {
  RepositoryRuntimeFilesystemObservation,
  RepositoryRuntimeLifecycleObservation,
  RepositoryRuntimeProcessObservation,
} from "./repository-runtime-observations.js";
import type { RepositoryRuntimeSnapshot } from "./repository-runtime-snapshot.js";

export const RUNTIME_RECONCILIATION_CODES = Object.freeze([
  "managed-present",
  "managed-missing",
  "runtime-residual",
  "execution-active",
  "execution-unknown",
  "unmanaged-worktree",
  "safe-runtime-residual",
  "cleanup-incomplete",
] as const);
export type RuntimeReconciliationCode = (typeof RUNTIME_RECONCILIATION_CODES)[number];
export type RuntimeReconciliationDisposition = "observe" | "retain" | "reconcile-runtime-only" | "blocked";
export type RuntimeReconciliationAction =
  | "inspect-session"
  | "inspect-processes"
  | "retain-runtime-state"
  | "remove-owned-runtime-state"
  | "retry-runtime-cleanup"
  | "inspect-unmanaged-worktree";

export interface RuntimeReconciliationFinding {
  readonly session_id: string | null;
  readonly code: RuntimeReconciliationCode;
  readonly disposition: RuntimeReconciliationDisposition;
  readonly proposed_actions: readonly RuntimeReconciliationAction[];
  readonly reason: string | null;
  readonly worktree_path?: string;
}

export interface RuntimeReconciliationResult {
  readonly registry_revision: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly findings: readonly RuntimeReconciliationFinding[];
}

const MAX_FINDINGS = 2_048;

/** Purely classify the supplied repository observation; no repository I/O is performed. */
export function reconcileSessionRuntimeEvidence(
  snapshot: RepositoryRuntimeSnapshot,
): DomainResult<RuntimeReconciliationResult> {
  if (!snapshot || typeof snapshot !== "object") return invalid("snapshot", "expected an object");
  const parsed = parseRepositoryRuntimeObservations(snapshot);
  if (!parsed.ok) return parsed;

  const observations = parsed.value;
  const findings: RuntimeReconciliationFinding[] = [];
  const sessions = [...snapshot.sessions].sort((left, right) => compare(left.sessionId, right.sessionId));
  for (const session of sessions) {
    const process = observations.processes.get(session.sessionId);
    const file = observations.filesystem.get(session.sessionId);
    const lifecycle = observations.lifecycle.get(session.sessionId);
    let finding: RuntimeReconciliationFinding;

    if (
      observations.processes_unknown ||
      observations.filesystem_unknown ||
      observations.lifecycle_unknown ||
      process === undefined
    ) {
      finding = make(
        session.sessionId,
        "execution-unknown",
        "blocked",
        ["inspect-processes"],
        "required observation is unknown or missing",
      );
    } else if (process.status === "active") {
      finding = make(session.sessionId, "execution-active", "blocked", ["inspect-processes"], process.reason);
    } else if (process.status === "unknown") {
      finding = make(session.sessionId, "execution-unknown", "blocked", ["inspect-processes"], process.reason);
    } else if (file === undefined || lifecycle === undefined) {
      finding = make(
        session.sessionId,
        "execution-unknown",
        "blocked",
        ["inspect-session"],
        "required observation is missing",
      );
    } else if (file.policy_status === "unknown") {
      finding = make(session.sessionId, "execution-unknown", "blocked", ["inspect-session"], file.reason);
    } else if (file.runtime_status === "cleanup-incomplete") {
      const retrySafe = process.status === "inactive" && file.owner === "proven";
      finding = retrySafe
        ? make(
            session.sessionId,
            "cleanup-incomplete",
            "reconcile-runtime-only",
            ["retry-runtime-cleanup"],
            file.reason,
          )
        : make(session.sessionId, "cleanup-incomplete", "blocked", ["inspect-session"], file.reason);
    } else if (file.runtime_status === "runtime-residual") {
      const safe =
        file.owner === "proven" &&
        process.status === "inactive" &&
        (lifecycle.state === "parked" || lifecycle.state === "closed" || lifecycle.state === "discarded") &&
        lifecycle.recoverable_work === "absent" &&
        lifecycle.integration === "proven";
      if (safe) {
        finding = make(
          session.sessionId,
          "safe-runtime-residual",
          "reconcile-runtime-only",
          ["remove-owned-runtime-state"],
          file.reason,
        );
      } else if (file.owner === "proven" && process.status === "inactive") {
        finding = make(
          session.sessionId,
          "runtime-residual",
          "retain",
          ["retain-runtime-state", "inspect-session"],
          file.reason,
        );
      } else {
        finding = make(session.sessionId, "runtime-residual", "blocked", ["inspect-session"], file.reason);
      }
    } else if (lifecycle.physical_state === "missing") {
      finding = make(session.sessionId, "managed-missing", "retain", ["inspect-session"], lifecycle.reason);
    } else if (unknownFilesystemEvidence(file) || unknownLifecycleEvidence(lifecycle)) {
      finding = make(
        session.sessionId,
        "execution-unknown",
        "blocked",
        ["inspect-session"],
        "required observation is unknown",
      );
    } else if (lifecycle.physical_state !== "present") {
      finding = make(
        session.sessionId,
        "execution-unknown",
        "blocked",
        ["inspect-session"],
        lifecycle.reason ?? "required physical state is unknown",
      );
    } else {
      finding = make(
        session.sessionId,
        "managed-present",
        "observe",
        ["inspect-session"],
        file.reason ?? lifecycle.reason,
      );
    }
    findings.push(finding);
  }

  for (const entry of observations.unmanaged_worktrees) {
    findings.push(
      make(null, "unmanaged-worktree", "observe", ["inspect-unmanaged-worktree"], entry.reason, entry.worktree_path),
    );
  }

  findings.sort(
    (left, right) =>
      compare(left.session_id ?? "\uffff", right.session_id ?? "\uffff") ||
      compare(left.code, right.code) ||
      compare(left.worktree_path ?? "", right.worktree_path ?? ""),
  );
  const truncated = findings.length > MAX_FINDINGS;
  const complete =
    snapshot.complete &&
    !observations.processes_unknown &&
    !observations.filesystem_unknown &&
    !observations.lifecycle_unknown &&
    sessions.every(
      (session) =>
        observations.processes.has(session.sessionId) &&
        observations.filesystem.has(session.sessionId) &&
        observations.lifecycle.has(session.sessionId) &&
        !unknownProcessEvidence(observations.processes.get(session.sessionId)) &&
        !unknownFilesystemEvidence(observations.filesystem.get(session.sessionId)) &&
        !unknownLifecycleEvidence(observations.lifecycle.get(session.sessionId)),
    ) &&
    !truncated;
  const bounded = findings
    .slice(0, MAX_FINDINGS)
    .map((finding) => (complete ? finding : suppressDestructiveProposal(finding)));
  return success(
    Object.freeze({
      registry_revision: snapshot.registry.revision,
      complete,
      truncated,
      findings: Object.freeze(bounded),
    }),
  );
}

function unknownProcessEvidence(process: RepositoryRuntimeProcessObservation | undefined): boolean {
  return process === undefined || process.status === "unknown";
}

function unknownFilesystemEvidence(file: RepositoryRuntimeFilesystemObservation | undefined): boolean {
  return (
    file === undefined ||
    file.policy_status === "unknown" ||
    file.runtime_status === "unknown" ||
    file.owner === "unknown"
  );
}

function unknownLifecycleEvidence(lifecycle: RepositoryRuntimeLifecycleObservation | undefined): boolean {
  return (
    lifecycle === undefined ||
    lifecycle.physical_state === null ||
    lifecycle.recoverable_work === "unknown" ||
    lifecycle.integration === "unknown" ||
    lifecycle.cleanup === "unknown"
  );
}

function make(
  session_id: string | null,
  code: RuntimeReconciliationCode,
  disposition: RuntimeReconciliationDisposition,
  proposed_actions: readonly RuntimeReconciliationAction[],
  reason: string | null,
  worktree_path?: string,
): RuntimeReconciliationFinding {
  return Object.freeze({
    session_id,
    code,
    disposition,
    proposed_actions: Object.freeze([...proposed_actions]),
    reason,
    ...(worktree_path === undefined ? {} : { worktree_path }),
  });
}

function suppressDestructiveProposal(finding: RuntimeReconciliationFinding): RuntimeReconciliationFinding {
  if (
    !finding.proposed_actions.includes("remove-owned-runtime-state") &&
    !finding.proposed_actions.includes("retry-runtime-cleanup")
  )
    return finding;
  if (finding.code === "safe-runtime-residual") {
    return make(
      finding.session_id,
      finding.code,
      "retain",
      ["retain-runtime-state", "inspect-session"],
      finding.reason,
      finding.worktree_path,
    );
  }
  return make(finding.session_id, finding.code, "blocked", ["inspect-session"], finding.reason, finding.worktree_path);
}

function compare(left: string, right: string): number {
  const leftPoints = [...left];
  const rightPoints = [...right];
  for (let index = 0; index < leftPoints.length && index < rightPoints.length; index += 1) {
    const difference = leftPoints[index]!.codePointAt(0)! - rightPoints[index]!.codePointAt(0)!;
    if (difference !== 0) return difference;
  }
  return leftPoints.length - rightPoints.length;
}

function invalid(field: string, reason: string): DomainResult<never> {
  return failure(
    new DomainError("INVALID_ARGUMENT", `Runtime reconciliation field '${field}' is invalid: ${reason}.`, { field }),
  );
}
