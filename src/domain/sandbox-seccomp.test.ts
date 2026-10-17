import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function compiledSyscallNumbers(bytes: Uint8Array, architecture: keyof typeof EXPECTED_SYSCALLS): number[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const numbers: number[] = [];
  const start = architecture === "x64" ? 8 : 4;
  for (let index = start; index < start + Object.keys(EXPECTED_SYSCALLS[architecture]).length * 2; index += 2) {
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

    assert.deepEqual(compiledSyscallNumbers(compiled.value, architecture), Object.values(expected));
    assert.deepEqual(sandboxSeccompProfileMetadata(architecture).denied_syscalls, SANDBOX_SECCOMP_DENIED_SYSCALLS);
  }
});

test("unsupported seccomp architectures fail closed with the typed capability error", () => {
  assert.equal(sandboxSeccompArchitectureSupported("ia32"), false);
  const result = compileSandboxSeccompProfile("ia32");
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
});

const RAW_CLONE_SYSCALLS = { x64: 56, arm64: 220, arm: 120, riscv64: 220 } as const;
const AUDIT_ARCH = { x64: 0xc000003e, arm64: 0xc00000b7, arm: 0x40000028, riscv64: 0xc00000f3 } as const;

/** Tiny classic-BPF interpreter for the opcodes emitted by the sandbox policy. */
function evaluateFilter(
  bytes: Uint8Array,
  architecture: keyof typeof RAW_CLONE_SYSCALLS,
  nr: number,
  cloneFlags = 0,
): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let accumulator = 0;
  for (let pc = 0; pc < bytes.byteLength / INSTRUCTION_SIZE;) {
    const offset = pc * INSTRUCTION_SIZE;
    const code = view.getUint16(offset, true);
    const jt = view.getUint8(offset + 2);
    const jf = view.getUint8(offset + 3);
    const constant = view.getUint32(offset + 4, true);
    if (code === 0x20) {
      accumulator = constant === 0 ? nr : constant === 4 ? AUDIT_ARCH[architecture] : constant === 16 ? cloneFlags : 0;
      pc++;
    } else if (code === 0x54) {
      accumulator &= constant;
      pc++;
    } else if (code === 0x15) {
      pc += 1 + (accumulator === constant ? jt : jf);
    } else if (code === 0x06) {
      return constant;
    } else {
      assert.fail(`unexpected BPF opcode 0x${code.toString(16)}`);
    }
  }
  assert.fail("BPF fell off the end without a decision");
}

test("payload seccomp denies namespace clone and clone3 while preserving ordinary fork/threads", () => {
  const allow = 0x7fff0000;
  const permissionDenied = 0x00050001;
  const kernelFallback = 0x00050026;
  for (const architecture of Object.keys(RAW_CLONE_SYSCALLS) as Array<keyof typeof RAW_CLONE_SYSCALLS>) {
    const filter = compileSandboxSeccompProfile(architecture);
    assert.equal(filter.ok, true);
    if (!filter.ok) continue;
    const clone = RAW_CLONE_SYSCALLS[architecture];
    for (const flags of [0, 0x00000100, 0x00010000]) {
      assert.equal(evaluateFilter(filter.value, architecture, clone, flags), allow);
    }
    for (const flags of [
      0x00000080, 0x00020000, 0x02000000, 0x04000000, 0x08000000, 0x10000000, 0x20000000, 0x40000000,
    ]) {
      assert.equal(evaluateFilter(filter.value, architecture, clone, flags), permissionDenied);
    }
    assert.equal(
      evaluateFilter(filter.value, architecture, 435),
      kernelFallback,
      "clone3 must allow libc clone fallback",
    );
    assert.equal(evaluateFilter(filter.value, architecture, 999), allow, "unlisted ordinary syscalls stay allowed");
  }
  const x64 = compileSandboxSeccompProfile("x64");
  assert.equal(x64.ok, true);
  if (x64.ok)
    assert.equal(
      evaluateFilter(x64.value, "x64", 0x40000000 | 56),
      permissionDenied,
      "x32 namespace syscall alias must not bypass the filter",
    );
});

test("the Linux kernel enforces namespace clone denials while ordinary fork and threads survive", (t) => {
  if (process.platform !== "linux" || !(process.arch in RAW_CLONE_SYSCALLS)) {
    t.skip("requires Linux on a supported seccomp architecture");
    return;
  }
  const python = spawnSync("python3", ["--version"], { encoding: "utf8" });
  if (python.error) {
    t.skip("Python ctypes is unavailable for the real kernel filter test");
    return;
  }
  const filter = compileSandboxSeccompProfile(process.arch);
  assert.equal(filter.ok, true);
  if (!filter.ok) return;
  const architecture = process.arch as keyof typeof RAW_CLONE_SYSCALLS;
  const probe = String.raw`
import ctypes, errno, json, os, signal, sys, threading
class Instruction(ctypes.Structure):
    _fields_ = [("code", ctypes.c_ushort), ("jt", ctypes.c_ubyte), ("jf", ctypes.c_ubyte), ("k", ctypes.c_uint)]
class Program(ctypes.Structure):
    _fields_ = [("len", ctypes.c_ushort), ("filter", ctypes.POINTER(Instruction))]
raw = sys.stdin.buffer.read()
instructions = (Instruction * (len(raw) // 8)).from_buffer_copy(raw)
program = Program(len(instructions), instructions)
libc = ctypes.CDLL(None, use_errno=True)
libc.syscall.restype = ctypes.c_long
assert libc.prctl(38, 1, 0, 0, 0) == 0, ctypes.get_errno()
assert libc.prctl(22, 2, ctypes.byref(program), 0, 0) == 0, ctypes.get_errno()
clone_nr = int(sys.argv[1])
for flag in [0x80, 0x20000, 0x2000000, 0x4000000, 0x8000000, 0x10000000, 0x20000000, 0x40000000]:
    result = libc.syscall(clone_nr, flag | signal.SIGCHLD, 0, 0, 0, 0)
    if result == 0:
        os._exit(99)
    assert result == -1 and ctypes.get_errno() == errno.EPERM, (flag, result, ctypes.get_errno())
assert libc.syscall(435, 0, 0) == -1 and ctypes.get_errno() == errno.ENOSYS
child = os.fork()
if child == 0:
    os._exit(0)
assert os.waitpid(child, 0)[1] == 0
observed = []
thread = threading.Thread(target=lambda: observed.append("thread-ok"))
thread.start()
thread.join()
assert observed == ["thread-ok"]
print(json.dumps({"namespace_flags_denied": 8, "clone3_errno": errno.ENOSYS, "fork": "passed", "thread": "passed"}))
`;
  const result = spawnSync("python3", ["-c", probe, String(RAW_CLONE_SYSCALLS[architecture])], {
    input: filter.value,
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, `${result.error?.message ?? ""}${result.stderr}`);
  assert.deepEqual(JSON.parse(result.stdout), {
    namespace_flags_denied: 8,
    clone3_errno: 38,
    fork: "passed",
    thread: "passed",
  });
});
