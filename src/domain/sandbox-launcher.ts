import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";
import {
  deriveLandlockRules,
  LANDLOCK_ABI_MINIMUM,
  LANDLOCK_SETUP_FAILURE_PREFIX,
  LANDLOCK_TRAMPOLINE,
  type LandlockEffectiveState,
  type LandlockRule,
} from "./landlock.js";
import {
  compileSandboxSeccompProfile,
  SANDBOX_CAPABILITY_BASELINE_ID,
  SANDBOX_CAPABILITY_BASELINE_VERSION,
  SANDBOX_SECCOMP_PROFILE_ID,
  SANDBOX_SECCOMP_PROFILE_VERSION,
  type SandboxSeccompProfileMetadata,
} from "./sandbox-seccomp.js";
import type { SandboxExecutionRequest } from "./sandbox.js";
import {
  attachProcessToCgroup,
  cleanupCgroupScope,
  cgroupLimitEvents,
  createCgroupScope,
  readCgroupAccounting,
  type CgroupAccounting,
  type CgroupScope,
} from "./cgroups-v2.js";

const SANDBOX_HOME = "/home/nawabari";
const SANDBOX_CONFIG_HOME = `${SANDBOX_HOME}/.config`;
const SANDBOX_LOCAL_HOME = `${SANDBOX_HOME}/.local`;
const SANDBOX_CACHE_HOME = `${SANDBOX_HOME}/.cache`;
const SANDBOX_SHARED_HOME = `${SANDBOX_HOME}/.nawabari`;
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_024 * 1_024;

export type SandboxCommand = {
  readonly command: string;
  readonly args?: readonly string[];
};

/**
 * The exact argv/cwd/env handed to Node's non-shell child process launcher.
 * The profile is the only owner of mount and namespace arguments.
 */
export type SandboxInvocation = {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  /** Raw sock_filter bytes supplied to bubblewrap through inherited fd 3. */
  readonly seccomp_profile: Uint8Array;
  readonly seccomp_profile_metadata: SandboxSeccompProfileMetadata;
  readonly landlock: {
    readonly abi: number | null;
    readonly state: LandlockEffectiveState;
    readonly rule_count: number;
  };
};

export type SandboxExecutionResult = {
  readonly exit_code: number | null;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration_ms: number;
  /** Applied policy identity, retained as bounded machine-readable evidence. */
  readonly seccomp_profile?: SandboxSeccompProfileMetadata;
  readonly resources?: {
    readonly cgroup_contract_id: string;
    readonly scope: string;
    readonly accounting: CgroupAccounting;
    readonly limit_events: readonly string[];
  };
  readonly landlock?: {
    readonly abi: number | null;
    readonly state: LandlockEffectiveState;
    readonly rule_count: number;
  };
};

export type SandboxLauncherOptions = {
  readonly timeout_ms?: number;
  readonly max_output_bytes?: number;
};

type ValidatedTopology = {
  readonly repository: string;
  readonly worktree: string;
  readonly home: string;
  readonly cache: string;
  readonly persistent_home: string;
  readonly git_metadata: string;
  readonly git_objects: string;
};

export type { LandlockRule } from "./landlock.js";

