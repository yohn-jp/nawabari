import { createHash } from "node:crypto";

import type { CheckpointEvidence, GitCheckpointPaths } from "../operation-authorization.js";
import {
  executeVerification,
  VERIFICATION_PROFILE_CONTRACT_ID,
  VERIFICATION_RESULT_SCHEMA_VERSION,
  type VerificationDiagnosticStream,
  type VerificationExecutorDependencies,
  type VerificationResult,
} from "../verification-executor.js";
import type { SandboxExecutionRequest } from "./sandbox.js";
import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";

/** Versioned identity for the bounded policy consumed by this leaf. */
export const FILESYSTEM_POLICY_CONTRACT_ID = "nawabari.filesystem-policy.v1" as const;
export const FILESYSTEM_POLICY_SCHEMA_VERSION = 1 as const;

/** Versioned identity for Git-observable policy evidence. */
export const FILESYSTEM_POLICY_EVIDENCE_CONTRACT_ID = "nawabari.filesystem-policy-evidence.v1" as const;
export const FILESYSTEM_POLICY_EVIDENCE_SCHEMA_VERSION = 1 as const;

/** Versioned identity for the serialized verifier envelope. */
export const VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID = "nawabari.verification-execution-evidence.v1" as const;
export const VERIFICATION_EXECUTION_EVIDENCE_SCHEMA_VERSION = 1 as const;

const MAX_TEXT = 1_024;
const MAX_POLICY_ID = 256;
const MAX_PATHS = 4_096;
const MAX_DIAGNOSTICS = 256;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const HEX_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;

export type FilesystemPolicyScope = Readonly<{
  readonly readOnly: readonly string[];
  readonly write: readonly string[];
  readonly create: readonly string[];
  readonly delete: readonly string[];
  readonly deny: readonly string[];
}>;

/**
 * The policy is a factual input to this producer.  It is deliberately not a
 * registry or a second working-set authority.  `revision` is the exact
 * execution-policy revision whose scope was used for the observation.
 */
export type FilesystemPolicy = Readonly<{
  readonly contract_id: typeof FILESYSTEM_POLICY_CONTRACT_ID;
  readonly schema_version: typeof FILESYSTEM_POLICY_SCHEMA_VERSION;
  readonly policy_id: string;
  readonly revision: number;
  readonly scope: FilesystemPolicyScope;
}>;

export type FilesystemPolicyInput = FilesystemPolicy;

export type FilesystemPolicyCheckpoint = CheckpointEvidence &
  Readonly<{
    /** False means the observation is not sufficient for a clean result. */
    readonly observation_complete?: boolean;
    readonly incomplete_reasons?: readonly string[];
    /** Optional provenance supplied by a caller that captured policy identity. */
    readonly policy_id?: string;
    readonly policy_revision?: number;
  }>;

export type PolicyMutationKind = "create" | "write_or_delete" | "unknown";
export type PolicyPathStatus = "allowed" | "denied" | "unresolved";
export type ClaimPathStatus = "in_claim" | "out_of_claim" | "unresolved";

export type FilesystemPolicyPathEvidence = Readonly<{
  readonly path: string;
  readonly status: PolicyPathStatus;
  readonly claim_status: ClaimPathStatus;
  readonly mutation: PolicyMutationKind;
  readonly reason:
    | "allowed-create"
    | "allowed-write-or-delete"
    | "denied-by-policy"
    | "create-not-authorized"
    | "mutation-not-authorized"
    | "observation-incomplete";
}>;

export type FilesystemPolicyViolation = Readonly<{
  readonly path: string;
  readonly code: "OUT_OF_POLICY";
  readonly reason: Exclude<FilesystemPolicyPathEvidence["reason"], "allowed-create" | "allowed-write-or-delete">;
  readonly claim_status: ClaimPathStatus;
}>;

