import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { LocalSessionBackend } from "./session-backend.js";
import {
  compileSandboxInvocation,
  compileSandboxSeccompProfile,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  type SandboxProbe,
} from "./sandbox.js";
import {
  EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
  STRICT_RUNTIME_POLICY,
  type RuntimePolicy,
  validateSessionRuntimeProjection,
} from "./runtime-projection.js";

test("the seccomp baseline is versioned, deterministic, and uses bounded EPERM denials", () => {
  const first = compileSandboxSeccompProfile("x64");
  const second = compileSandboxSeccompProfile("x64");
  assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
  assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
  if (!first.ok || !second.ok) return;
  assert.deepEqual([...first.value], [...second.value]);
  assert.equal(first.value.byteLength % 8, 0);
  assert.ok(first.value.byteLength > 0);
});

/**
 * Repository-owned, controlled/fake bubblewrap substitute. Each controlled
 * test copies it into a temporary unprivileged user-tool directory and injects
 * that directory through discoverSandboxRuntimeLayout(). It forwards the argv
 * following the compiled `--` separator to exec without establishing any
 * sandbox isolation.
 *
 * The controlled tests never depend on real bubblewrap or machine-global
 * setup. They must never be presented as evidence of real bubblewrap
 * sandboxing; only the dedicated real-isolation test below claims that, and
 * only when it finds genuine bubblewrap.
 */
const CONTROLLED_TEST_FIXTURE_SOURCE = fileURLToPath(
  new URL("../../scripts/test-fixtures/sandbox-launcher-test-stub.sh", import.meta.url),
);

type ControlledSandboxFixture = {
  readonly executable: string;
  readonly layout: ReturnType<typeof discoverSandboxRuntimeLayout>;
  readonly cleanup: () => void;
};

function createControlledSandboxFixture(): ControlledSandboxFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-sandbox-launcher-fixture-"));
  const home = path.join(root, "home");
  const bin = path.join(home, ".local", "bin");
  fs.mkdirSync(bin, { recursive: true, mode: 0o700 });
  const executable = path.join(bin, "bwrap");
  fs.copyFileSync(CONTROLLED_TEST_FIXTURE_SOURCE, executable);
  fs.chmodSync(executable, 0o700);

  const layout = discoverSandboxRuntimeLayout({ ...process.env, HOME: home, PATH: bin });
  assert.equal(layout.bubblewrap, executable);
  return {
    executable,
    layout,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
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

async function resolvedRequest(repository: string, worktree: string, runtimeLayout = discoverSandboxRuntimeLayout()) {
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
    runtimeLayout,
  );
  if (!request.ok) throw request.error;
  return request.value;
}

function projectionInput(
  filesystem: readonly Record<string, unknown>[],
  policy: RuntimePolicy = STRICT_RUNTIME_POLICY,
) {
  return {
    policy,
    profile: { id: "explicit-test", version: "1" },
    requirements: [],
    filesystem,
    executables: [],
  };
}

function validatedProjection(
  filesystem: readonly Record<string, unknown>[],
  policy: RuntimePolicy = STRICT_RUNTIME_POLICY,
) {
  const result = validateSessionRuntimeProjection(projectionInput(filesystem, policy));
  if (!result.ok) throw result.error;
  assert.equal(result.ok, true);
  return result.value;
}

