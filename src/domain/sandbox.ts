import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";

import { DomainError, failure, success, type DomainResult, type ErrorCode, type JsonObject } from "./errors.js";
import type { SessionBackend, SessionContext } from "./session.js";

/**
 * Versioned identity for the Linux sandbox execution contract (Issue #81).
 * This contract binds exactly one existing Nawabari session to an execution
 * request; it does not create a parallel session identity. It defines
 * capability/doctor state and one typed execution request/result. It does
 * not implement bubblewrap mounts; that is the next, downstream child.
 */
export const SANDBOX_CONTRACT_ID = "nawabari.sandbox-execution.v1" as const;
export const SANDBOX_CONTRACT_SCHEMA_VERSION = 1 as const;

/** Nawabari's only supported sandbox execution platform. */
export const SANDBOX_SUPPORTED_PLATFORM = "linux" as const;

export type SandboxCapabilityId =
  | "bubblewrap"
  | "user_namespaces"
  | "mount_namespaces"
  | "pid_namespace"
  | "ipc_namespace"
  | "uts_namespace"
  | "cgroups_v2"
  | "landlock"
  | "seccomp"
  | "capabilities";

/**
 * Capabilities without which protected execution cannot be established at
 * all: the bwrap binary plus the namespace classes bwrap unshares by
 * default. Missing any of these fails resolution closed.
 */
export const SANDBOX_REQUIRED_CAPABILITIES: readonly SandboxCapabilityId[] = Object.freeze([
  "bubblewrap",
  "user_namespaces",
  "mount_namespaces",
  "pid_namespace",
  "ipc_namespace",
  "uts_namespace",
]);

/** Defense-in-depth capabilities that strengthen but do not gate readiness. */
export const SANDBOX_OPTIONAL_CAPABILITIES: readonly SandboxCapabilityId[] = Object.freeze([
  "cgroups_v2",
  "landlock",
  "seccomp",
  "capabilities",
]);

export type SandboxCapabilityRequirement = "required" | "optional";
export type SandboxCapabilityStatus = "available" | "unavailable" | "not_applicable";

export type SandboxCapabilityCheck = {
  id: SandboxCapabilityId;
  requirement: SandboxCapabilityRequirement;
  status: SandboxCapabilityStatus;
  code: ErrorCode | null;
  message: string;
  details: JsonObject;
};

/**
 * Network isolation is a non-goal of this first contract. `inherited` is the
 * only honest value: the sandbox process shares the host network namespace.
 */
export type SandboxNetworkMode = "inherited";

export type SandboxDoctorReport = {
  schema_version: number;
  contract_id: string;
  platform: string;
  platform_supported: boolean;
  network_mode: SandboxNetworkMode;
  capabilities: SandboxCapabilityCheck[];
  ready: boolean;
  missing_required: SandboxCapabilityId[];
};

/**
 * The real repository UID/GID is never equated with the namespace-local
 * identity a sandboxed process observes; the two are represented separately.
 */
export type SandboxIdentity = {
  real_uid: number | null;
  real_gid: number | null;
  namespace_uid: number;
  namespace_gid: number;
};

/**
 * Typed filesystem topology inputs. These are derived from authoritative
 * session/runtime configuration only; there is no caller-supplied mount
 * string policy language.
 */
export type SandboxFilesystemTopology = {
  owned_worktree: string;
  home: string;
  cache: string;
  /** Repository-owned state shared by sessions; only this selected subtree is mounted. */
  persistent_home: string;
  /** Session-private Git admin view; the host worktree admin directory is never mounted. */
  git_metadata: string;
  /** Repository object database, exposed read-only for Git inspection. */
  git_objects: string;
  /** Host user-tool directories selected by the canonical profile and mounted read-only. */
  user_tool_paths: string[];
  /** Host HOME used to derive the selected user-tool paths; never mounted itself. */
  user_tool_home?: string | null;
  runtime_paths: string[];
  system_paths: string[];
};

export type SandboxExecutionRequest = {
  schema_version: number;
  contract_id: string;
  /**
   * Mirrors `SandboxExecutionOptions.enforce`. `true` means capability
   * resolution already proved readiness and a downstream executor must
   * establish protected execution. `false` means readiness was not required
   * to reach this request, so a downstream executor may still need to fall
   * back to the legacy unsandboxed path.
   */
  enforce: boolean;
  session_id: string;
  repository: string;
  worktree: string;
  branch: string;
  network_mode: SandboxNetworkMode;
  /** Resolved host path to bubblewrap; null is valid only for advisory requests. */
  sandbox_executable: string | null;
  identity: SandboxIdentity;
  filesystem: SandboxFilesystemTopology;
  required_capabilities: SandboxCapabilityId[];
};

