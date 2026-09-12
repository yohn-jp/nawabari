import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import {
  RUNTIME_PROFILE_CONTRACT_ID,
  RUNTIME_PROFILE_SCHEMA_VERSION,
  type ResolvedRuntimeProfile,
} from "./runtime-profile.js";
import {
  DEFAULT_RUNTIME_POLICY,
  projectSessionRuntimeProjection,
  runtimeMaterializationMissingError,
  validateRuntimePolicy,
  type RuntimeFilesystemProjection,
  type RuntimePolicy,
  type RuntimeProfileIdentity,
  type RuntimeRequirement,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";

/** Versioned evidence for a bounded Nix closure materialization. */
export const NIX_RUNTIME_CLOSURE_CONTRACT_ID = "nawabari.nix-runtime-closure.v1" as const;
export const NIX_RUNTIME_CLOSURE_SCHEMA_VERSION = 1 as const;

const DEFAULT_NIXPKGS_REF = "nixpkgs";
const DEFAULT_MAX_REQUIREMENTS = 128;
const DEFAULT_MAX_PATHS = 4_096;
const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1_024 * 1_024;
const DEFAULT_TIMEOUT_MS = 60_000;

/** Nix attributes for the canonical logical requirements in #290. */
export const DEFAULT_NIX_PACKAGE_ATTRIBUTES: Readonly<Record<string, string>> = Object.freeze({
  node: "nodejs",
  git: "git",
  pnpm: "pnpm",
  tgrep: "tgrep",
});

export type NixCommandResult = Readonly<{
  readonly exit_code: number;
  readonly stdout: string;
  readonly stderr: string;
}>;

/** Injectable command boundary; production never invokes a shell. */
export type NixCommandRunner = (executable: string, args: readonly string[]) => NixCommandResult;

export type NixRuntimeFileSystem = Readonly<{
  readonly lstatSync: (candidate: string) => {
    readonly isSymbolicLink: () => boolean;
    readonly isDirectory: () => boolean;
    readonly isFile: () => boolean;
  };
  readonly realpathSync: (candidate: string) => string;
}>;

export type NixRuntimeClosureOptions = Readonly<{
  /** Defaults to strict default-deny. Compatibility must be selected explicitly. */
  readonly policy?: RuntimePolicy;
  /** Nix executable used for read-only path-info queries. */
  readonly nix_executable?: string;
  /** A pinned flake/input reference is recommended for reproducible deployments. */
  readonly nixpkgs?: string;
  /** Alias for callers that use the explicit reference terminology. */
  readonly nixpkgs_ref?: string;
  /** Nix attribute overrides keyed by requirement id first, then logical name. */
  readonly package_attributes?: Readonly<Record<string, string>>;
  readonly command_runner?: NixCommandRunner;
  /** Nix store root; injectable for hermetic tests and non-default stores. */
  readonly store_root?: string;
  readonly filesystem?: NixRuntimeFileSystem;
  readonly max_requirements?: number;
  readonly max_paths?: number;
  readonly max_output_bytes?: number;
  readonly timeout_ms?: number;
}>;

export type NixRuntimePackageResolution = Readonly<{
  readonly requirement_id: string;
  readonly installable: string;
  readonly root: string;
  readonly closure: readonly string[];
}>;

export type NixRuntimeClosure = Readonly<{
  readonly contract_id: typeof NIX_RUNTIME_CLOSURE_CONTRACT_ID;
  readonly schema_version: typeof NIX_RUNTIME_CLOSURE_SCHEMA_VERSION;
  readonly policy: RuntimePolicy;
  readonly profile: RuntimeProfileIdentity;
  readonly requirements: readonly RuntimeRequirement[];
  readonly packages: readonly NixRuntimePackageResolution[];
  readonly store_paths: readonly string[];
  /** The generic #289 input; no executable aliases are created by #291. */
  readonly projection: SessionRuntimeProjection;
}>;

type NixRuntimeStat = ReturnType<NixRuntimeFileSystem["lstatSync"]>;
type NixRuntimeOptions = Required<
  Pick<
    NixRuntimeClosureOptions,
    "nix_executable" | "nixpkgs" | "max_requirements" | "max_paths" | "max_output_bytes" | "timeout_ms"
  >
> & {
  readonly policy: RuntimePolicy;
  readonly package_attributes: Readonly<Record<string, string>>;
  readonly command_runner: NixCommandRunner;
  readonly store_root: string;
  readonly filesystem: NixRuntimeFileSystem;
};

const nativeFileSystem: NixRuntimeFileSystem = {
  lstatSync: (candidate) => fs.lstatSync(candidate),
  realpathSync: (candidate) => fs.realpathSync.native(candidate),
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && !value.includes("\0");
}

function isStableIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[a-z0-9][a-z0-9._-]*$/u.test(value);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function materializationFailure(
  requirement: RuntimeRequirement | null,
  reason: string,
  details: JsonObject = {},
): DomainResult<never> {
  const fallback = requirement ?? { id: "runtime-profile", kind: "runtime" as const };
  const canonical = runtimeMaterializationMissingError(fallback.id, fallback.kind);
  return failure(
    new DomainError(
      canonical.code,
      canonical.message,
      { ...(canonical.details ?? {}), reason, ...details },
      canonical.exitCode,
    ),
  );
}

function validateLimit(value: unknown, fallback: number): number | null {
  if (value === undefined) return fallback;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 ? value : null;
}

function validateStoreRoot(value: unknown): string | null {
  if (!isNonEmptyText(value) || !path.posix.isAbsolute(value)) return null;
  const normalized = path.posix.normalize(value);
  if (normalized !== value || normalized === "/" || normalized.endsWith("/")) return null;
  return normalized;
}

function validateProfile(
  profile: unknown,
  maxRequirements: number,
): DomainResult<{ readonly profile: RuntimeProfileIdentity; readonly requirements: readonly RuntimeRequirement[] }> {
  if (!isRecord(profile) || !isRecord(profile.profile) || !Array.isArray(profile.requirements)) {
    return materializationFailure(null, "the resolved runtime profile is missing its logical material");
  }
  if ("contract_id" in profile && profile.contract_id !== RUNTIME_PROFILE_CONTRACT_ID) {
    return materializationFailure(null, "the runtime profile contract identity is unsupported");
  }
  if ("schema_version" in profile && profile.schema_version !== RUNTIME_PROFILE_SCHEMA_VERSION) {
    return materializationFailure(null, "the runtime profile schema version is unsupported");
  }
  const identity = profile.profile;
  if (!isStableIdentifier(identity.id) || !isNonEmptyText(identity.version)) {
    return materializationFailure(null, "the resolved runtime profile identity is invalid");
  }
  if (profile.requirements.length > maxRequirements) {
    return materializationFailure(null, "the declared requirement set exceeds the bounded resolver limit", {
      max_requirements: maxRequirements,
    });
  }

  const requirements: RuntimeRequirement[] = [];
  const ids = new Set<string>();
  for (const value of profile.requirements) {
    if (
      !isRecord(value) ||
      !isStableIdentifier(value.id) ||
      (value.kind !== "runtime" && value.kind !== "package") ||
      !isNonEmptyText(value.name) ||
      !isNonEmptyText(value.version) ||
      value.name.startsWith("/") ||
      value.name.startsWith("~") ||
      value.name.startsWith("$")
    ) {
      return materializationFailure(null, "a declared runtime requirement is invalid");
    }
    if (ids.has(value.id)) {
      return materializationFailure(
        { id: value.id, kind: value.kind, name: value.name, version: value.version },
        "a declared runtime requirement is duplicated",
      );
    }
    ids.add(value.id);
    requirements.push(
      Object.freeze({
        id: value.id,
        kind: value.kind,
        name: value.name,
        version: value.version,
      }),
    );
  }
  requirements.sort((left, right) => compareText(`${left.kind}:${left.id}`, `${right.kind}:${right.id}`));
  return success({
    profile: Object.freeze({ id: identity.id, version: identity.version }),
    requirements: Object.freeze(requirements),
  });
}

function validateOptions(
  options: NixRuntimeClosureOptions,
  requirement: RuntimeRequirement | null,
): DomainResult<NixRuntimeOptions> {
  const policy = validateRuntimePolicy(options.policy ?? DEFAULT_RUNTIME_POLICY);
  if (!policy.ok) return materializationFailure(requirement, "the runtime policy is invalid");

  const nixExecutable = options.nix_executable ?? "nix";
  if (!isNonEmptyText(nixExecutable)) return materializationFailure(requirement, "the Nix executable is invalid");

  if (options.nixpkgs_ref !== undefined && options.nixpkgs !== undefined && options.nixpkgs_ref !== options.nixpkgs) {
    return materializationFailure(requirement, "the Nixpkgs references are ambiguous");
  }
  const ref = options.nixpkgs_ref ?? options.nixpkgs ?? DEFAULT_NIXPKGS_REF;
  if (!isNonEmptyText(ref) || ref.includes("#") || /\s/u.test(ref)) {
    return materializationFailure(requirement, "the Nixpkgs reference is invalid", { nixpkgs: ref });
  }

  const storeRoot = validateStoreRoot(options.store_root ?? "/nix/store");
  if (storeRoot === null) return materializationFailure(requirement, "the Nix store root is invalid");

  const maxRequirements = validateLimit(options.max_requirements, DEFAULT_MAX_REQUIREMENTS);
  const maxPaths = validateLimit(options.max_paths, DEFAULT_MAX_PATHS);
  const maxOutputBytes = validateLimit(options.max_output_bytes, DEFAULT_MAX_OUTPUT_BYTES);
  const timeoutMs = validateLimit(options.timeout_ms, DEFAULT_TIMEOUT_MS);
  if (maxRequirements === null || maxPaths === null || maxOutputBytes === null || timeoutMs === null) {
    return materializationFailure(requirement, "a resolver bound is invalid");
  }

  const attributes = options.package_attributes ?? DEFAULT_NIX_PACKAGE_ATTRIBUTES;
  if (!isRecord(attributes)) return materializationFailure(requirement, "the Nix attribute map is invalid");
  for (const [key, value] of Object.entries(attributes)) {
    if (!isNonEmptyText(key) || !isNonEmptyText(value)) {
      return materializationFailure(requirement, "the Nix attribute map contains an invalid entry");
    }
  }

  return success({
    policy: policy.value,
    nix_executable: nixExecutable,
    nixpkgs: ref,
    package_attributes: attributes,
    command_runner: options.command_runner ?? createDefaultNixCommandRunner(maxOutputBytes, timeoutMs),
    store_root: storeRoot,
    filesystem: options.filesystem ?? nativeFileSystem,
    max_requirements: maxRequirements,
    max_paths: maxPaths,
    max_output_bytes: maxOutputBytes,
    timeout_ms: timeoutMs,
  });
}

function commandResultText(value: unknown): string {
  return typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : "";
}

function createDefaultNixCommandRunner(maxOutputBytes: number, timeoutMs: number): NixCommandRunner {
  return (executable, args) => {
    try {
      const stdout = execFileSync(executable, [...args], {
        cwd: process.cwd(),
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: maxOutputBytes,
        stdio: ["ignore", "pipe", "pipe"],
      }) as string;
      return { exit_code: 0, stdout, stderr: "" };
    } catch (error: unknown) {
      const candidate = isRecord(error) ? error : {};
      const status = typeof candidate.status === "number" ? candidate.status : 1;
      return {
        exit_code: status,
        stdout: commandResultText(candidate.stdout),
        stderr: commandResultText(candidate.stderr),
      };
    }
  };
}

const NIX_ATTRIBUTE_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_+.-]*(?:\.[A-Za-z0-9_][A-Za-z0-9_+.-]*)*$/u;

