import fs from "node:fs";
import { posix } from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import {
  DEFAULT_NIX_PACKAGE_ATTRIBUTES,
  materializeNixRuntimeClosure,
  type NixRuntimeClosure,
  type NixRuntimeClosureOptions,
} from "./nix-runtime-closure.js";
import {
  runtimeMaterializationMissingError,
  STRICT_RUNTIME_POLICY,
  type RuntimeExecutableProvider,
  type RuntimeRequirement,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";
import type { ResolvedRuntimeProfile, RuntimeProfileRequirementOperation } from "./runtime-profile.js";
import type { RuntimeExecutableProviderMaterialization } from "./runtime-executable-projection.js";

/** Versioned identity for the concrete tgrep materialization boundary. */
export const TGREP_RUNTIME_MATERIALIZATION_CONTRACT_ID = "nawabari.tgrep-runtime-materialization.v1" as const;
export const TGREP_RUNTIME_MATERIALIZATION_SCHEMA_VERSION = 1 as const;

/** The implementation backend is requested explicitly and is not a default profile member. */
export const TGREP_BACKEND_NAME = "tgrep" as const;
export const TGREP_BACKEND_VERSION = "1.0.8" as const;
export const TGREP_BACKEND_REQUIREMENT: RuntimeRequirement = Object.freeze({
  id: "tgrep-backend",
  kind: "package",
  name: TGREP_BACKEND_NAME,
  version: TGREP_BACKEND_VERSION,
});
export const TGREP_BACKEND_REQUIREMENT_OPERATION: RuntimeProfileRequirementOperation = Object.freeze({
  operation: "add" as const,
  requirement: TGREP_BACKEND_REQUIREMENT,
});

/** Immutable Nixpkgs revision containing the matching tgrep package definition. */
export const TGREP_NIXPKGS_REF = "github:NixOS/nixpkgs/0fcf36803fcc836b476126432b3334b293538476" as const;
export const TGREP_NIX_PACKAGE_ATTRIBUTE = "tgrep" as const;
export const TGREP_NIX_INSTALLABLE = `${TGREP_NIXPKGS_REF}#${TGREP_NIX_PACKAGE_ATTRIBUTE}` as const;
export const TGREP_EXECUTABLE_RELATIVE_PATH = "bin/tgrep" as const;

/** Provider identity consumed by #293; it does not create a public tgrep alias. */
export const TGREP_BACKEND_PROVIDER: RuntimeExecutableProvider = Object.freeze({
  id: "tgrep-backend-provider",
  requirement_id: TGREP_BACKEND_REQUIREMENT.id,
});

/** Only the two bounded CLI observations permitted by the materialization contract. */
export const TGREP_BACKEND_EVIDENCE = Object.freeze({
  version: "tgrep 1.0.8\n",
  help_sha256: "af98560daab3db4eb96b8fc3beafa15f397dbe2a4c6e8f5b0566b07fd0a9255f",
  help_bytes: 9_103,
});

export type TgrepRuntimeMaterializationOptions = Omit<
  NixRuntimeClosureOptions,
  "nixpkgs" | "nixpkgs_ref" | "package_attributes"
>;

export type TgrepRuntimeMaterialization = Readonly<{
  readonly contract_id: typeof TGREP_RUNTIME_MATERIALIZATION_CONTRACT_ID;
  readonly schema_version: typeof TGREP_RUNTIME_MATERIALIZATION_SCHEMA_VERSION;
  readonly backend: typeof TGREP_BACKEND_NAME;
  readonly requirement: RuntimeRequirement;
  readonly provider: RuntimeExecutableProvider;
  readonly nixpkgs_ref: typeof TGREP_NIXPKGS_REF;
  readonly nix_installable: typeof TGREP_NIX_INSTALLABLE;
  /** Exact canonical source and in-sandbox target supplied to #293. */
  readonly executable_source: string;
  readonly executable_target: string;
  readonly provider_materialization: RuntimeExecutableProviderMaterialization;
  /** Bounded strict filesystem projection from #291; it has no executable aliases. */
  readonly projection: SessionRuntimeProjection;
  readonly closure: NixRuntimeClosure;
  readonly evidence: typeof TGREP_BACKEND_EVIDENCE;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function materializationFailure(reason: string, details: JsonObject = {}): DomainResult<never> {
  const canonical = runtimeMaterializationMissingError(TGREP_BACKEND_REQUIREMENT.id, TGREP_BACKEND_REQUIREMENT.kind);
  return failure(
    new DomainError(
      canonical.code,
      `${canonical.message.slice(0, -1)}: ${reason}.`,
      { ...(canonical.details ?? {}), reason, ...details },
      canonical.exitCode,
    ),
  );
}

function declaredRequirement(profile: unknown): DomainResult<RuntimeRequirement> {
  if (!isRecord(profile) || !Array.isArray(profile.requirements)) {
    return materializationFailure("the resolved profile does not contain logical requirements");
  }
  const candidate = profile.requirements.find((value) => isRecord(value) && value.id === TGREP_BACKEND_REQUIREMENT.id);
  if (!isRecord(candidate)) {
    return materializationFailure("the tgrep backend requirement was not explicitly selected");
  }
  if (
    candidate.kind !== TGREP_BACKEND_REQUIREMENT.kind ||
    candidate.name !== TGREP_BACKEND_REQUIREMENT.name ||
    candidate.version !== TGREP_BACKEND_REQUIREMENT.version
  ) {
    return materializationFailure("the selected tgrep requirement is not the pinned backend contract", {
      requirement_id: TGREP_BACKEND_REQUIREMENT.id,
    });
  }
  return success(TGREP_BACKEND_REQUIREMENT);
}

function validatePinnedOptions(options: unknown): DomainResult<null> {
  if (!isRecord(options)) return materializationFailure("the tgrep materializer options are invalid");
  if (options.policy !== undefined && (!isRecord(options.policy) || options.policy.mode !== "strict")) {
    return materializationFailure("the tgrep backend requires the strict runtime policy");
  }
  if ("nixpkgs" in options || "nixpkgs_ref" in options || "package_attributes" in options) {
    return materializationFailure("the tgrep Nix source and attribute mapping are pinned by contract");
  }
  return success(null);
}

function exactExecutableSource(
  closure: NixRuntimeClosure,
  packageRoot: string,
): DomainResult<{ readonly source: string; readonly target: string }> {
  if (posix.normalize(packageRoot) !== packageRoot || !packageRoot.startsWith("/")) {
    return materializationFailure("the pinned tgrep package root is not canonical", { package_root: packageRoot });
  }
  if (!posix.basename(packageRoot).endsWith(`-${TGREP_BACKEND_NAME}-${TGREP_BACKEND_VERSION}`)) {
    return materializationFailure("the pinned tgrep package output name does not match the evidence version", {
      package_root: packageRoot,
    });
  }
  const source = posix.join(packageRoot, TGREP_EXECUTABLE_RELATIVE_PATH);
  const backing = closure.projection.filesystem.find(
    (entry) => entry.source === packageRoot && entry.target === packageRoot,
  );
  if (backing === undefined) {
    return materializationFailure("the pinned tgrep package root is not in the strict closure projection", {
      package_root: packageRoot,
    });
  }
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
      return materializationFailure("the pinned tgrep executable is not a regular executable file", { source });
    }
    if (fs.realpathSync.native(source) !== source) {
      return materializationFailure("the pinned tgrep executable resolves through a symlink", { source });
    }
  } catch {
    return materializationFailure("the pinned tgrep executable is unavailable", { source });
  }
  return success({ source, target: source });
}

