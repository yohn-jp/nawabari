import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { DomainError, failure, success, type DomainResult, type JsonObject } from "./errors.js";

/** Versioned, execution-level cgroups v2 evidence/control contract. */
export const CGROUPS_V2_CONTRACT_ID = "nawabari.cgroups-v2.v1" as const;
export const CGROUPS_V2_ROOT = "/sys/fs/cgroup" as const;

const CONTROLLERS = ["cpu", "memory", "pids"] as const;
const MAX_MEMORY_LIMIT = 1_024 * 1_024 * 1_024 * 1_024;
const MAX_PIDS_LIMIT = 1_000_000;
const MAX_CGROUP_FILE_BYTES = 64 * 1_024;

export type CgroupLimitProfile = {
  /** Maximum CPU time in each period, in microseconds. */
  readonly cpu_max_usec?: number;
  /** CPU quota period in microseconds. Defaults to 100000. */
  readonly cpu_period_usec?: number;
  /** Maximum resident memory in bytes. */
  readonly memory_max_bytes?: number;
  /** Maximum number of processes/threads in the scope. */
  readonly pids_max?: number;
};

export type CgroupExecutionIdentity = {
  readonly session_id: string;
  readonly execution_id: string;
};

export type CgroupScope = {
  readonly contract_id: typeof CGROUPS_V2_CONTRACT_ID;
  readonly root: string;
  readonly parent: string;
  readonly path: string;
  readonly name: string;
  readonly identity: CgroupExecutionIdentity;
  readonly limits: CgroupLimitProfile;
};

export type CgroupAccounting = {
  readonly bounded: true;
  readonly cpu_usage_usec: number | null;
  readonly cpu_user_usec: number | null;
  readonly cpu_system_usec: number | null;
  readonly cpu_throttled_usec: number | null;
  readonly memory_current_bytes: number | null;
  readonly memory_peak_bytes: number | null;
  readonly pids_current: number | null;
  readonly pids_max_events: number | null;
  readonly memory_oom_kill_events: number | null;
  readonly memory_max_events: number | null;
  readonly cpu_throttled: boolean;
  readonly memory_limit_exceeded: boolean;
  readonly pids_limit_exceeded: boolean;
};

export type CgroupLimitEvent = "cpu" | "memory" | "pids";

export type CgroupScopeOptions = {
  readonly root?: string;
  readonly limits?: CgroupLimitProfile;
  /** Injectable filesystem boundary for hermetic tests and controlled runtimes. */
  readonly filesystem?: CgroupFileSystem;
};

export type CgroupFileSystem = {
  readonly statSync: (file: string) => { readonly isDirectory: () => boolean; readonly isFile: () => boolean };
  readonly realpathSync: (file: string) => string;
  readonly readFileSync: (file: string) => string;
  readonly writeFileSync: (file: string, value: string) => void;
  readonly mkdirSync: (file: string, options?: { readonly recursive?: boolean; readonly mode?: number }) => void;
  readonly rmdirSync: (file: string) => void;
};

const nativeFileSystem: CgroupFileSystem = {
  statSync: (file) => fs.statSync(file),
  realpathSync: (file) => fs.realpathSync.native(file),
  readFileSync: (file) => fs.readFileSync(file, { encoding: "utf8", flag: "r" }),
  writeFileSync: (file, value) => fs.writeFileSync(file, value, { encoding: "utf8" }),
  mkdirSync: (file, options) => fs.mkdirSync(file, options),
  rmdirSync: (file) => fs.rmdirSync(file),
};

const scopeFilesystems = new WeakMap<CgroupScope, CgroupFileSystem>();

function filesystemFor(scope: CgroupScope): CgroupFileSystem {
  return scopeFilesystems.get(scope) ?? nativeFileSystem;
}

function cgroupError(
  code: "SANDBOX_CGROUP_SCOPE_CONFLICT" | "SANDBOX_CGROUP_SETUP_FAILED",
  message: string,
  details: JsonObject,
): DomainResult<never> {
  return failure(new DomainError(code, message, details));
}

function capabilityError(message: string, details: JsonObject): DomainResult<never> {
  return failure(new DomainError("SANDBOX_CAPABILITY_UNAVAILABLE", message, details));
}

function cleanupError(message: string, details: JsonObject): DomainResult<never> {
  return failure(new DomainError("SANDBOX_CGROUP_CLEANUP_FAILED", message, details));
}

function isSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
}

