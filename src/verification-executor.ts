import { createHash } from "node:crypto";
import path from "node:path";

import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";
import {
  validateWorkingSetRuntimeProjection,
  type WorkingSetRuntimeProjection,
} from "./domain/working-set-runtime-projection.js";
import { validateFilesystemPolicyToken, type FilesystemPolicyToken } from "./domain/filesystem-policy-revision.js";
import { validateSessionRuntimeProjection, type SessionRuntimeProjection } from "./domain/runtime-projection.js";
import { runSandboxedCommand, type SandboxCommand, type SandboxExecutionResult } from "./domain/sandbox-launcher.js";
import type { SandboxExecutionRequest } from "./domain/sandbox.js";
import { captureGitSourceObservation, normalizeBranchId } from "./git.js";
import { isSessionId } from "./session-id.js";

/** Stable, transport-neutral verification profile identity. */
export const VERIFICATION_PROFILE_CONTRACT_ID = "nawabari.verification-profile.v1" as const;
export const VERIFICATION_PROFILE_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_RESULT_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_RESULT_SCHEMA = "verification-result.v1" as const;
export const SOURCE_BOUND_VERIFICATION_RESULT_CONTRACT_ID = "nawabari.verification-result.v2" as const;
export const SOURCE_BOUND_VERIFICATION_RESULT_SCHEMA_VERSION = 2 as const;
export const SOURCE_BOUND_VERIFICATION_RESULT_SCHEMA = "verification-result.v2" as const;
export const VERIFICATION_SOURCE_WITNESS_CONTRACT_ID = "nawabari.verification-source-witness.v1" as const;
export const VERIFICATION_SOURCE_WITNESS_SCHEMA_VERSION = 1 as const;

const SOURCE_HASH = /^[0-9a-f]{64}$/u;
const SOURCE_REVISION = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/iu;
const MAX_RUNTIME_IDENTITY_BYTES = 128 * 1_024;
const MAX_SOURCE_FILE_COUNT = 4_096;
const MAX_SOURCE_BYTE_COUNT = 64 * 1_024 * 1_024;

const MAX_PROFILE_ID_LENGTH = 128;
const MAX_PROFILE_VERSION_LENGTH = 64;
const MAX_EXECUTABLE_LENGTH = 1_024;
const MAX_ARGV_ENTRIES = 128;
const MAX_ARG_LENGTH = 4_096;
const MAX_READ_SELECTOR_LENGTH = 1_024;
const MAX_READ_SELECTORS = 2_048;
const MAX_TIMEOUT_MS = 15 * 60 * 1_000;
const MAX_OUTPUT_BYTES = 1_024 * 1_024;
const MAX_DIAGNOSTIC_CHARS = 4_096;
const MAX_DIAGNOSTIC_LINE_CHARS = 512;
const MAX_DIAGNOSTIC_LINES = 64;
const SAFE_TEXT = /^[^\u0000-\u001f\u007f]+$/u;
const SHELL_EXECUTABLES = new Set([
  "ash",
  "bash",
  "cmd",
  "command.com",
  "fish",
  "ksh",
  "powershell",
  "pwsh",
  "sh",
  "zsh",
]);

export type VerificationReadVisibility = "declared" | "repository";

/**
 * A trusted, fixed verification command.  `argv` contains arguments only;
 * shell source is deliberately not part of this contract.
 */
export type VerificationProfile = Readonly<{
  readonly contract_id: typeof VERIFICATION_PROFILE_CONTRACT_ID;
  readonly schema_version: typeof VERIFICATION_PROFILE_SCHEMA_VERSION;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly executable: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  readonly read_visibility: VerificationReadVisibility;
  readonly declared_read: readonly string[];
  /** Verification is read-only unless a future version explicitly changes this contract. */
  readonly write_policy: "deny";
  readonly timeout_ms: number;
  readonly max_output_bytes: number;
}>;

export type VerificationProfileInput = Partial<
  Pick<VerificationProfile, "contract_id" | "schema_version" | "declared_read" | "write_policy">
> &
  Omit<VerificationProfile, "contract_id" | "schema_version" | "declared_read" | "write_policy"> & {
    readonly contract_id?: string;
    readonly schema_version?: number;
    readonly declared_read?: readonly string[];
    readonly write_policy?: string;
  };

