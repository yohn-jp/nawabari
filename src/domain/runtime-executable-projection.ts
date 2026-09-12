import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult } from "./errors.js";
import {
  runtimeMaterializationMissingError,
  runtimeProviderMissingError,
  type ProjectedExecutableEntrypoint,
  type RuntimeExecutableProvider,
  type RuntimeFilesystemProjection,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";

/** The only command-discovery surface exposed by a strict runtime. */
export const CANONICAL_EXECUTABLE_ROOT = "/nawabari/bin" as const;

/** A provider result supplied by a selected runtime materializer. */
export type RuntimeExecutableProviderMaterialization = Readonly<{
  readonly provider: RuntimeExecutableProvider;
  /** Exact host path; this is never resolved through PATH. */
  readonly source: string;
}>;

export type RuntimeExecutableMaterializationMap = ReadonlyMap<string, RuntimeExecutableProviderMaterialization>;

/** One pinned file bind in the canonical executable surface. */
export type RuntimeExecutableProjectionEntry = Readonly<{
  readonly name: string;
  readonly source: string;
  readonly target: string;
  /** The declared namespace path from which the source was materialized. */
  readonly backing_target: string;
  readonly provider: RuntimeExecutableProvider;
  readonly provenance: RuntimeFilesystemProjection["provenance"];
  readonly source_kind: "file";
}>;

/** Stable map identity for a provider and its declared requirement. */
export function runtimeExecutableProviderKey(provider: RuntimeExecutableProvider): string {
  return `${provider.id}\u0000${provider.requirement_id}`;
}

function projectionInvalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `Runtime executable field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function projectionAmbiguous(field: string, reason: string, value: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_AMBIGUOUS", `Runtime executable field '${field}' is ambiguous: ${reason}.`, {
      field,
      value,
    }),
  );
}

function isWithin(parent: string, candidate: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}/`);
}

function isCanonicalAbsolute(value: string): boolean {
  return (
    value.length > 0 &&
    path.posix.isAbsolute(value) &&
    !value.includes("\0") &&
    path.posix.normalize(value) === value &&
    value !== "/"
  );
}

function canonicalExecutableTarget(name: string): string {
  return `${CANONICAL_EXECUTABLE_ROOT}/${name}`;
}

function requirementKind(projection: SessionRuntimeProjection, requirementId: string): "runtime" | "package" {
  return projection.requirements.find((requirement) => requirement.id === requirementId)?.kind ?? "package";
}

function missingProvider(entrypoint: ProjectedExecutableEntrypoint): DomainResult<never> {
  return failure(
    runtimeProviderMissingError(entrypoint.provider.id, entrypoint.name, entrypoint.provider.requirement_id),
  );
}

function materializationMissing(
  projection: SessionRuntimeProjection,
  entrypoint: ProjectedExecutableEntrypoint,
  reason: string,
  source?: string,
): DomainResult<never> {
  const requirement = runtimeMaterializationMissingError(
    entrypoint.provider.requirement_id,
    requirementKind(projection, entrypoint.provider.requirement_id),
  );
  return failure(
    new DomainError(
      requirement.code,
      requirement.message,
      {
        ...(requirement.details ?? {}),
        entrypoint: entrypoint.name,
        provider_id: entrypoint.provider.id,
        reason,
        ...(source === undefined ? {} : { source }),
      },
      requirement.exitCode,
    ),
  );
}

function filesystemCandidates(
  entrypoint: ProjectedExecutableEntrypoint,
  filesystem: readonly RuntimeFilesystemProjection[],
): readonly RuntimeFilesystemProjection[] {
  return filesystem.filter(
    (projection) => entrypoint.target === projection.target || entrypoint.target.startsWith(`${projection.target}/`),
  );
}

function sourceForEntrypoint(
  projection: SessionRuntimeProjection,
  entrypoint: ProjectedExecutableEntrypoint,
): DomainResult<{ readonly source: string; readonly backing_target: string }> {
  if (isWithin(CANONICAL_EXECUTABLE_ROOT, entrypoint.target)) {
    return projectionInvalid(
      "executables.target",
      "the canonical executable surface cannot be used as a provider target",
      entrypoint.target,
    );
  }
  const candidates = filesystemCandidates(entrypoint, projection.filesystem);
  if (candidates.length === 0) return missingProvider(entrypoint);
  if (candidates.length !== 1) {
    return projectionAmbiguous(
      "executables.target",
      "the entrypoint is backed by multiple materialized projections",
      entrypoint.target,
    );
  }

  const backing = candidates[0] as RuntimeFilesystemProjection;
  const relative = path.posix.relative(backing.target, entrypoint.target);
  if (backing.target === entrypoint.target && relative !== "") {
    return projectionInvalid("executables.target", "the materialized backing path is inconsistent", entrypoint.target);
  }
  if (relative.startsWith("../") || path.posix.isAbsolute(relative)) {
    return projectionInvalid(
      "executables.target",
      "the backing path escaped its materialized projection",
      entrypoint.target,
    );
  }

  const source = relative === "" ? backing.source : path.posix.join(backing.source, relative);
  if (!isCanonicalAbsolute(source) || isWithin(CANONICAL_EXECUTABLE_ROOT, source)) {
    return projectionInvalid("executables.source", "the backing path is not a canonical non-recursive path", source);
  }
  return success({ source, backing_target: backing.target });
}