function validateIdentity(identity: CgroupExecutionIdentity): DomainResult<null> {
  if (
    typeof identity.session_id !== "string" ||
    identity.session_id.length === 0 ||
    identity.session_id.length > 256 ||
    identity.session_id.includes("\0") ||
    typeof identity.execution_id !== "string" ||
    identity.execution_id.length === 0 ||
    identity.execution_id.length > 256 ||
    identity.execution_id.includes("\0")
  ) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The cgroup scope identity is invalid.", {
      session_id: identity.session_id,
      execution_id: identity.execution_id,
    });
  }
  return success(null);
}

function validateLimits(limits: CgroupLimitProfile): DomainResult<CgroupLimitProfile> {
  const cpuPeriod = limits.cpu_period_usec ?? 100_000;
  if (limits.cpu_max_usec !== undefined && !isSafeInteger(limits.cpu_max_usec)) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The CPU cgroup limit is invalid.", {
      limit: limits.cpu_max_usec,
    });
  }
  if (!isSafeInteger(cpuPeriod) || cpuPeriod < 1_000 || cpuPeriod > 1_000_000) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The CPU cgroup period is invalid.", { period_usec: cpuPeriod });
  }
  if (limits.cpu_max_usec !== undefined && limits.cpu_max_usec > cpuPeriod) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The CPU quota cannot exceed its period.", {
      max_usec: limits.cpu_max_usec,
      period_usec: cpuPeriod,
    });
  }
  if (
    limits.memory_max_bytes !== undefined &&
    (!isSafeInteger(limits.memory_max_bytes) || limits.memory_max_bytes > MAX_MEMORY_LIMIT)
  ) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The memory cgroup limit is invalid.", {
      limit: limits.memory_max_bytes,
    });
  }
  if (limits.pids_max !== undefined && (!isSafeInteger(limits.pids_max) || limits.pids_max > MAX_PIDS_LIMIT)) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The PID cgroup limit is invalid.", { limit: limits.pids_max });
  }
  return success({
    ...(limits.cpu_max_usec === undefined ? {} : { cpu_max_usec: limits.cpu_max_usec }),
    ...(limits.cpu_max_usec === undefined && limits.cpu_period_usec === undefined
      ? {}
      : { cpu_period_usec: cpuPeriod }),
    ...(limits.memory_max_bytes === undefined ? {} : { memory_max_bytes: limits.memory_max_bytes }),
    ...(limits.pids_max === undefined ? {} : { pids_max: limits.pids_max }),
  });
}

