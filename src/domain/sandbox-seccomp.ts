import process from "node:process";

import { DomainError, failure, success, type DomainResult } from "./errors.js";

/**
 * The seccomp policy is deliberately a small deny-list.  Development tools
 * need a broad syscall surface (in particular for process creation and file
 * watching), so the profile blocks only operations that would extend the
 * protected topology or expose host-wide kernel/control-plane authority.
 */
export const SANDBOX_SECCOMP_PROFILE_ID = "nawabari.seccomp.v1" as const;
export const SANDBOX_SECCOMP_PROFILE_VERSION = 1 as const;
export const SANDBOX_SECCOMP_DEFAULT_ACTION = "allow" as const;
export const SANDBOX_SECCOMP_DENIAL_ACTION = "errno:EPERM" as const;

export const SANDBOX_SECCOMP_DENIED_SYSCALLS = Object.freeze([
  "acct",
  "add_key",
  "bpf",
  "delete_module",
  "fanotify_init",
  "fsconfig",
  "fsmount",
  "fsopen",
  "fspick",
  "init_module",
  "kexec_file_load",
  "kexec_load",
  "keyctl",
  "mount",
  "mount_setattr",
  "move_mount",
  "open_by_handle_at",
  "perf_event_open",
  "pivot_root",
  "process_vm_readv",
  "process_vm_writev",
  "ptrace",
  "quotactl",
  "quotactl_fd",
  "reboot",
  "request_key",
  "setns",
  "swapon",
  "swapoff",
  "syslog",
  "umount2",
  "unshare",
  "userfaultfd",
] as const);

export const SANDBOX_SECCOMP_PROFILE = Object.freeze({
  id: SANDBOX_SECCOMP_PROFILE_ID,
  version: SANDBOX_SECCOMP_PROFILE_VERSION,
  default_action: SANDBOX_SECCOMP_DEFAULT_ACTION,
  denial_action: SANDBOX_SECCOMP_DENIAL_ACTION,
  denied_syscalls: SANDBOX_SECCOMP_DENIED_SYSCALLS,
});

export type SandboxSeccompProfileMetadata = {
  readonly id: typeof SANDBOX_SECCOMP_PROFILE_ID;
  readonly version: typeof SANDBOX_SECCOMP_PROFILE_VERSION;
  readonly default_action: typeof SANDBOX_SECCOMP_DEFAULT_ACTION;
  readonly denial_action: typeof SANDBOX_SECCOMP_DENIAL_ACTION;
  readonly denied_syscalls: readonly string[];
  readonly architecture: string;
};

export const SANDBOX_CAPABILITY_BASELINE_ID = "nawabari.capabilities.v1" as const;
export const SANDBOX_CAPABILITY_BASELINE_VERSION = 1 as const;
export const SANDBOX_AMBIENT_CAPABILITIES = Object.freeze([]) as readonly string[];

export type SandboxCapabilityBaseline = {
  readonly id: typeof SANDBOX_CAPABILITY_BASELINE_ID;
  readonly version: typeof SANDBOX_CAPABILITY_BASELINE_VERSION;
  readonly ambient_capabilities: readonly string[];
  readonly enforcement: "bubblewrap --cap-drop ALL";
};

/** Metadata is part of the sandbox capability contract and is JSON-safe. */
export function sandboxSeccompProfileMetadata(architecture = process.arch): SandboxSeccompProfileMetadata {
  return {
    id: SANDBOX_SECCOMP_PROFILE_ID,
    version: SANDBOX_SECCOMP_PROFILE_VERSION,
    default_action: SANDBOX_SECCOMP_DEFAULT_ACTION,
    denial_action: SANDBOX_SECCOMP_DENIAL_ACTION,
    denied_syscalls: [...SANDBOX_SECCOMP_DENIED_SYSCALLS],
    architecture,
  };
}

