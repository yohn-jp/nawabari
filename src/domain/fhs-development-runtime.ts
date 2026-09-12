import fs from "node:fs";
import { posix } from "node:path";
import process from "node:process";

import { DomainError, failure, success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";
import { materializeFhsRuntime, type FhsRuntimeExecutableDeclaration } from "./fhs-runtime.js";
import {
  compileRuntimeExecutableProjection,
  type RuntimeExecutableProjectionEntry,
} from "./runtime-executable-projection.js";
import {
  CANONICAL_RUNTIME_PROFILES,
  RUNTIME_PROFILE_CONTRACT_ID,
  RUNTIME_PROFILE_SCHEMA_VERSION,
  resolveRuntimeProfile,
  type ResolvedRuntimeProfile,
} from "./runtime-profile.js";
import {
  projectSessionRuntimeProjection,
  runtimeMaterializationMissingError,
  STRICT_RUNTIME_POLICY,
  validateRuntimePolicy,
  type RuntimePolicy,
  type RuntimeProfileIdentity,
  type RuntimeRequirement,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";
import type { SandboxRuntimeLayout } from "./sandbox.js";

/** The canonical standalone Linux development baseline. */
export const FHS_DEVELOPMENT_RUNTIME_REQUIREMENT_IDS = Object.freeze([
  "node-runtime",
  "git-package",
  "pnpm-package",
] as const);

/**
 * Explicit host/runtime evidence keys. These are exact executable sources,
 * not search roots or package-manager configuration; absence is meaningful and
 * leaves the strict baseline unavailable.
 */
export const FHS_DEVELOPMENT_EXECUTABLE_ENVIRONMENT_KEYS = Object.freeze({
  "node-runtime": "NAWABARI_FHS_NODE_EXECUTABLE",
  "git-package": "NAWABARI_FHS_GIT_EXECUTABLE",
  "pnpm-package": "NAWABARI_FHS_PNPM_EXECUTABLE",
} as const);

/** Stable provider identities consumed by #293's executable projection. */
export const FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS: Readonly<Record<string, string>> = Object.freeze({
  "node-runtime": "fhs-node-runtime-provider",
  "git-package": "fhs-git-package-provider",
  "pnpm-package": "fhs-pnpm-package-provider",
});

export type FhsDevelopmentRuntimeInput = Readonly<{
  /** Resolved logical profile; omitted means the canonical development profile. */
  readonly profile?: ResolvedRuntimeProfile;
  /** Strict is the only policy owned by this standalone development resolver. */
  readonly policy?: RuntimePolicy;
  /** Exact candidates supplied by the host/runtime evidence layer. */
  readonly executable_candidates: readonly FhsRuntimeExecutableDeclaration[];
  /** Optional bounded ELF search paths forwarded to #292. */
  readonly library_search_paths?: readonly string[];
}>;

export type FhsDevelopmentRuntimeResolution = Readonly<{
  readonly policy: RuntimePolicy;
  readonly profile: RuntimeProfileIdentity;
  readonly materializer: "fhs";
  readonly projection: SessionRuntimeProjection;
  readonly executable_projection: readonly RuntimeExecutableProjectionEntry[];
}>;

export type FhsDevelopmentRuntimeReadiness = Readonly<{
  /** True only when the same resolver used to build execution material is successful. */
  readonly strict_ready: boolean;
  /** Canonical diagnostic evidence for an unavailable baseline. */
  readonly reason: string | null;
  readonly code: ErrorCode | null;
  readonly details: JsonObject;
}>;

/**
 * Read only the three explicit executable-source declarations exposed by the
 * host/runtime boundary. In particular, this function never consults PATH,
 * HOME, profile directories, or Corepack state.
 */
export function readExplicitFhsDevelopmentExecutableCandidates(
  environment: NodeJS.ProcessEnv = process.env,
): readonly FhsRuntimeExecutableDeclaration[] {
  const candidates = FHS_DEVELOPMENT_RUNTIME_REQUIREMENT_IDS.flatMap((requirementId) => {
    const candidate = environment[FHS_DEVELOPMENT_EXECUTABLE_ENVIRONMENT_KEYS[requirementId]];
    return typeof candidate === "string" && candidate.length > 0
      ? [{ requirement_id: requirementId, path: candidate } satisfies FhsRuntimeExecutableDeclaration]
      : [];
  });
  candidates.sort((left, right) => compareText(left.requirement_id, right.requirement_id));
  return Object.freeze(candidates.map((candidate) => Object.freeze(candidate)));
}

/** Stable executable file name backing each canonical development requirement. */
const FHS_DEVELOPMENT_EXECUTABLE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  "node-runtime": "node",
  "git-package": "git",
  "pnpm-package": "pnpm",
});