export type SandboxExecutionOptions = {
  session_id: string | null;
  /** When true, resolution fails closed instead of returning an unsandboxed request. */
  enforce: boolean;
};

/** Injectable capability probe so doctor/resolution logic stays host-independent and testable. */
export type SandboxProbe = {
  platform(): string;
  uid(): number | null;
  gid(): number | null;
  hasBubblewrap(): boolean;
  /**
   * Proves user, mount, PID, IPC, and UTS namespace creation together by
   * actually asking bubblewrap to unshare all of them, not by inferring
   * support from `/proc/self/ns/*` existence. Those files describe the
   * calling process's own current namespace membership — present on any
   * modern kernel — and prove nothing about whether this host or its
   * container/seccomp/AppArmor policy permits `clone(CLONE_NEWUSER)` and
   * friends. False-positive readiness here would let `enforce: true`
   * resolve successfully even though bwrap cannot actually sandbox.
   */
  hasNamespaceSupport(): boolean;
  hasCgroupsV2(): boolean;
  hasLandlock(): boolean;
  hasSeccomp(): boolean;
  hasCapabilities(): boolean;
};

/**
 * Explicit runtime inputs consumed by the canonical profile. The shape is
 * intentionally fixed: callers can select a supported runtime layout, but
 * cannot supply an arbitrary list of mount source/destination pairs.
 */
export type SandboxRuntimeLayout = {
  bubblewrap: string | null;
  /** Host HOME used only to resolve the selected read-only tool directories. */
  user_home?: string | null;
  user_local_bin: string | null;
  user_local_lib: string | null;
  user_pnpm_bin: string | null;
  nix_store: string | null;
  nix_current_system: string | null;
  nix_wrappers: string | null;
  nix_user_profile: string | null;
  usr: string | null;
  bin: string | null;
  lib: string | null;
  lib64: string | null;
  passwd: string | null;
  group: string | null;
  nsswitch: string | null;
  hosts: string | null;
  resolv_conf: string | null;
  alternatives: string | null;
  ssl_certs: string | null;
  pki_certs: string | null;
  ca_certificates: string | null;
};

