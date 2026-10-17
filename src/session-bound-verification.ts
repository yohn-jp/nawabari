import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";
import {
  isSandboxExecutionEvidenceSnapshot,
  type SandboxExecutionEvidenceSnapshot,
} from "./domain/sandbox-execution-evidence.js";
import type { SandboxProbe, SandboxRuntimeLayout } from "./domain/sandbox.js";
import { launchManagedSessionCommand } from "./domain/session-console.js";
import {
  SESSION_VERIFICATION_SNAPSHOT_CONTRACT_ID,
  SESSION_VERIFICATION_SNAPSHOT_SCHEMA_VERSION,
  type SessionBackend,
  type SessionContext,
  type SessionVerificationSnapshot,
} from "./domain/session.js";
import type { SessionExecutionRecord } from "./domain/session-execution-record.js";
import type { SessionLaunchSupervisorResult } from "./domain/session-launch-supervisor.js";
import type { OwnedExecutionObservation } from "./domain/session-process-observation.js";
import {
  validateVerificationProfile,
  type VerificationProfile,
  type VerificationProfileInput,
  type VerificationResult,
  type VerificationSourceWitness,
} from "./verification-executor.js";
import { isSessionId } from "./session-id.js";

export const SESSION_BOUND_VERIFICATION_CONTRACT_ID = "nawabari.session-bound-verification.v1" as const;
export const SESSION_BOUND_VERIFICATION_SCHEMA_VERSION = 1 as const;
export const SESSION_BOUND_VERIFICATION_RESULT_SCHEMA = "nawabari.session-bound-verification.v1" as const;

const MAX_REQUEST_BYTES = 1 * 1_024 * 1_024;
const packageMetadata = createRequire(import.meta.url)("../package.json") as { version: string };

export type SessionBoundVerificationRequest = Readonly<{
  contract_id: typeof SESSION_BOUND_VERIFICATION_CONTRACT_ID;
  schema_version: typeof SESSION_BOUND_VERIFICATION_SCHEMA_VERSION;
  session_id: string;
  snapshot: SessionVerificationSnapshot;
  profile: VerificationProfileInput;
}>;

export type SessionBoundVerificationSource = Readonly<{
  status: "proven" | "unresolved";
  before: VerificationSourceWitness | null;
  after: VerificationSourceWitness | null;
  witness: VerificationSourceWitness | null;
  reason?: "pre-observation-unavailable" | "post-observation-unavailable" | "source-changed" | "policy-changed";
}>;

export type ManagedVerificationExecution = Readonly<{
  supervisor: SessionLaunchSupervisorResult;
  execution: SessionExecutionRecord;
  effective_revision: number;
  request_identity: Readonly<{
    session_id: string;
    repository: string;
    worktree: string;
    branch: string;
    network_mode: string;
  }>;
  owned_execution?: OwnedExecutionObservation;
}>;

export type SessionBoundVerificationResult = Readonly<{
  contract_id: typeof SESSION_BOUND_VERIFICATION_CONTRACT_ID;
  schema_version: typeof SESSION_BOUND_VERIFICATION_SCHEMA_VERSION;
  producer: Readonly<{ package: "nawabari"; version: string }>;
  session_id: string;
  profile: VerificationProfile & Readonly<{ profile_sha256: string }>;
  source: SessionBoundVerificationSource;
  verification: VerificationResult;
  managed_execution: ManagedVerificationExecution | null;
  execution_evidence: SandboxExecutionEvidenceSnapshot | null;
  final_snapshot: SessionVerificationSnapshot | null;
  status: "passed" | "failed" | "unavailable";
  receipt_sha256: string;
}>;

export type SessionBoundVerificationDependencies = Readonly<{
  sandbox_probe?: SandboxProbe;
  sandbox_runtime_layout?: SandboxRuntimeLayout;
  now?: () => string;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalClone(value: unknown, ancestors = new Set<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (ancestors.has(value)) throw new TypeError("cyclic receipt data");
    ancestors.add(value);
    const result = value.map((entry) => canonicalClone(entry, ancestors));
    ancestors.delete(value);
    return result;
  }
  if (isRecord(value)) {
    if (ancestors.has(value)) throw new TypeError("cyclic receipt data");
    ancestors.add(value);
    const result: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort()) result[key] = canonicalClone(value[key], ancestors);
    ancestors.delete(value);
    return result;
  }
  throw new TypeError("receipt contains non-JSON data");
}

function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalClone(value));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function invalid(message: string, field: string): DomainResult<never> {
  return failure(new DomainError("INVALID_ARGUMENT", message, { field }));
}