/**
 * Fixed, bounded FHS binary directories consulted when no explicit host
 * evidence env var is supplied. This is a small deterministic allowlist, not a
 * PATH search: it never reflects process PATH, HOME, profile files, or
 * Corepack state, so it cannot be redirected by an attacker-controlled PATH.
 */
export const FHS_DEVELOPMENT_DEFAULT_EXECUTABLE_ROOTS = Object.freeze(["/usr/bin", "/usr/local/bin", "/bin"] as const);

/**
 * Resolve a single fixed-root candidate to the canonical form the strict
 * validator requires: an absolute, fully symlink-resolved, regular,
 * executable file. Returns null when the root has no usable candidate.
 */
function canonicalDefaultExecutable(candidatePath: string): string | null {
  try {
    const resolved = fs.realpathSync.native(candidatePath);
    if (!canonicalAbsolutePath(resolved)) return null;
    const stat = fs.lstatSync(resolved);
    if (stat.isSymbolicLink() || !stat.isFile()) return null;
    if ((stat.mode & 0o111) === 0) return null;
    return resolved;
  } catch {
    return null;
  }
}

/**
 * Discover a default candidate for each canonical development requirement
 * from a small fixed set of FHS binary directories (default:
 * `FHS_DEVELOPMENT_DEFAULT_EXECUTABLE_ROOTS`). This is the fallback used only
 * when no explicit `NAWABARI_FHS_*_EXECUTABLE` evidence is supplied; every
 * discovered candidate is still re-validated by the same strict pipeline that
 * validates explicit candidates.
 */
export function discoverDefaultFhsDevelopmentExecutableCandidates(
  roots: readonly string[] = FHS_DEVELOPMENT_DEFAULT_EXECUTABLE_ROOTS,
): readonly FhsRuntimeExecutableDeclaration[] {
  const candidates = FHS_DEVELOPMENT_RUNTIME_REQUIREMENT_IDS.flatMap((requirementId) => {
    const name = FHS_DEVELOPMENT_EXECUTABLE_NAMES[requirementId];
    for (const root of roots) {
      const resolved = canonicalDefaultExecutable(posix.join(root, name));
      if (resolved !== null)
        return [{ requirement_id: requirementId, path: resolved } satisfies FhsRuntimeExecutableDeclaration];
    }
    return [];
  });
  candidates.sort((left, right) => compareText(left.requirement_id, right.requirement_id));
  return Object.freeze(candidates.map((candidate) => Object.freeze(candidate)));
}

/**
 * The canonical host/runtime evidence source for standalone FHS development
 * materialization: explicit `NAWABARI_FHS_*_EXECUTABLE` evidence always wins
 * per requirement; a fixed-root default candidate (see
 * `discoverDefaultFhsDevelopmentExecutableCandidates`) fills any requirement
 * left unset so strict execution succeeds out of the box on a supported
 * host. A requirement with neither source still fails closed.
 */
