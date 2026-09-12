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
  projectSessionRuntimeProjection,
  runtimeMaterializationMissingError,
  STRICT_RUNTIME_POLICY,
  type RuntimeExecutableProvider,
  type RuntimeFilesystemProjection,
  type RuntimeProfileIdentity,
  type RuntimeRequirement,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";
import type { ResolvedRuntimeProfile } from "./runtime-profile.js";
import type { RuntimeExecutableProviderMaterialization } from "./runtime-executable-projection.js";

/** Versioned identity for the concrete #309 backend-materialization boundary. */
export const PNPM_MIDDLEWARE_BACKEND_MATERIALIZATION_CONTRACT_ID =
  "nawabari.pnpm-middleware-backend-materialization.v1" as const;
export const PNPM_MIDDLEWARE_BACKEND_MATERIALIZATION_SCHEMA_VERSION = 1 as const;

/** Stable backend targets consumed by #306; its public executable alias is separate. */
export const PNPM_MIDDLEWARE_RTK_TARGET = "/runtime/pnpm-middleware/rtk" as const;
export const PNPM_MIDDLEWARE_REAL_PNPM_TARGET = "/runtime/pnpm-middleware/pnpm/bin/pnpm.mjs" as const;
export const PNPM_MIDDLEWARE_PNPM_BUNDLE_TARGET = "/runtime/pnpm-middleware/pnpm/dist/pnpm.mjs" as const;

/**
 * Backend identities owned by #309.  The public launcher requirements and
 * provider/entrypoint constants remain owned by #306.
 */
export const RTK_BACKEND_REQUIREMENT = Object.freeze({
  id: "rtk-pnpm-middleware",
  kind: "package" as const,
  name: "rtk",
  version: "0.45.0",
});

export const REAL_PNPM_BACKEND_REQUIREMENT = Object.freeze({
  id: "pnpm-pinned-backend",
  kind: "package" as const,
  name: "pnpm",
  version: "11.18.0",
});

export const RTK_NIXPKGS_REF = "github:NixOS/nixpkgs/bb92730f6e97ca1c19e285a872cdd62a1a25c467" as const;
export const RTK_NIX_PACKAGE_ATTRIBUTE = "rtk" as const;
export const RTK_NIX_INSTALLABLE = `${RTK_NIXPKGS_REF}#${RTK_NIX_PACKAGE_ATTRIBUTE}` as const;
export const RTK_EXECUTABLE_RELATIVE_PATH = "bin/rtk" as const;

export const PNPM_NIXPKGS_REF = "github:NixOS/nixpkgs/44cc5cdbf88deb1d20243d1d5e3b46ad008b6139" as const;
export const PNPM_NIX_PACKAGE_ATTRIBUTE = "pnpm" as const;
export const PNPM_NIX_INSTALLABLE = `${PNPM_NIXPKGS_REF}#${PNPM_NIX_PACKAGE_ATTRIBUTE}` as const;
/** `bin/pnpm` is a symlink; this is the exact regular executable in the Nix output. */
export const PNPM_EXECUTABLE_RELATIVE_PATH = "libexec/pnpm/bin/pnpm.mjs" as const;
export const PNPM_BUNDLE_RELATIVE_PATH = "libexec/pnpm/dist/pnpm.mjs" as const;

/** Immutable source pins obtained from the selected Nixpkgs expressions. */
export const RTK_NIX_SOURCE = Object.freeze({
  owner: "rtk-ai",
  repository: "rtk",
  tag: "v0.45.0",
  revision: "refs/tags/v0.45.0",
  url: "https://github.com/rtk-ai/rtk/archive/refs/tags/v0.45.0.tar.gz",
  hash: "sha256-weAyHM0nWLrM8JRbbXIfjUsHtAep3DOFyTO+M3BZ/iU=",
  cargo_hash: "sha256-tgW6il/xLxt/xwhUBJ4MNVnk0JSZ7iFjJaEobj5+H4o=",
});

