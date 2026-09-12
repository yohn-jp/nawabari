import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import { LocalSessionBackend } from "./session-backend.js";
import {
  buildExplicitCompatibilityRuntimeProjection,
  compileSandboxInvocation,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  sandboxDoctorReport,
  type SandboxExecutionRequest,
} from "./sandbox.js";

function runGit(args: readonly string[], cwd: string, allowFailure = false): string {
  try {
    return execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: allowFailure ? "ignore" : ["ignore", "pipe", "pipe"],
    });
  } catch (error: unknown) {
    if (allowFailure) return "";
    throw error;
  }
}

function createRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-security-negative-"));
  runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
  runGit(["config", "user.name", "Nawabari Security Tests"], repository);
  runGit(["config", "user.email", "security-tests@nawabari.invalid"], repository);
  fs.writeFileSync(path.join(repository, "README.md"), "security conformance\n");
  runGit(["add", "README.md"], repository);
  runGit(["commit", "--quiet", "-m", "initial"], repository);
  return repository;
}

type SecurityFixture = {
  readonly backend: LocalSessionBackend;
  readonly repository: string;
  readonly worktree: string;
  readonly sibling: string;
  readonly sessionId: string;
  readonly request: SandboxExecutionRequest;
};

async function createSecurityFixture(): Promise<SecurityFixture> {
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const sibling = `${repository}-sibling`;
  const backend = new LocalSessionBackend();
  const owned = await backend.createSession(
    { cwd: repository },
    { branch: "feature/security-negative-owned", worktree, label: null, base: null },
  );
  if (!owned.ok) throw owned.error;
  const other = await backend.createSession(
    { cwd: repository },
    { branch: "feature/security-negative-sibling", worktree: sibling, label: null, base: null },
  );
  if (!other.ok) throw other.error;
  fs.writeFileSync(path.join(sibling, "secret.txt"), "sibling secret\n");

  const runtimeProjection = buildExplicitCompatibilityRuntimeProjection(discoverSandboxRuntimeLayout());
  if (!runtimeProjection.ok) throw runtimeProjection.error;

  const request = await resolveSandboxExecutionRequest(
    backend,
    { cwd: worktree },
    { session_id: owned.value.session_id, enforce: true, runtime_projection: runtimeProjection.value },
  );
  if (!request.ok) throw request.error;
  return {
    backend,
    repository,
    worktree,
    sibling,
    sessionId: owned.value.session_id,
    request: request.value,
  };
}

function cleanupSecurityFixture(fixture: SecurityFixture): void {
  runGit(["worktree", "remove", "--force", fixture.worktree], fixture.repository, true);
  runGit(["worktree", "remove", "--force", fixture.sibling], fixture.repository, true);
  fs.rmSync(fixture.worktree, { recursive: true, force: true });
  fs.rmSync(fixture.sibling, { recursive: true, force: true });
  fs.rmSync(fixture.repository, { recursive: true, force: true });
}

async function successfulRun(request: SandboxExecutionRequest, command: string, args: readonly string[] = []) {
  const result = await runSandboxedCommand(request, { command, args });
  if (!result.ok) throw result.error;
  assert.equal(result.ok, true);
  return result.value;
}

