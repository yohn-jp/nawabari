import path from "node:path";

import type { SandboxFilesystemTopology } from "./sandbox.js";

/**
 * Landlock is an optional second filesystem boundary.  The bubblewrap
 * topology remains authoritative: this module only compiles that topology
 * into a fixed set of namespace paths and never accepts source/destination
 * grants from a caller.
 */
export const LANDLOCK_ABI_MINIMUM = 1 as const;
export const LANDLOCK_CREATE_RULESET_VERSION = 1 as const;
export const LANDLOCK_RULE_TYPE_PATH_BENEATH = 1 as const;

export const LANDLOCK_ACCESS_FS = Object.freeze({
  execute: 1 << 0,
  write_file: 1 << 1,
  read_file: 1 << 2,
  read_dir: 1 << 3,
  remove_dir: 1 << 4,
  remove_file: 1 << 5,
  make_char: 1 << 6,
  make_dir: 1 << 7,
  make_reg: 1 << 8,
  make_sock: 1 << 9,
  make_fifo: 1 << 10,
  make_block: 1 << 11,
  make_sym: 1 << 12,
  refer: 1 << 13,
  truncate: 1 << 14,
});

export const LANDLOCK_ACCESS_FS_ABI1 =
  LANDLOCK_ACCESS_FS.execute |
  LANDLOCK_ACCESS_FS.write_file |
  LANDLOCK_ACCESS_FS.read_file |
  LANDLOCK_ACCESS_FS.read_dir |
  LANDLOCK_ACCESS_FS.remove_dir |
  LANDLOCK_ACCESS_FS.remove_file |
  LANDLOCK_ACCESS_FS.make_char |
  LANDLOCK_ACCESS_FS.make_dir |
  LANDLOCK_ACCESS_FS.make_reg |
  LANDLOCK_ACCESS_FS.make_sock |
  LANDLOCK_ACCESS_FS.make_fifo |
  LANDLOCK_ACCESS_FS.make_block |
  LANDLOCK_ACCESS_FS.make_sym;

const LANDLOCK_ACCESS_FS_ABI2 = LANDLOCK_ACCESS_FS_ABI1 | LANDLOCK_ACCESS_FS.refer;
const LANDLOCK_ACCESS_FS_ABI3 = LANDLOCK_ACCESS_FS_ABI2 | LANDLOCK_ACCESS_FS.truncate;

const READ_ACCESS = LANDLOCK_ACCESS_FS.execute | LANDLOCK_ACCESS_FS.read_file | LANDLOCK_ACCESS_FS.read_dir;
const WRITE_ACCESS = LANDLOCK_ACCESS_FS_ABI3;

export type LandlockRule = {
  readonly path: string;
  readonly allowed_access: number;
};

/** State before/after applying the optional defense-in-depth policy. */
export type LandlockEffectiveState =
  "available" | "enforced" | "reduced-defense" | "incompatible" | "error" | "not-applicable";

export type LandlockCapability = {
  readonly abi: number | null;
  readonly supported: boolean;
  readonly effective_state: LandlockEffectiveState;
};

/** Marker kept short so setup diagnostics remain bounded at every boundary. */
export const LANDLOCK_SETUP_FAILURE_PREFIX = "nawabari-landlock: ";

function addRule(rules: Map<string, number>, candidate: string, allowedAccess: number): void {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) return;
  const normalized = path.posix.normalize(candidate);
  // A root rule would turn this into a second broad policy authority.  The
  // canonical profile always supplies narrower mounted paths instead.
  if (normalized === "/") return;
  rules.set(normalized, (rules.get(normalized) ?? 0) | allowedAccess);
}

function addParentRules(rules: Map<string, number>, candidate: string): void {
  let parent = path.posix.dirname(candidate);
  while (parent !== "/" && parent !== ".") {
    addRule(rules, parent, LANDLOCK_ACCESS_FS.execute | LANDLOCK_ACCESS_FS.read_dir);
    parent = path.posix.dirname(parent);
  }
}

function addDirectoryRule(rules: Map<string, number>, candidate: string, allowedAccess: number): void {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) return;
  addParentRules(rules, candidate);
  addRule(rules, candidate, allowedAccess);
}

function addFileRule(rules: Map<string, number>, candidate: string): void {
  if (!path.isAbsolute(candidate) || candidate.includes("\0")) return;
  addParentRules(rules, candidate);
  addRule(rules, candidate, LANDLOCK_ACCESS_FS.execute | LANDLOCK_ACCESS_FS.read_file);
}

function isKnownFile(candidate: string): boolean {
  return new Set(["/etc/passwd", "/etc/group", "/etc/nsswitch.conf", "/etc/hosts", "/etc/resolv.conf"]).has(
    path.posix.normalize(candidate),
  );
}