export const PNPM_NIX_SOURCE = Object.freeze({
  registry: "https://registry.npmjs.org/",
  package: "pnpm",
  version: "11.18.0",
  url: "https://registry.npmjs.org/pnpm/-/pnpm-11.18.0.tgz",
  hash: "sha256-KcNcqNKih5iP3uPg824H2bk3g/VntXm3/Vt5ikVj3YE=",
});

export const RTK_BACKEND_PROVIDER: RuntimeExecutableProvider = Object.freeze({
  id: "rtk-pnpm",
  requirement_id: RTK_BACKEND_REQUIREMENT.id,
});

export const REAL_PNPM_BACKEND_PROVIDER: RuntimeExecutableProvider = Object.freeze({
  id: "pnpm-real-backend",
  requirement_id: REAL_PNPM_BACKEND_REQUIREMENT.id,
});

/** Bounded observations recorded from the exact resolved Nix output files. */
export const RTK_BACKEND_EVIDENCE = Object.freeze({
  executable_sha256: "44ef7ff8063d5ddc2ea68b1662c346129322cd2ce922440e53ca1486d1aa7ee0",
  version: "rtk 0.45.0\n",
  version_bytes: 11,
  version_sha256: "9755282c9fbe0070d4f117d607f93a2b8a881ecfe373886e1ddec350cb2d920b",
  proxy_help_bytes: 382,
  proxy_help_sha256: "268105667cee57d4b742de30183bd4d780459c893ea942402f2f32d133c273d7",
});

export const PNPM_BACKEND_EVIDENCE = Object.freeze({
  executable_sha256: "81c9d9b2d59db7fa00bb3456a6bacbc6c58b7aeb5c744727c4e167cdadd957e8",
  version: "11.18.0\n",
  version_bytes: 8,
  version_sha256: "324f52ea836cd47edb7932f3992fa50b67fc7fec13a6950e1a1ddf720afab6d2",
  help_bytes: 2_305,
  help_sha256: "015f07d56a341088941fffca78f148ff6a9eb17af5246b80aa729a8028f4cb36",
  bundle_bytes: 12_904_703,
  bundle_sha256: "d34a7b439643e7b8680a817387ec3692c7097ae7a85865c2c15ad6211143d506",
});

export type PnpmMiddlewareBackendDescriptor = Readonly<{
  /** Exact path visible inside the sandbox and passed to #306. */
  readonly path: string;
  /** Exact regular executable source in the already-materialized Nix output. */
  readonly source: string;
  readonly provider: RuntimeExecutableProvider;
}>;

/**
 * Structural backend-only handoff consumed by #306's materialize API.  This
 * boundary intentionally contains no launcher, entrypoint, or public provider
 * contract so the two Issues have one-way ownership.
 */
export type PnpmMiddlewareBackendMaterializationOptions = Omit<
  NixRuntimeClosureOptions,
  "nixpkgs" | "nixpkgs_ref" | "package_attributes"
>;

export type PnpmMiddlewareBackendMaterialization = Readonly<{
  readonly contract_id: typeof PNPM_MIDDLEWARE_BACKEND_MATERIALIZATION_CONTRACT_ID;
  readonly schema_version: typeof PNPM_MIDDLEWARE_BACKEND_MATERIALIZATION_SCHEMA_VERSION;
  readonly profile: RuntimeProfileIdentity;
  readonly requirements: readonly [RuntimeRequirement, RuntimeRequirement];
  /** Exact descriptors accepted by #306's materializePnpmMiddleware input. */
  readonly rtk: PnpmMiddlewareBackendDescriptor;
  readonly real_pnpm: PnpmMiddlewareBackendDescriptor;
  /** Strict bounded projection containing closure roots and exact executable files. */
  readonly projection: SessionRuntimeProjection;
  readonly rtk_closure: NixRuntimeClosure;
  readonly real_pnpm_closure: NixRuntimeClosure;
  readonly rtk_provider_materialization: RuntimeExecutableProviderMaterialization;
  readonly real_pnpm_provider_materialization: RuntimeExecutableProviderMaterialization;
  readonly evidence: Readonly<{
    readonly rtk: typeof RTK_BACKEND_EVIDENCE;
    readonly real_pnpm: typeof PNPM_BACKEND_EVIDENCE;
  }>;
}>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function materializationFailure(
  requirement: RuntimeRequirement,
  reason: string,
  details: JsonObject = {},
): DomainResult<never> {
  const canonical = runtimeMaterializationMissingError(requirement.id, requirement.kind);
  return failure(
    new DomainError(
      canonical.code,
      `${canonical.message.slice(0, -1)}: ${reason}.`,
      { ...(canonical.details ?? {}), reason, ...details },
      canonical.exitCode,
    ),
  );
}