function pathExists(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

function existingPath(candidate: string): string | null {
  return pathExists(candidate) ? candidate : null;
}

function commandExistsOnPath(command: string, environment: NodeJS.ProcessEnv = process.env): boolean {
  return executableOnPath(command, environment) !== null;
}

function executableOnPath(command: string, environment: NodeJS.ProcessEnv = process.env): string | null {
  const pathEnvironment = environment.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  for (const directory of pathEnvironment.split(separator)) {
    if (directory.length === 0) continue;
    const candidate = path.join(directory, command);
    if (pathExists(candidate)) return candidate;
  }
  return null;
}

function kernelSupportsLandlockAbi(): boolean {
  const [majorText, minorText] = os.release().split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 5 || (major === 5 && minor >= 13);
}

const BUBBLEWRAP_NAMESPACE_PROBE_TIMEOUT_MS = 5_000;

/**
 * Execution-level evidence: actually unshare every required namespace class
 * through bwrap itself instead of trusting static filesystem evidence. A
 * process that already has its own namespace handles (every process does)
 * says nothing about whether creating *new* ones is permitted here.
 */
function probeBubblewrapNamespaceSupport(hasBwrap: boolean): boolean {
  if (!hasBwrap) return false;
  const bwrap = executableOnPath("bwrap");
  if (bwrap === null) return false;
  try {
    execFileSync(
      bwrap,
      ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--ro-bind", "/", "/", "true"],
      { stdio: ["ignore", "ignore", "ignore"], timeout: BUBBLEWRAP_NAMESPACE_PROBE_TIMEOUT_MS },
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * Local kernel/runtime capability probes. Required namespace support is
 * verified by an actual bubblewrap execution probe; optional capabilities
 * remain best-effort static filesystem evidence since they never gate
 * `ready`.
 */
export const defaultSandboxProbe: SandboxProbe = Object.freeze({
  platform: () => process.platform,
  uid: () => (typeof process.getuid === "function" ? process.getuid() : null),
  gid: () => (typeof process.getgid === "function" ? process.getgid() : null),
  hasBubblewrap: () => commandExistsOnPath("bwrap"),
  hasNamespaceSupport: () => probeBubblewrapNamespaceSupport(commandExistsOnPath("bwrap")),
  hasCgroupsV2: () => pathExists("/sys/fs/cgroup/cgroup.controllers"),
  hasLandlock: () => pathExists("/sys/kernel/security/landlock") || kernelSupportsLandlockAbi(),
  hasSeccomp: () => pathExists("/proc/sys/kernel/seccomp"),
  hasCapabilities: () => pathExists("/proc/self/status"),
});

/**
 * user_namespaces/mount_namespaces/pid_namespace/ipc_namespace/uts_namespace
 * are reported as distinct capability ids for machine-readability, but all
 * five share one execution-level probe: bwrap needs every one of them
 * together to sandbox anything, so proving them together is what the
 * doctor's `ready` signal actually needs.
 */
const CAPABILITY_PROBE: Readonly<Record<SandboxCapabilityId, (probe: SandboxProbe) => boolean>> = Object.freeze({
  bubblewrap: (probe) => probe.hasBubblewrap(),
  user_namespaces: (probe) => probe.hasNamespaceSupport(),
  mount_namespaces: (probe) => probe.hasNamespaceSupport(),
  pid_namespace: (probe) => probe.hasNamespaceSupport(),
  ipc_namespace: (probe) => probe.hasNamespaceSupport(),
  uts_namespace: (probe) => probe.hasNamespaceSupport(),
  cgroups_v2: (probe) => probe.hasCgroupsV2(),
  landlock: (probe) => probe.hasLandlock(),
  seccomp: (probe) => probe.hasSeccomp(),
  capabilities: (probe) => probe.hasCapabilities(),
});

const NAMESPACE_CAPABILITIES: ReadonlySet<SandboxCapabilityId> = new Set([
  "user_namespaces",
  "mount_namespaces",
  "pid_namespace",
  "ipc_namespace",
  "uts_namespace",
]);

const CAPABILITY_LABEL: Readonly<Record<SandboxCapabilityId, string>> = Object.freeze({
  bubblewrap: "The bwrap executable",
  user_namespaces: "Linux user namespaces",
  mount_namespaces: "Linux mount namespaces",
  pid_namespace: "Linux PID namespace isolation",
  ipc_namespace: "Linux IPC namespace isolation",
  uts_namespace: "Linux UTS namespace isolation",
  cgroups_v2: "The unified cgroups v2 hierarchy",
  landlock: "The Landlock LSM ABI",
  seccomp: "seccomp filtering",
  capabilities: "Linux capability-set inspection",
});

function capabilityCheck(
  id: SandboxCapabilityId,
  requirement: SandboxCapabilityRequirement,
  platformSupported: boolean,
  probe: SandboxProbe,
  namespaceSupport: boolean,
): SandboxCapabilityCheck {
  const label = CAPABILITY_LABEL[id];
  if (!platformSupported) {
    return {
      id,
      requirement,
      status: "not_applicable",
      code: "SANDBOX_UNSUPPORTED_PLATFORM",
      message: `${label} was not evaluated because the platform does not support Nawabari sandbox execution.`,
      details: {},
    };
  }
  const available = NAMESPACE_CAPABILITIES.has(id) ? namespaceSupport : CAPABILITY_PROBE[id](probe);
  return {
    id,
    requirement,
    status: available ? "available" : "unavailable",
    code: available ? null : "SANDBOX_CAPABILITY_UNAVAILABLE",
    message: available ? `${label} is available.` : `${label} is not available.`,
    details: {},
  };
}

/**
 * Pure, side-effect-free capability/doctor inspection. Always returns a
 * report; it never throws and never selects an unsandboxed path itself.
 */
export function sandboxDoctorReport(probe: SandboxProbe = defaultSandboxProbe): SandboxDoctorReport {
  const platform = probe.platform();
  const platformSupported = platform === SANDBOX_SUPPORTED_PLATFORM;
  const namespaceSupport = platformSupported && probe.hasNamespaceSupport();
  const capabilities = [
    ...SANDBOX_REQUIRED_CAPABILITIES.map((id) =>
      capabilityCheck(id, "required", platformSupported, probe, namespaceSupport),
    ),
    ...SANDBOX_OPTIONAL_CAPABILITIES.map((id) =>
      capabilityCheck(id, "optional", platformSupported, probe, namespaceSupport),
    ),
  ];
  const missingRequired = capabilities
    .filter((entry) => entry.requirement === "required" && entry.status !== "available")
    .map((entry) => entry.id);

  return {
    schema_version: SANDBOX_CONTRACT_SCHEMA_VERSION,
    contract_id: SANDBOX_CONTRACT_ID,
    platform,
    platform_supported: platformSupported,
    network_mode: "inherited",
    capabilities,
    ready: platformSupported && missingRequired.length === 0,
    missing_required: missingRequired,
  };
}

/**
 * Discover only paths from the fixed standalone-Linux and NixOS layouts.
 * `/usr` is a conditional standalone input, never the assumed root of the
 * runtime; NixOS paths are selected when they actually exist.
 */
export function discoverSandboxRuntimeLayout(environment: NodeJS.ProcessEnv = process.env): SandboxRuntimeLayout {
  const candidateHome = environment.HOME ?? null;
  const home =
    candidateHome !== null && path.isAbsolute(candidateHome) && !candidateHome.includes("\0") ? candidateHome : null;
  const user = environment.USER ?? environment.LOGNAME ?? null;
  const perUserProfile = user === null ? null : `/etc/profiles/per-user/${user}`;
  return {
    bubblewrap: executableOnPath("bwrap", environment),
    user_home: home,
    user_local_bin: home === null ? null : existingPath(path.join(home, ".local", "bin")),
    user_local_lib: home === null ? null : existingPath(path.join(home, ".local", "lib")),
    user_pnpm_bin: home === null ? null : existingPath(path.join(home, ".local", "share", "pnpm")),
    nix_store: existingPath("/nix/store"),
    nix_current_system: existingPath("/run/current-system"),
    nix_wrappers: existingPath("/run/wrappers"),
    nix_user_profile: perUserProfile === null ? null : existingPath(perUserProfile),
    usr: existingPath("/usr"),
    bin: existingPath("/bin"),
    lib: existingPath("/lib"),
    lib64: existingPath("/lib64"),
    passwd: existingPath("/etc/passwd"),
    group: existingPath("/etc/group"),
    nsswitch: existingPath("/etc/nsswitch.conf"),
    hosts: existingPath("/etc/hosts"),
    resolv_conf: existingPath("/etc/resolv.conf"),
    alternatives: existingPath("/etc/alternatives"),
    ssl_certs: existingPath("/etc/ssl"),
    pki_certs: existingPath("/etc/pki"),
    ca_certificates: existingPath("/etc/ca-certificates"),
  };
}

function nonNullPaths(paths: readonly (string | null)[]): string[] {
  return paths.filter((candidate): candidate is string => candidate !== null);
}

function sandboxRuntimePaths(layout: SandboxRuntimeLayout): string[] {
  return [
    "/dev",
    "/proc",
    "/tmp",
    ...nonNullPaths([layout.nix_store, layout.nix_current_system, layout.nix_wrappers, layout.nix_user_profile]),
  ];
}

function sandboxSystemPaths(layout: SandboxRuntimeLayout): string[] {
  return nonNullPaths([
    layout.usr,
    layout.bin,
    layout.lib,
    layout.lib64,
    layout.passwd,
    layout.group,
    layout.nsswitch,
    layout.hosts,
    layout.resolv_conf,
    layout.alternatives,
    layout.ssl_certs,
    layout.pki_certs,
    layout.ca_certificates,
  ]);
}

function deriveGitObjectsPath(repository: string, worktree: string): string {
  try {
    const worktreeGitPath = path.join(worktree, ".git");
    const gitEntry = readFileSync(worktreeGitPath, "utf8").trim();
    const gitDirectory = gitEntry.startsWith("gitdir:")
      ? path.resolve(worktree, gitEntry.slice("gitdir:".length).trim())
      : worktreeGitPath;
    const commonDirFile = path.join(gitDirectory, "commondir");
    const commonDirectory = existsSync(commonDirFile)
      ? path.resolve(gitDirectory, readFileSync(commonDirFile, "utf8").trim())
      : gitDirectory;
    const objects = path.join(commonDirectory, "objects");
    if (existsSync(objects)) return objects;
  } catch {
    // The guard has already established the session's physical authority;
    // retain a deterministic fallback for unusual non-linked Git layouts.
  }
  return path.join(repository, ".git", "objects");
}

/**
 * Typed filesystem topology derived from the authoritative repository common
 * Git directory and the resolved session identity only; callers cannot
 * inject arbitrary mount paths through this contract.
 */
function deriveFilesystemTopology(
  repository: string,
  worktree: string,
  sessionId: string,
  runtimeLayout: SandboxRuntimeLayout,
): SandboxFilesystemTopology {
  const sandboxStateRoot = path.join(repository, "nawabari", "sandbox", sessionId);
  return {
    owned_worktree: worktree,
    home: path.join(sandboxStateRoot, "home"),
    cache: path.join(sandboxStateRoot, "cache"),
    persistent_home: path.join(repository, "nawabari", "sandbox", "shared-home"),
    git_metadata: path.join(sandboxStateRoot, "git"),
    git_objects: deriveGitObjectsPath(repository, worktree),
    user_tool_paths: nonNullPaths([
      runtimeLayout.user_local_bin,
      runtimeLayout.user_local_lib,
      runtimeLayout.user_pnpm_bin,
    ]),
    user_tool_home: runtimeLayout.user_home,
    runtime_paths: sandboxRuntimePaths(runtimeLayout),
    system_paths: sandboxSystemPaths(runtimeLayout),
  };
}

function resolveIdentity(probe: SandboxProbe): SandboxIdentity {
  return {
    real_uid: probe.uid(),
    real_gid: probe.gid(),
    namespace_uid: 0,
    namespace_gid: 0,
  };
}

/**
 * Resolve one typed sandbox execution request for a single, already
 * authoritative Nawabari session. Repository/worktree/branch/session
 * identity is derived exclusively from `backend.guard`, the same
 * registry/guard authority every other governed operation uses; this
 * function does not re-verify Git or registry state on its own.
 *
 * When `options.enforce` is true and required sandbox capabilities are
 * unavailable (including an unsupported platform), resolution fails closed:
 * it never returns a request that silently downgrades to the legacy
 * unsandboxed path.
 */
export async function resolveSandboxExecutionRequest(
  backend: SessionBackend,
  context: SessionContext,
  options: SandboxExecutionOptions,
  probe: SandboxProbe = defaultSandboxProbe,
  runtimeLayout: SandboxRuntimeLayout = discoverSandboxRuntimeLayout(),
): Promise<DomainResult<SandboxExecutionRequest>> {
  const guardResult = await backend.guard(context, { session_id: options.session_id });
  if (!guardResult.ok) return failure(guardResult.error);

  const decision = guardResult.value;
  if (!decision.allowed || decision.session_id === null || decision.branch === null) {
    const code: ErrorCode = decision.code === "ALLOWED" ? "OPERATION_REJECTED" : decision.code;
    return failure(
      new DomainError(code, `Sandbox execution request was denied by the Nawabari session guard: ${code}.`, {
        guard: decision as unknown as JsonObject,
      }),
    );
  }

  const doctor = sandboxDoctorReport(probe);
  if (options.enforce && !doctor.ready) {
    const code: ErrorCode = doctor.platform_supported
      ? "SANDBOX_CAPABILITY_UNAVAILABLE"
      : "SANDBOX_UNSUPPORTED_PLATFORM";
    return failure(
      new DomainError(
        code,
        "Sandbox execution was required but could not be established; the legacy unsandboxed path was not selected.",
        {
          session_id: decision.session_id,
          platform: doctor.platform,
          platform_supported: doctor.platform_supported,
          missing_required: doctor.missing_required,
        },
      ),
    );
  }

  return success({
    schema_version: SANDBOX_CONTRACT_SCHEMA_VERSION,
    contract_id: SANDBOX_CONTRACT_ID,
    enforce: options.enforce,
    session_id: decision.session_id,
    repository: decision.repository,
    worktree: decision.worktree,
    branch: decision.branch,
    network_mode: doctor.network_mode,
    sandbox_executable: runtimeLayout.bubblewrap,
    identity: resolveIdentity(probe),
    filesystem: deriveFilesystemTopology(decision.repository, decision.worktree, decision.session_id, runtimeLayout),
    required_capabilities: [...SANDBOX_REQUIRED_CAPABILITIES],
  });
}

export {
  compileSandboxInvocation,
  runSandboxedCommand,
  type SandboxCommand,
  type SandboxExecutionResult,
  type SandboxInvocation,
  type SandboxLauncherOptions,
} from "./sandbox-launcher.js";