test("canonical protected execution rejects the Issue #93 security-negative matrix", async (t) => {
  if (process.platform !== "linux") {
    t.skip("canonical protected execution is Linux-only");
    return;
  }
  const doctor = sandboxDoctorReport();
  const layout = discoverSandboxRuntimeLayout();
  if (!doctor.ready || layout.bubblewrap === null) {
    t.skip(`protected execution unavailable: ${doctor.missing_required.join(", ") || "bubblewrap"}`);
    return;
  }

  const fixture = await createSecurityFixture();
  const hostTmpDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-host-tmp-"));
  const hostTmpMarker = path.join(hostTmpDirectory, "marker");
  const privateTmpMarker = `nawabari-private-tmp-${process.pid}-${Date.now()}`;
  const controlMarker = path.join(fixture.repository, "nawabari", "control-plane-secret");
  const symlinkEscape = path.join(fixture.worktree, "sibling-escape");
  const hostPidNamespace = fs.readlinkSync("/proc/self/ns/pid");
  const hostNetworkNamespace = fs.readlinkSync("/proc/self/ns/net");
  fs.writeFileSync(hostTmpMarker, "host-only\n");
  fs.mkdirSync(path.dirname(controlMarker), { recursive: true, mode: 0o700 });
  fs.writeFileSync(controlMarker, "control-plane-only\n");
  fs.symlinkSync(fixture.sibling, symlinkEscape, "dir");

  try {
    await t.test("sibling direct, traversal, cwd, symlink, and unmounted control paths are denied", async () => {
      const result = await successfulRun(fixture.request, "sh", [
        "-ceu",
        [
          'test ! -r "$1/secret.txt"',
          'test ! -r "$2/../$(basename "$1")/secret.txt"',
          'if cd "$1"; then exit 41; fi',
          'test ! -r "$2/sibling-escape/secret.txt"',
          'test ! -e "$3"',
          "test ! -e /nawabari/control-plane-secret",
          "printf security-negative-filesystem-ok",
        ].join(";"),
        "security-negative-filesystem",
        fixture.sibling,
        fixture.worktree,
        controlMarker,
      ]);
      assert.equal(result.exit_code, 0, JSON.stringify(result));
      assert.equal(result.stdout, "security-negative-filesystem-ok");
    });

    await t.test("/tmp and /proc retain the documented private session topology", async () => {
      const result = await successfulRun(fixture.request, "sh", [
        "-ceu",
        [
          'test ! -e "$1"',
          `test ! -e /tmp/${privateTmpMarker}`,
          `touch /tmp/${privateTmpMarker}`,
          "test -r /proc/1/status",
          'test ! -e "/proc/$2"',
          'test "$(readlink /proc/self/ns/pid)" != "$3"',
          "printf security-negative-session-topology-ok",
        ].join(";"),
        "security-negative-session-topology",
        hostTmpMarker,
        String(process.pid),
        hostPidNamespace,
      ]);
      assert.equal(result.exit_code, 0, JSON.stringify(result));
      assert.equal(result.stdout, "security-negative-session-topology-ok");
      assert.equal(fs.existsSync(path.join(os.tmpdir(), privateTmpMarker)), false);
    });

    await t.test("namespace-local root cannot obtain host privilege", async () => {
      const result = await successfulRun(fixture.request, "sh", [
        "-ceu",
        [
          'test "$(id -u)" = 0',
          "grep -q '^CapEff:[[:space:]]*0*$' /proc/self/status",
          "mkdir /tmp/mnt",
          "if mount -t tmpfs none /tmp/mnt 2>/tmp/mount-denied; then exit 42; fi",
          "printf security-negative-privilege-ok",
        ].join(";"),
        "security-negative-privilege",
      ]);
      assert.equal(result.exit_code, 0, JSON.stringify(result));
      assert.equal(result.stdout, "security-negative-privilege-ok");
    });

    await t.test("seccomp denies namespace creation with bounded diagnostics", async () => {
      const result = await successfulRun(fixture.request, "sh", ["-ceu", "unshare -Ur true"]);
      assert.equal(result.exit_code, 1, JSON.stringify(result));
      assert.match(result.stderr, /Permission denied|Operation not permitted/u, JSON.stringify(result));
      assert.equal(result.seccomp_profile?.id, "nawabari.seccomp.v1");
      assert.equal(result.seccomp_profile?.version, 1);
    });

    await t.test("Landlock, when enforced, denies writes outside the canonical topology", async () => {
      const invocation = compileSandboxInvocation(fixture.request, { command: "true" });
      assert.equal(invocation.ok, true, invocation.ok ? "" : JSON.stringify(invocation.error));
      if (!invocation.ok) return;
      if (invocation.value.landlock.state !== "enforced") {
        assert.ok(
          ["reduced-defense", "incompatible", "error"].includes(invocation.value.landlock.state),
          invocation.value.landlock.state,
        );
        return;
      }
      const result = await successfulRun(fixture.request, "sh", [
        "-ceu",
        "test -f /etc/passwd; if mkdir /nawabari/security-negative-escape; then exit 42; else printf landlock-denied; fi",
        "security-negative-landlock",
      ]);
      assert.equal(result.exit_code, 0, JSON.stringify(result));
      assert.equal(result.stdout, "landlock-denied");
      assert.equal(result.landlock?.state, "enforced");
      assert.equal(fs.existsSync(path.join(fixture.repository, "nawabari", "security-negative-escape")), false);
    });

    await t.test("cgroup identity is deterministic and cleanup is not confused with ownership", async () => {
      const executionId = `security-negative-${process.pid}-${Date.now()}`;
      const request = await resolveSandboxExecutionRequest(
        fixture.backend,
        { cwd: fixture.worktree },
        {
          session_id: fixture.sessionId,
          enforce: true,
          runtime_projection: fixture.request.runtime_projection,
          cgroups: { required: true, execution_id: executionId },
        },
      );
      if (!request.ok) {
        assert.equal(request.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE", JSON.stringify(request.error));
        return;
      }
      const first = await runSandboxedCommand(request.value, { command: "true" });
      if (!first.ok) {
        assert.ok(
          ["SANDBOX_CAPABILITY_UNAVAILABLE", "SANDBOX_CGROUP_SETUP_FAILED", "SANDBOX_CGROUP_SCOPE_CONFLICT"].includes(
            first.error.code,
          ),
          JSON.stringify(first.error),
        );
        return;
      }
      assert.equal(first.value.exit_code, 0, JSON.stringify(first.value));
      assert.ok(first.value.resources);
      const scope = first.value.resources?.scope;
      assert.match(scope ?? "", /^nawabari-[a-f0-9]{48}$/u);
      assert.equal(fs.existsSync(path.join("/sys/fs/cgroup", "nawabari", scope as string)), false);

      const second = await runSandboxedCommand(request.value, { command: "true" });
      assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
      if (!second.ok) return;
      assert.equal(second.value.resources?.scope, scope);
      assert.equal(fs.existsSync(path.join("/sys/fs/cgroup", "nawabari", scope as string)), false);
    });

    await t.test("network remains inherited and is never presented as isolated", async () => {
      assert.equal(fixture.request.network_mode, "inherited");
      const invocation = compileSandboxInvocation(fixture.request, { command: "true" });
      assert.equal(invocation.ok, true, invocation.ok ? "" : JSON.stringify(invocation.error));
      if (!invocation.ok) return;
      assert.equal(invocation.value.args.includes("--unshare-net"), false);
      const result = await successfulRun(fixture.request, "readlink", ["/proc/self/ns/net"]);
      assert.equal(result.exit_code, 0, JSON.stringify(result));
      assert.equal(result.stdout.trim(), hostNetworkNamespace);
    });

    await t.test("protected execution cannot downgrade to ambient execution", async () => {
      const marker = path.join(fixture.worktree, "ambient-downgrade-marker");
      const downgrade = await runSandboxedCommand(
        { ...fixture.request, enforce: false },
        { command: "sh", args: ["-ceu", `touch ${JSON.stringify(marker)}`] },
      );
      assert.equal(downgrade.ok, false, downgrade.ok ? JSON.stringify(downgrade.value) : "");
      if (!downgrade.ok) assert.equal(downgrade.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
      assert.equal(fs.existsSync(marker), false);
    });
  } finally {
    fs.rmSync(hostTmpDirectory, { recursive: true, force: true });
    fs.rmSync(controlMarker, { force: true });
    cleanupSecurityFixture(fixture);
  }
});