export type VerificationDiagnosticStream = Readonly<{
  readonly chars: number;
  readonly lines: number;
  readonly bytes: number;
  readonly sha256: string;
  readonly text: string;
  readonly truncated: boolean;
}>;

export type VerificationResult = Readonly<{
  readonly schema_version: typeof VERIFICATION_RESULT_SCHEMA_VERSION;
  readonly contract_id: typeof VERIFICATION_PROFILE_CONTRACT_ID;
  readonly profile_id: string;
  readonly profile_version: string;
  readonly status: "passed" | "failed" | "unavailable";
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly duration_ms: number | null;
  readonly stdout: VerificationDiagnosticStream;
  readonly stderr: VerificationDiagnosticStream;
  /** The verifier never returns an agent working-set revision or mutation. */
  readonly working_set_mutated: false;
}>;

/** Hash-only identity of the exact bounded inputs covered by verification. */
export type VerificationSourceWitness = Readonly<{
  readonly contract_id: typeof VERIFICATION_SOURCE_WITNESS_CONTRACT_ID;
  readonly schema_version: typeof VERIFICATION_SOURCE_WITNESS_SCHEMA_VERSION;
  readonly identity_sha256: string;
  readonly head_id: string;
  readonly base_id: string;
  readonly profile_sha256: string;
  readonly policy_sha256: string;
  readonly runtime_sha256: string;
  readonly source_sha256: string;
  readonly file_count: number;
  readonly byte_count: number;
}>;

export type SourceBoundVerificationResult = Readonly<{
  readonly schema_version: typeof SOURCE_BOUND_VERIFICATION_RESULT_SCHEMA_VERSION;
  readonly contract_id: typeof SOURCE_BOUND_VERIFICATION_RESULT_CONTRACT_ID;
  /** Effective status is unavailable whenever source provenance is unresolved. */
  readonly status: VerificationResult["status"];
  /** Existing v1 diagnostics/result semantics are retained without rewriting them. */
  readonly verification: VerificationResult;
  readonly source:
    | Readonly<{ readonly status: "proven"; readonly witness: VerificationSourceWitness }>
    | Readonly<{
        readonly status: "unresolved";
        readonly reason:
          | "policy-fence-unavailable"
          | "pre-observation-unavailable"
          | "post-observation-unavailable"
          | "source-changed";
      }>;
}>;

export type VerificationExecutorDependencies = Readonly<{
  /** Existing protected execution authority; injectable for deterministic tests. */
  readonly execute?: (
    request: SandboxExecutionRequest,
    command: SandboxCommand,
    options: { readonly timeout_ms: number; readonly max_output_bytes: number },
  ) => Promise<DomainResult<SandboxExecutionResult>>;
}>;

export type VerificationFilesystemPolicyFence = Readonly<{
  readonly policy_token: FilesystemPolicyToken;
  readonly expected_policy_token: FilesystemPolicyToken;
}>;

function invalid(field: string, reason: string): DomainResult<never> {
  return failure(
    new DomainError("INVALID_ARGUMENT", `Verification profile field '${field}' is invalid: ${reason}.`, { field }),
  );
}

function boundedText(value: unknown, field: string, maximum: number): DomainResult<string> {
  if (typeof value !== "string" || value.length === 0 || value.length > maximum || !SAFE_TEXT.test(value)) {
    return invalid(field, "expected bounded text without control characters");
  }
  return success(value.normalize("NFC"));
}

function positiveLimit(value: unknown, field: string, maximum: number): DomainResult<number> {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > maximum) {
    return invalid(field, `expected a positive integer no greater than ${maximum}`);
  }
  return success(value as number);
}

function validateExecutable(value: unknown): DomainResult<string> {
  const executable = boundedText(value, "executable", MAX_EXECUTABLE_LENGTH);
  if (!executable.ok) return executable;
  const basename = path.posix.basename(executable.value.replaceAll("\\", "/")).toLowerCase();
  if (SHELL_EXECUTABLES.has(basename)) return invalid("executable", "shell interpreters are not permitted");
  if (/\s/u.test(executable.value)) return invalid("executable", "whitespace is not permitted");
  return executable;
}

function validateCwd(value: unknown): DomainResult<string> {
  const cwd = boundedText(value, "cwd", MAX_EXECUTABLE_LENGTH);
  if (!cwd.ok) return cwd;
  if (!path.isAbsolute(cwd.value) || path.posix.normalize(cwd.value) !== cwd.value) {
    return invalid("cwd", "expected a normalized absolute path");
  }
  return cwd;
}