function validateRoot(root: string, filesystem: CgroupFileSystem): DomainResult<string> {
  if (!path.isAbsolute(root) || root.includes("\0")) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The cgroups v2 root must be an absolute path.", { root });
  }
  try {
    if (
      !filesystem.statSync(root).isDirectory() ||
      !filesystem.statSync(path.join(root, "cgroup.controllers")).isFile()
    ) {
      return capabilityError("The cgroups v2 hierarchy is unavailable.", { root });
    }
    return success(filesystem.realpathSync(root));
  } catch (error: unknown) {
    return capabilityError("The cgroups v2 hierarchy is unavailable.", {
      root,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

/** Derive a stable, non-display-name scope name from both authoritative identities. */
export function deriveCgroupScopeName(identity: CgroupExecutionIdentity): string {
  const checked = validateIdentity(identity);
  if (!checked.ok) throw checked.error;
  const digest = crypto
    .createHash("sha256")
    .update(`${identity.session_id}\0${identity.execution_id}`, "utf8")
    .digest("hex");
  return `nawabari-${digest.slice(0, 48)}`;
}

function readBounded(file: string, filesystem: CgroupFileSystem = nativeFileSystem): string | null {
  try {
    const value = filesystem.readFileSync(file);
    return value.slice(0, MAX_CGROUP_FILE_BYTES);
  } catch {
    return null;
  }
}

function parseCounter(text: string | null, key?: string): number | null {
  if (text === null) return null;
  const line =
    key === undefined
      ? text.trim()
      : (text
          .split(/\r?\n/u)
          .find((entry) => entry.startsWith(`${key} `))
          ?.slice(key.length)
          .trim() ?? "");
  if (!/^\d+$/u.test(line)) return null;
  const value = Number(line);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function requiredControllers(root: string, filesystem: CgroupFileSystem): DomainResult<null> {
  const available = readBounded(path.join(root, "cgroup.controllers"), filesystem);
  if (available === null) return capabilityError("Cannot read cgroups v2 controllers.", { root });
  // The scope is both a control and bounded accounting authority.  All three
  // controllers are therefore required even when the profile supplies no
  // optional limit; silently returning partial evidence would be misleading.
  const required = CONTROLLERS;
  const missing = required.filter((controller) => !available.split(/\s+/u).includes(controller));
  if (missing.length > 0) {
    return capabilityError("The requested cgroups v2 controllers are unavailable.", {
      missing,
      available: available.trim().slice(0, 256),
    });
  }
  return success(null);
}

function ensureControllerDelegation(parent: string, filesystem: CgroupFileSystem): DomainResult<null> {
  const controllers = CONTROLLERS;
  const controlFile = path.join(parent, "cgroup.subtree_control");
  const current = readBounded(controlFile, filesystem);
  if (current === null)
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "Cannot inspect cgroups v2 controller delegation.", { parent });
  const missing = controllers.filter(
    (controller) => !current.split(/\s+/u).includes(`+${controller}`) && !current.split(/\s+/u).includes(controller),
  );
  if (missing.length === 0) return success(null);
  try {
    filesystem.writeFileSync(controlFile, missing.map((controller) => `+${controller}`).join(" "));
    return success(null);
  } catch (error: unknown) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The requested cgroups v2 controllers cannot be delegated.", {
      parent,
      controllers: missing,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

function scopeWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function verifiesScopeIdentity(scope: CgroupScope): boolean {
  return (
    scopeWithin(scope.root, scope.path) &&
    scope.path === path.join(scope.root, "nawabari", scope.name) &&
    path.basename(scope.path) === scope.name &&
    deriveCgroupScopeName(scope.identity) === scope.name
  );
}

/** Create or resume a deterministic scope; an occupied scope is never adopted. */
export function createCgroupScope(
  identity: CgroupExecutionIdentity,
  options: CgroupScopeOptions = {},
): DomainResult<CgroupScope> {
  const validIdentity = validateIdentity(identity);
  if (!validIdentity.ok) return validIdentity;
  const limits = validateLimits(options.limits ?? {});
  if (!limits.ok) return limits;
  const filesystem = options.filesystem ?? nativeFileSystem;
  const root = validateRoot(options.root ?? CGROUPS_V2_ROOT, filesystem);
  if (!root.ok) return root;
  const controllerCheck = requiredControllers(root.value, filesystem);
  if (!controllerCheck.ok) return controllerCheck;
  const parent = path.join(root.value, "nawabari");
  const name = deriveCgroupScopeName(identity);
  const scopePath = path.join(parent, name);
  if (!scopeWithin(root.value, parent) || !scopeWithin(root.value, scopePath)) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The derived cgroups v2 scope escaped its root.", {
      root: root.value,
    });
  }
  try {
    filesystem.mkdirSync(parent, { recursive: false, mode: 0o755 });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The cgroups v2 scope parent could not be created.", {
        parent,
        reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
  }
  const delegated = ensureControllerDelegation(parent, filesystem);
  if (!delegated.ok) return delegated;
  let createdNew = false;
  try {
    filesystem.mkdirSync(scopePath, { mode: 0o755 });
    createdNew = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The cgroups v2 scope could not be created.", {
        scope: scopePath,
      });
    }
    const processes = parseProcessIds(readBounded(path.join(scopePath, "cgroup.procs"), filesystem));
    if (processes.length > 0) {
      return cgroupError("SANDBOX_CGROUP_SCOPE_CONFLICT", "The deterministic cgroups v2 scope is still occupied.", {
        scope: name,
        process_count: processes.length,
      });
    }
  }
  const applied = applyCgroupLimits(scopePath, limits.value, filesystem);
  if (!applied.ok) {
    if (createdNew) {
      try {
        filesystem.rmdirSync(scopePath);
      } catch {
        // Preserve the original setup failure; a later retry can reconcile it.
      }
    }
    return applied;
  }
  const scope = {
    contract_id: CGROUPS_V2_CONTRACT_ID,
    root: root.value,
    parent,
    path: scopePath,
    name,
    identity,
    limits: limits.value,
  } satisfies CgroupScope;
  scopeFilesystems.set(scope, filesystem);
  return success(scope);
}