function isKnownDirectory(candidate: string): boolean {
  const normalized = path.posix.normalize(candidate);
  return (
    normalized === "/dev" ||
    normalized === "/proc" ||
    normalized === "/tmp" ||
    normalized === "/usr" ||
    normalized === "/bin" ||
    normalized === "/lib" ||
    normalized === "/lib64" ||
    normalized === "/nix/store" ||
    normalized === "/run/current-system" ||
    normalized === "/run/wrappers" ||
    normalized === "/etc/profiles" ||
    normalized === "/etc/alternatives" ||
    normalized === "/etc/ssl" ||
    normalized === "/etc/pki" ||
    normalized === "/etc/ca-certificates" ||
    normalized === "/run/systemd/resolve" ||
    normalized === "/run/NetworkManager" ||
    normalized === "/mnt/wsl" ||
    normalized.startsWith("/usr/") ||
    normalized.startsWith("/bin/") ||
    normalized.startsWith("/lib/") ||
    normalized.startsWith("/lib64/") ||
    normalized.startsWith("/nix/store/") ||
    normalized.startsWith("/run/current-system/") ||
    normalized.startsWith("/run/wrappers/") ||
    normalized.startsWith("/etc/profiles/") ||
    normalized.startsWith("/etc/alternatives/") ||
    normalized.startsWith("/etc/ssl/") ||
    normalized.startsWith("/etc/pki/") ||
    normalized.startsWith("/etc/ca-certificates/") ||
    normalized.startsWith("/run/systemd/resolve/") ||
    normalized.startsWith("/run/NetworkManager/") ||
    normalized.startsWith("/mnt/wsl/")
  );
}

function isCanonicalSystemPath(candidate: string): boolean {
  const normalized = path.posix.normalize(candidate);
  return isKnownFile(normalized) || isKnownDirectory(normalized);
}

function userToolDestination(source: string, userHome: string | null | undefined): string | null {
  if (userHome === null || userHome === undefined || !path.isAbsolute(userHome) || userHome.includes("\0")) {
    return null;
  }
  const normalizedSource = path.posix.normalize(source);
  const normalizedHome = path.posix.normalize(userHome);
  const localBin = path.posix.join(normalizedHome, ".local", "bin");
  const localLib = path.posix.join(normalizedHome, ".local", "lib");
  const pnpmBin = path.posix.join(normalizedHome, ".local", "share", "pnpm");
  if (normalizedSource === localBin || normalizedSource.startsWith(`${localBin}/`)) return "/home/nawabari/.local/bin";
  if (normalizedSource === localLib || normalizedSource.startsWith(`${localLib}/`)) return "/home/nawabari/.local/lib";
  if (normalizedSource === pnpmBin || normalizedSource.startsWith(`${pnpmBin}/`)) {
    return "/home/nawabari/.local/share/pnpm";
  }
  return null;
}

/**
 * Compile only namespace-visible paths from the canonical topology.  Host
 * paths that are mounted at a fixed destination are translated to that
 * destination; the host HOME, sibling worktrees, and arbitrary grants never
 * become Landlock rules.
 */
export function deriveLandlockRules(topology: SandboxFilesystemTopology): readonly LandlockRule[] {
  const rules = new Map<string, number>();

  addDirectoryRule(rules, topology.owned_worktree, WRITE_ACCESS);
  addDirectoryRule(rules, "/home/nawabari", WRITE_ACCESS);
  addDirectoryRule(rules, "/home/nawabari/.cache", WRITE_ACCESS);
  addDirectoryRule(rules, "/home/nawabari/.nawabari", WRITE_ACCESS);
  addDirectoryRule(rules, "/nawabari/git", WRITE_ACCESS);
  addDirectoryRule(rules, "/nawabari/git/objects", READ_ACCESS);
  addDirectoryRule(rules, "/tmp", WRITE_ACCESS);

  for (const source of topology.user_tool_paths) {
    const destination = userToolDestination(source, topology.user_tool_home);
    if (destination !== null) addDirectoryRule(rules, destination, READ_ACCESS);
  }

  for (const source of topology.runtime_paths) {
    if (isKnownFile(source)) addFileRule(rules, source);
    else if (isKnownDirectory(source)) addDirectoryRule(rules, source, READ_ACCESS);
  }

  for (const source of topology.system_paths) {
    if (!isCanonicalSystemPath(source)) continue;
    if (isKnownFile(source)) addFileRule(rules, source);
    else addDirectoryRule(rules, source, READ_ACCESS);
  }

  return [...rules.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([rulePath, allowedAccess]) => ({ path: rulePath, allowed_access: allowedAccess }));
}

/**
 * Small in-namespace adapter.  It is passed through argv to the selected
 * runtime executable, never through a shell.  Any setup failure exits before
 * the requested command is exec'd and emits only a bounded marker/diagnostic.
 */