/**
 * Materialize the explicitly selected tgrep requirement through #291's
 * strict Nix closure path. No backend lookup or host fallback is performed.
 */
export function materializeTgrepRuntime(
  profile: ResolvedRuntimeProfile,
  options: TgrepRuntimeMaterializationOptions = {},
): DomainResult<TgrepRuntimeMaterialization> {
  const optionsCheck = validatePinnedOptions(options);
  if (!optionsCheck.ok) return optionsCheck;
  const requirement = declaredRequirement(profile);
  if (!requirement.ok) return requirement;

  const closure = materializeNixRuntimeClosure(profile, {
    ...options,
    policy: STRICT_RUNTIME_POLICY,
    nixpkgs_ref: TGREP_NIXPKGS_REF,
    package_attributes: Object.freeze({
      ...DEFAULT_NIX_PACKAGE_ATTRIBUTES,
      [TGREP_BACKEND_REQUIREMENT.id]: TGREP_NIX_PACKAGE_ATTRIBUTE,
      [TGREP_BACKEND_NAME]: TGREP_NIX_PACKAGE_ATTRIBUTE,
    }),
  });
  if (!closure.ok) return closure;
  const packageResolution = closure.value.packages.find(
    (candidate) => candidate.requirement_id === TGREP_BACKEND_REQUIREMENT.id,
  );
  if (packageResolution === undefined) {
    return materializationFailure("the Nix closure did not resolve the pinned tgrep requirement");
  }
  if (packageResolution.installable !== TGREP_NIX_INSTALLABLE) {
    return materializationFailure("the Nix closure returned a non-pinned tgrep installable", {
      installable: packageResolution.installable,
    });
  }
  const executable = exactExecutableSource(closure.value, packageResolution.root);
  if (!executable.ok) return executable;

  const providerMaterialization: RuntimeExecutableProviderMaterialization = Object.freeze({
    provider: TGREP_BACKEND_PROVIDER,
    source: executable.value.source,
  });
  return success(
    Object.freeze({
      contract_id: TGREP_RUNTIME_MATERIALIZATION_CONTRACT_ID,
      schema_version: TGREP_RUNTIME_MATERIALIZATION_SCHEMA_VERSION,
      backend: TGREP_BACKEND_NAME,
      requirement: TGREP_BACKEND_REQUIREMENT,
      provider: TGREP_BACKEND_PROVIDER,
      nixpkgs_ref: TGREP_NIXPKGS_REF,
      nix_installable: TGREP_NIX_INSTALLABLE,
      executable_source: executable.value.source,
      executable_target: executable.value.target,
      provider_materialization: providerMaterialization,
      projection: closure.value.projection,
      closure: closure.value,
      evidence: TGREP_BACKEND_EVIDENCE,
    }),
  );
}

/** FHS cannot pin this backend and its evidence through #292's current input. */
export function materializeTgrepFhsRuntime(_input?: unknown): DomainResult<never> {
  return materializationFailure("the pinned tgrep backend is unsupported by the explicit FHS artifact contract");
}

export const materializeTgrepRuntimeProjection = materializeTgrepRuntime;