function validateArgv(value: unknown): DomainResult<readonly string[]> {
  if (!Array.isArray(value) || value.length > MAX_ARGV_ENTRIES) return invalid("argv", "expected a bounded array");
  const argv: string[] = [];
  for (const [index, argument] of value.entries()) {
    const parsed = boundedText(argument, `argv[${index}]`, MAX_ARG_LENGTH);
    if (!parsed.ok) return parsed;
    if ((index === 0 && (argument === "-c" || argument === "--command")) || argument === "-c") {
      return invalid(`argv[${index}]`, "shell command arguments are not permitted");
    }
    argv.push(parsed.value);
  }
  return success(Object.freeze(argv));
}

function validateReadSelectors(
  value: unknown,
  visibility: VerificationReadVisibility,
): DomainResult<readonly string[]> {
  if (value === undefined) return success(Object.freeze([]));
  if (!Array.isArray(value) || value.length > MAX_READ_SELECTORS) {
    return invalid("declared_read", "expected a bounded array");
  }
  const selectors: string[] = [];
  for (const [index, selector] of value.entries()) {
    const parsed = boundedText(selector, `declared_read[${index}]`, MAX_READ_SELECTOR_LENGTH);
    if (!parsed.ok) return parsed;
    const normalized = parsed.value.replaceAll("\\", "/");
    if (
      normalized.startsWith("/") ||
      normalized.includes("//") ||
      normalized.split("/").some((part) => part === "" || part === "." || part === "..")
    ) {
      return invalid(`declared_read[${index}]`, "expected a canonical repository-relative selector");
    }
    selectors.push(normalized);
  }
  if (visibility === "declared" && selectors.length === 0)
    return invalid("declared_read", "cannot be empty for declared visibility");
  return success(Object.freeze([...new Set(selectors)].sort()));
}

/** Validate and canonicalize a transport-neutral profile without filesystem access. */
export function validateVerificationProfile(input: unknown): DomainResult<VerificationProfile> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    return invalid("profile", "expected an object");
  const value = input as Record<string, unknown>;
  if (value.contract_id !== VERIFICATION_PROFILE_CONTRACT_ID) return invalid("contract_id", "unsupported contract");
  if (value.schema_version !== VERIFICATION_PROFILE_SCHEMA_VERSION)
    return invalid("schema_version", "unsupported version");
  const profileId = boundedText(value.profile_id, "profile_id", MAX_PROFILE_ID_LENGTH);
  if (!profileId.ok) return profileId;
  const profileVersion = boundedText(value.profile_version, "profile_version", MAX_PROFILE_VERSION_LENGTH);
  if (!profileVersion.ok) return profileVersion;
  const executable = validateExecutable(value.executable);
  if (!executable.ok) return executable;
  const argv = validateArgv(value.argv);
  if (!argv.ok) return argv;
  const cwd = validateCwd(value.cwd);
  if (!cwd.ok) return cwd;
  if (value.read_visibility !== "declared" && value.read_visibility !== "repository") {
    return invalid("read_visibility", "expected 'declared' or 'repository'");
  }
  const visibility = value.read_visibility as VerificationReadVisibility;
  const declaredRead = validateReadSelectors(value.declared_read, visibility);
  if (!declaredRead.ok) return declaredRead;
  if (value.write_policy !== "deny") return invalid("write_policy", "verification writes are default-deny");
  const timeout = positiveLimit(value.timeout_ms, "timeout_ms", MAX_TIMEOUT_MS);
  if (!timeout.ok) return timeout;
  const output = positiveLimit(value.max_output_bytes, "max_output_bytes", MAX_OUTPUT_BYTES);
  if (!output.ok) return output;
  return success(
    Object.freeze({
      contract_id: VERIFICATION_PROFILE_CONTRACT_ID,
      schema_version: VERIFICATION_PROFILE_SCHEMA_VERSION,
      profile_id: profileId.value,
      profile_version: profileVersion.value,
      executable: executable.value,
      argv: argv.value,
      cwd: cwd.value,
      read_visibility: visibility,
      declared_read: declaredRead.value,
      write_policy: "deny" as const,
      timeout_ms: timeout.value,
      max_output_bytes: output.value,
    }),
  );
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function streamDiagnostic(value: string, maxBytes: number): VerificationDiagnosticStream {
  const input = Buffer.from(value, "utf8");
  const bounded = input.subarray(0, maxBytes);
  const decoded = bounded
    .toString("utf8")
    .normalize("NFC")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "�");
  const lines = decoded.split(/\r?\n/u);
  const selected = lines.slice(0, MAX_DIAGNOSTIC_LINES).map((line) => line.slice(0, MAX_DIAGNOSTIC_LINE_CHARS));
  let text = selected.join("\n");
  let truncated = input.byteLength > bounded.byteLength || lines.length > MAX_DIAGNOSTIC_LINES;
  if (text.length > MAX_DIAGNOSTIC_CHARS) {
    text = text.slice(0, MAX_DIAGNOSTIC_CHARS - 1) + "…";
    truncated = true;
  }
  return Object.freeze({
    chars: text.length,
    lines: selected.length,
    bytes: input.byteLength,
    sha256: createHash("sha256").update(input).digest("hex"),
    text,
    truncated,
  });
}