function parseRequest(value: unknown): DomainResult<SessionBoundVerificationRequest> {
  if (!isRecord(value)) return invalid("Session-bound verification request must be an object.", "request");
  try {
    if (Buffer.byteLength(canonicalJson(value), "utf8") > MAX_REQUEST_BYTES) {
      return invalid("Session-bound verification request exceeds its size bound.", "request");
    }
  } catch {
    return invalid("Session-bound verification request must contain bounded JSON data.", "request");
  }
  if (value.contract_id !== SESSION_BOUND_VERIFICATION_CONTRACT_ID) {
    return invalid("Session-bound verification contract is unsupported.", "contract_id");
  }
  if (value.schema_version !== SESSION_BOUND_VERIFICATION_SCHEMA_VERSION) {
    return invalid("Session-bound verification schema version is unsupported.", "schema_version");
  }
  if (typeof value.session_id !== "string" || !isSessionId(value.session_id)) {
    return invalid("Session-bound verification requires a canonical session identity.", "session_id");
  }
  if (
    !isRecord(value.snapshot) ||
    value.snapshot.session_id !== value.session_id ||
    value.snapshot.contract_id !== SESSION_VERIFICATION_SNAPSHOT_CONTRACT_ID ||
    value.snapshot.schema_version !== SESSION_VERIFICATION_SNAPSHOT_SCHEMA_VERSION ||
    typeof value.snapshot.repository !== "string" ||
    value.snapshot.repository.length === 0 ||
    typeof value.snapshot.worktree !== "string" ||
    !path.isAbsolute(value.snapshot.worktree) ||
    path.resolve(value.snapshot.worktree) !== value.snapshot.worktree ||
    typeof value.snapshot.branch !== "string" ||
    !isRecord(value.snapshot.managed) ||
    !isRecord(value.snapshot.filesystem_policy_token)
  ) {
    return invalid("The owner snapshot must identify the requested session.", "snapshot");
  }
  if (!isRecord(value.profile)) return invalid("Verification profile must be an object.", "profile");
  const profile = validateVerificationProfile(value.profile);
  if (!profile.ok) return profile;
  return success({
    contract_id: SESSION_BOUND_VERIFICATION_CONTRACT_ID,
    schema_version: SESSION_BOUND_VERIFICATION_SCHEMA_VERSION,
    session_id: value.session_id,
    snapshot: value.snapshot as unknown as SessionVerificationSnapshot,
    profile: profile.value,
  });
}

function snapshotMatchesExecutionStart(
  expected: SessionVerificationSnapshot,
  actual: SessionVerificationSnapshot,
  managedExecution: ManagedVerificationExecution,
): boolean {
  const executionStarted = managedExecution.supervisor.started;
  const expectedRevision = expected.managed.registry_revision + (executionStarted ? 4 : 1);
  const expectedToken = {
    ...expected.filesystem_policy_token,
    registry_revision: actual.filesystem_policy_token.registry_revision,
  };
  return (
    actual.session_id === expected.session_id &&
    actual.repository === expected.repository &&
    actual.worktree === expected.worktree &&
    actual.branch === expected.branch &&
    actual.state === "active" &&
    actual.managed.profile_digest === expected.managed.profile_digest &&
    actual.managed.admission === expected.managed.admission &&
    actual.managed.runtime_epoch === expected.managed.runtime_epoch &&
    actual.managed.claim_set_generation === expected.managed.claim_set_generation &&
    actual.managed.registry_revision === expectedRevision &&
    actual.filesystem_policy_token.registry_revision === actual.managed.registry_revision &&
    isDeepStrictEqual(actual.filesystem_policy_token, expectedToken)
  );
}

export function isSessionBoundPhysicalExecutionProven(
  evidence: SandboxExecutionEvidenceSnapshot | null,
  executionId: string,
): boolean {
  if (evidence === null || !isSandboxExecutionEvidenceSnapshot(evidence)) return false;
  const physical = evidence.physical_execution;
  const namespaces = Object.values(physical.start.namespaces);
  return (
    evidence.execution_id === executionId &&
    physical.correlation_id === executionId &&
    evidence.exit_code === 0 &&
    evidence.signal === null &&
    evidence.raw_output.capture_mode === "pipes" &&
    evidence.raw_output.complete &&
    !evidence.raw_output.truncated &&
    evidence.raw_output.observed_stdout_bytes === evidence.raw_output.stdout_bytes &&
    evidence.raw_output.observed_stderr_bytes === evidence.raw_output.stderr_bytes &&
    physical.start.state === "observed" &&
    physical.start.outer_pid !== null &&
    physical.start.process_start_ticks !== null &&
    namespaces.length === 5 &&
    namespaces.every((namespace) => namespace.state === "observed" && namespace.distinct_from_caller === true) &&
    physical.termination.state === "observed-exited" &&
    physical.termination.reason === "exited" &&
    physical.cleanup.state === "observed-empty" &&
    physical.cleanup.process_count === 0
  );
}

