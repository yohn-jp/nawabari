import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistry, toPersistedSessionRecord, REGISTRY_SCHEMA_VERSION } from "../session-registry.js";
import { LocalSessionBackend } from "./session-backend.js";
import {
  resolveSandboxExecutionRequest,
  sandboxDoctorReport,
  SANDBOX_REQUIRED_CAPABILITIES,
  type SandboxProbe,
} from "./sandbox.js";

function readyProbe(overrides: Partial<SandboxProbe> = {}): SandboxProbe {
  return {
    platform: () => "linux",
    uid: () => 1_000,
    gid: () => 1_000,
    hasBubblewrap: () => true,
    hasNamespaceSupport: () => true,
    hasCgroupsV2: () => true,
    hasLandlock: () => true,
    hasSeccomp: () => true,
    hasCapabilities: () => true,
    ...overrides,
  };
}

test("sandbox doctor reports ready when every required and optional capability is present on Linux", () => {
  const report = sandboxDoctorReport(readyProbe());
  assert.equal(report.platform_supported, true);
  assert.equal(report.ready, true);
  assert.deepEqual(report.missing_required, []);
  assert.equal(report.network_mode, "inherited");
  assert.equal(report.capabilities.length, SANDBOX_REQUIRED_CAPABILITIES.length + 2);
  assert.equal(
    report.capabilities.every((check) => check.status === "available"),
    true,
  );
});