function failureResult(profile: VerificationProfile, error: DomainError): VerificationResult {
  const diagnostic = streamDiagnostic(error.message, profile.max_output_bytes);
  return Object.freeze({
    schema_version: VERIFICATION_RESULT_SCHEMA_VERSION,
    contract_id: VERIFICATION_PROFILE_CONTRACT_ID,
    profile_id: profile.profile_id,
    profile_version: profile.profile_version,
    status: "unavailable",
    exit_code: null,
    signal: null,
    duration_ms: null,
    stdout: streamDiagnostic("", profile.max_output_bytes),
    stderr: diagnostic,
    working_set_mutated: false,
  });
}

function verificationScope(profile: VerificationProfile): WorkingSetRuntimeProjection["scope"] {
  return {
    readOnly: profile.read_visibility === "repository" ? ["**"] : profile.declared_read,
    write: [],
    create: [],
    delete: [],
    deny: [],
  };
}

/**
 * Derive the verifier's invocation-only working-set projection. The caller's
 * agent projection remains untouched; the existing launcher owns enforcement.
 */
function deriveVerificationRuntimeProjection(
  profile: VerificationProfile,
  request: SandboxExecutionRequest,
): DomainResult<SessionRuntimeProjection> {
  const runtimeProjection = request.runtime_projection;
  if (runtimeProjection === undefined) {
    return failure(
      new DomainError(
        "RUNTIME_PROJECTION_INVALID",
        "Verification requires an explicit runtime projection for protected execution.",
        { session_id: request.session_id },
      ),
    );
  }

  const workingSet = runtimeProjection.working_set;
  if (workingSet === undefined) {
    return failure(
      new DomainError("RUNTIME_PROJECTION_INVALID", "Verification requires a bounded working-set runtime projection.", {
        session_id: request.session_id,
      }),
    );
  }

  const projectedWorkingSet = validateWorkingSetRuntimeProjection({
    ...workingSet,
    scope: verificationScope(profile),
  });
  if (!projectedWorkingSet.ok) return failure(projectedWorkingSet.error);

  const projected = validateSessionRuntimeProjection({
    ...runtimeProjection,
    working_set: projectedWorkingSet.value,
  });
  if (!projected.ok) return failure(projected.error);
  return projected;
}

/**
 * Execute a trusted verification profile through the existing protected
 * launcher. The caller supplies an already-authoritative sandbox request;
 * this function does not consult or mutate session registry, claims, or
 * Effective Working Set state.
 */
