import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LocalSessionBackend } from "./session-backend.js";
import {
  compileSandboxInvocation,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  type SandboxProbe,
} from "./sandbox.js";

/**
 * CI-declared, controlled/fake bubblewrap substitute (see
 * scripts/test-fixtures/sandbox-launcher-test-stub.sh and the workflow step
 * that installs it). It forwards the argv following the compiled `--`
 * separator to exec without establishing any sandbox isolation.
 *
 * Tests below prefer real bubblewrap when the host genuinely has it
 * (`discoverSandboxRuntimeLayout()` resolves it), so this fallback never
 * masks real capability. When real bubblewrap is absent, it keeps
 * argv-construction, topology-validation, and output/timeout-bounding
 * coverage deterministic instead of depending on undeclared ambient host
 * state. It must never be presented as evidence of real bubblewrap
 * sandboxing; only the dedicated real-isolation test below claims that,
 * and only when it finds genuine bubblewrap.
 */
const CONTROLLED_TEST_SANDBOX_EXECUTABLE = "/usr/local/bin/nawabari-sandbox-test-stub";

function resolveTestSandboxExecutable(discovered: string | null): string | null {
  if (discovered !== null) return discovered;
  return fs.existsSync(CONTROLLED_TEST_SANDBOX_EXECUTABLE) ? CONTROLLED_TEST_SANDBOX_EXECUTABLE : null;
}

function readyProbe(): SandboxProbe {
  return {
    platform: () => "linux",
    uid: () => (typeof process.getuid === "function" ? process.getuid() : null),
    gid: () => (typeof process.getgid === "function" ? process.getgid() : null),
    hasBubblewrap: () => true,
    hasNamespaceSupport: () => true,
    hasCgroupsV2: () => false,
    hasLandlock: () => false,
    hasSeccomp: () => true,
    hasCapabilities: () => true,
  };
}

function createRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-sandbox-launcher-"));
  runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
  runGit(["config", "user.name", "Nawabari Tests"], repository);
  runGit(["config", "user.email", "tests@nawabari.invalid"], repository);
  fs.writeFileSync(path.join(repository, "README.md"), "sandbox\n");
  runGit(["add", "README.md"], repository);
  runGit(["commit", "--quiet", "-m", "initial"], repository);
  return repository;
}

function removeWorktree(repository: string, worktree: string): void {
  runGit(["worktree", "remove", "--force", worktree], repository, false);
}

function runGit(args: readonly string[], cwd: string, throwOnError = true): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: throwOnError ? ["ignore", "pipe", "pipe"] : "ignore",
  });
}

async function resolvedRequest(repository: string, worktree: string) {
  const backend = new LocalSessionBackend();
  const created = await backend.createSession(
    { cwd: repository },
    { branch: "feature/sandbox-launcher", worktree, label: null, base: null },
  );
  if (!created.ok) throw created.error;
  const request = await resolveSandboxExecutionRequest(
    backend,
    { cwd: worktree },
    { session_id: created.value.session_id, enforce: true },
    readyProbe(),
    discoverSandboxRuntimeLayout(),
  );
  if (!request.ok) throw request.error;
  return { ...request.value, sandbox_executable: resolveTestSandboxExecutable(request.value.sandbox_executable) };
}

