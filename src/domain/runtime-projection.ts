import { posix } from "node:path";

import { DomainError, failure, success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";

/** Versioned identity for the Session Runtime Projection domain contract. */
export const SESSION_RUNTIME_PROJECTION_CONTRACT_ID = "nawabari.session-runtime-projection.v1" as const;
export const SESSION_RUNTIME_PROJECTION_SCHEMA_VERSION = 1 as const;

export const RUNTIME_POLICY_MODES = Object.freeze(["strict", "compatibility"] as const);
export const RUNTIME_FILESYSTEM_ACCESS_MODES = Object.freeze(["read-only", "read-write"] as const);
export const RUNTIME_PROJECTION_PROVENANCES = Object.freeze([
  "session",
  "runtime-profile",
  "package",
  "compatibility",
] as const);

export type RuntimePolicyMode = (typeof RUNTIME_POLICY_MODES)[number];
export type RuntimeFilesystemAccessMode = (typeof RUNTIME_FILESYSTEM_ACCESS_MODES)[number];
export type RuntimeProjectionProvenance = (typeof RUNTIME_PROJECTION_PROVENANCES)[number];

/** Strict policy has no host fallback field that can be silently enabled. */
export type StrictRuntimePolicy = Readonly<{
  readonly mode: "strict";
  readonly host_visibility: "default-deny";
  readonly compatibility: "disabled";
  readonly unrestricted_host_fallback: "forbidden";
}>;

/** Compatibility is an explicit policy selection, never an omitted default. */
export type ExplicitCompatibilityRuntimePolicy = Readonly<{
  readonly mode: "compatibility";
  readonly host_visibility: "explicit";
  readonly compatibility: "explicit";
  readonly unrestricted_host_fallback: "explicit-only";
}>;

export type RuntimePolicy = StrictRuntimePolicy | ExplicitCompatibilityRuntimePolicy;

export const STRICT_RUNTIME_POLICY: StrictRuntimePolicy = Object.freeze({
  mode: "strict",
  host_visibility: "default-deny",
  compatibility: "disabled",
  unrestricted_host_fallback: "forbidden",
});

/** The default policy is strict; compatibility requires this separate value. */
export const DEFAULT_RUNTIME_POLICY = STRICT_RUNTIME_POLICY;

export const EXPLICIT_COMPATIBILITY_RUNTIME_POLICY: ExplicitCompatibilityRuntimePolicy = Object.freeze({
  mode: "compatibility",
  host_visibility: "explicit",
  compatibility: "explicit",
  unrestricted_host_fallback: "explicit-only",
});

export type RuntimeProfileIdentity = Readonly<{
  /** Stable identity of the materialized runtime profile, not an executable alias. */
  readonly id: string;
  readonly version: string;
}>;

export type RuntimeRequirementKind = "runtime" | "package";

export type RuntimeRequirement = Readonly<{
  readonly id: string;
  readonly kind: RuntimeRequirementKind;
  readonly name: string;
  readonly version: string;
}>;

export type RuntimeFilesystemProjection = Readonly<{
  /** Host/materialization source path. */
  readonly source: string;
  /** Path visible inside the protected runtime. */
  readonly target: string;
  readonly access_mode: RuntimeFilesystemAccessMode;
  readonly provenance: RuntimeProjectionProvenance;
}>;

/** Provider identity is intentionally abstract; concrete tools are not domain vocabulary. */
export type RuntimeExecutableProvider = Readonly<{
  readonly id: string;
  readonly requirement_id: string;
}>;

export type ProjectedExecutableEntrypoint = Readonly<{
  /** Stable name exposed to direct and shell execution. */
  readonly name: string;
  /** Sandbox path of the projected entrypoint. */
  readonly target: string;
  readonly provider: RuntimeExecutableProvider;
  readonly provenance: RuntimeProjectionProvenance;
}>;

export type RuntimeProjectionInput = Readonly<{
  policy: RuntimePolicy;
  profile: RuntimeProfileIdentity;
  requirements: readonly RuntimeRequirement[];
  filesystem: readonly RuntimeFilesystemProjection[];
  executables: readonly ProjectedExecutableEntrypoint[];
}>;

export type SessionRuntimeProjection = RuntimeProjectionInput &
  Readonly<{
    readonly contract_id: typeof SESSION_RUNTIME_PROJECTION_CONTRACT_ID;
    readonly schema_version: typeof SESSION_RUNTIME_PROJECTION_SCHEMA_VERSION;
  }>;

export type RuntimeProjectionErrorCode = Extract<
  ErrorCode,
  | "RUNTIME_PROJECTION_INVALID"
  | "RUNTIME_PROJECTION_AMBIGUOUS"
  | "RUNTIME_PROVIDER_MISSING"
  | "RUNTIME_MATERIALIZATION_MISSING"
>;

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidProjection(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `Runtime projection field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function ambiguousProjection(field: string, reason: string, value: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_AMBIGUOUS", `Runtime projection field '${field}' is ambiguous: ${reason}.`, {
      field,
      value,
    }),
  );
}

function isStableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function validatePath(value: unknown, field: string): DomainResult<string> {
  if (!isNonEmptyText(value) || !value.startsWith("/")) {
    return invalidProjection(field, "expected an absolute POSIX path", typeof value === "string" ? value : undefined);
  }
  if (posix.normalize(value) !== value) {
    return invalidProjection(field, "path must be normalized and contain no traversal aliases", value);
  }
  return success(value);
}

function validatePolicy(value: unknown): DomainResult<RuntimePolicy> {
  if (!isRecord(value) || !isNonEmptyText(value.mode)) {
    return invalidProjection("policy", "expected an explicit strict or compatibility policy");
  }

  if (value.mode === "strict") {
    if (
      value.host_visibility !== "default-deny" ||
      value.compatibility !== "disabled" ||
      value.unrestricted_host_fallback !== "forbidden"
    ) {
      return invalidProjection("policy", "strict policy must be default-deny and forbid host fallback");
    }
    return success(STRICT_RUNTIME_POLICY);
  }

  if (value.mode === "compatibility") {
    if (
      value.host_visibility !== "explicit" ||
      value.compatibility !== "explicit" ||
      value.unrestricted_host_fallback !== "explicit-only"
    ) {
      return invalidProjection("policy", "compatibility behavior must be explicitly selected");
    }
    return success(EXPLICIT_COMPATIBILITY_RUNTIME_POLICY);
  }

  return invalidProjection("policy.mode", "expected 'strict' or 'compatibility'");
}

/** Validate a policy independently when a resolver has not built the full view yet. */
export function validateRuntimePolicy(value: unknown): DomainResult<RuntimePolicy> {
  return validatePolicy(value);
}

function validateProfile(value: unknown): DomainResult<RuntimeProfileIdentity> {
  if (!isRecord(value) || !isStableIdentifier(value.id) || !isNonEmptyText(value.version)) {
    return invalidProjection("profile", "expected a stable id and non-empty version");
  }
  return success(Object.freeze({ id: value.id, version: value.version }));
}

function validateRequirement(value: unknown, index: number): DomainResult<RuntimeRequirement> {
  const field = `requirements[${index}]`;
  if (
    !isRecord(value) ||
    !isStableIdentifier(value.id) ||
    (value.kind !== "runtime" && value.kind !== "package") ||
    !isNonEmptyText(value.name) ||
    !isNonEmptyText(value.version)
  ) {
    return invalidProjection(field, "expected id, kind, name, and version");
  }
  return success(
    Object.freeze({
      id: value.id,
      kind: value.kind,
      name: value.name,
      version: value.version,
    }),
  );
}

function validateFilesystemProjection(
  value: unknown,
  index: number,
  policy: RuntimePolicy,
): DomainResult<RuntimeFilesystemProjection> {
  const field = `filesystem[${index}]`;
  if (!isRecord(value)) return invalidProjection(field, "expected an object");
  const source = validatePath(value.source, `${field}.source`);
  if (!source.ok) return source;
  const target = validatePath(value.target, `${field}.target`);
  if (!target.ok) return target;
  if (value.access_mode !== "read-only" && value.access_mode !== "read-write") {
    return invalidProjection(`${field}.access_mode`, "expected 'read-only' or 'read-write'");
  }
  if (!RUNTIME_PROJECTION_PROVENANCES.includes(value.provenance as RuntimeProjectionProvenance)) {
    return invalidProjection(`${field}.provenance`, "expected a canonical projection provenance");
  }
  const provenance = value.provenance as RuntimeProjectionProvenance;
  if (policy.mode === "strict" && provenance === "compatibility") {
    return invalidProjection(`${field}.provenance`, "strict policy cannot select compatibility visibility");
  }
  if (policy.mode === "strict" && (source.value === "/" || target.value === "/")) {
    return invalidProjection(field, "strict policy cannot project the host or sandbox filesystem root");
  }
  return success(
    Object.freeze({
      source: source.value,
      target: target.value,
      access_mode: value.access_mode,
      provenance,
    }),
  );
}

function validateExecutable(
  value: unknown,
  index: number,
  policy: RuntimePolicy,
  requirements: ReadonlyMap<string, RuntimeRequirement>,
): DomainResult<ProjectedExecutableEntrypoint> {
  const field = `executables[${index}]`;
  if (!isRecord(value) || !isNonEmptyText(value.name) || !/^[A-Za-z0-9][A-Za-z0-9+._-]*$/u.test(value.name)) {
    return invalidProjection(`${field}.name`, "expected a stable executable basename");
  }
  const target = validatePath(value.target, `${field}.target`);
  if (!target.ok) return target;
  if (!isRecord(value.provider) || !isStableIdentifier(value.provider.id)) {
    return invalidProjection(`${field}.provider`, "expected a stable provider id");
  }
  if (!isStableIdentifier(value.provider.requirement_id)) {
    return invalidProjection(`${field}.provider.requirement_id`, "expected a stable requirement id");
  }
  if (!requirements.has(value.provider.requirement_id)) {
    return invalidProjection(
      `${field}.provider.requirement_id`,
      "must reference a declared requirement",
      value.provider.requirement_id,
    );
  }
  if (!RUNTIME_PROJECTION_PROVENANCES.includes(value.provenance as RuntimeProjectionProvenance)) {
    return invalidProjection(`${field}.provenance`, "expected a canonical projection provenance");
  }
  const provenance = value.provenance as RuntimeProjectionProvenance;
  if (policy.mode === "strict" && provenance === "compatibility") {
    return invalidProjection(`${field}.provenance`, "strict policy cannot select compatibility entrypoints");
  }
  if (policy.mode === "strict" && target.value === "/") {
    return invalidProjection(`${field}.target`, "strict policy cannot project the sandbox filesystem root");
  }
  return success(
    Object.freeze({
      name: value.name,
      target: target.value,
      provider: Object.freeze({
        id: value.provider.id,
        requirement_id: value.provider.requirement_id,
      }),
      provenance,
    }),
  );
}

function assertUniqueRequirements(requirements: readonly RuntimeRequirement[]): DomainResult<null> {
  const ids = new Set<string>();
  for (const requirement of requirements) {
    if (ids.has(requirement.id)) return ambiguousProjection("requirements", "duplicate requirement id", requirement.id);
    ids.add(requirement.id);
  }
  return success(null);
}

function assertUniqueFilesystemTargets(filesystem: readonly RuntimeFilesystemProjection[]): DomainResult<null> {
  const ordered = [...filesystem].sort((left, right) => compareText(left.target, right.target));
  for (let index = 1; index < ordered.length; index += 1) {
    const current = ordered[index];
    for (let priorIndex = 0; priorIndex < index; priorIndex += 1) {
      const prior = ordered[priorIndex];
      if (prior.target === current.target) {
        return ambiguousProjection("filesystem.target", "multiple projections select the same target", current.target);
      }
      if (current.target.startsWith(`${prior.target}/`) || prior.target.startsWith(`${current.target}/`)) {
        return ambiguousProjection("filesystem.target", "nested targets have overlapping visibility", current.target);
      }
    }
  }
  return success(null);
}

function assertUniqueExecutables(executables: readonly ProjectedExecutableEntrypoint[]): DomainResult<null> {
  const names = new Set<string>();
  for (const executable of executables) {
    if (names.has(executable.name))
      return ambiguousProjection("executables.name", "duplicate entrypoint name", executable.name);
    names.add(executable.name);
  }
  return success(null);
}

/**
 * Validate and canonically order one runtime projection. This is pure: it
 * performs no package discovery, host probing, materialization, or sandbox
 * setup. The returned contract is the input to those later authorities.
 */
export function validateSessionRuntimeProjection(input: unknown): DomainResult<SessionRuntimeProjection> {
  if (!isRecord(input)) return invalidProjection("projection", "expected an object");
  if ("contract_id" in input && input.contract_id !== SESSION_RUNTIME_PROJECTION_CONTRACT_ID) {
    return invalidProjection("contract_id", "does not match the canonical runtime projection contract");
  }
  if ("schema_version" in input && input.schema_version !== SESSION_RUNTIME_PROJECTION_SCHEMA_VERSION) {
    return invalidProjection("schema_version", "does not match the canonical runtime projection schema");
  }

  const policy = validatePolicy(input.policy);
  if (!policy.ok) return failure(policy.error);
  const profile = validateProfile(input.profile);
  if (!profile.ok) return failure(profile.error);
  if (!Array.isArray(input.requirements)) return invalidProjection("requirements", "expected an array");
  if (!Array.isArray(input.filesystem)) return invalidProjection("filesystem", "expected an array");
  if (!Array.isArray(input.executables)) return invalidProjection("executables", "expected an array");

  const requirements: RuntimeRequirement[] = [];
  for (const [index, value] of input.requirements.entries()) {
    const result = validateRequirement(value, index);
    if (!result.ok) return failure(result.error);
    requirements.push(result.value);
  }
  const uniqueRequirements = assertUniqueRequirements(requirements);
  if (!uniqueRequirements.ok) return failure(uniqueRequirements.error);
  const requirementMap = new Map(requirements.map((requirement) => [requirement.id, requirement]));

  const filesystem: RuntimeFilesystemProjection[] = [];
  for (const [index, value] of input.filesystem.entries()) {
    const result = validateFilesystemProjection(value, index, policy.value);
    if (!result.ok) return failure(result.error);
    filesystem.push(result.value);
  }
  const uniqueTargets = assertUniqueFilesystemTargets(filesystem);
  if (!uniqueTargets.ok) return failure(uniqueTargets.error);

  const executables: ProjectedExecutableEntrypoint[] = [];
  for (const [index, value] of input.executables.entries()) {
    const result = validateExecutable(value, index, policy.value, requirementMap);
    if (!result.ok) return failure(result.error);
    executables.push(result.value);
  }
  const uniqueExecutables = assertUniqueExecutables(executables);
  if (!uniqueExecutables.ok) return failure(uniqueExecutables.error);

  return success(
    Object.freeze({
      contract_id: SESSION_RUNTIME_PROJECTION_CONTRACT_ID,
      schema_version: SESSION_RUNTIME_PROJECTION_SCHEMA_VERSION,
      policy: policy.value,
      profile: profile.value,
      requirements: Object.freeze(
        [...requirements].sort((left, right) => compareText(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`)),
      ),
      filesystem: Object.freeze(
        [...filesystem].sort((left, right) =>
          compareText(`${left.target}:${left.source}`, `${right.target}:${right.source}`),
        ),
      ),
      executables: Object.freeze(
        [...executables].sort((left, right) =>
          compareText(`${left.name}:${left.target}`, `${right.name}:${right.target}`),
        ),
      ),
    }),
  );
}