function nixAttributeForRequirement(
  requirement: RuntimeRequirement,
  attributes: Readonly<Record<string, string>>,
): string | null {
  const attribute = attributes[requirement.id] ?? attributes[requirement.name] ?? requirement.name;
  return isNonEmptyText(attribute) && NIX_ATTRIBUTE_PATTERN.test(attribute) ? attribute : null;
}

function installableForRequirement(requirement: RuntimeRequirement, options: NixRuntimeOptions): DomainResult<string> {
  const attribute = nixAttributeForRequirement(requirement, options.package_attributes);
  if (attribute === null) {
    return materializationFailure(requirement, "no safe Nix attribute maps the logical requirement");
  }
  const installable = `${options.nixpkgs}#${attribute}`;
  if (byteLength(installable) > 1_024) {
    return materializationFailure(requirement, "the Nix installable exceeds the bounded length");
  }
  return success(installable);
}

function isStorePath(value: string, storeRoot: string): boolean {
  if (!value.startsWith(`${storeRoot}/`) || value.includes("\0")) return false;
  if (path.posix.normalize(value) !== value || path.posix.dirname(value) !== storeRoot) return false;
  const name = path.posix.basename(value);
  return name.length > 0 && name !== "." && name !== "..";
}

function collectJsonStorePaths(value: unknown, storeRoot: string, paths: Set<string>): void {
  if (typeof value === "string") {
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string") {
        if (isStorePath(item, storeRoot)) paths.add(item);
      } else {
        collectJsonStorePaths(item, storeRoot, paths);
      }
    }
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, item] of Object.entries(value)) {
    if (isStorePath(key, storeRoot)) paths.add(key);
    if (key === "path" && typeof item === "string" && isStorePath(item, storeRoot)) paths.add(item);
    if (typeof item !== "string") collectJsonStorePaths(item, storeRoot, paths);
  }
}

