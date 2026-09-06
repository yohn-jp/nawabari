import assert from "node:assert/strict";
import { test } from "node:test";

import {
  compileSandboxSeccompProfile,
  SANDBOX_SECCOMP_DENIED_SYSCALLS,
  sandboxSeccompArchitectureSupported,
  sandboxSeccompProfileMetadata,
} from "./sandbox-seccomp.js";

const INSTRUCTION_SIZE = 8;
const BPF_JMP_JEQ_K = 0x15;

const EXPECTED_SYSCALLS = {
  x64: {
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
  },
  arm64: {
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
  },
  arm: {
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
    keyctl: 311,
    mount: 21,
    mount_setattr: 442,
    move_mount: 429,
    open_by_handle_at: 371,
    perf_event_open: 364,
    pivot_root: 218,
    process_vm_readv: 376,
    process_vm_writev: 377,
    ptrace: 26,
    quotactl: 131,
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
  },
  riscv64: {
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
  },
} as const;

function compiledSyscallNumbers(bytes: Uint8Array): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numbers: number[] = [];
  for (let index = 4; index < bytes.byteLength / INSTRUCTION_SIZE - 1; index += 2) {
    const code = view.getUint16(index * INSTRUCTION_SIZE, true);
    assert.equal(code, BPF_JMP_JEQ_K);
    numbers.push(view.getUint32(index * INSTRUCTION_SIZE + 4, true));
  }
  return numbers;
}

test("seccomp compilation uses the authoritative syscall mapping on every supported architecture", () => {
  for (const architecture of Object.keys(EXPECTED_SYSCALLS) as Array<keyof typeof EXPECTED_SYSCALLS>) {
    const expected = EXPECTED_SYSCALLS[architecture];
    assert.equal(sandboxSeccompArchitectureSupported(architecture), true);
    const compiled = compileSandboxSeccompProfile(architecture);
    assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.error));
    if (!compiled.ok) continue;

    assert.deepEqual(compiledSyscallNumbers(compiled.value), Object.values(expected));
    assert.deepEqual(sandboxSeccompProfileMetadata(architecture).denied_syscalls, SANDBOX_SECCOMP_DENIED_SYSCALLS);
  }
});

test("unsupported seccomp architectures fail closed with the typed capability error", () => {
  assert.equal(sandboxSeccompArchitectureSupported("ia32"), false);
  const result = compileSandboxSeccompProfile("ia32");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
});