function validateExecutableSource(
  projection: SessionRuntimeProjection,
  entrypoint: ProjectedExecutableEntrypoint,
  source: string,
): DomainResult<null> {
  if (!isCanonicalAbsolute(source)) {
    return projectionInvalid("executables.source", "expected an absolute canonical path", source);
  }
  if (isWithin(CANONICAL_EXECUTABLE_ROOT, source) || source === CANONICAL_EXECUTABLE_ROOT) {
    return projectionInvalid("executables.source", "the canonical executable surface cannot back itself", source);
  }
  try {
    const stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) {
      return projectionInvalid("executables.source", "the backing executable must not be a symlink", source);
    }
    if (!stat.isFile()) {
      return materializationMissing(projection, entrypoint, "the provider result is not a regular file", source);
    }
    if ((stat.mode & 0o111) === 0) {
      return materializationMissing(projection, entrypoint, "the provider result is not executable", source);
    }
    if (fs.realpathSync.native(source) !== source) {
      return projectionInvalid("executables.source", "the backing executable resolves through a symlink", source);
    }
  } catch {
    return materializationMissing(projection, entrypoint, "the provider result is missing", source);
  }
  return success(null);
}

function validateProviderMaterialization(
  projection: SessionRuntimeProjection,
  entrypoint: ProjectedExecutableEntrypoint,
  materialization: RuntimeExecutableProviderMaterialization,
  expectedSource: string,
): DomainResult<null> {
  const expectedKey = runtimeExecutableProviderKey(entrypoint.provider);
  if (
    !materialization ||
    typeof materialization !== "object" ||
    typeof materialization.source !== "string" ||
    materialization.provider === null ||
    typeof materialization.provider !== "object" ||
    typeof materialization.provider.id !== "string" ||
    typeof materialization.provider.requirement_id !== "string"
  ) {
    return projectionInvalid("executables.provider", "expected one materialization result", expectedKey);
  }
  if (
    materialization.provider.id !== entrypoint.provider.id ||
    materialization.provider.requirement_id !== entrypoint.provider.requirement_id
  ) {
    return projectionInvalid(
      "executables.provider",
      "the provider materialization does not match the declared provider and requirement",
      expectedKey,
    );
  }
  if (materialization.source !== expectedSource) {
    return projectionAmbiguous(
      "executables.source",
      "the provider result conflicts with the materialized target",
      materialization.source,
    );
  }
  return validateExecutableSource(projection, entrypoint, materialization.source);
}

function deriveMaterializations(
  projection: SessionRuntimeProjection,
): DomainResult<RuntimeExecutableMaterializationMap> {
  const materializations = new Map<string, RuntimeExecutableProviderMaterialization>();
  for (const entrypoint of projection.executables) {
    const resolved = sourceForEntrypoint(projection, entrypoint);
    if (!resolved.ok) return resolved;
    const key = runtimeExecutableProviderKey(entrypoint.provider);
    const materialization = Object.freeze({ provider: entrypoint.provider, source: resolved.value.source });
    const previous = materializations.get(key);
    if (previous !== undefined && previous.source !== materialization.source) {
      return projectionAmbiguous(
        "executables.provider",
        "one provider identity resolves to conflicting backing paths",
        key,
      );
    }
    materializations.set(key, materialization);
  }
  return success(materializations);
}

function validateMaterializationMap(
  projection: SessionRuntimeProjection,
  materializations: RuntimeExecutableMaterializationMap,
): DomainResult<null> {
  const declared = new Set(
    projection.executables.map((entrypoint) => runtimeExecutableProviderKey(entrypoint.provider)),
  );
  for (const [key, materialization] of materializations) {
    if (!declared.has(key)) {
      return projectionInvalid("executables.provider", "an undeclared provider materialization was supplied", key);
    }
  }
  for (const entrypoint of projection.executables) {
    const key = runtimeExecutableProviderKey(entrypoint.provider);
    const materialization = materializations.get(key);
    if (materialization === undefined) return missingProvider(entrypoint);
    const resolved = sourceForEntrypoint(projection, entrypoint);
    if (!resolved.ok) return resolved;
    const valid = validateProviderMaterialization(projection, entrypoint, materialization, resolved.value.source);
    if (!valid.ok) return valid;
  }
  return success(null);
}

/**
 * Compile the validated runtime declaration into pinned executable file
 * projections. The default map is derived only from explicit filesystem
 * materialization; callers may supply the same map when an adapter has
 * already resolved provider identities.
 */
export function compileRuntimeExecutableProjection(
  projection: SessionRuntimeProjection,
  suppliedMaterializations?: RuntimeExecutableMaterializationMap,
): DomainResult<readonly RuntimeExecutableProjectionEntry[]> {
  const materializations =
    suppliedMaterializations === undefined ? deriveMaterializations(projection) : success(suppliedMaterializations);
  if (!materializations.ok) return materializations;
  const validMap = validateMaterializationMap(projection, materializations.value);
  if (!validMap.ok) return validMap;

  const entries: RuntimeExecutableProjectionEntry[] = [];
  const targets = new Set<string>();
  for (const entrypoint of projection.executables) {
    const key = runtimeExecutableProviderKey(entrypoint.provider);
    const materialization = materializations.value.get(key) as RuntimeExecutableProviderMaterialization;
    const backing = sourceForEntrypoint(projection, entrypoint);
    if (!backing.ok) return backing;
    const target = canonicalExecutableTarget(entrypoint.name);
    if (targets.has(target)) {
      return projectionAmbiguous("executables.name", "duplicate canonical executable target", target);
    }
    targets.add(target);
    entries.push(
      Object.freeze({
        name: entrypoint.name,
        source: materialization.source,
        target,
        backing_target: backing.value.backing_target,
        provider: entrypoint.provider,
        provenance: entrypoint.provenance,
        source_kind: "file" as const,
      }),
    );
  }
  entries.sort((left, right) => (left.target < right.target ? -1 : left.target > right.target ? 1 : 0));
  return success(Object.freeze(entries));
}

/** Naming alias for callers that treat the result as a projected surface. */
export const projectRuntimeExecutableSurface = compileRuntimeExecutableProjection;
