import type { JsonValue } from "./errors.js";
import type { RepositoryRuntimeLifecycleObservation } from "../repository-runtime-observations.js";
import { REPOSITORY_LIFECYCLE_OBSERVATION_V2 } from "../repository-runtime-observations.js";
import type { RepositoryRuntimeObservation } from "../repository-runtime-snapshot.js";
import { compareCodePointStrings } from "../resource-claims.js";
import type { RepositoryRegistryView, SessionDiagnostic, SessionRecord, SessionRegistry } from "../session-registry.js";

const MAX_SESSIONS = 1_024;
const SOURCE_UNAVAILABLE = "lifecycle source unavailable" as const;
const SOURCE_CHANGED = "lifecycle source changed during collection" as const;
const SOURCE_OVER_BOUND = "lifecycle source exceeded the session bound" as const;
const EVIDENCE_UNAVAILABLE = "lifecycle evidence unavailable" as const;

const LIFECYCLE_STATES = new Set([
  "active",
  "parking",
  "parked",
  "close-ready",
  "blocked-recoverable",
  "closed",
  "discarded",
  "stale-inconsistent",
]);

/** Injectable clock for deterministic observation timestamps. */
export type RepositoryRuntimeLifecycleCollectorOptions = Readonly<{
  now?: () => Date;
}>;

/** Collect one bounded lifecycle sample from the existing read-only registry authorities. */
export function collectRepositoryRuntimeLifecycleObservation(
  registry: Pick<SessionRegistry, "readRepositoryView" | "diagnose">,
  options: RepositoryRuntimeLifecycleCollectorOptions = {},
): RepositoryRuntimeObservation<JsonValue> {
  try {
    const before = registry.readRepositoryView();
    if (!isValidView(before)) return unknown(SOURCE_UNAVAILABLE);
    if (before.sessions.length > MAX_SESSIONS) return unknown(SOURCE_OVER_BOUND);

    const sessions = [...before.sessions].sort((left, right) =>
      compareCodePointStrings(left.sessionId, right.sessionId),
    );
    const seen = new Set<string>();
    const rows: RepositoryRuntimeLifecycleObservation[] = [];
    for (const session of sessions) {
      if (seen.has(session.sessionId)) return unknown(SOURCE_UNAVAILABLE);
      seen.add(session.sessionId);

      const diagnostic = registry.diagnose(session.sessionId);
      if (!matchesCapturedSession(before.repositoryId, session, diagnostic)) return unknown(SOURCE_CHANGED);
      const row = projectDiagnostic(session.sessionId, diagnostic);
      if (row === undefined) return unknown(EVIDENCE_UNAVAILABLE);
      rows.push(row);
    }

    const after = registry.readRepositoryView();
    if (!isValidView(after) || after.sessions.length > MAX_SESSIONS) return unknown(SOURCE_CHANGED);
    if (!sameSource(before, after)) return unknown(SOURCE_CHANGED);

    const observedAt = (options.now ?? (() => new Date()))().toISOString();
    const value = Object.freeze({
      contract_id: REPOSITORY_LIFECYCLE_OBSERVATION_V2,
      schema_version: 2,
      sessions: Object.freeze(rows),
    });
    return {
      status: "available",
      observed_at: observedAt,
      value: value as unknown as JsonValue,
    };
  } catch {
    return unknown(SOURCE_UNAVAILABLE);
  }
}

function unknown(reason: string): RepositoryRuntimeObservation<JsonValue> {
  return { status: "unknown", observed_at: null, reason };
}

function isValidView(view: RepositoryRegistryView): boolean {
  return (
    typeof view.repositoryId === "string" &&
    view.repositoryId.length > 0 &&
    isNonNegativeSafeInteger(view.registrySchemaVersion) &&
    isNonNegativeSafeInteger(view.registryRevision) &&
    isNonNegativeSafeInteger(view.runtimeEpoch) &&
    isNonNegativeSafeInteger(view.claimSetGeneration) &&
    Array.isArray(view.sessions) &&
    view.sessions.every(
      (session) =>
        typeof session.sessionId === "string" &&
        session.sessionId.length > 0 &&
        session.repositoryId === view.repositoryId,
    )
  );
}