function parsePathInfo(
  output: string,
  storeRoot: string,
  requirement: RuntimeRequirement,
  maxPaths: number,
  maxOutputBytes: number,
): DomainResult<readonly string[]> {
  if (byteLength(output) > maxOutputBytes) {
    return materializationFailure(requirement, "Nix path-info output exceeded the bounded size");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(output) as unknown;
  } catch {
    return materializationFailure(requirement, "Nix path-info did not return valid JSON");
  }
  const paths = new Set<string>();
  collectJsonStorePaths(parsed, storeRoot, paths);
  if (paths.size === 0) return materializationFailure(requirement, "Nix path-info returned no store paths");
  if (paths.size > maxPaths) {
    return materializationFailure(requirement, "the Nix closure exceeds the bounded path limit", {
      max_paths: maxPaths,
    });
  }
  return success(Object.freeze([...paths].sort(compareText)));
}

function queryPathInfo(
  requirement: RuntimeRequirement,
  installable: string,
  recursive: boolean,
  options: NixRuntimeOptions,
): DomainResult<readonly string[]> {
  const args = [
    "path-info",
    "--json",
    "--json-format",
    "1",
    "--no-pretty",
    ...(recursive ? ["--recursive"] : []),
    "--offline",
    installable,
  ];
  let result: NixCommandResult;
  try {
    result = options.command_runner(options.nix_executable, args);
  } catch {
    return materializationFailure(requirement, "the Nix path-info command could not be started");
  }
  if (
    !isRecord(result) ||
    typeof result.exit_code !== "number" ||
    !Number.isSafeInteger(result.exit_code) ||
    typeof result.stdout !== "string" ||
    typeof result.stderr !== "string"
  ) {
    return materializationFailure(requirement, "the Nix command returned an invalid result");
  }
  if (result.exit_code !== 0) {
    return materializationFailure(requirement, "the declared material is unavailable from the local Nix store", {
      installable,
      exit_code: result.exit_code,
      stderr: result.stderr.slice(0, 240),
    });
  }
  return parsePathInfo(result.stdout, options.store_root, requirement, options.max_paths, options.max_output_bytes);
}