export const LANDLOCK_TRAMPOLINE = String.raw`
import ctypes, json, os, sys

SYS_LANDLOCK_CREATE_RULESET = 444
SYS_LANDLOCK_ADD_RULE = 445
SYS_LANDLOCK_RESTRICT_SELF = 446
LANDLOCK_CREATE_RULESET_VERSION = 1
LANDLOCK_RULE_TYPE_PATH_BENEATH = 1
PR_SET_NO_NEW_PRIVS = 38
O_PATH = getattr(os, "O_PATH", 0o10000000)
O_CLOEXEC = getattr(os, "O_CLOEXEC", 0o2000000)
LANDLOCK_ACCESS_FS_ABI1 = (1 << 13) - 1
LANDLOCK_ACCESS_FS_ABI2 = LANDLOCK_ACCESS_FS_ABI1 | (1 << 13)
LANDLOCK_ACCESS_FS_ABI3 = LANDLOCK_ACCESS_FS_ABI2 | (1 << 14)

class RulesetAttr(ctypes.Structure):
    _fields_ = [("handled_access_fs", ctypes.c_uint64)]

class PathBeneath(ctypes.Structure):
    _fields_ = [("allowed_access", ctypes.c_uint64), ("parent_fd", ctypes.c_int32)]

def fail(message):
    bounded = str(message).replace("\n", " ")[:240]
    sys.stderr.write("nawabari-landlock: " + bounded + "\n")
    raise SystemExit(125)

def main():
    if len(sys.argv) < 4 or sys.argv[2] != "--":
        fail("invalid trampoline arguments")
    try:
        rules = json.loads(sys.argv[1])
    except Exception as error:
        fail("invalid derived rules: " + str(error))
    if not isinstance(rules, list):
        fail("invalid derived rules")
    command = sys.argv[3:]
    if not command or any("\x00" in item for item in command):
        fail("invalid command arguments")

    try:
        libc = ctypes.CDLL(None, use_errno=True)
        libc.syscall.restype = ctypes.c_long
        version = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, None, 0, LANDLOCK_CREATE_RULESET_VERSION)
        if version < 1:
            fail("Landlock ABI is unavailable")
        abi = int(version)
        handled = LANDLOCK_ACCESS_FS_ABI3 if abi >= 3 else LANDLOCK_ACCESS_FS_ABI2 if abi >= 2 else LANDLOCK_ACCESS_FS_ABI1
        ruleset = RulesetAttr(handled_access_fs=handled)
        ruleset_fd = libc.syscall(SYS_LANDLOCK_CREATE_RULESET, ctypes.byref(ruleset), ctypes.sizeof(ruleset), 0)
        if ruleset_fd < 0:
            fail("landlock_create_ruleset failed: " + os.strerror(ctypes.get_errno()))
        opened = []
        try:
            for item in rules:
                if not isinstance(item, dict) or not isinstance(item.get("path"), str):
                    fail("invalid derived rule")
                rule_path = item["path"]
                if not rule_path.startswith("/"):
                    fail("derived rule path is not absolute")
                fd = os.open(rule_path, O_PATH | O_CLOEXEC)
                opened.append(fd)
                rule = PathBeneath(allowed_access=int(item.get("allowed_access", 0)) & handled, parent_fd=fd)
                if libc.syscall(SYS_LANDLOCK_ADD_RULE, ruleset_fd, LANDLOCK_RULE_TYPE_PATH_BENEATH, ctypes.byref(rule), 0) < 0:
                    fail("landlock_add_rule failed: " + os.strerror(ctypes.get_errno()))
            if libc.prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) < 0:
                fail("PR_SET_NO_NEW_PRIVS failed: " + os.strerror(ctypes.get_errno()))
            if libc.syscall(SYS_LANDLOCK_RESTRICT_SELF, ruleset_fd, 0) < 0:
                fail("landlock_restrict_self failed: " + os.strerror(ctypes.get_errno()))
        finally:
            for fd in opened:
                try:
                    os.close(fd)
                except OSError:
                    pass
            os.close(ruleset_fd)
    except SystemExit:
        raise
    except Exception as error:
        fail("Landlock setup failed: " + str(error))

    try:
        os.execvp(command[0], command)
    except Exception as error:
        fail("command execution failed: " + str(error))

main()
`;

export function landlockHandledAccessForAbi(abi: number): number {
  if (!Number.isSafeInteger(abi) || abi < LANDLOCK_ABI_MINIMUM) return 0;
  if (abi >= 3) return LANDLOCK_ACCESS_FS_ABI3;
  if (abi >= 2) return LANDLOCK_ACCESS_FS_ABI2;
  return LANDLOCK_ACCESS_FS_ABI1;
}
