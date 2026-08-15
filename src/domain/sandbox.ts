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
  runtime_paths: string[];
  system_paths: string[];
};

export type SandboxExecutionRequest = {
  schema_version: number;
  contract_id: string;
  session_id: string;
  repository: string;
  worktree: string;
  branch: string;
  network_mode: SandboxNetworkMode;
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
  hasUserNamespaces(): boolean;
  hasMountNamespaces(): boolean;
  hasPidNamespace(): boolean;
  hasIpcNamespace(): boolean;
  hasUtsNamespace(): boolean;
  hasCgroupsV2(): boolean;
  hasLandlock(): boolean;
  hasSeccomp(): boolean;
  hasCapabilities(): boolean;
};

const PROC_NS_DIRECTORY = "/proc/self/ns";
const RUNTIME_NAMESPACE_FILE: Record<"mnt" | "pid" | "ipc" | "uts" | "user", string> = {
  mnt: `${PROC_NS_DIRECTORY}/mnt`,
  pid: `${PROC_NS_DIRECTORY}/pid`,
  ipc: `${PROC_NS_DIRECTORY}/ipc`,
  uts: `${PROC_NS_DIRECTORY}/uts`,
  user: `${PROC_NS_DIRECTORY}/user`,
};

function pathExists(candidate: string): boolean {
  try {
    return existsSync(candidate);
  } catch {
    return false;
  }
}

function readTrimmed(candidate: string): string | null {
  try {
    return readFileSync(candidate, "utf8").trim();
  } catch {
    return null;
  }
}

function commandExistsOnPath(command: string): boolean {
  const pathEnvironment = process.env.PATH ?? "";
  const separator = process.platform === "win32" ? ";" : ":";
  return pathEnvironment
    .split(separator)
    .some((directory) => directory.length > 0 && pathExists(path.join(directory, command)));
}

function kernelSupportsLandlockAbi(): boolean {
  const [majorText, minorText] = os.release().split(".");
  const major = Number(majorText);
  const minor = Number(minorText);
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return false;
  return major > 5 || (major === 5 && minor >= 13);
}

/** Best-effort local kernel/runtime capability probes; no external process is spawned. */
export const defaultSandboxProbe: SandboxProbe = Object.freeze({
  platform: () => process.platform,
  uid: () => (typeof process.getuid === "function" ? process.getuid() : null),
  gid: () => (typeof process.getgid === "function" ? process.getgid() : null),
  hasBubblewrap: () => commandExistsOnPath("bwrap"),
  hasUserNamespaces: () => {
    if (!pathExists(RUNTIME_NAMESPACE_FILE.user)) return false;
    const flag = readTrimmed("/proc/sys/kernel/unprivileged_userns_clone");
    return flag === null || flag === "1";
  },
  hasMountNamespaces: () => pathExists(RUNTIME_NAMESPACE_FILE.mnt),
  hasPidNamespace: () => pathExists(RUNTIME_NAMESPACE_FILE.pid),
  hasIpcNamespace: () => pathExists(RUNTIME_NAMESPACE_FILE.ipc),
  hasUtsNamespace: () => pathExists(RUNTIME_NAMESPACE_FILE.uts),
  hasCgroupsV2: () => pathExists("/sys/fs/cgroup/cgroup.controllers"),
  hasLandlock: () => pathExists("/sys/kernel/security/landlock") || kernelSupportsLandlockAbi(),
  hasSeccomp: () => pathExists("/proc/sys/kernel/seccomp"),
  hasCapabilities: () => pathExists("/proc/self/status"),
});

const CAPABILITY_PROBE: Readonly<Record<SandboxCapabilityId, (probe: SandboxProbe) => boolean>> = Object.freeze({
  bubblewrap: (probe) => probe.hasBubblewrap(),
  user_namespaces: (probe) => probe.hasUserNamespaces(),
  mount_namespaces: (probe) => probe.hasMountNamespaces(),
  pid_namespace: (probe) => probe.hasPidNamespace(),
  ipc_namespace: (probe) => probe.hasIpcNamespace(),
  uts_namespace: (probe) => probe.hasUtsNamespace(),
  cgroups_v2: (probe) => probe.hasCgroupsV2(),
  landlock: (probe) => probe.hasLandlock(),
  seccomp: (probe) => probe.hasSeccomp(),
  capabilities: (probe) => probe.hasCapabilities(),
});

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
  const available = CAPABILITY_PROBE[id](probe);
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
  const capabilities = [
    ...SANDBOX_REQUIRED_CAPABILITIES.map((id) => capabilityCheck(id, "required", platformSupported, probe)),
    ...SANDBOX_OPTIONAL_CAPABILITIES.map((id) => capabilityCheck(id, "optional", platformSupported, probe)),
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

const SANDBOX_RUNTIME_PATHS: readonly string[] = Object.freeze(["/dev", "/proc", "/tmp"]);
const SANDBOX_SYSTEM_PATHS: readonly string[] = Object.freeze(["/usr", "/bin", "/lib", "/lib64", "/etc/resolv.conf"]);

/**
 * Typed filesystem topology derived from the authoritative repository common
 * Git directory and the resolved session identity only; callers cannot
 * inject arbitrary mount paths through this contract.
 */
function deriveFilesystemTopology(repository: string, worktree: string, sessionId: string): SandboxFilesystemTopology {
  const sandboxStateRoot = path.join(repository, "nawabari", "sandbox", sessionId);
  return {
    owned_worktree: worktree,
    home: path.join(sandboxStateRoot, "home"),
    cache: path.join(sandboxStateRoot, "cache"),
    runtime_paths: [...SANDBOX_RUNTIME_PATHS],
    system_paths: [...SANDBOX_SYSTEM_PATHS],
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
    session_id: decision.session_id,
    repository: decision.repository,
    worktree: decision.worktree,
    branch: decision.branch,
    network_mode: doctor.network_mode,
    identity: resolveIdentity(probe),
    filesystem: deriveFilesystemTopology(decision.repository, decision.worktree, decision.session_id),
    required_capabilities: [...SANDBOX_REQUIRED_CAPABILITIES],
  });
}