function verifyStorePath(
  candidate: string,
  requirement: RuntimeRequirement,
  options: NixRuntimeOptions,
): DomainResult<null> {
  if (!isStorePath(candidate, options.store_root)) {
    return materializationFailure(requirement, "Nix returned a path outside the selected store root", {
      path: candidate,
    });
  }
  let stat: NixRuntimeStat;
  try {
    stat = options.filesystem.lstatSync(candidate);
    if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) {
      return materializationFailure(requirement, "a resolved store path is not a regular materialized path", {
        path: candidate,
      });
    }
    if (options.filesystem.realpathSync(candidate) !== candidate) {
      return materializationFailure(requirement, "a resolved store path traverses an unproven symlink", {
        path: candidate,
      });
    }
  } catch {
    return materializationFailure(requirement, "a resolved store path is missing or cannot be canonicalized", {
      path: candidate,
    });
  }
  return success(null);
}

function freezeProjection(
  policy: RuntimePolicy,
  profile: RuntimeProfileIdentity,
  requirements: readonly RuntimeRequirement[],
  filesystem: readonly RuntimeFilesystemProjection[],
): DomainResult<SessionRuntimeProjection> {
  const projection = projectSessionRuntimeProjection({
    policy,
    profile,
    requirements,
    filesystem,
    executables: [],
  });
  return projection.ok ? projection : failure(projection.error);
}

/**
 * Resolve an already-selected #290 profile using Nix's native path-info
 * closure query, then create only exact store-path projections. This function
 * does not build, substitute, crawl the store, or inspect PATH/home state.
 */