function applyCgroupLimits(
  scope: string,
  limits: CgroupLimitProfile,
  filesystem: CgroupFileSystem,
): DomainResult<null> {
  const writes: Array<[string, string]> = [];
  if (limits.cpu_max_usec !== undefined)
    writes.push(["cpu.max", `${limits.cpu_max_usec} ${limits.cpu_period_usec ?? 100_000}`]);
  if (limits.memory_max_bytes !== undefined) writes.push(["memory.max", String(limits.memory_max_bytes)]);
  if (limits.pids_max !== undefined) writes.push(["pids.max", String(limits.pids_max)]);
  try {
    for (const [file, value] of writes) filesystem.writeFileSync(path.join(scope, file), value);
    return success(null);
  } catch (error: unknown) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "A cgroups v2 limit could not be applied.", {
      scope,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

function parseProcessIds(text: string | null): number[] {
  if (text === null) return [];
  return text
    .split(/\r?\n/u)
    .map((entry) => Number(entry.trim()))
    .filter((pid) => Number.isSafeInteger(pid) && pid > 0);
}

/** Attach only a positive process id to the exact scope created for this identity. */
export function attachProcessToCgroup(scope: CgroupScope, pid: number): DomainResult<null> {
  if (!Number.isSafeInteger(pid) || pid < 1)
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The process id is invalid.", { pid });
  try {
    if (!verifiesScopeIdentity(scope)) {
      return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The cgroups v2 scope identity could not be verified.", {
        scope: scope.name,
      });
    }
    filesystemFor(scope).writeFileSync(path.join(scope.path, "cgroup.procs"), String(pid));
    return success(null);
  } catch (error: unknown) {
    return cgroupError("SANDBOX_CGROUP_SETUP_FAILED", "The protected process could not be attached to cgroups v2.", {
      scope: scope.name,
      pid,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

/** Read bounded counters only; malformed/unavailable kernel files become null evidence. */
export function readCgroupAccounting(scope: CgroupScope): CgroupAccounting {
  const filesystem = filesystemFor(scope);
  const cpu = readBounded(path.join(scope.path, "cpu.stat"), filesystem);
  const memory = readBounded(path.join(scope.path, "memory.current"), filesystem);
  const memoryPeak = readBounded(path.join(scope.path, "memory.peak"), filesystem);
  const memoryEvents = readBounded(path.join(scope.path, "memory.events"), filesystem);
  const pids = readBounded(path.join(scope.path, "pids.current"), filesystem);
  const pidsEvents = readBounded(path.join(scope.path, "pids.events"), filesystem);
  const cpuThrottled = parseCounter(cpu, "throttled_usec");
  const memoryOomKill = parseCounter(memoryEvents, "oom_kill");
  const memoryMax = parseCounter(memoryEvents, "max");
  const pidsMax = parseCounter(pidsEvents, "max");
  return {
    bounded: true,
    cpu_usage_usec: parseCounter(cpu, "usage_usec"),
    cpu_user_usec: parseCounter(cpu, "user_usec"),
    cpu_system_usec: parseCounter(cpu, "system_usec"),
    cpu_throttled_usec: cpuThrottled,
    memory_current_bytes: parseCounter(memory),
    memory_peak_bytes: parseCounter(memoryPeak),
    pids_current: parseCounter(pids),
    pids_max_events: pidsMax,
    memory_oom_kill_events: memoryOomKill,
    memory_max_events: memoryMax,
    cpu_throttled: cpuThrottled !== null && cpuThrottled > 0,
    memory_limit_exceeded: (memoryOomKill !== null && memoryOomKill > 0) || (memoryMax !== null && memoryMax > 0),
    pids_limit_exceeded: pidsMax !== null && pidsMax > 0,
  };
}

/** Remove only an identity-verified, empty scope. Populated scopes are killed first through cgroup.kill. */
export function cleanupCgroupScope(scope: CgroupScope): DomainResult<{ readonly removed: boolean }> {
  if (!verifiesScopeIdentity(scope)) {
    return cleanupError("The cgroups v2 scope identity could not be verified for cleanup.", { scope: scope.name });
  }
  const filesystem = filesystemFor(scope);
  const processes = parseProcessIds(readBounded(path.join(scope.path, "cgroup.procs"), filesystem));
  if (processes.length > 0) {
    try {
      filesystem.writeFileSync(path.join(scope.path, "cgroup.kill"), "1");
    } catch (error: unknown) {
      return cleanupError("The occupied cgroups v2 scope could not be safely terminated.", {
        scope: scope.name,
        process_count: processes.length,
        reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
      });
    }
    if (parseProcessIds(readBounded(path.join(scope.path, "cgroup.procs"), filesystem)).length > 0) {
      return cleanupError("The cgroups v2 scope remained occupied after cleanup.", { scope: scope.name });
    }
  }
  try {
    filesystem.rmdirSync(scope.path);
    return success({ removed: true });
  } catch (error: unknown) {
    return cleanupError("The cgroups v2 scope could not be removed.", {
      scope: scope.name,
      reason: error instanceof Error ? error.message.slice(0, 200) : "unknown",
    });
  }
}

export function cgroupLimitEvents(accounting: CgroupAccounting): CgroupLimitEvent[] {
  const events: CgroupLimitEvent[] = [];
  if (accounting.cpu_throttled) events.push("cpu");
  if (accounting.memory_limit_exceeded) events.push("memory");
  if (accounting.pids_limit_exceeded) events.push("pids");
  return events;
}