/** Alias emphasizing that validation also produces the canonical projection. */
export const projectSessionRuntimeProjection = validateSessionRuntimeProjection;
export const validateRuntimeProjection = validateSessionRuntimeProjection;

/** Serialize only a validated/canonical projection; no ambient state is consulted. */
export function serializeSessionRuntimeProjection(input: unknown): DomainResult<string> {
  const projection = validateSessionRuntimeProjection(input);
  return projection.ok ? success(JSON.stringify(projection.value)) : failure(projection.error);
}

/** Canonical recoverable error for a provider not present in the selected projection. */
export function runtimeProviderMissingError(
  providerId: string,
  entrypoint: string,
  requirementId: string,
): DomainError {
  return new DomainError(
    "RUNTIME_PROVIDER_MISSING",
    `Runtime provider '${providerId}' is missing for executable entrypoint '${entrypoint}'.`,
    { provider_id: providerId, entrypoint, requirement_id: requirementId },
  );
}

/** Canonical recoverable error for declared material that was not materialized. */
export function runtimeMaterializationMissingError(requirementId: string, kind: RuntimeRequirementKind): DomainError {
  return new DomainError(
    "RUNTIME_MATERIALIZATION_MISSING",
    `Runtime ${kind} requirement '${requirementId}' was not materialized.`,
    { requirement_id: requirementId, requirement_kind: kind },
  );
}

export function isRuntimeProjectionError(
  error: DomainError,
): error is DomainError & { readonly code: RuntimeProjectionErrorCode } {
  return (
    error.code === "RUNTIME_PROJECTION_INVALID" ||
    error.code === "RUNTIME_PROJECTION_AMBIGUOUS" ||
    error.code === "RUNTIME_PROVIDER_MISSING" ||
    error.code === "RUNTIME_MATERIALIZATION_MISSING"
  );
}

/** JSON-safe descriptor used by architecture/public documentation consumers. */
export const SESSION_RUNTIME_PROJECTION_DESCRIPTOR: JsonObject = Object.freeze({
  contract_id: SESSION_RUNTIME_PROJECTION_CONTRACT_ID,
  schema_version: SESSION_RUNTIME_PROJECTION_SCHEMA_VERSION,
  policy: {
    default: "strict",
    host_visibility: "default-deny",
    compatibility: "explicit-only",
    unrestricted_host_fallback: "never-implicit",
  },
  fields: ["policy", "profile", "requirements", "filesystem", "executables"],
  ownership: {
    resolves_before: "nawabari.sandbox-execution.v1",
    isolation_backend: "SandboxExecutionRequest",
    behavior_change_in_this_contract: false,
  },
});