function validatePinnedOptions(options: unknown): DomainResult<null> {
  if (!isRecord(options))
    return materializationFailure(RTK_BACKEND_REQUIREMENT, "the materializer options are invalid");
  if (options.policy !== undefined && (!isRecord(options.policy) || options.policy.mode !== "strict")) {
    return materializationFailure(RTK_BACKEND_REQUIREMENT, "the backend requires the strict runtime policy");
  }
  if ("nixpkgs" in options || "nixpkgs_ref" in options || "package_attributes" in options) {
    return materializationFailure(
      RTK_BACKEND_REQUIREMENT,
      "the RTK and pnpm Nix sources and attributes are pinned by contract",
    );
  }
  return success(null);
}

function declaredRequirements(profile: unknown): DomainResult<readonly [RuntimeRequirement, RuntimeRequirement]> {
  if (!isRecord(profile) || !Array.isArray(profile.requirements)) {
    return materializationFailure(RTK_BACKEND_REQUIREMENT, "the resolved profile has no logical requirements");
  }
  const selected: RuntimeRequirement[] = [];
  for (const requirement of [RTK_BACKEND_REQUIREMENT, REAL_PNPM_BACKEND_REQUIREMENT]) {
    const candidate = profile.requirements.find((value) => isRecord(value) && value.id === requirement.id);
    if (!isRecord(candidate)) {
      return materializationFailure(requirement, "the backend requirement was not explicitly selected");
    }
    if (
      candidate.kind !== requirement.kind ||
      candidate.name !== requirement.name ||
      candidate.version !== requirement.version
    ) {
      return materializationFailure(
        requirement,
        "the selected requirement does not match the pinned backend contract",
        {
          requirement_id: requirement.id,
        },
      );
    }
    selected.push(requirement);
  }
  return success(Object.freeze(selected) as readonly [RuntimeRequirement, RuntimeRequirement]);
}

function profileForRequirement(
  profile: ResolvedRuntimeProfile,
  requirement: RuntimeRequirement,
): ResolvedRuntimeProfile {
  return Object.freeze({
    contract_id: profile.contract_id,
    schema_version: profile.schema_version,
    profile: profile.profile,
    selected_profiles: profile.selected_profiles,
    requirements: Object.freeze([requirement]),
  });
}

function canonicalExecutable(
  closure: NixRuntimeClosure,
  requirement: RuntimeRequirement,
  packageAttribute: string,
  installable: string,
  relativePath: string,
  target: string,
): DomainResult<{ readonly source: string; readonly target: string; readonly root: string }> {
  const packageResolution = closure.packages.find((candidate) => candidate.requirement_id === requirement.id);
  if (packageResolution === undefined) {
    return materializationFailure(requirement, "the Nix closure did not resolve the pinned package");
  }
  if (packageResolution.installable !== installable) {
    return materializationFailure(requirement, "the Nix closure returned a non-pinned installable", {
      installable: packageResolution.installable,
    });
  }
  const root = packageResolution.root;
  if (
    !posix.isAbsolute(root) ||
    posix.normalize(root) !== root ||
    !posix.basename(root).endsWith(`-${packageAttribute}-${requirement.version}`)
  ) {
    return materializationFailure(requirement, "the Nix output root does not match the pinned package version", {
      root,
    });
  }
  if (!closure.projection.filesystem.some((entry) => entry.source === root && entry.target === root)) {
    return materializationFailure(requirement, "the package root is not present in the strict closure projection", {
      root,
    });
  }
  const source = posix.join(root, relativePath);
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111) === 0) {
      return materializationFailure(requirement, "the pinned executable is not a regular executable file", { source });
    }
    if (fs.realpathSync.native(source) !== source) {
      return materializationFailure(requirement, "the pinned executable resolves through a symlink", { source });
    }
  } catch {
    return materializationFailure(requirement, "the pinned executable is unavailable", { source });
  }
  return success({ source, target, root });
}

