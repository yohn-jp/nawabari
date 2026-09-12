import fs from "node:fs";
import { posix } from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import type { SandboxRuntimeLayout } from "./sandbox.js";
import {
  EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
  projectSessionRuntimeProjection,
  type RuntimeProfileIdentity,
  type RuntimeRequirement,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";

/** The legacy path arrays are accepted only as a bounded compatibility input. */
export type LegacyCompatibilityPathInputs = Readonly<{
  readonly runtime_paths: readonly string[];
  readonly system_paths: readonly string[];
  readonly user_tool_paths: readonly string[];
  readonly user_tool_home?: string | null;
}>;

export type CompatibilityRuntimeProjectionSource = SandboxRuntimeLayout | LegacyCompatibilityPathInputs;

export type CompatibilityRuntimeProjectionOptions = Readonly<{
  /** Profile identity retained in the projection; defaults to the legacy view. */
  readonly profile?: RuntimeProfileIdentity;
  /** Logical requirements retained for the downstream projection contract. */
  readonly requirements?: readonly RuntimeRequirement[];
}>;

const DEFAULT_COMPATIBILITY_PROFILE: RuntimeProfileIdentity = Object.freeze({
  id: "compatibility-runtime",
  version: "1",
});

const BACKEND_OWNED_RUNTIME_PATHS = new Set(["/dev", "/proc", "/tmp"]);
const BROAD_FHS_SYSTEM_ROOTS = ["/usr", "/bin", "/lib", "/lib64"] as const;
const RUNTIME_ROOTS = ["/nix/store", "/run/current-system", "/run/wrappers", "/etc/profiles"] as const;
const SYSTEM_ROOTS = [
  ...BROAD_FHS_SYSTEM_ROOTS,
  "/nix/store",
  "/run/current-system",
  "/run/wrappers",
  "/run/systemd/resolve",
  "/run/NetworkManager",
  "/mnt/wsl",
  "/etc/profiles",
  "/etc/alternatives",
  "/etc/ssl",
  "/etc/pki",
  "/etc/ca-certificates",
] as const;
const SYSTEM_FILES = new Set(["/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/hosts", "/etc/resolv.conf"]);

type CompatibilityPaths = LegacyCompatibilityPathInputs;
type CompatibilityEntry = Readonly<{
  readonly source: string;
  readonly target: string;
  readonly label: string;
}>;

function pathMatches(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}/`);
}

function invalid(field: string, reason: string, value?: string): DomainResult<never> {
  return failure(
    new DomainError("RUNTIME_PROJECTION_INVALID", `Compatibility projection field '${field}' is invalid: ${reason}.`, {
      field,
      ...(value === undefined ? {} : { value }),
    }),
  );
}

function ambiguous(field: string, reason: string, value: string): DomainResult<never> {
  return failure(
    new DomainError(
      "RUNTIME_PROJECTION_AMBIGUOUS",
      `Compatibility projection field '${field}' is ambiguous: ${reason}.`,
      {
        field,
        value,
      },
    ),
  );
}

function missing(reason: string, details: JsonObject = {}): DomainResult<never> {
  return failure(
    new DomainError(
      "RUNTIME_MATERIALIZATION_MISSING",
      `The explicit compatibility projection is unavailable: ${reason}.`,
      details,
    ),
  );
}

function isPath(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.startsWith("/") && !value.includes("\0");
}

function allowedRuntimePath(candidate: string): boolean {
  return RUNTIME_ROOTS.some((root) => pathMatches(candidate, root));
}

function allowedSystemPath(candidate: string, nixOSRuntime: boolean): boolean {
  if (nixOSRuntime && BROAD_FHS_SYSTEM_ROOTS.some((root) => pathMatches(candidate, root))) return false;
  return SYSTEM_ROOTS.some((root) => pathMatches(candidate, root)) || SYSTEM_FILES.has(candidate);
}

function userToolKind(
  candidate: string,
  hostHome: string | null | undefined,
): "local_bin" | "local_lib" | "pnpm_bin" | null {
  if (hostHome === null || hostHome === undefined || !isPath(hostHome)) return null;
  const localBin = posix.join(posix.normalize(hostHome), ".local", "bin");
  const localLib = posix.join(posix.normalize(hostHome), ".local", "lib");
  const pnpmBin = posix.join(posix.normalize(hostHome), ".local", "share", "pnpm");
  if (pathMatches(candidate, localBin)) return "local_bin";
  if (pathMatches(candidate, localLib)) return "local_lib";
  if (pathMatches(candidate, pnpmBin)) return "pnpm_bin";
  return null;
}

function compatibilityPaths(source: CompatibilityRuntimeProjectionSource): CompatibilityPaths {
  if ("runtime_paths" in source && "system_paths" in source && "user_tool_paths" in source) return source;
  return {
    runtime_paths: [
      "/dev",
      "/proc",
      "/tmp",
      ...[source.nix_store, source.nix_current_system, source.nix_wrappers, source.nix_user_profile].filter(
        (candidate): candidate is string => candidate !== null,
      ),
    ],
    system_paths: [
      ...[
        source.usr,
        source.bin,
        source.lib,
        source.lib64,
        source.passwd,
        source.group,
        source.nsswitch,
        source.hosts,
        source.resolv_conf,
        source.alternatives,
        source.ssl_certs,
        source.pki_certs,
        source.ca_certificates,
      ].filter((candidate): candidate is string => candidate !== null),
    ],
    user_tool_paths: [source.user_local_bin, source.user_local_lib, source.user_pnpm_bin].filter(
      (candidate): candidate is string => candidate !== null,
    ),
    user_tool_home: source.user_home,
  };
}

function canonicalSource(source: string, label: string, allowed: (candidate: string) => boolean): DomainResult<string> {
  if (!isPath(source) || posix.normalize(source) !== source || source === "/") {
    return invalid(`${label}.source`, "expected a non-root canonical absolute path", source);
  }
  if (!allowed(source))
    return invalid(`${label}.source`, "path is outside the supported compatibility surface", source);
  try {
    const stat = fs.lstatSync(source);
    if (!stat.isDirectory() && !stat.isFile() && !stat.isSymbolicLink()) {
      return missing("path is not a regular file or directory", { path: source });
    }
    const resolved = fs.realpathSync.native(source);
    if (resolved === "/" || !allowed(resolved)) {
      return invalid(`${label}.source`, "canonical source escapes the supported compatibility surface", source);
    }
    const resolvedStat = fs.statSync(resolved);
    if (!resolvedStat.isDirectory() && !resolvedStat.isFile()) {
      return missing("canonical source is not a regular file or directory", { path: source });
    }
    return success(resolved);
  } catch {
    return missing("path does not exist or cannot be canonicalized", { path: source });
  }
}

/**
 * Build the complete explicit compatibility view from the exact legacy
 * profile inputs. Backend-owned /dev, /proc, and /tmp remain represented by
 * the fixed sandbox topology; every other legacy host-backed path is emitted
 * as a read-only compatibility-provenance projection entry.
 */
export function buildExplicitCompatibilityRuntimeProjection(
  source: CompatibilityRuntimeProjectionSource,
  options: CompatibilityRuntimeProjectionOptions = {},
): DomainResult<SessionRuntimeProjection> {
  const paths = compatibilityPaths(source);
  const nixOSRuntime =
    paths.runtime_paths.includes("/nix/store") && paths.runtime_paths.includes("/run/current-system");
  const entries: CompatibilityEntry[] = [];
  const targets = new Map<string, string>();
  const add = (
    candidate: string,
    target: string,
    label: string,
    allowed: (value: string) => boolean,
  ): DomainResult<null> => {
    if (!isPath(target) || posix.normalize(target) !== target || target === "/") {
      return invalid(`${label}.target`, "expected a non-root canonical absolute path", target);
    }
    const canonical = canonicalSource(candidate, label, allowed);
    if (!canonical.ok) return canonical;
    const previous = targets.get(target);
    if (previous !== undefined) {
      if (previous === canonical.value) return success(null);
      return ambiguous("filesystem.target", "multiple compatibility sources select the same target", target);
    }
    targets.set(target, canonical.value);
    entries.push({ source: canonical.value, target, label });
    return success(null);
  };

  for (const [index, candidate] of paths.runtime_paths.entries()) {
    if (BACKEND_OWNED_RUNTIME_PATHS.has(candidate)) continue;
    const added = add(candidate, candidate, `runtime_paths[${index}]`, (value) => allowedRuntimePath(value));
    if (!added.ok) return added;
  }
  for (const [index, candidate] of paths.system_paths.entries()) {
    const added = add(candidate, candidate, `system_paths[${index}]`, (value) =>
      allowedSystemPath(value, nixOSRuntime),
    );
    if (!added.ok) return added;
  }
  for (const [index, candidate] of paths.user_tool_paths.entries()) {
    const kind = userToolKind(candidate, paths.user_tool_home);
    const target =
      kind === "local_bin"
        ? "/home/nawabari/.local/bin"
        : kind === "local_lib"
          ? "/home/nawabari/.local/lib"
          : kind === "pnpm_bin"
            ? "/home/nawabari/.local/share/pnpm"
            : null;
    if (target === null)
      return invalid(`user_tool_paths[${index}]`, "path is outside the selected local-tool profile", candidate);
    const added = add(
      candidate,
      target,
      `user_tool_paths[${index}]`,
      (value) => userToolKind(value, paths.user_tool_home) !== null,
    );
    if (!added.ok) return added;
  }

  if (entries.length === 0) return missing("no supported legacy runtime paths are available");
  const projection = projectSessionRuntimeProjection({
    policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
    profile: options.profile ?? DEFAULT_COMPATIBILITY_PROFILE,
    requirements: options.requirements ?? [],
    filesystem: entries.map((entry) => ({
      source: entry.source,
      target: entry.target,
      access_mode: "read-only" as const,
      provenance: "compatibility" as const,
    })),
    executables: [],
  });
  return projection.ok ? projection : failure(projection.error);
}
