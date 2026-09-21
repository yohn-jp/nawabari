import { DomainError, failure, success, type DomainResult } from "./errors.js";
import { compileRuntimeExecutableProjection } from "./runtime-executable-projection.js";
import {
  RUNTIME_RESOLUTION_SERIALIZATION_KEY,
  resolveRuntimeProjection,
  serializeRuntimeResolution,
  type RuntimeResolution,
  type RuntimeResolutionFhsOptions,
  type RuntimeResolutionOptions,
} from "./runtime-resolution.js";
import {
  projectSessionRuntimeProjection,
  runtimeProviderMissingError,
  validateSessionRuntimeProjection,
  type ProjectedExecutableEntrypoint,
  type RuntimeExecutableProvider,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";
import type { NixRuntimeClosureOptions } from "./nix-runtime-closure.js";
import type { SandboxRuntimeLayout } from "./sandbox.js";
import {
  validateWorktreeRuntimeProfile,
  type ResolvedWorktreeRuntimeProfile,
  type WorktreeRuntimeProfile,
  type WorktreeRuntimeToolReference,
} from "./worktree-runtime-profile.js";

/** The governed document key for a resolved worktree runtime projection. */
export const WORKTREE_PROFILE_RUNTIME_SERIALIZATION_KEY = "runtime-resolution" as const;
/** Alias used by callers that persist the resolution independently. */
export { RUNTIME_RESOLUTION_SERIALIZATION_KEY };

/** Versioned identity for the worktree-profile-to-runtime adapter. */
export const WORKTREE_PROFILE_RUNTIME_CONTRACT_ID = "nawabari.worktree-profile-runtime.v1" as const;
export const WORKTREE_PROFILE_RUNTIME_SCHEMA_VERSION = 1 as const;

/**
 * A host layout plus the platform observation used by the existing runtime
 * resolver. `SandboxRuntimeLayout` deliberately does not contain platform
 * state, so callers may provide it here without changing that contract.
 */
export type WorktreeProfileRuntimeLayout = SandboxRuntimeLayout &
  Readonly<{
    readonly platform?: string;
  }>;

export type WorktreeProfileRuntimeOptions = Readonly<{
  readonly platform?: string;
  readonly nix?: NixRuntimeClosureOptions;
  readonly fhs?: RuntimeResolutionFhsOptions;
}>;

/** A materialized result accepted by the pure entrypoint selector. */
export type ProfileRuntimeMaterialized =
  RuntimeResolution | SessionRuntimeProjection | Readonly<{ readonly projection: SessionRuntimeProjection }>;

/** The selector intentionally consumes the profile's declared provider refs. */
export type ProfileRuntimeBindings = readonly WorktreeRuntimeToolReference[];

export type WorktreeProfileRuntimeResolution = RuntimeResolution;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function entrypointProviderKey(provider: RuntimeExecutableProvider): string {
  return `${provider.id}\u0000${provider.requirement_id}`;
}

function providerMissing(entrypoint: WorktreeRuntimeToolReference): DomainResult<never> {
  return failure(
    runtimeProviderMissingError(entrypoint.provider.id, entrypoint.entrypoint, entrypoint.provider.requirement_id),
  );
}

function materializedProjection(materialized: ProfileRuntimeMaterialized): DomainResult<SessionRuntimeProjection> {
  if (isRecord(materialized) && "projection" in materialized) {
    return validateSessionRuntimeProjection(materialized.projection);
  }
  return validateSessionRuntimeProjection(materialized);
}

function isEntrypointArray(value: unknown): value is readonly ProjectedExecutableEntrypoint[] {
  return Array.isArray(value);
}

function selectedEntrypoint(
  materialized: readonly ProjectedExecutableEntrypoint[],
  binding: WorktreeRuntimeToolReference,
): ProjectedExecutableEntrypoint | null {
  const providerKey = entrypointProviderKey(binding.provider);
  return (
    materialized.find(
      (entrypoint) =>
        entrypoint.name === binding.entrypoint && entrypointProviderKey(entrypoint.provider) === providerKey,
    ) ?? null
  );
}

/**
 * Select only the executable surface declared by a worktree profile.
 *
 * This function does not materialize, discover, alias, or fallback to another
 * provider. A profile binding must match one already projected executable by
 * both entrypoint name and exact provider identity.
 */
export function selectProfileEntrypoints(
  materialized: ProfileRuntimeMaterialized | readonly ProjectedExecutableEntrypoint[],
  bindings: ProfileRuntimeBindings,
): DomainResult<readonly ProjectedExecutableEntrypoint[]> {
  if (!Array.isArray(bindings)) {
    return failure(
      new DomainError("RUNTIME_PROJECTION_INVALID", "Worktree runtime tool bindings must be an array.", {
        field: "tools",
      }),
    );
  }
  let executables: readonly ProjectedExecutableEntrypoint[];
  if (isEntrypointArray(materialized)) {
    executables = materialized;
  } else {
    const projection = materializedProjection(materialized);
    if (!projection.ok) return failure(projection.error);
    executables = projection.value.executables;
  }
  const selected: ProjectedExecutableEntrypoint[] = [];
  const names = new Set<string>();
  for (const binding of bindings) {
    if (
      !isRecord(binding) ||
      typeof binding.entrypoint !== "string" ||
      !isRecord(binding.provider) ||
      typeof binding.provider.id !== "string" ||
      typeof binding.provider.requirement_id !== "string"
    ) {
      return failure(
        new DomainError("RUNTIME_PROJECTION_INVALID", "A worktree runtime tool binding is invalid.", {
          field: "tools",
        }),
      );
    }
    const parsedBinding: WorktreeRuntimeToolReference = {
      entrypoint: binding.entrypoint,
      provider: { id: binding.provider.id, requirement_id: binding.provider.requirement_id },
    };
    if (names.has(parsedBinding.entrypoint)) {
      return failure(
        new DomainError("RUNTIME_PROJECTION_AMBIGUOUS", "A worktree runtime tool entrypoint is duplicated.", {
          field: "tools.entrypoint",
          value: parsedBinding.entrypoint,
        }),
      );
    }
    names.add(parsedBinding.entrypoint);
    const entrypoint = selectedEntrypoint(executables, parsedBinding);
    if (entrypoint === null) return providerMissing(parsedBinding);
    selected.push(entrypoint);
  }

  selected.sort((left, right) => compareText(`${left.name}\u0000${left.target}`, `${right.name}\u0000${right.target}`));
  return success(Object.freeze(selected));
}

function runtimeLayoutParts(
  layout: WorktreeProfileRuntimeLayout,
  options: WorktreeProfileRuntimeOptions,
): Pick<RuntimeResolutionOptions, "platform" | "runtime_layout" | "nix" | "fhs"> {
  return {
    platform: options.platform ?? layout.platform ?? process.platform,
    runtime_layout: layout,
    ...(options.nix === undefined ? {} : { nix: options.nix }),
    ...(options.fhs === undefined ? {} : { fhs: options.fhs }),
  };
}

/**
 * Resolve a worktree profile through the existing material/profile resolver,
 * then narrow its user-visible executable surface to the declared tools.
 * Materialized filesystem entries are intentionally retained unchanged: the
 * runtime helper and other infrastructure material remain available even
 * when a user tool is not selected.
 */
export function resolveWorktreeProfileRuntime(
  profile: WorktreeRuntimeProfile | ResolvedWorktreeRuntimeProfile | unknown,
  runtimeLayout: WorktreeProfileRuntimeLayout,
  options: WorktreeProfileRuntimeOptions = {},
): DomainResult<WorktreeProfileRuntimeResolution> {
  const checked = validateWorktreeRuntimeProfile(profile);
  if (!checked.ok) return failure(checked.error);

  const resolved = resolveRuntimeProjection({
    policy: checked.value.execution.policy,
    profile_selection: checked.value.materialSelection,
    ...runtimeLayoutParts(runtimeLayout, options),
  });
  if (!resolved.ok) return failure(resolved.error);

  const selected = selectProfileEntrypoints(resolved.value, checked.value.tools);
  if (!selected.ok) return failure(selected.error);

  const projection = projectSessionRuntimeProjection({
    policy: resolved.value.policy,
    profile: resolved.value.profile,
    requirements: resolved.value.projection.requirements,
    filesystem: resolved.value.projection.filesystem,
    executables: selected.value,
    ...(resolved.value.projection.working_set === undefined
      ? {}
      : { working_set: resolved.value.projection.working_set }),
  });
  if (!projection.ok) return failure(projection.error);

  // Keep the existing executable projection authority in the path after the
  // profile narrows the declaration. This validates provider/source identity
  // without creating a second provider or materializer contract.
  const executableSurface = compileRuntimeExecutableProjection(projection.value);
  if (!executableSurface.ok) return failure(executableSurface.error);

  return success(
    Object.freeze({
      policy: projection.value.policy,
      profile: projection.value.profile,
      materializer: resolved.value.materializer,
      projection: projection.value,
    }),
  );
}

/** Serialize only a validated resolution under the governed document key. */
export function serializeWorktreeProfileRuntimeResolution(input: unknown): DomainResult<string> {
  return serializeRuntimeResolution(input);
}
export { serializeRuntimeResolution };

/** JSON-safe descriptor for the adapter and its authority boundaries. */
export const WORKTREE_PROFILE_RUNTIME_DESCRIPTOR = Object.freeze({
  contract_id: WORKTREE_PROFILE_RUNTIME_CONTRACT_ID,
  schema_version: WORKTREE_PROFILE_RUNTIME_SCHEMA_VERSION,
  serialization_key: WORKTREE_PROFILE_RUNTIME_SERIALIZATION_KEY,
  authorities: {
    material: "resolveRuntimeProjection",
    executable: "compileRuntimeExecutableProjection",
    profile: "validateWorktreeRuntimeProfile",
  },
  excludes: ["ambient PATH", "host fallback", "provider aliases", "infrastructure helper removal"],
});
