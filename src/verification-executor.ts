import { createHash } from "node:crypto";
import path from "node:path";

import { DomainError, failure, success, type DomainResult } from "./domain/errors.js";
import {
  validateWorkingSetRuntimeProjection,
  type WorkingSetRuntimeProjection,
} from "./domain/working-set-runtime-projection.js";
import { validateSessionRuntimeProjection, type SessionRuntimeProjection } from "./domain/runtime-projection.js";
import { runSandboxedCommand, type SandboxCommand, type SandboxExecutionResult } from "./domain/sandbox-launcher.js";
import type { SandboxExecutionRequest } from "./domain/sandbox.js";

/** Stable, transport-neutral verification profile identity. */
export const VERIFICATION_PROFILE_CONTRACT_ID = "nawabari.verification-profile.v1" as const;
export const VERIFICATION_PROFILE_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_RESULT_SCHEMA_VERSION = 1 as const;
export const VERIFICATION_RESULT_SCHEMA = "verification-result.v1" as const;

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

export type VerificationExecutorDependencies = Readonly<{
  /** Existing protected execution authority; injectable for deterministic tests. */
  readonly execute?: (
    request: SandboxExecutionRequest,
    command: SandboxCommand,
    options: { readonly timeout_ms: number; readonly max_output_bytes: number },
  ) => Promise<DomainResult<SandboxExecutionResult>>;
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

  const {
    filesystem_policy: _filesystemPolicy,
    auxiliary_state: _auxiliaryState,
    ...verificationBase
  } = runtimeProjection;
  const projected = validateSessionRuntimeProjection({
    ...verificationBase,
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
): Promise<DomainResult<VerificationResult>> {
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
  const verifierRequest = {
    ...request,
    runtime_projection: verifierProjection.value,
    // Verification receives its own read-only projection. The agent's
    // materialized enforcement plan must never widen that invocation-local
    // authority.
    filesystem_policy: undefined,
    auxiliary_state: undefined,
  };
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

export const runVerification = executeVerification;