test("sandbox doctor fails closed when bubblewrap itself is missing", () => {
  const report = sandboxDoctorReport(readyProbe({ hasBubblewrap: () => false }));
  assert.equal(report.ready, false);
  assert.deepEqual(report.missing_required, ["bubblewrap"]);
  const bwrap = report.capabilities.find((check) => check.id === "bubblewrap");
  assert.equal(bwrap?.status, "unavailable");
  assert.equal(bwrap?.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
});

test("sandbox doctor treats seccomp and capability reduction as required baseline capabilities", () => {
  const report = sandboxDoctorReport(readyProbe({ hasSeccomp: () => false, hasCapabilities: () => false }));
  assert.equal(report.ready, false);
  assert.deepEqual(report.missing_required, ["seccomp", "capabilities"]);
  const seccomp = report.capabilities.find((check) => check.id === "seccomp");
  assert.equal(seccomp?.requirement, "required");
  assert.equal(seccomp?.details.profile_id, "nawabari.seccomp.v1");
  const capabilities = report.capabilities.find((check) => check.id === "capabilities");
  assert.equal(capabilities?.requirement, "required");
  assert.deepEqual(capabilities?.details.ambient_capabilities, []);
});

test("sandbox doctor fails closed when bubblewrap cannot actually establish the required namespaces", () => {
  const report = sandboxDoctorReport(readyProbe({ hasNamespaceSupport: () => false }));
  assert.equal(report.ready, false);
  assert.deepEqual(report.missing_required, [
    "user_namespaces",
    "mount_namespaces",
    "pid_namespace",
    "ipc_namespace",
    "uts_namespace",
  ]);
});

test("sandbox doctor marks every capability not_applicable on an unsupported platform", () => {
  const report = sandboxDoctorReport(readyProbe({ platform: () => "darwin" }));
  assert.equal(report.platform_supported, false);
  assert.equal(report.ready, false);
  assert.equal(
    report.capabilities.every(
      (check) => check.status === "not_applicable" && check.code === "SANDBOX_UNSUPPORTED_PLATFORM",
    ),
    true,
  );
});

test("resolveSandboxExecutionRequest binds an owned active session and derives its filesystem topology", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-sandbox-owned`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/sandbox-owned", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const result = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktreePath },
      { session_id: created.value.session_id, enforce: true },
      readyProbe(),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.enforce, true);
    assert.equal(result.value.session_id, created.value.session_id);
    assert.equal(result.value.worktree, created.value.worktree);
    assert.equal(result.value.branch, "feature/sandbox-owned");
    assert.equal(result.value.network_mode, "inherited");
    assert.equal(result.value.identity.real_uid, 1_000);
    assert.equal(result.value.identity.namespace_uid, 0);
    assert.equal(result.value.filesystem.owned_worktree, created.value.worktree);
    assert.equal(
      result.value.filesystem.home.startsWith(path.join(created.value.repository, "nawabari", "sandbox")),
      true,
    );
    assert.deepEqual(result.value.required_capabilities, [...SANDBOX_REQUIRED_CAPABILITIES]);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resolveSandboxExecutionRequest returns an enforce:false request instead of failing when protection was not requested", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-sandbox-not-enforced`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/sandbox-not-enforced", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const result = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktreePath },
      { session_id: created.value.session_id, enforce: false },
      readyProbe({ hasBubblewrap: () => false }),
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.enforce, false);
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resolveSandboxExecutionRequest fails closed instead of falling back when a required capability is missing and enforcement is requested", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-sandbox-no-fallback`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/sandbox-no-fallback", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const probe = readyProbe({ hasBubblewrap: () => false });
    const report = sandboxDoctorReport(probe);
    assert.equal(report.ready, false);
    assert.deepEqual(report.missing_required, ["bubblewrap"]);

    const result = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktreePath },
      { session_id: created.value.session_id, enforce: true },
      probe,
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resolveSandboxExecutionRequest treats cgroups as a profile requirement, not session lifecycle authority", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-sandbox-cgroups-required`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/sandbox-cgroups-required", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const unavailable = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktreePath },
      { session_id: created.value.session_id, enforce: true, cgroups: { required: true, execution_id: "run-1" } },
      readyProbe({ hasCgroupsV2: () => false }),
    );
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");

    const available = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktreePath },
      { session_id: created.value.session_id, enforce: true, cgroups: { required: true, execution_id: "run-1" } },
      readyProbe(),
    );
    assert.equal(available.ok, true);
    if (!available.ok) return;
    assert.deepEqual(available.value.required_capabilities.at(-1), "cgroups_v2");
    assert.equal(available.value.cgroups?.execution_id, "run-1");
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resolveSandboxExecutionRequest fails closed on an unsupported platform when enforcement is requested", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-sandbox-unsupported`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/sandbox-unsupported", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const result = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktreePath },
      { session_id: created.value.session_id, enforce: true },
      readyProbe({ platform: () => "win32" }),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "SANDBOX_UNSUPPORTED_PLATFORM");
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resolveSandboxExecutionRequest propagates a stale registry denial from the authoritative guard path", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-sandbox-stale`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/sandbox-stale" });
    fs.writeFileSync(
      registry.paths.registry,
      `${JSON.stringify(
        {
          schema_version: REGISTRY_SCHEMA_VERSION,
          repository_id: registry.repository.repositoryId,
          sessions: [toPersistedSessionRecord({ ...session, state: "stale" })],
        },
        null,
        2,
      )}\n`,
    );

    const backend = new LocalSessionBackend();
    const result = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktreePath },
      { session_id: session.sessionId, enforce: false },
      readyProbe(),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "STALE_REGISTRY");
  } finally {
    removeWorktree(repositoryPath, worktreePath);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resolveSandboxExecutionRequest propagates a caller identity mismatch from the authoritative guard path", async () => {
  const repositoryPath = createRepository();
  const firstWorktree = `${repositoryPath}-sandbox-caller-first`;
  const secondWorktree = `${repositoryPath}-sandbox-caller-second`;
  try {
    const backend = new LocalSessionBackend();
    const first = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/sandbox-caller-first", worktree: firstWorktree, label: null, base: null },
    );
    const second = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/sandbox-caller-second", worktree: secondWorktree, label: null, base: null },
    );
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;

    const result = await resolveSandboxExecutionRequest(
      backend,
      { cwd: firstWorktree },
      { session_id: second.value.session_id, enforce: false },
      readyProbe(),
    );

    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.error.code, "WORKTREE_OWNED_BY_OTHER_SESSION");
  } finally {
    removeWorktree(repositoryPath, firstWorktree);
    removeWorktree(repositoryPath, secondWorktree);
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-sandbox-"));
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  runGit(["config", "commit.gpgsign", "false"], repositoryPath);
  runGit(["config", "core.hooksPath", "/dev/null"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  return repositoryPath;
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    // The directory cleanup below is sufficient when Git never created it.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function runGit(args: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    }),
  ).trim();
}