export function materializeNixRuntimeClosure(
  profile: ResolvedRuntimeProfile,
  options: NixRuntimeClosureOptions = {},
): DomainResult<NixRuntimeClosure> {
  if (!isRecord(options)) return materializationFailure(null, "the Nix materializer options are invalid");
  const initialOptions = validateOptions(options, null);
  if (!initialOptions.ok) return initialOptions;
  const profileResult = validateProfile(profile, initialOptions.value.max_requirements);
  if (!profileResult.ok) return profileResult;
  const requirementForErrors = profileResult.value.requirements[0] ?? null;
  const optionsResult = validateOptions(options, requirementForErrors);
  if (!optionsResult.ok) return optionsResult;
  const resolvedOptions = optionsResult.value;

  const packages: NixRuntimePackageResolution[] = [];
  const storePaths = new Set<string>();
  const pathProvenance = new Map<string, "runtime-profile" | "package">();
  for (const requirement of profileResult.value.requirements) {
    const installable = installableForRequirement(requirement, resolvedOptions);
    if (!installable.ok) return installable;
    const roots = queryPathInfo(requirement, installable.value, false, resolvedOptions);
    if (!roots.ok) return roots;
    if (roots.value.length !== 1) {
      return materializationFailure(requirement, "the declared installable resolved to an ambiguous output set", {
        installable: installable.value,
        output_count: roots.value.length,
      });
    }
    const root = roots.value[0] as string;
    const closure = queryPathInfo(requirement, installable.value, true, resolvedOptions);
    if (!closure.ok) return closure;
    if (!closure.value.includes(root)) {
      return materializationFailure(requirement, "the Nix closure omitted its declared root", {
        root,
        installable: installable.value,
      });
    }
    for (const storePath of closure.value) {
      const verified = verifyStorePath(storePath, requirement, resolvedOptions);
      if (!verified.ok) return verified;
      storePaths.add(storePath);
      const provenance = requirement.kind === "runtime" ? "runtime-profile" : "package";
      const previous = pathProvenance.get(storePath);
      if (previous === undefined || (provenance === "runtime-profile" && previous === "package")) {
        pathProvenance.set(storePath, provenance);
      }
      if (storePaths.size > resolvedOptions.max_paths) {
        return materializationFailure(requirement, "the combined Nix closure exceeds the bounded path limit", {
          max_paths: resolvedOptions.max_paths,
        });
      }
    }
    packages.push(
      Object.freeze({
        requirement_id: requirement.id,
        installable: installable.value,
        root,
        closure: Object.freeze([...closure.value].sort(compareText)),
      }),
    );
  }

  const sortedStorePaths = Object.freeze([...storePaths].sort(compareText));
  const filesystem: RuntimeFilesystemProjection[] =
    resolvedOptions.policy.mode === "compatibility"
      ? [
          Object.freeze({
            source: resolvedOptions.store_root,
            target: resolvedOptions.store_root,
            access_mode: "read-only" as const,
            provenance: "compatibility" as const,
          }),
        ]
      : sortedStorePaths.map((storePath) =>
          Object.freeze({
            source: storePath,
            target: storePath,
            access_mode: "read-only" as const,
            provenance: pathProvenance.get(storePath) ?? ("package" as const),
          }),
        );

  if (resolvedOptions.policy.mode === "compatibility") {
    try {
      const stat = resolvedOptions.filesystem.lstatSync(resolvedOptions.store_root);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return materializationFailure(requirementForErrors, "the compatibility Nix store root is not a directory");
      }
      if (resolvedOptions.filesystem.realpathSync(resolvedOptions.store_root) !== resolvedOptions.store_root) {
        return materializationFailure(requirementForErrors, "the compatibility Nix store root is not canonical");
      }
    } catch {
      return materializationFailure(requirementForErrors, "the compatibility Nix store root is unavailable");
    }
  }

  const projection = freezeProjection(
    resolvedOptions.policy,
    profileResult.value.profile,
    profileResult.value.requirements,
    filesystem,
  );
  if (!projection.ok) return projection;
  return success(
    Object.freeze({
      contract_id: NIX_RUNTIME_CLOSURE_CONTRACT_ID,
      schema_version: NIX_RUNTIME_CLOSURE_SCHEMA_VERSION,
      policy: resolvedOptions.policy,
      profile: profileResult.value.profile,
      requirements: profileResult.value.requirements,
      packages: Object.freeze(packages.sort((left, right) => compareText(left.requirement_id, right.requirement_id))),
      store_paths: sortedStorePaths,
      projection: projection.value,
    }),
  );
}

/** Resolve is the same bounded operation; the alias mirrors profile terminology. */
export const resolveNixRuntimeClosure = materializeNixRuntimeClosure;
export const materializeNixRuntimeProfile = materializeNixRuntimeClosure;

export function isNixRuntimeClosureError(error: DomainError): boolean {
  return error.code === "RUNTIME_MATERIALIZATION_MISSING";
}