function topologyError(message: string, details: JsonObject): DomainResult<never> {
  return failure(new DomainError("SANDBOX_TOPOLOGY_INVALID", message, details));
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function canonicalPath(candidate: string, label: string): DomainResult<string> {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) {
    return topologyError(`${label} must be an absolute path without NUL bytes.`, { label, path: candidate });
  }
  try {
    const normalized = path.normalize(candidate);
    const resolved = fs.realpathSync.native(candidate);
    if (resolved !== normalized) {
      return topologyError(`${label} must not resolve through an unproven symlink.`, {
        label,
        path: candidate,
        resolved,
      });
    }
    return success(resolved);
  } catch (error: unknown) {
    return topologyError(`${label} does not exist or cannot be canonicalized.`, {
      label,
      path: candidate,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

function preparePrivateDirectory(candidate: string, repository: string, label: string): DomainResult<string> {
  if (!isWithin(repository, candidate) || candidate === repository) {
    return topologyError(`${label} must be a private directory below the authoritative repository.`, {
      label,
      path: candidate,
      repository,
    });
  }
  let existingAncestor = candidate;
  while (!fs.existsSync(existingAncestor)) {
    const parent = path.dirname(existingAncestor);
    if (parent === existingAncestor) {
      return topologyError(`${label} has no canonicalizable parent.`, { label, path: candidate });
    }
    existingAncestor = parent;
  }
  try {
    const resolvedAncestor = fs.realpathSync.native(existingAncestor);
    if (!isWithin(repository, resolvedAncestor)) {
      return topologyError(`${label} would traverse outside the authoritative repository.`, {
        label,
        path: candidate,
        existing_ancestor: existingAncestor,
        resolved_ancestor: resolvedAncestor,
        repository,
      });
    }
  } catch (error: unknown) {
    return topologyError(`${label} has an unresolvable parent.`, {
      label,
      path: candidate,
      existing_ancestor: existingAncestor,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
  try {
    fs.mkdirSync(candidate, { recursive: true, mode: 0o700 });
  } catch (error: unknown) {
    return topologyError(`${label} could not be prepared.`, {
      label,
      path: candidate,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
  return canonicalPath(candidate, label);
}

function validateTopology(request: SandboxExecutionRequest): DomainResult<ValidatedTopology> {
  const repository = canonicalPath(request.repository, "repository");
  if (!repository.ok) return repository;
  const worktree = canonicalPath(request.worktree, "worktree");
  if (!worktree.ok) return worktree;
  if (request.filesystem.owned_worktree !== request.worktree) {
    return topologyError("The filesystem topology worktree must equal the authoritative session worktree.", {
      request_worktree: request.worktree,
      topology_worktree: request.filesystem.owned_worktree,
    });
  }

  const home = preparePrivateDirectory(request.filesystem.home, repository.value, "session home");
  if (!home.ok) return home;
  const cache = preparePrivateDirectory(request.filesystem.cache, repository.value, "session cache");
  if (!cache.ok) return cache;
  const persistentHome = preparePrivateDirectory(
    request.filesystem.persistent_home,
    repository.value,
    "persistent repository home",
  );
  if (!persistentHome.ok) return persistentHome;
  const gitMetadata = preparePrivateDirectory(request.filesystem.git_metadata, repository.value, "Git metadata");
  if (!gitMetadata.ok) return gitMetadata;
  const gitObjects = canonicalPath(request.filesystem.git_objects, "Git object database");
  if (!gitObjects.ok) return gitObjects;
  if (!isWithin(repository.value, gitObjects.value)) {
    return topologyError("The Git object database escaped the authoritative repository.", {
      repository: repository.value,
      git_objects: gitObjects.value,
    });
  }

  if (!isWithin(repository.value, home.value) || !isWithin(repository.value, cache.value)) {
    return topologyError("Session-private state escaped the authoritative repository.", {
      repository: repository.value,
      home: home.value,
      cache: cache.value,
    });
  }
  return success({
    repository: repository.value,
    worktree: worktree.value,
    home: home.value,
    cache: cache.value,
    persistent_home: persistentHome.value,
    git_metadata: gitMetadata.value,
    git_objects: gitObjects.value,
  });
}

function pathMatches(candidate: string, root: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${path.sep}`);
}

function allowedSystemPath(candidate: string): boolean {
  const normalized = path.normalize(candidate);
  const roots = [
    "/usr",
    "/bin",
    "/lib",
    "/lib64",
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
  ];
  if (roots.some((root) => pathMatches(normalized, root))) return true;
  return new Set(["/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/hosts", "/etc/resolv.conf"]).has(normalized);
}

function allowedRuntimePath(candidate: string): boolean {
  const normalized = path.normalize(candidate);
  return (
    normalized === "/dev" ||
    normalized === "/proc" ||
    normalized === "/tmp" ||
    pathMatches(normalized, "/nix/store") ||
    pathMatches(normalized, "/run/current-system") ||
    pathMatches(normalized, "/run/wrappers") ||
    pathMatches(normalized, "/etc/profiles")
  );
}

function allowedUserToolPath(
  candidate: string,
  hostHome: string | null | undefined = process.env.HOME,
): "local_bin" | "local_lib" | "pnpm_bin" | null {
  const home = hostHome;
  if (home === undefined || home === null) return null;
  if (!path.isAbsolute(home) || home.includes("\0")) return null;
  const normalized = path.normalize(candidate);
  if (pathMatches(normalized, path.join(home, ".local", "bin"))) return "local_bin";
  if (pathMatches(normalized, path.join(home, ".local", "lib"))) return "local_lib";
  if (pathMatches(normalized, path.join(home, ".local", "share", "pnpm"))) return "pnpm_bin";
  return null;
}

function ensureSourcePath(candidate: string, label: string): DomainResult<string> {
  try {
    const stat = fs.statSync(candidate);
    if (!stat.isDirectory() && !stat.isFile()) {
      return topologyError(`${label} is not a regular file or directory.`, { label, path: candidate });
    }
    return success(candidate);
  } catch (error: unknown) {
    return topologyError(`${label} does not exist.`, {
      label,
      path: candidate,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

function destinationParents(destination: string): string[] {
  const parent = path.posix.dirname(destination);
  if (parent === "/" || parent === ".") return [];
  const parts = parent.split("/").filter(Boolean);
  const result: string[] = [];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    result.push(current);
  }
  return result;
}

function addDirectory(args: string[], destination: string, seen: Set<string>): void {
  for (const parent of destinationParents(destination)) {
    if (seen.has(parent)) continue;
    seen.add(parent);
    args.push("--dir", parent);
  }
}

function addReadOnlyBind(args: string[], source: string, destination: string, seenDirectories: Set<string>): void {
  addDirectory(args, destination, seenDirectories);
  args.push("--ro-bind", source, destination);
}

function addReadWriteBind(args: string[], source: string, destination: string, seenDirectories: Set<string>): void {
  addDirectory(args, destination, seenDirectories);
  args.push("--bind", source, destination);
}

function pathEntriesForEnvironment(request: SandboxExecutionRequest): string[] {
  const entries: string[] = [];
  const sources = new Set(request.filesystem.runtime_paths);
  const system = new Set(request.filesystem.system_paths);
  const tools = new Set(request.filesystem.user_tool_paths);
  const hostHome = request.filesystem.user_tool_home ?? process.env.HOME;
  if (tools.has(path.join(hostHome ?? "", ".local", "bin"))) entries.push(`${SANDBOX_LOCAL_HOME}/bin`);
  if (tools.has(path.join(hostHome ?? "", ".local", "share", "pnpm"))) {
    entries.push(`${SANDBOX_LOCAL_HOME}/share/pnpm`);
  }
  if (sources.has("/run/current-system")) entries.push("/run/current-system/sw/bin");
  if (sources.has("/run/wrappers")) entries.push("/run/wrappers/bin");
  const profile = [...sources].find((source) => source.startsWith("/etc/profiles/per-user/"));
  if (profile !== undefined) entries.push(`${profile}/bin`);
  if (system.has("/usr")) entries.push("/usr/local/bin", "/usr/bin");
  if (system.has("/bin")) entries.push("/bin");
  return [...new Set(entries)];
}

function validateExecutable(request: SandboxExecutionRequest): DomainResult<string> {
  if (!request.enforce) {
    return failure(
      new DomainError(
        "SANDBOX_CAPABILITY_UNAVAILABLE",
        "A sandbox launcher cannot execute an advisory request without protected enforcement.",
        { enforce: false, session_id: request.session_id },
      ),
    );
  }
  if (request.sandbox_executable === null || !path.isAbsolute(request.sandbox_executable)) {
    return failure(
      new DomainError(
        "SANDBOX_CAPABILITY_UNAVAILABLE",
        "Bubblewrap was not resolved for the protected execution request.",
        { session_id: request.session_id },
      ),
    );
  }
  const checked = ensureSourcePath(request.sandbox_executable, "bubblewrap executable");
  if (!checked.ok) return checked;
  try {
    const stat = fs.statSync(request.sandbox_executable);
    const resolved = fs.realpathSync.native(request.sandbox_executable);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) {
      return failure(
        new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", "The resolved bubblewrap path is not executable.", {
          path: request.sandbox_executable,
        }),
      );
    }
    if (
      !allowedSystemPath(resolved) &&
      allowedUserToolPath(resolved, request.filesystem.user_tool_home) === null &&
      !allowedRuntimePath(resolved)
    ) {
      return topologyError("Bubblewrap resolved outside the fixed runtime profile.", {
        path: request.sandbox_executable,
        resolved,
      });
    }
  } catch {
    return failure(
      new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", "The resolved bubblewrap path cannot be canonicalized.", {
        path: request.sandbox_executable,
      }),
    );
  }
  return checked;
}

function sandboxPathForLandlockHelper(source: string, request: SandboxExecutionRequest): string {
  const kind = allowedUserToolPath(source, request.filesystem.user_tool_home);
  if (kind === "local_bin") return `${SANDBOX_LOCAL_HOME}/bin/${path.basename(source)}`;
  if (kind === "local_lib") return `${SANDBOX_LOCAL_HOME}/lib/${path.basename(source)}`;
  if (kind === "pnpm_bin") return `${SANDBOX_LOCAL_HOME}/share/pnpm/${path.basename(source)}`;
  return source;
}

function validateLandlockExecutable(request: SandboxExecutionRequest): DomainResult<string | null> {
  const source = request.landlock_executable;
  if (source === undefined || source === null) return success(null);
  if (!path.isAbsolute(source) || source.includes("\0")) {
    return topologyError("The Landlock runtime adapter must be an absolute path without NUL bytes.", {
      path: source,
    });
  }
  const checked = ensureSourcePath(source, "Landlock runtime adapter");
  if (!checked.ok) return checked;
  try {
    const stat = fs.statSync(source);
    if (!stat.isFile() || (stat.mode & 0o111) === 0) {
      return failure(
        new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", "The Landlock runtime adapter is not executable.", {
          path: source,
        }),
      );
    }
    const resolved = fs.realpathSync.native(source);
    if (
      !allowedSystemPath(resolved) &&
      !allowedRuntimePath(resolved) &&
      allowedUserToolPath(resolved, request.filesystem.user_tool_home) === null
    ) {
      return topologyError("The Landlock runtime adapter resolves outside the canonical runtime profile.", {
        path: source,
        resolved,
      });
    }
    return success(sandboxPathForLandlockHelper(resolved, request));
  } catch {
    return failure(
      new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", "The Landlock runtime adapter cannot be canonicalized.", {
        path: source,
      }),
    );
  }
}

function validateProfilePaths(request: SandboxExecutionRequest): DomainResult<null> {
  for (const source of request.filesystem.runtime_paths) {
    if (!allowedRuntimePath(source)) {
      return topologyError("The runtime path is outside the canonical profile.", { path: source });
    }
    if (source === "/dev" || source === "/proc" || source === "/tmp") continue;
    const checked = ensureSourcePath(source, "runtime path");
    if (!checked.ok) return checked;
    try {
      const resolved = fs.realpathSync.native(source);
      if (!allowedRuntimePath(resolved)) {
        return topologyError("The runtime path symlink resolves outside the canonical profile.", {
          path: source,
          resolved,
        });
      }
    } catch {
      return topologyError("The runtime path cannot be canonicalized.", { path: source });
    }
  }
  for (const source of request.filesystem.system_paths) {
    if (!allowedSystemPath(source)) {
      return topologyError("The system path is outside the canonical profile.", { path: source });
    }
    const checked = ensureSourcePath(source, "system path");
    if (!checked.ok) return checked;
    try {
      const resolved = fs.realpathSync.native(source);
      if (!allowedSystemPath(resolved)) {
        return topologyError("The system path symlink resolves outside the canonical profile.", {
          path: source,
          resolved,
        });
      }
    } catch {
      return topologyError("The system path cannot be canonicalized.", { path: source });
    }
  }
  for (const source of request.filesystem.user_tool_paths) {
    if (allowedUserToolPath(source, request.filesystem.user_tool_home) === null) {
      return topologyError("The user-tool path is outside the selected local-tool profile.", { path: source });
    }
    const checked = ensureSourcePath(source, "user-tool path");
    if (!checked.ok) return checked;
    try {
      const resolved = fs.realpathSync.native(source);
      if (allowedUserToolPath(resolved, request.filesystem.user_tool_home) === null) {
        return topologyError("The user-tool path symlink resolves outside the selected profile.", {
          path: source,
          resolved,
        });
      }
    } catch {
      return topologyError("The user-tool path cannot be canonicalized.", { path: source });
    }
  }
  return success(null);
}

function worktreeGitDirectory(worktree: string): string | null {
  try {
    const entry = path.join(worktree, ".git");
    const stat = fs.lstatSync(entry);
    if (stat.isSymbolicLink()) return null;
    if (stat.isDirectory()) return entry;
    const text = fs.readFileSync(entry, "utf8").trim();
    if (!text.startsWith("gitdir:")) return null;
    return path.resolve(worktree, text.slice("gitdir:".length).trim());
  } catch {
    return null;
  }
}

function copyIfRegular(source: string, destination: string): void {
  try {
    if (fs.lstatSync(source).isFile()) fs.copyFileSync(source, destination);
  } catch {
    // Optional Git metadata is intentionally omitted when unavailable.
  }
}

function prepareGitMetadata(request: SandboxExecutionRequest, topology: ValidatedTopology): DomainResult<null> {
  try {
    fs.mkdirSync(topology.git_metadata, { recursive: true, mode: 0o700 });
    fs.writeFileSync(
      path.join(topology.git_metadata, "config"),
      "[core]\n\trepositoryformatversion = 0\n\tbare = false\n",
      { mode: 0o600 },
    );
    const admin = worktreeGitDirectory(topology.worktree);
    if (admin !== null) {
      copyIfRegular(path.join(admin, "HEAD"), path.join(topology.git_metadata, "HEAD"));
      copyIfRegular(path.join(admin, "index"), path.join(topology.git_metadata, "index"));
      let head = "";
      try {
        head = fs.readFileSync(path.join(admin, "HEAD"), "utf8").trim();
      } catch {
        head = "";
      }
      const reference = /^ref:\s+(refs\/heads\/[A-Za-z0-9._/-]+)$/u.exec(head)?.[1];
      if (reference !== undefined) {
        if (reference.split("/").some((part) => part === "." || part === "..")) {
          return topologyError("The authoritative Git HEAD contains an unsafe ref path.", {
            session_id: request.session_id,
            reference,
          });
        }
        const commonDirectory = path.dirname(topology.git_objects);
        const source = path.join(commonDirectory, reference);
        const destination = path.join(topology.git_metadata, reference);
        fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
        copyIfRegular(source, destination);
      }
      const commonDirectory = path.dirname(topology.git_objects);
      copyIfRegular(path.join(commonDirectory, "packed-refs"), path.join(topology.git_metadata, "packed-refs"));
    }
    if (!fs.existsSync(path.join(topology.git_metadata, "HEAD"))) {
      fs.writeFileSync(path.join(topology.git_metadata, "HEAD"), "ref: refs/heads/main\n", { mode: 0o600 });
    }
    return success(null);
  } catch (error: unknown) {
    return topologyError("Session-private Git metadata could not be prepared.", {
      session_id: request.session_id,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

/**
 * Compile one authoritative request into a deterministic bubblewrap argv.
 * Mounts are derived from fixed topology fields; caller data is used only as
 * the command and its argv, after the bwrap `--` terminator.
 */
export function compileSandboxInvocation(
  request: SandboxExecutionRequest,
  command: SandboxCommand,
): DomainResult<SandboxInvocation> {
  const executable = validateExecutable(request);
  if (!executable.ok) return executable;
  if (command.command.length === 0 || command.command.includes("\0")) {
    return topologyError("The sandbox command must be non-empty and contain no NUL bytes.", {
      command: command.command,
    });
  }
  const commandArgs = [...(command.args ?? [])];
  if (commandArgs.some((argument) => argument.includes("\0"))) {
    return topologyError("Sandbox command arguments cannot contain NUL bytes.", { session_id: request.session_id });
  }

  const topology = validateTopology(request);
  if (!topology.ok) return topology;
  const profilePaths = validateProfilePaths(request);
  if (!profilePaths.ok) return profilePaths;
  if (
    request.seccomp_profile.id !== SANDBOX_SECCOMP_PROFILE_ID ||
    request.seccomp_profile.version !== SANDBOX_SECCOMP_PROFILE_VERSION ||
    request.capability_baseline.id !== SANDBOX_CAPABILITY_BASELINE_ID ||
    request.capability_baseline.version !== SANDBOX_CAPABILITY_BASELINE_VERSION ||
    request.capability_baseline.ambient_capabilities.length !== 0
  ) {
    return failure(
      new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", "The protected execution security baseline is incompatible.", {
        seccomp_profile_id: request.seccomp_profile.id,
        seccomp_profile_version: request.seccomp_profile.version,
        capability_baseline_id: request.capability_baseline.id,
        capability_baseline_version: request.capability_baseline.version,
      }),
    );
  }
  const seccompProfile = compileSandboxSeccompProfile(request.seccomp_profile.architecture);
  if (!seccompProfile.ok) return seccompProfile;
  const landlockAbi = request.landlock_abi ?? null;
  const landlockSupported =
    landlockAbi !== null && Number.isSafeInteger(landlockAbi) && landlockAbi >= LANDLOCK_ABI_MINIMUM;
  const landlockUnavailableState: LandlockEffectiveState =
    request.landlock_state === "error" || (landlockAbi !== null && !Number.isSafeInteger(landlockAbi))
      ? "error"
      : landlockAbi === null
        ? "reduced-defense"
        : "incompatible";
  const landlockRequired = request.landlock_required === true;
  if (landlockRequired && !landlockSupported) {
    return failure(
      new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", "The required Landlock ABI is unavailable or incompatible.", {
        session_id: request.session_id,
        abi: landlockAbi,
        effective_state: landlockUnavailableState,
      }),
    );
  }
  const landlockSource = request.landlock_executable ?? null;
  const shouldValidateLandlock = landlockRequired || (landlockSupported && landlockSource !== null);
  const landlockExecutable = shouldValidateLandlock ? validateLandlockExecutable(request) : success(null);
  if (!landlockExecutable.ok) return landlockExecutable;
  if (landlockRequired && landlockExecutable.value === null) {
    return failure(
      new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", "The required Landlock runtime adapter is unavailable.", {
        session_id: request.session_id,
        abi: landlockAbi,
      }),
    );
  }
  const landlockEnabled = landlockSupported && landlockExecutable.value !== null;
  const landlockRules = deriveLandlockRules(request.filesystem);
  const gitMetadata = prepareGitMetadata(request, topology.value);
  if (!gitMetadata.ok) return gitMetadata;
  const pathValue = pathEntriesForEnvironment(request).join(":");

  const args: string[] = [
    "--die-with-parent",
    "--new-session",
    "--unshare-user",
    "--unshare-pid",
    "--unshare-ipc",
    "--unshare-uts",
    "--disable-userns",
    "--uid",
    "0",
    "--gid",
    "0",
    "--cap-drop",
    "ALL",
    "--seccomp",
    "3",
    "--clearenv",
    "--setenv",
    "HOME",
    SANDBOX_HOME,
    "--setenv",
    "TMPDIR",
    "/tmp",
    "--setenv",
    "XDG_CONFIG_HOME",
    SANDBOX_CONFIG_HOME,
    "--setenv",
    "XDG_CACHE_HOME",
    SANDBOX_CACHE_HOME,
    "--setenv",
    "XDG_DATA_HOME",
    `${SANDBOX_LOCAL_HOME}/share`,
    "--setenv",
    "USER",
    "nawabari",
    "--setenv",
    "LOGNAME",
    "nawabari",
    "--setenv",
    "NAWABARI_SESSION_ID",
    request.session_id,
    "--setenv",
    "PATH",
    pathValue,
    "--setenv",
    "GIT_DIR",
    "/nawabari/git",
    "--setenv",
    "GIT_WORK_TREE",
    topology.value.worktree,
    "--setenv",
    "GIT_CONFIG_NOSYSTEM",
    "1",
    "--setenv",
    "GIT_CONFIG_GLOBAL",
    "/dev/null",
    "--tmpfs",
    "/",
    "--dev",
    "/dev",
    "--proc",
    "/proc",
    "--tmpfs",
    "/tmp",
  ];
  const seenDirectories = new Set<string>();
  const worktreeDestination = topology.value.worktree;
  addReadWriteBind(args, topology.value.worktree, worktreeDestination, seenDirectories);
  addReadWriteBind(args, topology.value.home, SANDBOX_HOME, seenDirectories);
  addReadWriteBind(args, topology.value.cache, SANDBOX_CACHE_HOME, seenDirectories);
  addReadWriteBind(args, topology.value.persistent_home, SANDBOX_SHARED_HOME, seenDirectories);
  addReadWriteBind(args, topology.value.git_metadata, "/nawabari/git", seenDirectories);
  addReadOnlyBind(args, topology.value.git_objects, "/nawabari/git/objects", seenDirectories);

  for (const source of request.filesystem.user_tool_paths) {
    const kind = allowedUserToolPath(source, request.filesystem.user_tool_home);
    if (kind === "local_bin") addReadOnlyBind(args, source, `${SANDBOX_LOCAL_HOME}/bin`, seenDirectories);
    if (kind === "local_lib") addReadOnlyBind(args, source, `${SANDBOX_LOCAL_HOME}/lib`, seenDirectories);
    if (kind === "pnpm_bin") {
      addReadOnlyBind(args, source, `${SANDBOX_LOCAL_HOME}/share/pnpm`, seenDirectories);
    }
  }
  for (const source of request.filesystem.runtime_paths) {
    if (source === "/dev" || source === "/proc" || source === "/tmp") continue;
    addReadOnlyBind(args, source, source, seenDirectories);
  }
  for (const source of request.filesystem.system_paths) addReadOnlyBind(args, source, source, seenDirectories);

  for (const parent of destinationParents(worktreeDestination)) {
    if (seenDirectories.has(parent)) continue;
    seenDirectories.add(parent);
    args.push("--dir", parent);
  }
  const commandArgv = landlockEnabled
    ? [
        landlockExecutable.value as string,
        "-c",
        LANDLOCK_TRAMPOLINE,
        JSON.stringify(landlockRules),
        "--",
        command.command,
        ...commandArgs,
      ]
    : [command.command, ...commandArgs];
  args.push("--chdir", worktreeDestination, "--", ...commandArgv);

  const env: Record<string, string> = {
    PATH: pathValue,
    HOME: SANDBOX_HOME,
    TMPDIR: "/tmp",
    XDG_CONFIG_HOME: SANDBOX_CONFIG_HOME,
    XDG_CACHE_HOME: SANDBOX_CACHE_HOME,
    XDG_DATA_HOME: `${SANDBOX_LOCAL_HOME}/share`,
    USER: "nawabari",
    LOGNAME: "nawabari",
    NAWABARI_SESSION_ID: request.session_id,
  };
  return success({
    executable: executable.value,
    args,
    cwd: topology.value.worktree,
    env,
    seccomp_profile: seccompProfile.value,
    seccomp_profile_metadata: request.seccomp_profile,
    landlock: {
      abi: landlockAbi,
      state: landlockEnabled ? "enforced" : landlockUnavailableState,
      rule_count: landlockRules.length,
    },
  });
}

type SeccompProfileHandle = {
  readonly fd: number;
  readonly close: () => void;
};

/**
 * Give bubblewrap an unlinked, read-only profile file.  The descriptor stays
 * open only for the launch; no profile pathname is exposed inside the child.
 */
function openSeccompProfile(profile: Uint8Array): DomainResult<SeccompProfileHandle> {
  let directory: string | null = null;
  let fd: number | null = null;
  try {
    directory = fs.mkdtempSync(path.join(requirementTempDirectory(), "nawabari-seccomp-"));
    const profilePath = path.join(directory, "profile.bpf");
    fs.writeFileSync(profilePath, profile, { mode: 0o600 });
    fd = fs.openSync(profilePath, fs.constants.O_RDONLY);
    fs.unlinkSync(profilePath);
    fs.rmdirSync(directory);
    directory = null;
    return success({
      fd,
      close: () => {
        try {
          fs.closeSync(fd as number);
        } catch {
          // Closing an already-closed descriptor is harmless cleanup.
        }
      },
    });
  } catch (error: unknown) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        // Preserve the original setup failure.
      }
    }
    if (directory !== null) {
      try {
        fs.rmSync(directory, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup; the profile is never used after setup failure.
      }
    }
    return failure(
      new DomainError(
        "SANDBOX_EXECUTION_FAILED",
        "The seccomp baseline could not be prepared for protected execution.",
        {
          profile_id: SANDBOX_SECCOMP_PROFILE_ID,
          reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        },
      ),
    );
  }
}

function requirementTempDirectory(): string {
  return process.env.TMPDIR !== undefined && path.isAbsolute(process.env.TMPDIR) ? process.env.TMPDIR : "/tmp";
}

function boundedOutput(
  chunks: string[],
  bytes: number,
  maxBytes: number,
  value: Buffer | string,
): { readonly bytes: number; readonly exceeded: boolean } {
  const encoded = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  const textBytes = encoded.byteLength;
  const remaining = maxBytes - bytes;
  if (remaining <= 0) return { bytes, exceeded: textBytes > 0 };
  if (textBytes <= remaining) {
    chunks.push(encoded.toString("utf8"));
    return { bytes: bytes + textBytes, exceeded: false };
  }
  // Do not let a partial UTF-8 code point turn into U+FFFD and exceed the
  // advertised byte bound.  The launcher reports text, but the bound is
  // defined in bytes so that machine callers can rely on it for arbitrary
  // child output.
  let end = remaining;
  while (end > 0) {
    const last = encoded[end - 1] ?? 0;
    if ((last & 0x80) === 0) break;
    if ((last & 0xc0) === 0x80) {
      let start = end - 1;
      while (start > 0 && ((encoded[start - 1] ?? 0) & 0xc0) === 0x80) start -= 1;
      const lead = encoded[start] ?? 0;
      const width = (lead & 0xe0) === 0xc0 ? 2 : (lead & 0xf0) === 0xe0 ? 3 : (lead & 0xf8) === 0xf0 ? 4 : 1;
      if (start + width > end) {
        end = start;
        continue;
      }
    }
    break;
  }
  chunks.push(encoded.subarray(0, end).toString("utf8"));
  return { bytes: bytes + end, exceeded: true };
}

function landlockSetupDiagnostic(stderr: string): string | null {
  const marker = stderr.indexOf(LANDLOCK_SETUP_FAILURE_PREFIX);
  if (marker === -1) return null;
  return stderr
    .slice(marker + LANDLOCK_SETUP_FAILURE_PREFIX.length)
    .trim()
    .slice(0, 240);
}

/** Execute the compiled invocation with shell execution disabled and no fallback path. */
export function runSandboxedCommand(
  request: SandboxExecutionRequest,
  command: SandboxCommand,
  options: SandboxLauncherOptions = {},
): Promise<DomainResult<SandboxExecutionResult>> {
  const invocation = compileSandboxInvocation(request, command);
  if (!invocation.ok) return Promise.resolve(invocation);
  const timeoutMs = options.timeout_ms ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.max_output_bytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    !Number.isSafeInteger(maxOutputBytes) ||
    maxOutputBytes < 1
  ) {
    return Promise.resolve(
      failure(
        new DomainError("INVALID_ARGUMENT", "Sandbox execution limits must be positive safe integers.", {
          timeout_ms: timeoutMs,
          max_output_bytes: maxOutputBytes,
        }),
      ),
    );
  }

  const started = Date.now();
  const profile = openSeccompProfile(invocation.value.seccomp_profile);
  if (!profile.ok) return Promise.resolve(profile);
  let cgroupScope: CgroupScope | null = null;
  const cgroupConfig = request.cgroups;
  if (cgroupConfig !== undefined && (cgroupConfig.required || cgroupConfig.limits !== undefined)) {
    const scope = createCgroupScope(
      { session_id: request.session_id, execution_id: cgroupConfig.execution_id },
      { root: cgroupConfig.root, limits: cgroupConfig.limits },
    );
    if (!scope.ok) {
      profile.value.close();
      return Promise.resolve(scope);
    }
    cgroupScope = scope.value;
  }
  let child;
  try {
    child = spawn(invocation.value.executable, [...invocation.value.args], {
      cwd: invocation.value.cwd,
      env: { ...invocation.value.env },
      shell: false,
      stdio: ["ignore", "pipe", "pipe", profile.value.fd],
    });
    profile.value.close();
  } catch (error: unknown) {
    profile.value.close();
    if (cgroupScope !== null) cleanupCgroupScope(cgroupScope);
    return Promise.resolve(
      failure(
        new DomainError("SANDBOX_EXECUTION_FAILED", "Bubblewrap could not be started.", {
          reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
        }),
      ),
    );
  }

  if (cgroupScope !== null) {
    const childPid = child.pid;
    if (typeof childPid !== "number" || !Number.isSafeInteger(childPid) || childPid < 1) {
      child.kill("SIGKILL");
      cleanupCgroupScope(cgroupScope);
      return Promise.resolve(
        failure(
          new DomainError(
            "SANDBOX_CGROUP_SETUP_FAILED",
            "The protected process did not expose a valid process id.",
            {},
          ),
        ),
      );
    }
    const attached = attachProcessToCgroup(cgroupScope, childPid);
    if (!attached.ok) {
      child.kill("SIGKILL");
      cleanupCgroupScope(cgroupScope);
      return Promise.resolve(attached);
    }
  }

  return new Promise((resolve) => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    let outputBytes = 0;
    let timedOut = false;
    let outputExceeded = false;
    let spawnError: Error | null = null;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);

    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const accounting = cgroupScope === null ? null : readCgroupAccounting(cgroupScope);
      if (cgroupScope !== null) {
        const cleaned = cleanupCgroupScope(cgroupScope);
        if (!cleaned.ok) {
          resolve(cleaned);
          return;
        }
      }
      const resourceDetails: JsonObject =
        cgroupScope === null || accounting === null
          ? {}
          : {
              cgroup_scope: cgroupScope.name,
              cgroup_accounting: accounting as unknown as JsonObject,
              cgroup_limit_events: cgroupLimitEvents(accounting),
            };
      if (spawnError !== null) {
        resolve(
          failure(
            new DomainError("SANDBOX_EXECUTION_FAILED", "Bubblewrap failed before the command could run.", {
              reason: spawnError.message.slice(0, 200),
              ...resourceDetails,
            }),
          ),
        );
        return;
      }
      if (timedOut) {
        resolve(
          failure(
            new DomainError("SANDBOX_EXECUTION_TIMEOUT", "The sandboxed command exceeded its execution timeout.", {
              timeout_ms: timeoutMs,
              ...resourceDetails,
            }),
          ),
        );
        return;
      }
      if (outputExceeded) {
        resolve(
          failure(
            new DomainError("SANDBOX_OUTPUT_LIMIT", "The sandboxed command exceeded its output limit.", {
              max_output_bytes: maxOutputBytes,
              ...resourceDetails,
            }),
          ),
        );
        return;
      }
      const diagnostic = stderr.join("");
      if (code !== 0 && /^bwrap:/mu.test(diagnostic)) {
        const seccompFailure = /seccomp/u.test(diagnostic);
        resolve(
          failure(
            new DomainError(
              seccompFailure ? "SANDBOX_CAPABILITY_UNAVAILABLE" : "SANDBOX_EXECUTION_FAILED",
              seccompFailure
                ? "The required seccomp baseline could not be applied by bubblewrap."
                : "Bubblewrap could not establish the protected execution boundary.",
              {
                profile_id: invocation.value.seccomp_profile_metadata.id,
                profile_version: invocation.value.seccomp_profile_metadata.version,
                stderr: diagnostic.slice(0, maxOutputBytes),
              },
            ),
          ),
        );
        return;
      }
      const landlockDiagnostic =
        invocation.value.landlock.state === "enforced" ? landlockSetupDiagnostic(diagnostic) : null;
      if (landlockDiagnostic !== null) {
        resolve(
          failure(
            new DomainError(
              "SANDBOX_EXECUTION_FAILED",
              "Landlock setup failed; the protected command was not executed.",
              {
                session_id: request.session_id,
                abi: invocation.value.landlock.abi,
                effective_state: "error",
                retryable: false,
                diagnostic: landlockDiagnostic,
              },
            ),
          ),
        );
        return;
      }
      resolve(
        success({
          exit_code: code,
          signal,
          stdout: stdout.join(""),
          stderr: stderr.join(""),
          duration_ms: Date.now() - started,
          seccomp_profile: invocation.value.seccomp_profile_metadata,
          ...(cgroupScope === null || accounting === null
            ? {}
            : {
                resources: {
                  cgroup_contract_id: cgroupScope.contract_id,
                  scope: cgroupScope.name,
                  accounting,
                  limit_events: cgroupLimitEvents(accounting),
                },
              }),
          landlock: invocation.value.landlock,
        }),
      );
    };

    child.stdout?.on("data", (value: Buffer | string) => {
      const collected = boundedOutput(stdout, outputBytes, maxOutputBytes, value);
      outputBytes = collected.bytes;
      if (collected.exceeded) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.stderr?.on("data", (value: Buffer | string) => {
      const collected = boundedOutput(stderr, outputBytes, maxOutputBytes, value);
      outputBytes = collected.bytes;
      if (collected.exceeded) {
        outputExceeded = true;
        child.kill("SIGKILL");
      }
    });
    child.on("error", (error: Error) => {
      spawnError = error;
    });
    child.on("close", (code, signal) => finish(code, signal));
  });
}

export { deriveLandlockRules } from "./landlock.js";