export const sandboxCapabilityBaseline: SandboxCapabilityBaseline = Object.freeze({
  id: SANDBOX_CAPABILITY_BASELINE_ID,
  version: SANDBOX_CAPABILITY_BASELINE_VERSION,
  ambient_capabilities: SANDBOX_AMBIENT_CAPABILITIES,
  enforcement: "bubblewrap --cap-drop ALL",
});

type BpfInstruction = {
  readonly code: number;
  readonly jt: number;
  readonly jf: number;
  readonly k: number;
};

const BPF_LD = 0x00;
const BPF_W = 0x00;
const BPF_ABS = 0x20;
const BPF_JMP = 0x05;
const BPF_JEQ = 0x10;
const BPF_K = 0x00;
const BPF_RET = 0x06;
const SECCOMP_RET_KILL_PROCESS = 0x80000000;
const SECCOMP_RET_ERRNO = 0x00050000;
const SECCOMP_RET_ALLOW = 0x7fff0000;
const EPERM = 1;
const SECCOMP_DATA_NR_OFFSET = 0;
const SECCOMP_DATA_ARCH_OFFSET = 4;

const AUDIT_ARCH: Readonly<Record<string, number>> = Object.freeze({
  x64: 0xc000003e,
  arm64: 0xc00000b7,
  arm: 0x40000028,
  ia32: 0x40000003,
  riscv64: 0xc00000f3,
});

/** Syscall numbers needed by the compatibility profile on supported hosts. */
const SYSCALLS: Readonly<Record<string, Readonly<Record<string, number>>>> = Object.freeze({
  x64: Object.freeze({
    acct: 163,
    add_key: 248,
    bpf: 321,
    delete_module: 176,
    fanotify_init: 300,
    fsconfig: 431,
    fsmount: 432,
    fsopen: 430,
    fspick: 433,
    init_module: 175,
    kexec_file_load: 320,
    kexec_load: 246,
    keyctl: 250,
    mount: 165,
    mount_setattr: 442,
    move_mount: 429,
    open_by_handle_at: 304,
    perf_event_open: 298,
    pivot_root: 155,
    process_vm_readv: 310,
    process_vm_writev: 311,
    ptrace: 101,
    quotactl: 179,
    quotactl_fd: 443,
    reboot: 169,
    request_key: 249,
    setns: 308,
    swapon: 167,
    swapoff: 168,
    syslog: 103,
    umount2: 166,
    unshare: 272,
    userfaultfd: 323,
  }),
  arm64: Object.freeze({
    acct: 89,
    add_key: 217,
    bpf: 280,
    delete_module: 106,
    fanotify_init: 262,
    fsconfig: 431,
    fsmount: 432,
    fsopen: 430,
    fspick: 433,
    init_module: 105,
    kexec_file_load: 294,
    kexec_load: 104,
    keyctl: 219,
    mount: 40,
    mount_setattr: 442,
    move_mount: 429,
    open_by_handle_at: 265,
    perf_event_open: 241,
    pivot_root: 41,
    process_vm_readv: 270,
    process_vm_writev: 271,
    ptrace: 117,
    quotactl: 60,
    quotactl_fd: 443,
    reboot: 142,
    request_key: 218,
    setns: 268,
    swapon: 224,
    swapoff: 225,
    syslog: 116,
    umount2: 39,
    unshare: 97,
    userfaultfd: 282,
  }),
  arm: Object.freeze({
    acct: 51,
    add_key: 309,
    bpf: 386,
    delete_module: 129,
    fanotify_init: 367,
    fsconfig: 431,
    fsmount: 432,
    fsopen: 430,
    fspick: 433,
    init_module: 128,
    kexec_file_load: 401,
    kexec_load: 347,
    keyctl: 309,
    mount: 21,
    mount_setattr: 442,
    move_mount: 429,
    open_by_handle_at: 372,
    perf_event_open: 364,
    pivot_root: 218,
    process_vm_readv: 376,
    process_vm_writev: 377,
    ptrace: 26,
    quotactl: 388,
    quotactl_fd: 443,
    reboot: 88,
    request_key: 310,
    setns: 375,
    swapon: 87,
    swapoff: 115,
    syslog: 103,
    umount2: 52,
    unshare: 337,
    userfaultfd: 388,
  }),
  riscv64: Object.freeze({
    acct: 89,
    add_key: 217,
    bpf: 280,
    delete_module: 106,
    fanotify_init: 262,
    fsconfig: 431,
    fsmount: 432,
    fsopen: 430,
    fspick: 433,
    init_module: 105,
    kexec_file_load: 294,
    kexec_load: 104,
    keyctl: 219,
    mount: 40,
    mount_setattr: 442,
    move_mount: 429,
    open_by_handle_at: 265,
    perf_event_open: 241,
    pivot_root: 41,
    process_vm_readv: 270,
    process_vm_writev: 271,
    ptrace: 117,
    quotactl: 60,
    quotactl_fd: 443,
    reboot: 142,
    request_key: 218,
    setns: 268,
    swapon: 224,
    swapoff: 225,
    syslog: 116,
    umount2: 39,
    unshare: 97,
    userfaultfd: 282,
  }),
});