function executionFailed(verification: VerificationResult, evidence: SandboxExecutionEvidenceSnapshot | null): boolean {
  if (verification.status === "failed") return true;
  if (evidence === null) return false;
  return (
    evidence.exit_code !== 0 ||
    evidence.signal !== null ||
    evidence.physical_execution.termination.reason === "timeout" ||
    evidence.physical_execution.termination.reason === "cancelled" ||
    evidence.physical_execution.termination.reason === "output-limit" ||
    evidence.physical_execution.cleanup.state === "observed-populated"
  );
}

function sourceResult(
  managed: Awaited<ReturnType<typeof launchManagedSessionCommand>> extends DomainResult<infer T>
    ? Exclude<T, null>
    : never,
  finalSnapshot: SessionVerificationSnapshot | null,
  initialSnapshot: SessionVerificationSnapshot,
): SessionBoundVerificationSource {
  const before = managed.source_before ?? null;
  const after = managed.source_after ?? null;
  if (managed.verification?.source.status !== "proven") {
    const managedReason = managed.verification?.source.reason;
    return {
      status: "unresolved",
      before,
      after,
      witness: null,
      reason:
        managedReason === "policy-fence-unavailable"
          ? "policy-changed"
          : (managedReason ?? "pre-observation-unavailable"),
    };
  }
  if (before === null || after === null) {
    return { status: "unresolved", before, after, witness: null, reason: "post-observation-unavailable" };
  }
  if (!isDeepStrictEqual(before, after) || !isDeepStrictEqual(before, managed.verification.source.witness)) {
    return { status: "unresolved", before, after, witness: null, reason: "source-changed" };
  }
  if (finalSnapshot === null || !snapshotMatchesExecutionStart(initialSnapshot, finalSnapshot, managed)) {
    return { status: "unresolved", before, after, witness: null, reason: "policy-changed" };
  }
  return { status: "proven", before, after, witness: before };
}

function receiptDigest(receipt: Omit<SessionBoundVerificationResult, "receipt_sha256">): string {
  return sha256(canonicalJson(receipt));
}

/** Read a fresh owner-issued snapshot; this operation grants no execution authority. */
export async function getSessionVerificationSnapshot(
  context: SessionContext,
  backend: SessionBackend,
  sessionId: string,
): Promise<DomainResult<SessionVerificationSnapshot>> {
  if (!isSessionId(sessionId)) return invalid("A canonical active session identity is required.", "session_id");
  if (backend.getSessionVerificationSnapshot === undefined) {
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The session verification snapshot authority is unavailable.", {
        operation: "verification.snapshot",
      }),
    );
  }
  const snapshot = await backend.getSessionVerificationSnapshot(context, sessionId);
  if (!snapshot.ok) return snapshot;
  if (
    snapshot.value.session_id !== sessionId ||
    snapshot.value.contract_id !== SESSION_VERIFICATION_SNAPSHOT_CONTRACT_ID ||
    snapshot.value.schema_version !== SESSION_VERIFICATION_SNAPSHOT_SCHEMA_VERSION
  ) {
    return failure(
      new DomainError("RUNTIME_PROJECTION_INVALID", "The session owner returned a mismatched verification snapshot.", {
        requested_session_id: sessionId,
        observed_session_id: snapshot.value.session_id,
      }),
    );
  }
  return success(snapshot.value);
}

/**
 * Execute one approved profile through the active session's managed protected
 * launch owner. The request carries an exact owner snapshot; no caller-built
 * sandbox request or generic host execution path is accepted.
 */