export function readFhsDevelopmentExecutableCandidates(
  environment: NodeJS.ProcessEnv = process.env,
  roots: readonly string[] = FHS_DEVELOPMENT_DEFAULT_EXECUTABLE_ROOTS,
): readonly FhsRuntimeExecutableDeclaration[] {
  const explicit = new Map(
    readExplicitFhsDevelopmentExecutableCandidates(environment).map((candidate) => [
      candidate.requirement_id,
      candidate,
    ]),
  );
  const discovered = new Map(
    discoverDefaultFhsDevelopmentExecutableCandidates(roots).map((candidate) => [candidate.requirement_id, candidate]),
  );
  const candidates = FHS_DEVELOPMENT_RUNTIME_REQUIREMENT_IDS.flatMap((requirementId) => {
    const candidate = explicit.get(requirementId) ?? discovered.get(requirementId);
    return candidate === undefined ? [] : [candidate];
  });
  candidates.sort((left, right) => compareText(left.requirement_id, right.requirement_id));
  return Object.freeze(candidates.map((candidate) => Object.freeze(candidate)));
}

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\u0000");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Strip a reason's own trailing period so it nests into a sentence exactly once. */
function reasonSentence(reason: string): string {
  return reason.endsWith(".") ? reason.slice(0, -1) : reason;
}

function missing(
  requirement: Pick<RuntimeRequirement, "id" | "kind"> | null,
  reason: string,
  details: JsonObject = {},
): DomainResult<never> {
  const fallback = requirement ?? { id: "development-runtime", kind: "runtime" as const };
  const canonical = runtimeMaterializationMissingError(fallback.id, fallback.kind);
  return failure(
    new DomainError(
      canonical.code,
      `${canonical.message.slice(0, -1)}: ${reasonSentence(reason)}.`,
      { ...(canonical.details ?? {}), reason, ...details },
      canonical.exitCode,
    ),
  );
}