function statement(code: number, k: number): BpfInstruction {
  return { code, jt: 0, jf: 0, k };
}

function jumpIfEqual(k: number, jt: number, jf: number): BpfInstruction {
  return { code: BPF_JMP | BPF_JEQ | BPF_K, jt, jf, k };
}

function profileArchitecture(
  architecture: string,
): { readonly audit: number; readonly syscalls: Readonly<Record<string, number>> } | null {
  const audit = AUDIT_ARCH[architecture];
  const syscalls = SYSCALLS[architecture];
  return audit === undefined || syscalls === undefined ? null : { audit, syscalls };
}

export function sandboxSeccompArchitectureSupported(architecture = process.arch): boolean {
  return profileArchitecture(architecture) !== null;
}

/**
 * Build the raw sock_filter array expected by bubblewrap's `--seccomp FD`.
 * It intentionally uses ERRNO/EPERM for policy denials: callers get a
 * deterministic, bounded failure and normal subprocess trees keep running.
 */
export function compileSandboxSeccompProfile(architecture: string = process.arch): DomainResult<Uint8Array> {
  const selected = profileArchitecture(architecture);
  if (selected === null) {
    return failure(
      new DomainError(
        "SANDBOX_CAPABILITY_UNAVAILABLE",
        "The seccomp baseline has no compatible architecture profile.",
        {
          profile_id: SANDBOX_SECCOMP_PROFILE_ID,
          profile_version: SANDBOX_SECCOMP_PROFILE_VERSION,
          architecture,
        },
      ),
    );
  }

  const instructions: BpfInstruction[] = [
    statement(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_ARCH_OFFSET),
    jumpIfEqual(selected.audit, 1, 0),
    statement(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    statement(BPF_LD | BPF_W | BPF_ABS, SECCOMP_DATA_NR_OFFSET),
  ];
  for (const name of SANDBOX_SECCOMP_DENIED_SYSCALLS) {
    const syscall = selected.syscalls[name];
    if (syscall === undefined) continue;
    instructions.push(jumpIfEqual(syscall, 0, 1), statement(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM));
  }
  instructions.push(statement(BPF_RET | BPF_K, SECCOMP_RET_ALLOW));

  const bytes = new Uint8Array(instructions.length * 8);
  const view = new DataView(bytes.buffer);
  instructions.forEach((instruction, index) => {
    const offset = index * 8;
    view.setUint16(offset, instruction.code, true);
    view.setUint8(offset + 2, instruction.jt);
    view.setUint8(offset + 3, instruction.jf);
    view.setUint32(offset + 4, instruction.k >>> 0, true);
  });
  return success(bytes);
}