function canonicalAuxiliaryFile(
  closure: NixRuntimeClosure,
  requirement: RuntimeRequirement,
  root: string,
  relativePath: string,
  target: string,
): DomainResult<RuntimeFilesystemProjection> {
  const source = posix.join(root, relativePath);
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return materializationFailure(requirement, "the pinned runtime auxiliary is not a regular file", { source });
    }
    if (fs.realpathSync.native(source) !== source) {
      return materializationFailure(requirement, "the pinned runtime auxiliary resolves through a symlink", { source });
    }
  } catch {
    return materializationFailure(requirement, "the pinned runtime auxiliary is unavailable", { source });
  }
  if (!closure.projection.filesystem.some((entry) => entry.source === root && entry.target === root)) {
    return materializationFailure(requirement, "the package root is not present for the pinned runtime auxiliary", {
      root,
    });
  }
  return success({ source, target, access_mode: "read-only", provenance: "package" });
}

function addExactFileProjections(
  projections: readonly RuntimeFilesystemProjection[],
  exact: readonly RuntimeFilesystemProjection[],
  requirement: RuntimeRequirement,
): DomainResult<readonly RuntimeFilesystemProjection[]> {
  const byTarget = new Map<string, RuntimeFilesystemProjection>();
  for (const entry of [...projections, ...exact]) {
    const previous = byTarget.get(entry.target);
    if (previous !== undefined) {
      if (
        previous.source !== entry.source ||
        previous.access_mode !== entry.access_mode ||
        previous.provenance !== entry.provenance
      ) {
        return materializationFailure(requirement, "the combined backend projection has a conflicting target", {
          target: entry.target,
        });
      }
      continue;
    }
    byTarget.set(entry.target, entry);
  }
  return success(Object.freeze([...byTarget.values()]));
}

function backendClosure(
  profile: ResolvedRuntimeProfile,
  requirement: RuntimeRequirement,
  nixpkgsRef: string,
  packageAttribute: string,
  options: PnpmMiddlewareBackendMaterializationOptions,
): DomainResult<NixRuntimeClosure> {
  return materializeNixRuntimeClosure(profileForRequirement(profile, requirement), {
    ...options,
    policy: STRICT_RUNTIME_POLICY,
    nixpkgs_ref: nixpkgsRef,
    package_attributes: Object.freeze({
      ...DEFAULT_NIX_PACKAGE_ATTRIBUTES,
      [requirement.id]: packageAttribute,
    }),
  });
}

/**
 * Materialize both concrete middleware backends through #291's offline Nix
 * path-info authority.  Each backend uses its own immutable Nixpkgs revision;
 * no build, substitute, PATH lookup, home lookup, or store crawl occurs here.
 */