export async function executeVerification(
  profileInput: unknown,
  request: SandboxExecutionRequest,
  dependencies: VerificationExecutorDependencies = {},
  filesystemPolicyFence?: VerificationFilesystemPolicyFence,
): Promise<DomainResult<VerificationResult>> {
  if (filesystemPolicyFence !== undefined) {
    const token = validateFilesystemPolicyToken(
      filesystemPolicyFence.policy_token,
      filesystemPolicyFence.expected_policy_token,
    );
    if (!token.ok) return token;
  }
  const profile = validateVerificationProfile(profileInput);
  if (!profile.ok) return profile;
  if (profile.value.cwd !== request.worktree && !isWithin(request.worktree, profile.value.cwd)) {
    return invalid("cwd", "must be within the authoritative session worktree");
  }
  if (!request.enforce) {
    return failure(new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", "Verification requires protected execution.", {}));
  }
  const verifierProjection = deriveVerificationRuntimeProjection(profile.value, request);
  if (!verifierProjection.ok) return verifierProjection;
  // This request is invocation-local. It never writes the verifier scope back
  // to the caller's agent Effective Working Set or session registry.
  const verifierRequest = { ...request, runtime_projection: verifierProjection.value };
  const command: SandboxCommand = { command: profile.value.executable, args: profile.value.argv };
  const execute =
    dependencies.execute ??
    ((sandboxRequest, sandboxCommand, options) => runSandboxedCommand(sandboxRequest, sandboxCommand, options));
  const result = await execute(verifierRequest, command, {
    timeout_ms: profile.value.timeout_ms,
    max_output_bytes: profile.value.max_output_bytes,
  });
  if (!result.ok) return success(failureResult(profile.value, result.error));
  const value = result.value;
  return success(
    Object.freeze({
      schema_version: VERIFICATION_RESULT_SCHEMA_VERSION,
      contract_id: VERIFICATION_PROFILE_CONTRACT_ID,
      profile_id: profile.value.profile_id,
      profile_version: profile.value.profile_version,
      status: value.exit_code === 0 ? "passed" : "failed",
      exit_code: value.exit_code,
      signal: value.signal,
      duration_ms: value.duration_ms,
      stdout: streamDiagnostic(value.stdout, profile.value.max_output_bytes),
      stderr: streamDiagnostic(value.stderr, profile.value.max_output_bytes),
      working_set_mutated: false,
    }),
  );
}

function stableJson(value: unknown): string {
  const visit = (current: unknown, ancestors: Set<object>): unknown => {
    if (current === null || typeof current === "string" || typeof current === "boolean") return current;
    if (typeof current === "number" && Number.isFinite(current)) return current;
    if (Array.isArray(current)) {
      if (ancestors.has(current)) throw new TypeError("cyclic source identity");
      ancestors.add(current);
      const result = current.map((entry) => visit(entry, ancestors));
      ancestors.delete(current);
      return result;
    }
    if (typeof current === "object") {
      if (ancestors.has(current)) throw new TypeError("cyclic source identity");
      ancestors.add(current);
      const record = current as Record<string, unknown>;
      const result: Record<string, unknown> = {};
      for (const key of Object.keys(record).sort()) result[key] = visit(record[key], ancestors);
      ancestors.delete(current);
      return result;
    }
    throw new TypeError("source identity is not bounded JSON data");
  };
  return JSON.stringify(visit(value, new Set()));
}

function digestJson(value: unknown, maximumBytes: number): string {
  const encoded = stableJson(value);
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) throw new RangeError("source identity exceeds its bound");
  return createHash("sha256").update(encoded, "utf8").digest("hex");
}

function sourceUnavailable(message: string): DomainError {
  return new DomainError("PHYSICAL_OBSERVATION_UNAVAILABLE", message, {});
}

/**
 * Capture the exact bounded verifier-visible source and the already-authoritative
 * session/policy/runtime inputs. Raw filesystem paths stay local and are folded
 * into identity hashes before this witness can cross a transport boundary.
 */