test("compileSandboxInvocation emits fixed namespace/topology argv and terminates before command argv", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  try {
    const request = await resolvedRequest(repository, worktree);
    const compiled = compileSandboxInvocation(request, {
      command: "printf",
      args: ["%s", "literal; not shell syntax"],
    });

    assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.error));
    if (!compiled.ok) return;
    assert.equal(compiled.value.executable, request.sandbox_executable);
    assert.ok(compiled.value.args.includes("--tmpfs"));
    assert.ok(compiled.value.args.includes("/proc"));
    assert.ok(compiled.value.args.includes("/tmp"));
    assert.ok(compiled.value.args.includes("--unshare-user"));
    assert.ok(compiled.value.args.includes("--unshare-pid"));
    assert.ok(compiled.value.args.includes("--unshare-ipc"));
    assert.ok(compiled.value.args.includes("--unshare-uts"));
    assert.ok(!compiled.value.args.includes("--unshare-net"));
    const terminator = compiled.value.args.indexOf("--");
    assert.ok(terminator > 0);
    assert.deepEqual(compiled.value.args.slice(terminator), ["--", "printf", "%s", "literal; not shell syntax"]);
    assert.ok(compiled.value.args.includes(worktree));
  } finally {
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("compileSandboxInvocation rejects a path outside the fixed system profile", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  try {
    const request = await resolvedRequest(repository, worktree);
    const invalid = {
      ...request,
      filesystem: {
        ...request.filesystem,
        system_paths: [...request.filesystem.system_paths, path.join(repository, "sibling-secret")],
      },
    };
    const compiled = compileSandboxInvocation(invalid, { command: "true" });
    assert.equal(compiled.ok, false);
    if (!compiled.ok) assert.equal(compiled.error.code, "SANDBOX_TOPOLOGY_INVALID");
  } finally {
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("protected launcher fails closed when bubblewrap is unavailable or the worktree path is a symlink", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const alias = `${worktree}-alias`;
  try {
    const request = await resolvedRequest(repository, worktree);
    const missingExecutable = compileSandboxInvocation({ ...request, sandbox_executable: null }, { command: "true" });
    assert.equal(missingExecutable.ok, false);
    if (!missingExecutable.ok) assert.equal(missingExecutable.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");

    fs.symlinkSync(worktree, alias, "dir");
    const symlinkRequest = {
      ...request,
      worktree: alias,
      filesystem: { ...request.filesystem, owned_worktree: alias },
    };
    const rejected = compileSandboxInvocation(symlinkRequest, { command: "true" });
    assert.equal(rejected.ok, false);
    if (!rejected.ok) assert.equal(rejected.error.code, "SANDBOX_TOPOLOGY_INVALID");
  } finally {
    fs.rmSync(alias, { recursive: true, force: true });
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("sandboxed child limits are bounded and fail with stable errors", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  try {
    const request = await resolvedRequest(repository, worktree);
    const output = await runSandboxedCommand(
      request,
      { command: "node", args: ["-e", "process.stdout.write('0123456789')"] },
      { max_output_bytes: 5 },
    );
    assert.equal(output.ok, false);
    if (!output.ok) assert.equal(output.error.code, "SANDBOX_OUTPUT_LIMIT");

    const timeout = await runSandboxedCommand(request, { command: "sh", args: ["-c", "sleep 1"] }, { timeout_ms: 20 });
    assert.equal(timeout.ok, false);
    if (!timeout.ok) assert.equal(timeout.error.code, "SANDBOX_EXECUTION_TIMEOUT");
  } finally {
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("a protected session runs with a private root/tmp/proc view and only its owned worktree", async (t) => {
  if (process.platform !== "linux") {
    t.skip("bubblewrap profile is Linux-only");
    return;
  }
  const report = discoverSandboxRuntimeLayout();
  if (report.bubblewrap === null) {
    t.skip("bubblewrap is unavailable in this test environment");
    return;
  }
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const sibling = `${repository}-sibling-secret`;
  const privateTmpMarker = `nawabari-${process.pid}-${Date.now()}`;
  try {
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(path.join(sibling, "secret.txt"), "not mounted\n");
    const request = await resolvedRequest(repository, worktree);
    const result = await runSandboxedCommand(request, {
      command: "sh",
      args: [
        "-ceu",
        [
          'test "$PWD" = "$1"',
          'test ! -e "$2/secret.txt"',
          "printf owned > sandbox-write.txt",
          "test ! -e /etc/nawabari-host-file",
          "test -r /proc/1/status",
          "grep -q '^CapEff:[[:space:]]*0*$' /proc/self/status",
          'test ! -e "/tmp/' + privateTmpMarker + '"',
          'touch "/tmp/' + privateTmpMarker + '"',
          'printf "uid=%s\\n" "$(id -u)"',
        ].join(";"),
        "sandbox-check",
        worktree,
        sibling,
      ],
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;
    assert.equal(result.value.exit_code, 0, JSON.stringify(result.value));
    assert.match(result.value.stdout, /uid=0/);
    assert.equal(fs.readFileSync(path.join(worktree, "sandbox-write.txt"), "utf8"), "owned");
    assert.equal(fs.existsSync(path.join(os.tmpdir(), privateTmpMarker)), false);

    const git = await runSandboxedCommand(request, { command: "git", args: ["rev-parse", "--show-toplevel"] });
    assert.equal(git.ok, true, git.ok ? "" : JSON.stringify(git.error));
    if (git.ok) assert.equal(git.value.stdout.trim(), worktree, JSON.stringify(git.value));
    const node = await runSandboxedCommand(request, {
      command: "node",
      args: ["-e", "process.stdout.write('node-ok')"],
    });
    assert.equal(node.ok, true, node.ok ? "" : JSON.stringify(node.error));
    if (node.ok) assert.equal(node.value.stdout, "node-ok");
    const pnpm = await runSandboxedCommand(request, { command: "pnpm", args: ["--version"] });
    assert.equal(pnpm.ok, true, pnpm.ok ? "" : JSON.stringify(pnpm.error));
    if (pnpm.ok) assert.match(pnpm.value.stdout.trim(), /^\d+\.\d+\.\d+$/u, JSON.stringify(pnpm.value));
  } finally {
    removeWorktree(repository, worktree);
    fs.rmSync(sibling, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