export async function executeSessionBoundVerification(
  context: SessionContext,
  backend: SessionBackend,
  requestInput: SessionBoundVerificationRequest | unknown,
  dependencies: SessionBoundVerificationDependencies = {},
): Promise<DomainResult<SessionBoundVerificationResult>> {
  const parsedRequest = parseRequest(requestInput);
  if (!parsedRequest.ok) return parsedRequest;
  const request = parsedRequest.value;
  const profile = validateVerificationProfile(request.profile);
  if (!profile.ok) return profile;
  if (
    profile.value.cwd !== request.snapshot.worktree &&
    !profile.value.cwd.startsWith(`${request.snapshot.worktree}${path.sep}`)
  ) {
    return invalid("Verification cwd must remain inside the owned session worktree.", "profile.cwd");
  }
  if (
    request.snapshot.contract_id !== SESSION_VERIFICATION_SNAPSHOT_CONTRACT_ID ||
    request.snapshot.schema_version !== SESSION_VERIFICATION_SNAPSHOT_SCHEMA_VERSION ||
    request.snapshot.state !== "active" ||
    request.snapshot.managed.admission !== "open" ||
    request.snapshot.managed.profile_digest === null
  ) {
    return failure(
      new DomainError("OPERATION_REJECTED", "Verification requires an active managed session owner snapshot.", {
        session_id: request.session_id,
        state: request.snapshot.state,
        admission: request.snapshot.managed.admission,
      }),
    );
  }
  const currentSnapshot = await getSessionVerificationSnapshot(context, backend, request.session_id);
  if (!currentSnapshot.ok) return currentSnapshot;
  if (!isDeepStrictEqual(currentSnapshot.value, request.snapshot)) {
    return failure(
      new DomainError("STALE_REGISTRY", "The owner-issued verification snapshot is stale.", {
        session_id: request.session_id,
        expected_registry_revision: request.snapshot.managed.registry_revision,
        actual_registry_revision: currentSnapshot.value.managed.registry_revision,
      }),
    );
  }

  const launched = await launchManagedSessionCommand(context, backend, {
    session_id: request.session_id,
    command: { command: profile.value.executable, args: profile.value.argv, cwd: profile.value.cwd },
    verification: { profile: profile.value, expected_snapshot: request.snapshot },
    ...(dependencies.sandbox_probe === undefined ? {} : { sandbox_probe: dependencies.sandbox_probe }),
    ...(dependencies.sandbox_runtime_layout === undefined
      ? {}
      : { sandbox_runtime_layout: dependencies.sandbox_runtime_layout }),
    ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
  });
  if (!launched.ok) return launched;
  if (launched.value === null || launched.value.verification === undefined) {
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The managed session verifier did not produce an owner result.", {
        session_id: request.session_id,
      }),
    );
  }
  const managed = launched.value;
  const verification = managed.verification;
  if (verification === undefined) {
    return failure(
      new DomainError("BACKEND_UNAVAILABLE", "The managed session verifier did not produce a verification result.", {
        session_id: request.session_id,
      }),
    );
  }
  const observedFinal = await getSessionVerificationSnapshot(context, backend, request.session_id);
  const finalSnapshot = observedFinal.ok ? observedFinal.value : null;
  const source = sourceResult(managed, finalSnapshot, request.snapshot);
  const executionEvidence = managed.execution_evidence ?? null;
  const ownerScopeEmpty =
    managed.owned_execution?.state === "empty" && managed.owned_execution.cgroups?.population.state === "empty";
  const status =
    source.status === "proven" &&
    verification.verification.status === "passed" &&
    verification.verification.exit_code === 0 &&
    verification.verification.signal === null &&
    managed.supervisor.status === "completed" &&
    managed.supervisor.started &&
    managed.execution.state === "exited" &&
    ownerScopeEmpty &&
    isSessionBoundPhysicalExecutionProven(executionEvidence, managed.execution.execution_id)
      ? "passed"
      : executionFailed(verification.verification, executionEvidence)
        ? "failed"
        : "unavailable";
  const receiptWithoutDigest: Omit<SessionBoundVerificationResult, "receipt_sha256"> = {
    contract_id: SESSION_BOUND_VERIFICATION_CONTRACT_ID,
    schema_version: SESSION_BOUND_VERIFICATION_SCHEMA_VERSION,
    producer: { package: "nawabari", version: packageMetadata.version },
    session_id: request.session_id,
    profile: {
      ...profile.value,
      profile_sha256: sha256(canonicalJson(profile.value)),
    },
    source,
    verification: verification.verification,
    managed_execution: {
      supervisor: managed.supervisor,
      execution: managed.execution,
      effective_revision: managed.effective_revision,
      request_identity: managed.request_identity,
      ...(managed.owned_execution === undefined ? {} : { owned_execution: managed.owned_execution }),
    },
    execution_evidence: executionEvidence,
    final_snapshot: finalSnapshot,
    status,
  };
  try {
    return success({ ...receiptWithoutDigest, receipt_sha256: receiptDigest(receiptWithoutDigest) });
  } catch {
    return failure(
      new DomainError("INTERNAL_ERROR", "The verification receipt could not be canonically serialized.", {
        session_id: request.session_id,
      }),
    );
  }
}