export function captureVerificationSourceWitness(
  profileInput: unknown,
  request: SandboxExecutionRequest,
  filesystemPolicyFence: VerificationFilesystemPolicyFence | undefined,
): DomainResult<VerificationSourceWitness> {
  const profile = validateVerificationProfile(profileInput);
  if (!profile.ok) return profile;
  if (filesystemPolicyFence === undefined) {
    return failure(sourceUnavailable("Verification source provenance requires a current filesystem-policy fence."));
  }
  const token = validateFilesystemPolicyToken(
    filesystemPolicyFence.policy_token,
    filesystemPolicyFence.expected_policy_token,
  );
  if (!token.ok) return token;
  if (!request.enforce || typeof request.session_id !== "string" || !isSessionId(request.session_id)) {
    return failure(sourceUnavailable("Verification source provenance requires an enforced, identified session."));
  }
  if (
    typeof request.worktree !== "string" ||
    !path.isAbsolute(request.worktree) ||
    path.resolve(request.worktree) !== request.worktree ||
    !path.isAbsolute(profile.value.cwd)
  ) {
    return failure(sourceUnavailable("Verification source provenance requires an absolute authoritative worktree."));
  }
  if (profile.value.cwd !== request.worktree && !isWithin(request.worktree, profile.value.cwd)) {
    return failure(sourceUnavailable("The verification profile is outside the authoritative worktree."));
  }
  const runtimeProjection = validateSessionRuntimeProjection(request.runtime_projection);
  if (!runtimeProjection.ok || runtimeProjection.value.working_set === undefined) {
    return failure(sourceUnavailable("Verification source provenance requires a bounded runtime working set."));
  }
  const workingSet = runtimeProjection.value.working_set;
  if (
    token.value.working_set_revision !== workingSet.revision ||
    (token.value.session_id !== undefined && token.value.session_id !== request.session_id)
  ) {
    return failure(sourceUnavailable("The current policy fence disagrees with the session working-set identity."));
  }
  if (typeof request.repository !== "string" || request.repository.length === 0 || typeof request.branch !== "string") {
    return failure(sourceUnavailable("Verification source provenance requires repository and branch identity."));
  }

  try {
    const source = captureGitSourceObservation({
      cwd: request.worktree,
      read_selectors: profile.value.read_visibility === "repository" ? ["**"] : profile.value.declared_read,
    });
    if (source.branch_id !== normalizeBranchId(request.branch)) {
      return failure(sourceUnavailable("The execution branch does not match the observed worktree branch."));
    }
    const runtimeIdentity = {
      projection: runtimeProjection.value,
      resolution: request.runtime_resolution ?? null,
      repository_filesystem: request.filesystem,
      network_mode: request.network_mode,
      required_capabilities: request.required_capabilities,
      sandbox_executable: request.sandbox_executable,
      landlock_executable: request.landlock_executable ?? null,
      landlock_abi: request.landlock_abi ?? null,
      landlock_state: request.landlock_state ?? null,
      landlock_required: request.landlock_required ?? null,
      seccomp_profile: request.seccomp_profile,
      capability_baseline: request.capability_baseline,
    };
    const identitySha256 = digestJson(
      {
        local_repository_id: source.repository_id,
        local_worktree_id: source.worktree_id,
        request_repository: request.repository,
        request_worktree: request.worktree,
        request_session_id: request.session_id,
        request_branch: request.branch,
        observed_branch_id: source.branch_id,
        working_set_repository: workingSet.repository,
        base_branch: workingSet.base.branch,
      },
      MAX_RUNTIME_IDENTITY_BYTES,
    );
    const witness: VerificationSourceWitness = Object.freeze({
      contract_id: VERIFICATION_SOURCE_WITNESS_CONTRACT_ID,
      schema_version: VERIFICATION_SOURCE_WITNESS_SCHEMA_VERSION,
      identity_sha256: identitySha256,
      head_id: source.head_id,
      base_id: workingSet.base.revision,
      profile_sha256: digestJson(profile.value, MAX_RUNTIME_IDENTITY_BYTES),
      policy_sha256: digestJson(token.value, MAX_RUNTIME_IDENTITY_BYTES),
      runtime_sha256: digestJson(runtimeIdentity, MAX_RUNTIME_IDENTITY_BYTES),
      source_sha256: source.source_sha256,
      file_count: source.file_count,
      byte_count: source.byte_count,
    });
    return success(witness);
  } catch {
    return failure(sourceUnavailable("The exact bounded verifier-visible source could not be observed."));
  }
}

/** Re-observe the source and accepted identity inputs without rerunning verification. */
export function isVerificationSourceWitnessCurrent(
  witnessInput: unknown,
  profileInput: unknown,
  request: SandboxExecutionRequest,
  filesystemPolicyFence: VerificationFilesystemPolicyFence | undefined,
): boolean {
  const witness = validateVerificationSourceWitness(witnessInput);
  if (!witness.ok) return false;
  const current = captureVerificationSourceWitness(profileInput, request, filesystemPolicyFence);
  return current.ok && stableJson(current.value) === stableJson(witness.value);
}