function isNonNegativeSafeInteger(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

function sameSource(before: RepositoryRegistryView, after: RepositoryRegistryView): boolean {
  if (
    before.repositoryId !== after.repositoryId ||
    before.registrySchemaVersion !== after.registrySchemaVersion ||
    before.registryRevision !== after.registryRevision ||
    before.runtimeEpoch !== after.runtimeEpoch ||
    before.claimSetGeneration !== after.claimSetGeneration ||
    before.sessions.length !== after.sessions.length
  ) {
    return false;
  }

  const beforeSessions = [...before.sessions].sort((left, right) =>
    compareCodePointStrings(left.sessionId, right.sessionId),
  );
  const afterSessions = [...after.sessions].sort((left, right) =>
    compareCodePointStrings(left.sessionId, right.sessionId),
  );
  return beforeSessions.every((session, index) => sameSessionIdentity(session, afterSessions[index]));
}

function sameSessionIdentity(left: SessionRecord, right: SessionRecord | undefined): boolean {
  return (
    right !== undefined &&
    left.sessionId === right.sessionId &&
    left.repositoryId === right.repositoryId &&
    left.worktreeId === right.worktreeId &&
    left.worktreePath === right.worktreePath &&
    left.branchId === right.branchId &&
    left.branchName === right.branchName
  );
}

function matchesCapturedSession(repositoryId: string, captured: SessionRecord, diagnostic: SessionDiagnostic): boolean {
  return (
    diagnostic.operation === "diagnostic" &&
    diagnostic.repositoryId === repositoryId &&
    diagnostic.session.repositoryId === repositoryId &&
    sameSessionIdentity(captured, diagnostic.session) &&
    diagnostic.session.state === captured.state
  );
}

function projectDiagnostic(
  sessionId: string,
  diagnostic: SessionDiagnostic,
): RepositoryRuntimeLifecycleObservation | undefined {
  const lifecycle = diagnostic.lifecycle;
  if (
    lifecycle === undefined ||
    lifecycle.sessionState !== diagnostic.session.state ||
    lifecycle.physicalState !== diagnostic.physicalState ||
    !LIFECYCLE_STATES.has(lifecycle.state) ||
    !Array.isArray(diagnostic.blockers) ||
    diagnostic.integrationEvidence === undefined
  ) {
    return undefined;
  }

  const physicalState = projectPhysicalState(diagnostic.physicalState);
  if (physicalState === undefined) return undefined;

  let recoverableWork: RepositoryRuntimeLifecycleObservation["recoverable_work"];
  switch (lifecycle.recoverability) {
    case "recoverable":
      recoverableWork = "present";
      break;
    case "none":
      recoverableWork = "absent";
      break;
    case "ambiguous":
      recoverableWork = "unknown";
      break;
    default:
      return undefined;
  }

  const failedIntegrationProof = diagnostic.blockers.some((blocker) => blocker.code === "RECOVERABLE_COMMITS");
  const hasIntegrationProof = diagnostic.integrationEvidence.proof !== undefined;
  if (failedIntegrationProof && hasIntegrationProof) return undefined;
  const integration: RepositoryRuntimeLifecycleObservation["integration"] = hasIntegrationProof
    ? "proven"
    : failedIntegrationProof
      ? "unproven"
      : "unknown";

  const firstBlocker = diagnostic.blockers[0];
  if (firstBlocker !== undefined && typeof firstBlocker.code !== "string") return undefined;

  return Object.freeze({
    session_id: sessionId,
    state: lifecycle.state,
    physical_state: physicalState,
    recoverable_work: recoverableWork,
    integration,
    // Readiness is not a cleanup outcome. No current producer establishes completion.
    cleanup: "unknown",
    reason: firstBlocker?.code ?? null,
  });
}

/** Map only the physical vocabulary present in the canonical diagnostic producer. */
function projectPhysicalState(value: string): RepositoryRuntimeLifecycleObservation["physical_state"] | undefined {
  switch (value) {
    case "healthy":
      return "present";
    case "prunable-missing":
    case "registered-missing":
    case "unregistered-missing":
      return "missing";
    case "unregistered-present":
      return "unmanaged";
    case "prunable-present":
    case "invalid":
      return "ambiguous";
    case "closed":
    case "unavailable":
      return null;
    default:
      return undefined;
  }
}