export type FilesystemPolicyEvidence = Readonly<{
  readonly contract_id: typeof FILESYSTEM_POLICY_EVIDENCE_CONTRACT_ID;
  readonly schema_version: typeof FILESYSTEM_POLICY_EVIDENCE_SCHEMA_VERSION;
  readonly source: "git-checkpoint";
  readonly guarantee: "git-observable-only";
  /** This is a point-in-time observation, never an atomic filesystem snapshot. */
  readonly observation: Readonly<{
    readonly point_in_time: true;
    readonly atomic: false;
    readonly complete: boolean;
    readonly incomplete_reasons: readonly string[];
  }>;
  readonly checkpoint: Readonly<{
    readonly repository_id: string;
    readonly worktree_path: string;
    readonly branch_name: string;
    readonly head_id: string;
    readonly session_id: string;
  }>;
  readonly policy: Readonly<{
    readonly policy_id: string;
    readonly revision: number;
  }>;
  /** The Git changed set is evidence; it is not an inferred file-read set. */
  readonly paths: GitCheckpointPaths;
  /** Claim ownership and policy authorization remain separate dimensions. */
  readonly entries: readonly FilesystemPolicyPathEvidence[];
  readonly in_claim: readonly string[];
  readonly out_of_claim: readonly string[];
  readonly allowed: readonly string[];
  readonly denied: readonly string[];
  readonly unresolved: readonly string[];
  readonly violations: readonly FilesystemPolicyViolation[];
  readonly complete: boolean;
  readonly evidence_hash: string;
}>;