function ambiguous(field: string, value: string, reason: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_AMBIGUOUS", `FHS development field '${field}' is ambiguous: ${reason}.`, {
      field,
      value,
    }),
  );
}

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `FHS development field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function canonicalAbsolutePath(candidate: string): boolean {
  return posix.isAbsolute(candidate) && posix.normalize(candidate) === candidate && candidate !== "/";
}

function validateCandidatePath(
  candidate: unknown,
  requirement: RuntimeRequirement,
  field: string,
): DomainResult<string> {
  if (!isNonEmptyText(candidate) || !canonicalAbsolutePath(candidate)) {
    return invalid(
      field,
      "expected a normalized absolute path supplied by bounded host/runtime evidence",
      typeof candidate === "string" ? candidate : undefined,
    );
  }
  try {
    const stat = fs.lstatSync(candidate);
    if (stat.isSymbolicLink())
      return missing(requirement, "the candidate executable must not be a symlink", { field, source: candidate });
    if (!stat.isFile())
      return missing(requirement, "the candidate executable is not a regular file", { field, source: candidate });
    if ((stat.mode & 0o111) === 0)
      return missing(requirement, "the candidate executable is not executable", { field, source: candidate });
    const resolved = fs.realpathSync.native(candidate);
    if (resolved !== candidate)
      return missing(requirement, "the candidate executable resolves through a symlink", {
        field,
        source: candidate,
        resolved_source: resolved,
      });
    if (!canonicalAbsolutePath(resolved))
      return missing(requirement, "the candidate executable resolves to a non-canonical path", {
        field,
        source: candidate,
        resolved_source: resolved,
      });
    return success(resolved);
  } catch (error: unknown) {
    return missing(requirement, "the candidate executable is missing or cannot be canonicalized", {
      field,
      source: candidate,
      reason_detail: error instanceof Error ? error.message.slice(0, 120) : "unknown",
    });
  }
}

function resolvedProfile(input: UnknownRecord): DomainResult<ResolvedRuntimeProfile> {
  const profile =
    input.profile === undefined
      ? resolveRuntimeProfile({ profiles: ["development"] }, CANONICAL_RUNTIME_PROFILES)
      : !isRecord(input.profile)
        ? invalid("profile", "expected a resolved runtime profile")
        : success(input.profile as unknown as ResolvedRuntimeProfile);
  if (!profile.ok) return profile;
  if (
    !isRecord(profile.value) ||
    profile.value.contract_id !== RUNTIME_PROFILE_CONTRACT_ID ||
    profile.value.schema_version !== RUNTIME_PROFILE_SCHEMA_VERSION ||
    !isRecord(profile.value.profile) ||
    !isStableRequirement(profile.value.profile.id) ||
    !isNonEmptyText(profile.value.profile.version) ||
    !Array.isArray(profile.value.requirements)
  ) {
    return invalid("profile", "expected a validated runtime profile");
  }

  const requirementIds = new Set<string>();
  for (const [index, candidate] of profile.value.requirements.entries()) {
    if (
      !isRecord(candidate) ||
      !isStableRequirement(candidate.id) ||
      (candidate.kind !== "runtime" && candidate.kind !== "package") ||
      !isNonEmptyText(candidate.name) ||
      !isNonEmptyText(candidate.version)
    ) {
      return invalid(`profile.requirements[${index}]`, "expected a stable requirement descriptor");
    }
    if (requirementIds.has(candidate.id)) {
      return ambiguous("profile.requirements", candidate.id, "duplicate requirement id");
    }
    requirementIds.add(candidate.id);
  }

  for (const requirementId of FHS_DEVELOPMENT_RUNTIME_REQUIREMENT_IDS) {
    const requirement = profile.value.requirements.find(
      (candidate) =>
        isRecord(candidate) &&
        isStableRequirement(candidate.id) &&
        (candidate.kind === "runtime" || candidate.kind === "package") &&
        isNonEmptyText(candidate.name) &&
        isNonEmptyText(candidate.version) &&
        candidate.id === requirementId,
    );
    if (requirement === undefined) {
      const kind = requirementId === "node-runtime" ? "runtime" : "package";
      return missing({ id: requirementId, kind }, "the canonical development baseline requirement is absent", {
        requirement_id: requirementId,
      });
    }
  }
  return profile;
}

function isStableRequirement(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function validatedCandidates(
  value: unknown,
  profile: ResolvedRuntimeProfile,
): DomainResult<readonly FhsRuntimeExecutableDeclaration[]> {
  if (!Array.isArray(value)) return invalid("executable_candidates", "expected an array");
  const requirements = new Map(profile.requirements.map((requirement) => [requirement.id, requirement]));
  const seen = new Set<string>();
  const sources = new Map<string, string>();
  const validated: FhsRuntimeExecutableDeclaration[] = [];
  for (const [index, item] of value.entries()) {
    if (!isRecord(item) || !isNonEmptyText(item.requirement_id) || !isNonEmptyText(item.path)) {
      return invalid(`executable_candidates[${index}]`, "expected requirement_id and path");
    }
    const requirement = requirements.get(item.requirement_id);
    if (requirement === undefined)
      return missing(null, "the candidate references an unknown profile requirement", {
        requirement_id: item.requirement_id,
      });
    if (seen.has(item.requirement_id))
      return ambiguous(
        "executable_candidates.requirement_id",
        item.requirement_id,
        "multiple candidates satisfy one requirement",
      );
    seen.add(item.requirement_id);
    const checked = validateCandidatePath(item.path, requirement, `executable_candidates[${index}].path`);
    if (!checked.ok) return checked;
    const previousRequirement = sources.get(checked.value);
    if (previousRequirement !== undefined) {
      return ambiguous(
        "executable_candidates.path",
        checked.value,
        `one source cannot satisfy both ${previousRequirement} and ${item.requirement_id}`,
      );
    }
    sources.set(checked.value, item.requirement_id);
    validated.push(
      Object.freeze({
        requirement_id: item.requirement_id,
        path: checked.value,
        target: `/usr/local/bin/${requirement.name}`,
      }),
    );
  }
  for (const requirement of profile.requirements) {
    if (!seen.has(requirement.id)) return missing(requirement, "no explicit candidate was supplied");
  }
  validated.sort((left, right) => compareText(left.requirement_id, right.requirement_id));
  return success(Object.freeze(validated));
}

function developmentEntrypoints(
  profile: ResolvedRuntimeProfile,
  policy: RuntimePolicy,
  candidates: readonly FhsRuntimeExecutableDeclaration[],
): DomainResult<
  readonly {
    readonly name: string;
    readonly target: string;
    readonly provider: { readonly id: string; readonly requirement_id: string };
    readonly provenance: "runtime-profile" | "package";
  }[]
> {
  const paths = new Map(candidates.map((candidate) => [candidate.requirement_id, candidate.target ?? candidate.path]));
  const entrypoints = profile.requirements.map((requirement) => {
    const path = paths.get(requirement.id) as string;
    const providerId = FHS_DEVELOPMENT_RUNTIME_PROVIDER_IDS[requirement.id] ?? `fhs-${requirement.id}-provider`;
    return Object.freeze({
      name: requirement.name,
      target: path,
      provider: Object.freeze({ id: providerId, requirement_id: requirement.id }),
      provenance: (policy.mode === "strict" && requirement.kind === "runtime" ? "runtime-profile" : "package") as
        "runtime-profile" | "package",
    });
  });
  return success(Object.freeze(entrypoints));
}

/**
 * Resolve the canonical standalone Linux development baseline from explicit
 * candidates, materialize its bounded ELF/shebang closure, and compile the
 * exact result through #293's executable projection.
 */
export function resolveFhsDevelopmentRuntime(input: unknown): DomainResult<FhsDevelopmentRuntimeResolution> {
  if (!isRecord(input)) return invalid("materialization", "expected an object");
  const policy = validateRuntimePolicy(input.policy ?? STRICT_RUNTIME_POLICY);
  if (!policy.ok) return failure(policy.error);
  if (policy.value.mode !== "strict")
    return invalid("policy", "the FHS development resolver only supports strict policy");
  const profile = resolvedProfile(input);
  if (!profile.ok) return profile;
  const candidates = validatedCandidates(input.executable_candidates, profile.value);
  if (!candidates.ok) return candidates;
  const materialized = materializeFhsRuntime({
    profile: profile.value,
    policy: policy.value,
    executables: candidates.value,
    ...(input.library_search_paths === undefined ? {} : { library_search_paths: input.library_search_paths }),
  });
  if (!materialized.ok) return failure(materialized.error);
  const entrypoints = developmentEntrypoints(profile.value, policy.value, candidates.value);
  if (!entrypoints.ok) return entrypoints;
  const projection = projectSessionRuntimeProjection({
    policy: policy.value,
    profile: profile.value.profile,
    requirements: profile.value.requirements,
    filesystem: materialized.value.filesystem,
    executables: entrypoints.value,
  });
  if (!projection.ok) return failure(projection.error);
  const executableProjection = compileRuntimeExecutableProjection(projection.value);
  if (!executableProjection.ok) return failure(executableProjection.error);
  if (executableProjection.value.length !== profile.value.requirements.length) {
    return missing(null, "the executable projection did not preserve the complete development baseline");
  }
  return success(
    Object.freeze({
      policy: projection.value.policy,
      profile: projection.value.profile,
      materializer: "fhs" as const,
      projection: projection.value,
      executable_projection: executableProjection.value,
    }),
  );
}

/** Alias emphasizing that this result is the FHS materialization authority. */
export const materializeFhsDevelopmentRuntime = resolveFhsDevelopmentRuntime;

/**
 * Doctor/readiness authority. It calls the same resolver used by execution;
 * it never reports readiness from directory existence or layout heuristics.
 */
export function fhsDevelopmentRuntimeReadiness(
  platform: string,
  runtimeLayout: Pick<SandboxRuntimeLayout, "fhs_executable_candidates" | "fhs_library_search_paths">,
): FhsDevelopmentRuntimeReadiness {
  if (platform !== "linux") {
    return Object.freeze({
      strict_ready: false,
      reason: "standalone FHS development materialization is supported only on Linux",
      code: "SANDBOX_UNSUPPORTED_PLATFORM",
      details: { platform },
    });
  }
  const resolved = resolveFhsDevelopmentRuntime({
    executable_candidates: runtimeLayout.fhs_executable_candidates ?? [],
    ...(runtimeLayout.fhs_library_search_paths === undefined
      ? {}
      : { library_search_paths: runtimeLayout.fhs_library_search_paths }),
  });
  if (resolved.ok) {
    return Object.freeze({ strict_ready: true, reason: null, code: null, details: {} });
  }
  return Object.freeze({
    strict_ready: false,
    reason: resolved.error.message,
    code: resolved.error.code,
    details: resolved.error.details ?? {},
  });
}

export const doctorFhsDevelopmentRuntime = fhsDevelopmentRuntimeReadiness;
