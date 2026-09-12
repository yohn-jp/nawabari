import { posix } from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import { buildExplicitCompatibilityRuntimeProjection } from "./compatibility-runtime-projection.js";
import { compileRuntimeExecutableProjection } from "./runtime-executable-projection.js";
import { fhsDevelopmentRuntimeReadiness, materializeFhsDevelopmentRuntime } from "./fhs-development-runtime.js";
import {
  materializeNixRuntimeClosure,
  type NixRuntimeClosure,
  type NixRuntimeClosureOptions,
} from "./nix-runtime-closure.js";
import {
  CANONICAL_RUNTIME_PROFILES,
  DEFAULT_DEVELOPMENT_RUNTIME_PROFILE,
  resolveRuntimeProfile,
  type ResolvedRuntimeProfile,
  type RuntimeProfileSelection,
} from "./runtime-profile.js";
import {
  DEFAULT_RUNTIME_POLICY,
  EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
  projectSessionRuntimeProjection,
  runtimeMaterializationMissingError,
  STRICT_RUNTIME_POLICY,
  validateRuntimePolicy,
  type RuntimeFilesystemProjection,
  type RuntimePolicy,
  type RuntimeProfileIdentity,
  type RuntimeRequirement,
  type ProjectedExecutableEntrypoint,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";
import type { SandboxRuntimeLayout } from "./sandbox.js";

/** Materializer selected by the host layout, or the explicit compatibility path. */
export type RuntimeMaterializer = "nix" | "fhs" | "compatibility" | "provided";

/** Bounded evidence attached to a resolved protected execution request. */
export type RuntimeResolutionEvidence = Readonly<{
  readonly policy: RuntimePolicy;
  readonly profile: RuntimeProfileIdentity;
  readonly materializer: RuntimeMaterializer;
}>;

export type RuntimeResolution = RuntimeResolutionEvidence &
  Readonly<{
    readonly projection: SessionRuntimeProjection;
  }>;

export type RuntimeResolutionFhsOptions = Readonly<{
  /** Optional bounded ELF search paths forwarded to the canonical FHS resolver. */
  readonly library_search_paths?: readonly string[];
}>;

export type RuntimeResolutionOptions = Readonly<{
  readonly policy?: RuntimePolicy;
  /** An already resolved internal profile may be supplied by a caller. */
  readonly profile?: ResolvedRuntimeProfile;
  readonly profile_selection?: RuntimeProfileSelection;
  readonly platform: string;
  readonly runtime_layout: SandboxRuntimeLayout;
  readonly nix?: NixRuntimeClosureOptions;
  readonly fhs?: RuntimeResolutionFhsOptions;
}>;

export type RuntimeMaterializerAvailability = Readonly<{
  readonly selected: RuntimeMaterializer | null;
  readonly available: readonly RuntimeMaterializer[];
  readonly strict_ready: boolean;
  readonly reason: string | null;
}>;

export type RuntimeDoctorReport = Readonly<
  RuntimeMaterializerAvailability & {
    readonly default_policy: RuntimePolicy;
    readonly default_profile: RuntimeProfileIdentity;
    readonly compatibility_available: boolean;
    readonly compatibility_policy: RuntimePolicy;
  }
>;

/** The ordinary pass-through commands owned by the canonical development profile. */
const DEVELOPMENT_EXECUTABLE_RELATIVE_PATHS: Readonly<Record<string, string>> = Object.freeze({
  "node-runtime": "bin/node",
  "git-package": "bin/git",
  "pnpm-package": "bin/pnpm",
});

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function resolutionFailure(
  requirement: RuntimeRequirement | null,
  reason: string,
  details: JsonObject = {},
): DomainResult<never> {
  const fallback = requirement ?? { id: "runtime-profile", kind: "runtime" as const };
  const canonical = runtimeMaterializationMissingError(fallback.id, fallback.kind);
  return failure(
    new DomainError(
      canonical.code,
      `${canonical.message.slice(0, -1)}: ${reason}.`,
      { ...(canonical.details ?? {}), reason, ...details },
      canonical.exitCode,
    ),
  );
}

function unsupportedPlatform(platform: string): DomainResult<never> {
  return failure(
    new DomainError("SANDBOX_UNSUPPORTED_PLATFORM", "Protected runtime materializers support Linux only.", {
      platform,
    }),
  );
}

function hasNixMaterializer(layout: SandboxRuntimeLayout): boolean {
  // The supported Nix path is the native NixOS layout: the store and current
  // system closure identify one coherent runtime. A standalone host may have
  // a developer-installed Nix binary/store while still being an FHS host.
  return (
    layout.nix_store !== null && layout.nix_current_system !== null && layout.nix !== undefined && layout.nix !== null
  );
}

/**
 * Select a materializer from explicit host-layout evidence. The selection is
 * made once; callers must not retry a failed selected materializer with the
 * other platform path.
 */
export function runtimeMaterializerAvailability(
  platform: string,
  layout: SandboxRuntimeLayout,
): RuntimeMaterializerAvailability {
  if (platform !== "linux") {
    return Object.freeze({
      selected: null,
      available: Object.freeze([]),
      strict_ready: false,
      reason: "protected runtime materialization is supported only on Linux",
    });
  }

  const fhsReadiness = fhsDevelopmentRuntimeReadiness(platform, layout);
  const available = [
    ...(hasNixMaterializer(layout) ? (["nix"] as const) : []),
    ...(fhsReadiness.strict_ready ? (["fhs"] as const) : []),
  ];
  const selected = available[0] ?? null;
  return Object.freeze({
    selected,
    available: Object.freeze(available),
    strict_ready: selected !== null,
    reason:
      selected !== null
        ? null
        : (fhsReadiness.reason ?? "no supported Nix or standalone FHS materializer is available"),
  });
}

/** Diagnostic projection of the same deterministic materializer selection. */
export function runtimeDoctorReport(platform: string, layout: SandboxRuntimeLayout): RuntimeDoctorReport {
  const availability = runtimeMaterializerAvailability(platform, layout);
  const compatibilityAvailable = platform === "linux" && buildExplicitCompatibilityRuntimeProjection(layout).ok;
  return Object.freeze({
    ...availability,
    default_policy: STRICT_RUNTIME_POLICY,
    default_profile: Object.freeze({
      id: DEFAULT_DEVELOPMENT_RUNTIME_PROFILE.id,
      version: DEFAULT_DEVELOPMENT_RUNTIME_PROFILE.version,
    }),
    compatibility_available: compatibilityAvailable,
    compatibility_policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
  });
}

function resolveProfile(options: RuntimeResolutionOptions): DomainResult<ResolvedRuntimeProfile> {
  if (options.profile !== undefined) return success(options.profile);
  return resolveRuntimeProfile(options.profile_selection ?? { profiles: ["development"] }, CANONICAL_RUNTIME_PROFILES);
}

function providerId(materializer: RuntimeMaterializer, requirement: RuntimeRequirement): string {
  return `${materializer}-${requirement.id}-provider`;
}

function requirementProvenance(
  policy: RuntimePolicy,
  requirement: RuntimeRequirement,
): RuntimeFilesystemProjection["provenance"] {
  if (policy.mode === "compatibility") return "compatibility";
  return requirement.kind === "runtime" ? "runtime-profile" : "package";
}

function relativeExecutablePath(requirement: RuntimeRequirement): string | null {
  return DEVELOPMENT_EXECUTABLE_RELATIVE_PATHS[requirement.id] ?? null;
}

function packageResolution(
  closure: NixRuntimeClosure,
  requirement: RuntimeRequirement,
): { readonly root: string; readonly target: string } | null {
  const resolved = closure.packages.find((candidate) => candidate.requirement_id === requirement.id);
  const relative = relativeExecutablePath(requirement);
  if (resolved === undefined || relative === null) return null;
  return { root: resolved.root, target: posix.join(resolved.root, relative) };
}

function executableEntrypoints(
  profile: ResolvedRuntimeProfile,
  policy: RuntimePolicy,
  materializer: "nix" | "fhs",
  closure: NixRuntimeClosure | null,
): DomainResult<readonly ProjectedExecutableEntrypoint[]> {
  const entrypoints: ProjectedExecutableEntrypoint[] = [];
  for (const requirement of [...profile.requirements].sort((left, right) => compareText(left.id, right.id))) {
    const target =
      materializer === "nix" ? (packageResolution(closure as NixRuntimeClosure, requirement)?.target ?? null) : null;
    if (target === null) {
      return resolutionFailure(requirement, "the selected materializer has no canonical executable mapping", {
        materializer,
      });
    }
    entrypoints.push(
      Object.freeze({
        name: requirement.name,
        target,
        provider: Object.freeze({
          id: providerId(materializer, requirement),
          requirement_id: requirement.id,
        }),
        provenance: requirementProvenance(policy, requirement),
      }),
    );
  }
  return success(Object.freeze(entrypoints));
}

function compileAndValidate(
  policy: RuntimePolicy,
  profile: ResolvedRuntimeProfile,
  filesystem: readonly RuntimeFilesystemProjection[],
  executables: readonly ProjectedExecutableEntrypoint[],
  materializer: "nix" | "fhs",
): DomainResult<RuntimeResolution> {
  const materialized = projectSessionRuntimeProjection({
    policy,
    profile: profile.profile,
    requirements: profile.requirements,
    filesystem,
    executables,
  });
  if (!materialized.ok) return failure(materialized.error);

  // #293 is the sole executable provider/materialization primitive. Running it
  // here validates that every declared entrypoint is backed by the selected
  // bounded filesystem result before the projection is handed to the launcher.
  const executableSurface = compileRuntimeExecutableProjection(materialized.value);
  if (!executableSurface.ok) return failure(executableSurface.error);
  if (executableSurface.value.length !== executables.length) {
    return resolutionFailure(null, "the executable projection did not preserve the declared development surface", {
      materializer,
    });
  }

  return success(
    Object.freeze({
      policy,
      profile: materialized.value.profile,
      materializer,
      projection: materialized.value,
    }),
  );
}

function strictNixResolution(
  profile: ResolvedRuntimeProfile,
  policy: RuntimePolicy,
  options: RuntimeResolutionOptions,
): DomainResult<RuntimeResolution> {
  const layout = options.runtime_layout;
  const nixOptions: NixRuntimeClosureOptions = {
    ...(options.nix ?? {}),
    policy,
    ...(layout.nix === null || layout.nix === undefined
      ? {}
      : { nix_executable: options.nix?.nix_executable ?? layout.nix }),
    ...(layout.nix_store === null ? {} : { store_root: options.nix?.store_root ?? layout.nix_store }),
  };
  const closure = materializeNixRuntimeClosure(profile, nixOptions);
  if (!closure.ok) return failure(closure.error);
  const executables = executableEntrypoints(profile, policy, "nix", closure.value);
  if (!executables.ok) return failure(executables.error);
  return compileAndValidate(policy, profile, closure.value.projection.filesystem, executables.value, "nix");
}

function strictFhsResolution(
  profile: ResolvedRuntimeProfile,
  policy: RuntimePolicy,
  options: RuntimeResolutionOptions,
): DomainResult<RuntimeResolution> {
  const materialized = materializeFhsDevelopmentRuntime({
    profile,
    policy,
    executable_candidates: options.runtime_layout.fhs_executable_candidates ?? [],
    ...(options.fhs?.library_search_paths === undefined
      ? {}
      : { library_search_paths: options.fhs.library_search_paths }),
  });
  if (!materialized.ok) return failure(materialized.error);
  return success(
    Object.freeze({
      policy: materialized.value.policy,
      profile: materialized.value.profile,
      materializer: "fhs" as const,
      projection: materialized.value.projection,
    }),
  );
}

function compatibilityProjection(
  profile: ResolvedRuntimeProfile,
  options: RuntimeResolutionOptions,
): DomainResult<RuntimeResolution> {
  const projection = buildExplicitCompatibilityRuntimeProjection(options.runtime_layout, {
    profile: profile.profile,
    requirements: profile.requirements,
  });
  if (!projection.ok) return failure(projection.error);
  return success(
    Object.freeze({
      policy: projection.value.policy,
      profile: projection.value.profile,
      materializer: "compatibility" as const,
      projection: projection.value,
    }),
  );
}

/**
 * Compose the canonical runtime pipeline. This function has no fallback
 * branch after a strict materializer is selected.
 */
export function resolveRuntimeProjection(options: RuntimeResolutionOptions): DomainResult<RuntimeResolution> {
  if (!isRecord(options) || !isRecord(options.runtime_layout)) {
    return resolutionFailure(null, "runtime resolution options are invalid");
  }
  const policy = validateRuntimePolicy(options.policy ?? DEFAULT_RUNTIME_POLICY);
  if (!policy.ok) return failure(policy.error);
  if (options.platform !== "linux") return unsupportedPlatform(options.platform);
  const profile = resolveProfile(options);
  if (!profile.ok) return failure(profile.error);

  if (policy.value.mode === "compatibility") return compatibilityProjection(profile.value, options);
  if (policy.value.mode !== STRICT_RUNTIME_POLICY.mode) {
    return resolutionFailure(null, "the protected runtime policy is not strict");
  }
  const materializer = runtimeMaterializerAvailability(options.platform, options.runtime_layout);
  if (materializer.selected === null)
    return resolutionFailure(null, materializer.reason ?? "no strict materializer available");
  if (materializer.selected === "nix") return strictNixResolution(profile.value, policy.value, options);
  return strictFhsResolution(profile.value, policy.value, options);
}

export const resolveRuntimeResolution = resolveRuntimeProjection;
export const resolveSessionRuntimeProjection = resolveRuntimeProjection;