export function materializePnpmMiddlewareBackends(
  profile: ResolvedRuntimeProfile,
  options: PnpmMiddlewareBackendMaterializationOptions = {},
): DomainResult<PnpmMiddlewareBackendMaterialization> {
  const optionsCheck = validatePinnedOptions(options);
  if (!optionsCheck.ok) return optionsCheck;
  const requirements = declaredRequirements(profile);
  if (!requirements.ok) return requirements;

  const rtkClosure = backendClosure(
    profile,
    requirements.value[0],
    RTK_NIXPKGS_REF,
    RTK_NIX_PACKAGE_ATTRIBUTE,
    options,
  );
  if (!rtkClosure.ok) return rtkClosure;
  const rtkExecutable = canonicalExecutable(
    rtkClosure.value,
    requirements.value[0],
    RTK_NIX_PACKAGE_ATTRIBUTE,
    RTK_NIX_INSTALLABLE,
    RTK_EXECUTABLE_RELATIVE_PATH,
    PNPM_MIDDLEWARE_RTK_TARGET,
  );
  if (!rtkExecutable.ok) return rtkExecutable;

  const realPnpmClosure = backendClosure(
    profile,
    requirements.value[1],
    PNPM_NIXPKGS_REF,
    PNPM_NIX_PACKAGE_ATTRIBUTE,
    options,
  );
  if (!realPnpmClosure.ok) return realPnpmClosure;
  const realPnpmExecutable = canonicalExecutable(
    realPnpmClosure.value,
    requirements.value[1],
    PNPM_NIX_PACKAGE_ATTRIBUTE,
    PNPM_NIX_INSTALLABLE,
    PNPM_EXECUTABLE_RELATIVE_PATH,
    PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
  );
  if (!realPnpmExecutable.ok) return realPnpmExecutable;
  const pnpmBundle = canonicalAuxiliaryFile(
    realPnpmClosure.value,
    requirements.value[1],
    realPnpmExecutable.value.root,
    PNPM_BUNDLE_RELATIVE_PATH,
    PNPM_MIDDLEWARE_PNPM_BUNDLE_TARGET,
  );
  if (!pnpmBundle.ok) return pnpmBundle;

  const filesystem = addExactFileProjections(
    [...rtkClosure.value.projection.filesystem, ...realPnpmClosure.value.projection.filesystem],
    [
      {
        source: rtkExecutable.value.source,
        target: PNPM_MIDDLEWARE_RTK_TARGET,
        access_mode: "read-only",
        provenance: "package",
      },
      {
        source: realPnpmExecutable.value.source,
        target: PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
        access_mode: "read-only",
        provenance: "package",
      },
      pnpmBundle.value,
    ],
    requirements.value[0],
  );
  if (!filesystem.ok) return filesystem;

  const projection = projectSessionRuntimeProjection({
    policy: STRICT_RUNTIME_POLICY,
    profile: profile.profile,
    requirements: requirements.value,
    filesystem: filesystem.value,
    executables: [],
  });
  if (!projection.ok) return projection;

  const rtkProviderMaterialization: RuntimeExecutableProviderMaterialization = Object.freeze({
    provider: RTK_BACKEND_PROVIDER,
    source: rtkExecutable.value.source,
  });
  const realPnpmProviderMaterialization: RuntimeExecutableProviderMaterialization = Object.freeze({
    provider: REAL_PNPM_BACKEND_PROVIDER,
    source: realPnpmExecutable.value.source,
  });
  return success(
    Object.freeze({
      contract_id: PNPM_MIDDLEWARE_BACKEND_MATERIALIZATION_CONTRACT_ID,
      schema_version: PNPM_MIDDLEWARE_BACKEND_MATERIALIZATION_SCHEMA_VERSION,
      profile: profile.profile,
      requirements: requirements.value,
      rtk: Object.freeze({
        path: rtkExecutable.value.target,
        source: rtkExecutable.value.source,
        provider: RTK_BACKEND_PROVIDER,
      }),
      real_pnpm: Object.freeze({
        path: realPnpmExecutable.value.target,
        source: realPnpmExecutable.value.source,
        provider: REAL_PNPM_BACKEND_PROVIDER,
      }),
      projection: projection.value,
      rtk_closure: rtkClosure.value,
      real_pnpm_closure: realPnpmClosure.value,
      rtk_provider_materialization: rtkProviderMaterialization,
      real_pnpm_provider_materialization: realPnpmProviderMaterialization,
      evidence: Object.freeze({ rtk: RTK_BACKEND_EVIDENCE, real_pnpm: PNPM_BACKEND_EVIDENCE }),
    }),
  );
}

/** #292 accepts only a host path; it cannot prove these pinned package artifacts. */
export function materializePnpmMiddlewareFhsRuntime(_input?: unknown): DomainResult<never> {
  return materializationFailure(
    REAL_PNPM_BACKEND_REQUIREMENT,
    "the explicit #292 FHS declaration lacks the immutable source, version, and provenance binding required by this backend",
    {
      authority: "nawabari.fhs-runtime-materialization.v1",
      missing_primitive: "immutable package source/version/provenance binding",
    },
  );
}

export const materializePnpmMiddlewareBackendMaterialization = materializePnpmMiddlewareBackends;