export type VerificationExecutionEvidence = Readonly<{
  readonly schema_version: typeof VERIFICATION_EXECUTION_EVIDENCE_SCHEMA_VERSION;
  readonly contract_id: typeof VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID;
  /** The verifier result is nested under the explicit serialization key. */
  readonly verification: VerificationResult;
}>;

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("INVALID_ARGUMENT", `Filesystem policy evidence field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function boundedText(value: unknown, field: string, maximum = MAX_TEXT): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !SAFE_TEXT.test(value)) {
    return invalid(field, "expected bounded text without control characters");
  }
  return success(value.normalize("NFC"));
}

function positiveRevision(value: unknown, field: string): DomainResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 1) return invalid(field, "expected a positive integer");
  return success(value as number);
}

function selector(value: unknown, field: string): DomainResult<string> {
  const text = boundedText(value, field);
  if (!text.ok) return text;
  const normalized = text.value.replaceAll("\\", "/");
  if (
    normalized.startsWith("/") ||
    normalized.includes("//") ||
    normalized.split("/").some((part) => part.length === 0 || part === "." || part === "..")
  ) {
    return invalid(field, "expected a canonical repository-relative selector", normalized);
  }
  return success(normalized);
}

function concretePath(value: unknown, field: string): DomainResult<string> {
  const result = selector(value, field);
  if (!result.ok) return result;
  if (result.value.includes("*") || result.value.includes("?")) {
    return invalid(field, "observed paths must be concrete and cannot contain glob wildcards", result.value);
  }
  return result;
}

function pathList(value: unknown, field: string, concrete = false): DomainResult<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_PATHS) return invalid(field, "expected a bounded array");
  const values: string[] = [];
  for (const [index, item] of value.entries()) {
    const parsed = concrete ? concretePath(item, `${field}[${index}]`) : selector(item, `${field}[${index}]`);
    if (!parsed.ok) return parsed;
    values.push(parsed.value);
  }
  if (new Set(values).size !== values.length) return invalid(field, "contains duplicate paths");
  return success(Object.freeze([...values].sort(compareText)));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function scope(value: unknown): DomainResult<FilesystemPolicyScope> {
  if (!isRecord(value)) return invalid("scope", "expected an object");
  const output = {} as Record<keyof FilesystemPolicyScope, readonly string[]>;
  for (const key of ["readOnly", "write", "create", "delete", "deny"] as const) {
    const parsed = pathList(value[key], `scope.${key}`);
    if (!parsed.ok) return parsed;
    output[key] = parsed.value;
  }
  return success(Object.freeze(output));
}

/** Validate and canonicalize the bounded execution policy without I/O. */
export function validateFilesystemPolicy(input: unknown): DomainResult<FilesystemPolicy> {
  if (!isRecord(input)) return invalid("policy", "expected an object");
  if (input.contract_id !== FILESYSTEM_POLICY_CONTRACT_ID) return invalid("contract_id", "unsupported contract");
  if (input.schema_version !== FILESYSTEM_POLICY_SCHEMA_VERSION)
    return invalid("schema_version", "unsupported schema version");
  const id = boundedText(input.policy_id, "policy_id", MAX_POLICY_ID);
  if (!id.ok) return id;
  const revision = positiveRevision(input.revision, "revision");
  if (!revision.ok) return revision;
  const policyScope = scope(input.scope);
  if (!policyScope.ok) return policyScope;
  return success(
    Object.freeze({
      contract_id: FILESYSTEM_POLICY_CONTRACT_ID,
      schema_version: FILESYSTEM_POLICY_SCHEMA_VERSION,
      policy_id: id.value,
      revision: revision.value,
      scope: policyScope.value,
    }),
  );
}

function normalizeCheckpoint(input: unknown): DomainResult<FilesystemPolicyCheckpoint> {
  if (!isRecord(input)) return invalid("checkpoint", "expected an object");
  if (input.schemaVersion !== 1) return invalid("checkpoint.schemaVersion", "unsupported schema version");
  if (input.source !== "git") return invalid("checkpoint.source", "expected Git evidence");
  if (input.guarantee !== "git-observable-only") return invalid("checkpoint.guarantee", "unsupported guarantee");
  const repositoryId = boundedText(input.repositoryId, "checkpoint.repositoryId");
  if (!repositoryId.ok) return repositoryId;
  const worktreePath = boundedText(input.worktreePath, "checkpoint.worktreePath");
  if (!worktreePath.ok) return worktreePath;
  const branchName = boundedText(input.branchName, "checkpoint.branchName");
  if (!branchName.ok) return branchName;
  const headId = boundedText(input.headId, "checkpoint.headId", 128);
  if (!headId.ok) return headId;
  if (!HEX_REVISION.test(headId.value)) return invalid("checkpoint.headId", "expected an immutable Git revision");
  const sessionId = boundedText(input.sessionId, "checkpoint.sessionId");
  if (!sessionId.ok) return sessionId;
  if (!isRecord(input.paths)) return invalid("checkpoint.paths", "expected path evidence");
  const paths: Record<keyof GitCheckpointPaths, readonly string[]> = {} as Record<
    keyof GitCheckpointPaths,
    readonly string[]
  >;
  for (const key of ["changed", "staged", "unstaged", "untracked"] as const) {
    const parsed = pathList(input.paths[key], `checkpoint.paths.${key}`, true);
    if (!parsed.ok) return parsed;
    paths[key] = parsed.value;
  }
  const changed = new Set(paths.changed);
  for (const key of ["staged", "unstaged", "untracked"] as const) {
    for (const item of paths[key]) {
      if (!changed.has(item)) return invalid(`checkpoint.paths.${key}`, "contains a path absent from changed");
    }
  }
  const inClaim = pathList(input.inClaim, "checkpoint.inClaim", true);
  if (!inClaim.ok) return inClaim;
  const outOfClaim = pathList(input.outOfClaim, "checkpoint.outOfClaim", true);
  if (!outOfClaim.ok) return outOfClaim;
  const inSet = new Set(inClaim.value);
  const outSet = new Set(outOfClaim.value);
  for (const pathValue of inSet) {
    if (!changed.has(pathValue)) return invalid("checkpoint.inClaim", "contains a path absent from changed");
    if (outSet.has(pathValue)) return invalid("checkpoint.claim", "a path cannot be both in and out of claim");
  }
  for (const pathValue of outSet) {
    if (!changed.has(pathValue)) return invalid("checkpoint.outOfClaim", "contains a path absent from changed");
  }
  if (input.maxPaths !== 4_096) return invalid("checkpoint.maxPaths", "must use the canonical checkpoint bound");
  const complete = input.observation_complete === undefined || input.observation_complete === true;
  if (input.observation_complete !== undefined && typeof input.observation_complete !== "boolean")
    return invalid("checkpoint.observation_complete", "expected a boolean");
  const incompleteReasons: string[] = [];
  if (Array.isArray(input.incomplete_reasons)) {
    if (input.incomplete_reasons.length > MAX_DIAGNOSTICS)
      return invalid("checkpoint.incomplete_reasons", "too many reasons");
    for (const [index, reason] of input.incomplete_reasons.entries()) {
      const parsed = boundedText(reason, `checkpoint.incomplete_reasons[${index}]`);
      if (!parsed.ok) return parsed;
      incompleteReasons.push(parsed.value);
    }
  } else if (input.incomplete_reasons !== undefined) {
    return invalid("checkpoint.incomplete_reasons", "expected an array");
  }
  if (!complete && incompleteReasons.length === 0) incompleteReasons.push("checkpoint observation is incomplete");
  const policyId = input.policy_id === undefined ? undefined : boundedText(input.policy_id, "checkpoint.policy_id");
  if (policyId !== undefined && !policyId.ok) return policyId;
  const policyRevision =
    input.policy_revision === undefined
      ? undefined
      : positiveRevision(input.policy_revision, "checkpoint.policy_revision");
  if (policyRevision !== undefined && !policyRevision.ok) return policyRevision;
  return success(
    Object.freeze({
      schemaVersion: 1 as const,
      source: "git" as const,
      guarantee: "git-observable-only" as const,
      repositoryId: repositoryId.value,
      worktreePath: worktreePath.value,
      branchName: branchName.value,
      headId: headId.value,
      sessionId: sessionId.value,
      paths: Object.freeze(paths),
      inClaim: inClaim.value,
      outOfClaim: outOfClaim.value,
      maxPaths: 4_096 as const,
      observation_complete: complete,
      incomplete_reasons: Object.freeze([...new Set(incompleteReasons)].sort(compareText)),
      ...(policyId === undefined ? {} : { policy_id: policyId.value }),
      ...(policyRevision === undefined ? {} : { policy_revision: policyRevision.value }),
    }),
  );
}

function globRegex(selectorValue: string): RegExp {
  let expression = "^";
  for (let index = 0; index < selectorValue.length; index += 1) {
    const character = selectorValue[index];
    if (character === "*" && selectorValue[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  }
  return new RegExp(`${expression}$`, "u");
}

function matches(selectors: readonly string[], pathValue: string): boolean {
  return selectors.some((selectorValue) => globRegex(selectorValue).test(pathValue));
}

function claimStatus(checkpoint: FilesystemPolicyCheckpoint, pathValue: string): ClaimPathStatus {
  if (checkpoint.inClaim.includes(pathValue)) return "in_claim";
  if (checkpoint.outOfClaim.includes(pathValue)) return "out_of_claim";
  return "unresolved";
}

function stableClone(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableClone);
  if (isRecord(value)) {
    const output: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort(compareText)) output[key] = stableClone(value[key]);
    return output;
  }
  return value;
}

function evidenceHash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(stableClone(value)))
    .digest("hex");
}

function policyPathEvidence(
  pathValue: string,
  checkpoint: FilesystemPolicyCheckpoint,
  policy: FilesystemPolicy,
): FilesystemPolicyPathEvidence {
  const claim = claimStatus(checkpoint, pathValue);
  const mutation: PolicyMutationKind = checkpoint.paths.untracked.includes(pathValue) ? "create" : "write_or_delete";
  if (checkpoint.observation_complete === false) {
    return Object.freeze({
      path: pathValue,
      status: "unresolved",
      claim_status: claim,
      mutation,
      reason: "observation-incomplete",
    });
  }
  if (matches(policy.scope.deny, pathValue)) {
    return Object.freeze({
      path: pathValue,
      status: "denied",
      claim_status: claim,
      mutation,
      reason: "denied-by-policy",
    });
  }
  if (mutation === "create") {
    if (matches(policy.scope.create, pathValue)) {
      return Object.freeze({
        path: pathValue,
        status: "allowed",
        claim_status: claim,
        mutation,
        reason: "allowed-create",
      });
    }
    return Object.freeze({
      path: pathValue,
      status: "denied",
      claim_status: claim,
      mutation,
      reason: "create-not-authorized",
    });
  }
  if (matches(policy.scope.write, pathValue) || matches(policy.scope.delete, pathValue)) {
    return Object.freeze({
      path: pathValue,
      status: "allowed",
      claim_status: claim,
      mutation,
      reason: "allowed-write-or-delete",
    });
  }
  return Object.freeze({
    path: pathValue,
    status: "denied",
    claim_status: claim,
    mutation,
    reason: "mutation-not-authorized",
  });
}

/**
 * Project one Git checkpoint against the exact policy revision used for the
 * execution.  The result is diagnostic evidence only: it never expands
 * claims, changes an EWS, or turns a mutation into an authorization.
 */
export function projectFilesystemPolicyEvidence(
  checkpointInput: unknown,
  policyInput: unknown,
): DomainResult<FilesystemPolicyEvidence> {
  const checkpoint = normalizeCheckpoint(checkpointInput);
  if (!checkpoint.ok) return checkpoint;
  const policy = validateFilesystemPolicy(policyInput);
  if (!policy.ok) return policy;
  if (checkpoint.value.policy_id !== undefined && checkpoint.value.policy_id !== policy.value.policy_id) {
    return failure(
      new DomainError("GIT_STATE_AMBIGUOUS", "Checkpoint policy identity does not match the execution policy.", {
        checkpoint_policy_id: checkpoint.value.policy_id,
        policy_id: policy.value.policy_id,
      }),
    );
  }
  if (checkpoint.value.policy_revision !== undefined && checkpoint.value.policy_revision !== policy.value.revision) {
    return failure(
      new DomainError("GIT_STATE_AMBIGUOUS", "Checkpoint policy revision is stale for the execution policy.", {
        checkpoint_policy_revision: checkpoint.value.policy_revision,
        policy_revision: policy.value.revision,
      }),
    );
  }

  const entries = checkpoint.value.paths.changed.map((pathValue) =>
    policyPathEvidence(pathValue, checkpoint.value, policy.value),
  );
  const allowed = entries.filter((entry) => entry.status === "allowed").map((entry) => entry.path);
  const denied = entries.filter((entry) => entry.status === "denied").map((entry) => entry.path);
  const unresolved = entries.filter((entry) => entry.status === "unresolved").map((entry) => entry.path);
  const violations = entries
    .filter((entry): entry is FilesystemPolicyPathEvidence & { readonly status: "denied" } => entry.status === "denied")
    .map((entry) =>
      Object.freeze({
        path: entry.path,
        code: "OUT_OF_POLICY" as const,
        reason: entry.reason as FilesystemPolicyViolation["reason"],
        claim_status: entry.claim_status,
      }),
    );
  const observation = Object.freeze({
    point_in_time: true as const,
    atomic: false as const,
    complete: checkpoint.value.observation_complete ?? true,
    incomplete_reasons: checkpoint.value.incomplete_reasons ?? [],
  });
  const withoutHash = {
    contract_id: FILESYSTEM_POLICY_EVIDENCE_CONTRACT_ID,
    schema_version: FILESYSTEM_POLICY_EVIDENCE_SCHEMA_VERSION,
    source: "git-checkpoint" as const,
    guarantee: "git-observable-only" as const,
    observation,
    checkpoint: Object.freeze({
      repository_id: checkpoint.value.repositoryId,
      worktree_path: checkpoint.value.worktreePath,
      branch_name: checkpoint.value.branchName,
      head_id: checkpoint.value.headId,
      session_id: checkpoint.value.sessionId,
    }),
    policy: Object.freeze({ policy_id: policy.value.policy_id, revision: policy.value.revision }),
    paths: checkpoint.value.paths,
    entries: Object.freeze(entries),
    in_claim: checkpoint.value.inClaim,
    out_of_claim: checkpoint.value.outOfClaim,
    allowed: Object.freeze(allowed),
    denied: Object.freeze(denied),
    unresolved: Object.freeze(unresolved),
    violations: Object.freeze(violations),
    complete: observation.complete && unresolved.length === 0,
  };
  return success(Object.freeze({ ...withoutHash, evidence_hash: evidenceHash(withoutHash) }));
}

export const assessFilesystemPolicyEvidence = projectFilesystemPolicyEvidence;

/** Serialize only an already projected, deterministic evidence artifact. */
export function serializeFilesystemPolicyEvidence(input: unknown): DomainResult<string> {
  if (!isRecord(input)) return invalid("evidence", "expected an object");
  if (input.contract_id !== FILESYSTEM_POLICY_EVIDENCE_CONTRACT_ID)
    return invalid("evidence.contract_id", "unsupported contract");
  if (input.schema_version !== FILESYSTEM_POLICY_EVIDENCE_SCHEMA_VERSION)
    return invalid("evidence.schema_version", "unsupported schema version");
  if (typeof input.evidence_hash !== "string" || !/^[0-9a-f]{64}$/u.test(input.evidence_hash))
    return invalid("evidence.evidence_hash", "expected a SHA-256 digest");
  try {
    return success(JSON.stringify(input));
  } catch {
    return invalid("evidence", "could not serialize the bounded artifact");
  }
}

function validateDiagnosticStream(value: unknown, field: string): DomainResult<VerificationDiagnosticStream> {
  if (!isRecord(value)) return invalid(field, "expected a diagnostic stream");
  const nonNegative = (candidate: unknown, name: string): DomainResult<number> => {
    if (!Number.isSafeInteger(candidate) || (candidate as number) < 0)
      return invalid(name, "expected a non-negative integer");
    return success(candidate as number);
  };
  const chars = nonNegative(value.chars, `${field}.chars`);
  if (!chars.ok) return chars;
  const lines = nonNegative(value.lines, `${field}.lines`);
  if (!lines.ok) return lines;
  const bytes = nonNegative(value.bytes, `${field}.bytes`);
  if (!bytes.ok) return bytes;
  if (
    typeof value.text !== "string" ||
    value.text.length > 4_096 ||
    (value.text.length > 0 && !SAFE_TEXT.test(value.text))
  )
    return invalid(`${field}.text`, "expected bounded text without control characters");
  if (typeof value.sha256 !== "string" || !/^[0-9a-f]{64}$/u.test(value.sha256))
    return invalid(`${field}.sha256`, "expected a SHA-256 digest");
  if (typeof value.truncated !== "boolean") return invalid(`${field}.truncated`, "expected a boolean");
  return success(
    Object.freeze({
      chars: chars.value,
      lines: lines.value,
      bytes: bytes.value,
      sha256: value.sha256,
      text: value.text,
      truncated: value.truncated,
    }),
  );
}

function validateVerificationResult(input: unknown): DomainResult<VerificationResult> {
  if (!isRecord(input)) return invalid("verification", "expected a result object");
  if (input.schema_version !== VERIFICATION_RESULT_SCHEMA_VERSION)
    return invalid("verification.schema_version", "unsupported schema version");
  if (input.contract_id !== VERIFICATION_PROFILE_CONTRACT_ID)
    return invalid("verification.contract_id", "unsupported contract");
  const profileId = boundedText(input.profile_id, "verification.profile_id");
  if (!profileId.ok) return profileId;
  const profileVersion = boundedText(input.profile_version, "verification.profile_version");
  if (!profileVersion.ok) return profileVersion;
  if (!(input.status === "passed" || input.status === "failed" || input.status === "unavailable"))
    return invalid("verification.status", "unsupported status");
  if (input.exit_code !== null && !Number.isSafeInteger(input.exit_code))
    return invalid("verification.exit_code", "expected an integer or null");
  if (input.signal !== null && typeof input.signal !== "string")
    return invalid("verification.signal", "expected text or null");
  if (input.duration_ms !== null && (!Number.isSafeInteger(input.duration_ms) || (input.duration_ms as number) < 0))
    return invalid("verification.duration_ms", "expected a non-negative integer or null");
  if (input.working_set_mutated !== false)
    return invalid("verification.working_set_mutated", "verification cannot mutate the agent working set");
  const stdout = validateDiagnosticStream(input.stdout, "verification.stdout");
  if (!stdout.ok) return stdout;
  const stderr = validateDiagnosticStream(input.stderr, "verification.stderr");
  if (!stderr.ok) return stderr;
  return success(
    Object.freeze({
      schema_version: VERIFICATION_RESULT_SCHEMA_VERSION,
      contract_id: VERIFICATION_PROFILE_CONTRACT_ID,
      profile_id: profileId.value,
      profile_version: profileVersion.value,
      status: input.status,
      exit_code: input.exit_code as number | null,
      signal: input.signal,
      duration_ms: input.duration_ms as number | null,
      stdout: stdout.value,
      stderr: stderr.value,
      working_set_mutated: false as const,
    }),
  );
}

/**
 * The verification authority delegates to the existing protected executor.
 * It owns no session, claim, or agent-EWS state and cannot widen the caller's
 * projection.  This class exists so evidence composition can depend on an
 * explicit authority without making verifier access part of policy evidence.
 */
export class VerificationExecutionAuthority {
  readonly authority = "nawabari.verification-execution-authority.v1" as const;
  readonly #dependencies: VerificationExecutorDependencies;

  public constructor(dependencies: VerificationExecutorDependencies = {}) {
    this.#dependencies = dependencies;
  }

  public execute(profile: unknown, request: SandboxExecutionRequest): Promise<DomainResult<VerificationResult>> {
    return executeVerification(profile, request, this.#dependencies);
  }

  public async executeEvidence(
    profile: unknown,
    request: SandboxExecutionRequest,
  ): Promise<DomainResult<VerificationExecutionEvidence>> {
    const result = await this.execute(profile, request);
    if (!result.ok) return result;
    return success(
      Object.freeze({
        schema_version: VERIFICATION_EXECUTION_EVIDENCE_SCHEMA_VERSION,
        contract_id: VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID,
        verification: result.value,
      }),
    );
  }
}

/** Serialize a verifier result only under the canonical `verification` key. */
export function serializeVerificationExecutionEvidence(input: unknown): DomainResult<string> {
  if (!isRecord(input)) return invalid("verification_evidence", "expected an object");
  if (input.schema_version !== VERIFICATION_EXECUTION_EVIDENCE_SCHEMA_VERSION)
    return invalid("verification_evidence.schema_version", "unsupported schema version");
  if (input.contract_id !== VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID)
    return invalid("verification_evidence.contract_id", "unsupported contract");
  const verification = validateVerificationResult(input.verification);
  if (!verification.ok) return verification;
  return success(
    JSON.stringify({
      schema_version: VERIFICATION_EXECUTION_EVIDENCE_SCHEMA_VERSION,
      contract_id: VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID,
      verification: verification.value,
    }),
  );
}

export const VERIFICATION_EXECUTION_EVIDENCE_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: VERIFICATION_EXECUTION_EVIDENCE_CONTRACT_ID,
  schema_version: VERIFICATION_EXECUTION_EVIDENCE_SCHEMA_VERSION,
  key: "verification",
  authority: "nawabari.verification-execution-authority.v1",
  mutates_working_set: false,
  protected_execution_required: true,
});