test("compileSandboxInvocation emits fixed namespace/topology argv and terminates before command argv", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const fixture = createControlledSandboxFixture();
  try {
    const request = await resolvedRequest(repository, worktree, fixture.layout);
    assert.equal(request.sandbox_executable, fixture.executable);
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
    assert.deepEqual(
      compiled.value.args.slice(compiled.value.args.indexOf("--seccomp"), compiled.value.args.indexOf("--seccomp") + 2),
      ["--seccomp", "3"],
    );
    assert.ok(!compiled.value.args.includes("--unshare-net"));
    const terminator = compiled.value.args.indexOf("--");
    assert.ok(terminator > 0);
    assert.deepEqual(compiled.value.args.slice(terminator), ["--", "printf", "%s", "literal; not shell syntax"]);
    assert.ok(compiled.value.args.includes(worktree));
  } finally {
    fixture.cleanup();
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("explicit projections compile deterministic RO/RW mounts without legacy host visibility", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const fixture = createControlledSandboxFixture();
  const materialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-material-"));
  try {
    const request = await resolvedRequest(repository, worktree, fixture.layout);
    const readAlpha = path.join(materialRoot, "zeta");
    const readZeta = path.join(materialRoot, "alpha");
    fs.mkdirSync(readAlpha);
    fs.mkdirSync(readZeta);
    const writable = path.join(worktree, "writable");
    fs.mkdirSync(writable);
    const projection = validatedProjection([
      {
        source: readAlpha,
        target: "/runtime/zeta",
        access_mode: "read-only",
        provenance: "runtime-profile",
      },
      {
        source: writable,
        target: `${worktree}/writable`,
        access_mode: "read-write",
        provenance: "session",
      },
      {
        source: readZeta,
        target: "/runtime/alpha",
        access_mode: "read-only",
        provenance: "package",
      },
    ]);
    const compiled = compileSandboxInvocation({ ...request, runtime_projection: projection }, { command: "true" });
    assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.error));
    if (!compiled.ok) return;

    const alpha = compiled.value.args.findIndex(
      (value, index, args) => value === "--ro-bind" && args[index + 2] === "/runtime/alpha",
    );
    const zeta = compiled.value.args.findIndex(
      (value, index, args) => value === "--ro-bind" && args[index + 2] === "/runtime/zeta",
    );
    assert.ok(alpha > 0 && zeta > alpha, "projection mounts must sort by namespace target");
    assert.deepEqual(compiled.value.args.slice(alpha - 2, alpha), ["--dir", "/runtime/alpha"]);
    assert.deepEqual(compiled.value.args.slice(zeta - 2, zeta), ["--dir", "/runtime/zeta"]);
    assert.deepEqual(compiled.value.args.slice(alpha, alpha + 3), ["--ro-bind", readZeta, "/runtime/alpha"]);
    assert.deepEqual(compiled.value.args.slice(zeta, zeta + 3), ["--ro-bind", readAlpha, "/runtime/zeta"]);
    const writableIndex = compiled.value.args.findIndex(
      (value, index, args) => value === "--bind" && args[index + 1] === writable,
    );
    assert.deepEqual(compiled.value.args.slice(writableIndex, writableIndex + 3), [
      "--bind",
      writable,
      `${worktree}/writable`,
    ]);

    // An explicit projection is the complete user/runtime view. The fixed
    // backend mounts remain, while the discovered FHS/user-tool mounts do not.
    assert.equal(compiled.value.args.includes("/dev"), true);
    assert.equal(compiled.value.args.includes("/proc"), true);
    assert.equal(compiled.value.args.includes("/tmp"), true);
    assert.equal(compiled.value.args.includes("/usr"), false);
    assert.equal(compiled.value.args.includes("/bin"), false);
    assert.equal(compiled.value.args.includes(fixture.layout.user_local_bin ?? ""), false);
    const pathSetting = compiled.value.args.indexOf("PATH");
    assert.deepEqual(compiled.value.args.slice(pathSetting, pathSetting + 2), ["PATH", ""]);
  } finally {
    fixture.cleanup();
    removeWorktree(repository, worktree);
    fs.rmSync(materialRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("explicit projection source/target escapes, collisions, and unauthorized writes fail closed", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const fixture = createControlledSandboxFixture();
  const materialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-material-"));
  try {
    const request = await resolvedRequest(repository, worktree, fixture.layout);
    const material = path.join(materialRoot, "material");
    const outside = path.join(materialRoot, "outside");
    fs.mkdirSync(material);
    fs.mkdirSync(outside);

    const sourceLink = path.join(materialRoot, "source-link");
    fs.symlinkSync(outside, sourceLink, "dir");
    const escapedSource = compileSandboxInvocation(
      {
        ...request,
        runtime_projection: validatedProjection([
          { source: sourceLink, target: "/runtime/source", access_mode: "read-only", provenance: "package" },
        ]),
      },
      { command: "true" },
    );
    assert.equal(escapedSource.ok, false);
    if (!escapedSource.ok) assert.equal(escapedSource.error.code, "RUNTIME_PROJECTION_INVALID");

    const targetLink = path.join(worktree, "target-link");
    fs.symlinkSync(outside, targetLink, "dir");
    const escapedTarget = compileSandboxInvocation(
      {
        ...request,
        runtime_projection: validatedProjection([
          {
            source: material,
            target: `${worktree}/target-link/file`,
            access_mode: "read-only",
            provenance: "package",
          },
        ]),
      },
      { command: "true" },
    );
    assert.equal(escapedTarget.ok, false);
    if (!escapedTarget.ok) assert.equal(escapedTarget.error.code, "RUNTIME_PROJECTION_INVALID");

    const duplicate = compileSandboxInvocation(
      {
        ...request,
        runtime_projection: projectionInput([
          { source: material, target: "/runtime/same", access_mode: "read-only", provenance: "package" },
          { source: outside, target: "/runtime/same", access_mode: "read-write", provenance: "session" },
        ]) as never,
      },
      { command: "true" },
    );
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");

    const backendCollision = compileSandboxInvocation(
      {
        ...request,
        runtime_projection: validatedProjection([
          { source: material, target: "/dev/host", access_mode: "read-only", provenance: "package" },
        ]),
      },
      { command: "true" },
    );
    assert.equal(backendCollision.ok, false);
    if (!backendCollision.ok) assert.equal(backendCollision.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");

    const broadWrite = compileSandboxInvocation(
      {
        ...request,
        runtime_projection: validatedProjection([
          { source: material, target: "/runtime/write", access_mode: "read-write", provenance: "package" },
        ]),
      },
      { command: "true" },
    );
    assert.equal(broadWrite.ok, false);
    if (!broadWrite.ok) assert.equal(broadWrite.error.code, "RUNTIME_PROJECTION_INVALID");

    const traversal = compileSandboxInvocation(
      {
        ...request,
        runtime_projection: projectionInput([
          { source: material, target: "/runtime/../escape", access_mode: "read-only", provenance: "package" },
        ]) as never,
      },
      { command: "true" },
    );
    assert.equal(traversal.ok, false);
    if (!traversal.ok) assert.equal(traversal.error.code, "RUNTIME_PROJECTION_INVALID");
  } finally {
    fixture.cleanup();
    removeWorktree(repository, worktree);
    fs.rmSync(materialRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("compatibility profile selection is explicit and does not silently fall back from projection validation", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const fixture = createControlledSandboxFixture();
  const materialRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-material-"));
  try {
    const request = await resolvedRequest(repository, worktree, fixture.layout);
    const material = path.join(materialRoot, "material");
    fs.mkdirSync(material);
    const compatibility = validatedProjection(
      [{ source: material, target: "/compat/material", access_mode: "read-only", provenance: "compatibility" }],
      EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
    );
    const compiled = compileSandboxInvocation({ ...request, runtime_projection: compatibility }, { command: "true" });
    assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.error));
    if (!compiled.ok) return;
    assert.ok(compiled.value.args.includes("/compat/material"));
    assert.equal(compiled.value.args.includes("/usr"), false);

    const invalidStrict = compileSandboxInvocation(
      {
        ...request,
        runtime_projection: projectionInput([
          { source: material, target: "/compat/material", access_mode: "read-only", provenance: "compatibility" },
        ]) as never,
      },
      { command: "true" },
    );
    assert.equal(invalidStrict.ok, false);
    if (!invalidStrict.ok) assert.equal(invalidStrict.error.code, "RUNTIME_PROJECTION_INVALID");
  } finally {
    fixture.cleanup();
    removeWorktree(repository, worktree);
    fs.rmSync(materialRoot, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("compileSandboxInvocation rejects a path outside the fixed system profile", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const fixture = createControlledSandboxFixture();
  try {
    const request = await resolvedRequest(repository, worktree, fixture.layout);
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
    fixture.cleanup();
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("protected execution rejects an incompatible seccomp architecture without fallback", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const fixture = createControlledSandboxFixture();
  try {
    const request = await resolvedRequest(repository, worktree, fixture.layout);
    const incompatible = {
      ...request,
      seccomp_profile: { ...request.seccomp_profile, architecture: "mips64" },
    };
    const result = compileSandboxInvocation(incompatible, { command: "true" });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
  } finally {
    fixture.cleanup();
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("protected launcher fails closed when bubblewrap is unavailable or the worktree path is a symlink", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const alias = `${worktree}-alias`;
  const fixture = createControlledSandboxFixture();
  try {
    const request = await resolvedRequest(repository, worktree, fixture.layout);
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
    fixture.cleanup();
    fs.rmSync(alias, { recursive: true, force: true });
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("sandboxed child limits are bounded and fail with stable errors", async () => {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const fixture = createControlledSandboxFixture();
  try {
    const request = await resolvedRequest(repository, worktree, fixture.layout);
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

    const nonzero = await runSandboxedCommand(request, { command: "node", args: ["-e", "process.exit(7)"] });
    assert.equal(nonzero.ok, true, nonzero.ok ? "" : JSON.stringify(nonzero.error));
    if (nonzero.ok) {
      assert.equal(nonzero.value.exit_code, 7);
      assert.equal(nonzero.value.signal, null);
    }

    const signal = await runSandboxedCommand(request, {
      command: "node",
      args: ["-e", "process.kill(process.pid, 'SIGTERM')"],
    });
    assert.equal(signal.ok, true, signal.ok ? "" : JSON.stringify(signal.error));
    if (signal.ok) {
      assert.equal(signal.value.exit_code, null);
      assert.equal(signal.value.signal, "SIGTERM");
    }

    const combinedOutput = await runSandboxedCommand(
      request,
      {
        command: "node",
        args: ["-e", "process.stdout.write('123'); process.stderr.write('456')"],
      },
      { max_output_bytes: 5 },
    );
    assert.equal(combinedOutput.ok, false);
    if (!combinedOutput.ok) assert.equal(combinedOutput.error.code, "SANDBOX_OUTPUT_LIMIT");

    const unicodeOutput = await runSandboxedCommand(
      request,
      { command: "node", args: ["-e", "process.stdout.write('あ')"] },
      { max_output_bytes: 2 },
    );
    assert.equal(unicodeOutput.ok, false);
    if (!unicodeOutput.ok) assert.equal(unicodeOutput.error.code, "SANDBOX_OUTPUT_LIMIT");
  } finally {
    fixture.cleanup();
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

    const denied = await runSandboxedCommand(request, {
      command: "sh",
      args: ["-ceu", "unshare -Ur true"],
    });
    assert.equal(denied.ok, true, denied.ok ? "" : JSON.stringify(denied.error));
    if (denied.ok) {
      assert.equal(denied.value.exit_code, 1, JSON.stringify(denied.value));
      assert.match(denied.value.stderr, /[Pp]ermission denied|Operation not permitted/u);
      assert.equal(denied.value.seccomp_profile?.id, "nawabari.seccomp.v1");
      assert.equal(denied.value.seccomp_profile?.version, 1);
    }
  } finally {
    removeWorktree(repository, worktree);
    fs.rmSync(sibling, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