/** Execute only when the pre-execution witness is complete, then bind a second observation. */
export async function executeSourceBoundVerification(
  profileInput: unknown,
  request: SandboxExecutionRequest,
  filesystemPolicyFence: VerificationFilesystemPolicyFence | undefined,
  dependencies: VerificationExecutorDependencies = {},
): Promise<DomainResult<SourceBoundVerificationResult>> {
  const profile = validateVerificationProfile(profileInput);
  if (!profile.ok) return profile;
  const before = captureVerificationSourceWitness(profile.value, request, filesystemPolicyFence);
  if (!before.ok) {
    const result = failureResult(
      profile.value,
      sourceUnavailable("Verification did not run because its source could not be proven."),
    );
    return success(
      sourceBoundResult(result, {
        status: "unresolved",
        reason: filesystemPolicyFence === undefined ? "policy-fence-unavailable" : "pre-observation-unavailable",
      }),
    );
  }

  const executed = await executeVerification(profile.value, request, dependencies, filesystemPolicyFence);
  if (!executed.ok) return executed;
  const after = captureVerificationSourceWitness(profile.value, request, filesystemPolicyFence);
  if (!after.ok) {
    return success(sourceBoundResult(executed.value, { status: "unresolved", reason: "post-observation-unavailable" }));
  }
  if (stableJson(before.value) !== stableJson(after.value)) {
    return success(sourceBoundResult(executed.value, { status: "unresolved", reason: "source-changed" }));
  }
  return success(sourceBoundResult(executed.value, { status: "proven", witness: before.value }));
}

function sourceBoundResult(
  verification: VerificationResult,
  source: SourceBoundVerificationResult["source"],
): SourceBoundVerificationResult {
  return Object.freeze({
    schema_version: SOURCE_BOUND_VERIFICATION_RESULT_SCHEMA_VERSION,
    contract_id: SOURCE_BOUND_VERIFICATION_RESULT_CONTRACT_ID,
    status: source.status === "proven" ? verification.status : "unavailable",
    verification,
    source,
  });
}

/** Canonicalize and bound a source witness before evidence serialization. */
export function validateVerificationSourceWitness(input: unknown): DomainResult<VerificationSourceWitness> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return failure(new DomainError("INVALID_ARGUMENT", "Verification source witness must be an object.", {}));
  }
  const value = input as Record<string, unknown>;
  if (
    value.contract_id !== VERIFICATION_SOURCE_WITNESS_CONTRACT_ID ||
    value.schema_version !== VERIFICATION_SOURCE_WITNESS_SCHEMA_VERSION
  ) {
    return failure(new DomainError("INVALID_ARGUMENT", "Verification source witness contract is unsupported.", {}));
  }
  for (const field of [
    "identity_sha256",
    "profile_sha256",
    "policy_sha256",
    "runtime_sha256",
    "source_sha256",
  ] as const) {
    if (typeof value[field] !== "string" || !SOURCE_HASH.test(value[field] as string)) {
      return failure(new DomainError("INVALID_ARGUMENT", `Verification source witness '${field}' is invalid.`, {}));
    }
  }
  if (
    typeof value.head_id !== "string" ||
    !SOURCE_REVISION.test(value.head_id) ||
    typeof value.base_id !== "string" ||
    !SOURCE_REVISION.test(value.base_id)
  ) {
    return failure(new DomainError("INVALID_ARGUMENT", "Verification source witness revisions are invalid.", {}));
  }
  if (
    !Number.isSafeInteger(value.file_count) ||
    (value.file_count as number) < 0 ||
    (value.file_count as number) > MAX_SOURCE_FILE_COUNT ||
    !Number.isSafeInteger(value.byte_count) ||
    (value.byte_count as number) < 0 ||
    (value.byte_count as number) > MAX_SOURCE_BYTE_COUNT
  ) {
    return failure(new DomainError("INVALID_ARGUMENT", "Verification source witness bounds are invalid.", {}));
  }
  return success(
    Object.freeze({
      contract_id: VERIFICATION_SOURCE_WITNESS_CONTRACT_ID,
      schema_version: VERIFICATION_SOURCE_WITNESS_SCHEMA_VERSION,
      identity_sha256: value.identity_sha256 as string,
      head_id: value.head_id,
      base_id: value.base_id,
      profile_sha256: value.profile_sha256 as string,
      policy_sha256: value.policy_sha256 as string,
      runtime_sha256: value.runtime_sha256 as string,
      source_sha256: value.source_sha256 as string,
      file_count: value.file_count as number,
      byte_count: value.byte_count as number,
    }),
  );
}

export const runVerification = executeVerification;
