import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistry, toPersistedSessionRecord, REGISTRY_SCHEMA_VERSION } from "../session-registry.js";
import type { SessionBackend } from "./session.js";
import { LocalSessionBackend } from "./session-backend.js";
import {
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  sandboxDoctorReport,
  SANDBOX_REQUIRED_CAPABILITIES,
  type SandboxProbe,
} from "./sandbox.js";
import { EXPLICIT_COMPATIBILITY_RUNTIME_POLICY } from "./runtime-projection.js";
import { compileWorkingSetRuntimeProjection } from "./working-set-runtime-projection.js";

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

function effectiveWorkingSet(revision = 1, readOnly: readonly string[] = ["README.md"]) {
  return {
    version: 1 as const,
    kind: "effective-working-set" as const,
    revision,
    id: "ews-sandbox-test",
    repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
    base: { branch: "main", revision: "a".repeat(40) },
    scope: { readOnly, write: [], create: [], delete: [], deny: [".env"] },
    provenance: {
      executionScope: { kind: "implementation-execution-scope", version: 1, digest: "b".repeat(64), identity: "body" },
      candidateWorkingSet: { kind: "candidate-working-set", version: 1, digest: "c".repeat(64), identity: "candidate" },
      repository: { repositoryHost: "github.com", repositoryId: "1329799765", repository: "yohn-jp/nawabari" },
      base: { branch: "main", revision: "a".repeat(40) },
    },
  };
}

function strictProjection() {
  return {
    contract_id: "nawabari.session-runtime-projection.v1" as const,
    schema_version: 1 as const,
    policy: {
      mode: "strict" as const,
      host_visibility: "default-deny" as const,
      compatibility: "disabled" as const,
      unrestricted_host_fallback: "forbidden" as const,
    },
    profile: { id: "sandbox-test", version: "1" },
    requirements: [],
    filesystem: [],
    executables: [],
  };
}

function boundedBackend(currentWorkingSet: () => ReturnType<typeof effectiveWorkingSet>): SessionBackend {
  const session = {
    schema_version: 1,
    session_id: "0190f1e0-0000-7000-8000-000000000391",
    repository: "/tmp/sandbox-working-set-repository",
    worktree: "/tmp/sandbox-working-set-worktree",
    branch: "feature/sandbox-working-set",
    state: "active" as const,
    created_at: "2026-09-20T00:00:00.000Z",
    updated_at: "2026-09-20T00:00:00.000Z",
    working_set: currentWorkingSet(),
  };
  return {
    guard: async () => ({
      ok: true as const,
      value: {
        allowed: true,
        code: "ALLOWED" as const,
        repository: session.repository,
        worktree: session.worktree,
        branch: session.branch,
        session_id: session.session_id,
        owner_session_id: session.session_id,
        requested_session_id: session.session_id,
        state: session.state,
        details: {},
      },
    }),
    getSession: async () => ({ ok: true as const, value: { ...session, working_set: currentWorkingSet() } }),
  } as unknown as SessionBackend;
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

test("protected resolution composes the current persisted working set and rejects caller replacement", async () => {
  let currentWorkingSet = effectiveWorkingSet();
  const backend = boundedBackend(() => currentWorkingSet);
  const first = await resolveSandboxExecutionRequest(
    backend,
    { cwd: "/tmp/sandbox-working-set-worktree" },
    {
      session_id: "0190f1e0-0000-7000-8000-000000000391",
      enforce: true,
      runtime_projection: strictProjection(),
    },
    readyProbe(),
  );

  assert.equal(first.ok, true, first.ok ? "" : first.error.message);
  if (!first.ok) return;
  assert.equal(first.value.runtime_projection?.working_set?.working_set_id, "ews-sandbox-test");
  assert.equal(first.value.runtime_projection?.working_set?.revision, 1);
  assert.deepEqual(first.value.runtime_projection?.working_set?.scope.readOnly, ["README.md"]);

  const widened = compileWorkingSetRuntimeProjection({
    ...currentWorkingSet,
    scope: { ...currentWorkingSet.scope, readOnly: ["**"] },
  });
  assert.equal(widened.ok, true, widened.ok ? "" : widened.error.message);
  if (!widened.ok) return;
  const replaced = await resolveSandboxExecutionRequest(
    backend,
    { cwd: "/tmp/sandbox-working-set-worktree" },
    {
      session_id: "0190f1e0-0000-7000-8000-000000000391",
      enforce: true,
      runtime_projection: { ...strictProjection(), working_set: widened.value },
    },
    readyProbe(),
  );
  assert.equal(replaced.ok, false);
  if (!replaced.ok) assert.equal(replaced.error.code, "RUNTIME_PROJECTION_INVALID");

  currentWorkingSet = effectiveWorkingSet(2, ["README.md", "src/**"]);
  const expanded = await resolveSandboxExecutionRequest(
    backend,
    { cwd: "/tmp/sandbox-working-set-worktree" },
    {
      session_id: "0190f1e0-0000-7000-8000-000000000391",
      enforce: true,
      runtime_projection: strictProjection(),
    },
    readyProbe(),
  );
  assert.equal(expanded.ok, true, expanded.ok ? "" : expanded.error.message);
  if (!expanded.ok) return;
  assert.equal(expanded.value.runtime_projection?.working_set?.revision, 2);
  assert.deepEqual(expanded.value.runtime_projection?.working_set?.scope.readOnly, ["README.md", "src/**"]);
});

test("NixOS discovery uses explicit closure roots instead of broad FHS views", (t) => {
  const layout = discoverSandboxRuntimeLayout();
  if (layout.nix_store === null || layout.nix_current_system === null) {
    t.skip("canonical NixOS Runtime paths are unavailable in this environment");
    return;
  }

  assert.equal(layout.usr, null);
  assert.equal(layout.bin, null);
  assert.equal(layout.lib, null);
  assert.equal(layout.lib64, null);
  assert.equal(layout.nix_store, "/nix/store");
  assert.equal(layout.nix_current_system, "/run/current-system");
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
      {
        session_id: created.value.session_id,
        enforce: true,
        runtime_policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
      },
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
    assert.equal(result.value.runtime_projection?.policy.mode, "compatibility");
    assert.ok(result.value.runtime_projection?.filesystem.length);
    assert.equal(
      result.value.runtime_projection?.filesystem.every((entry) => entry.provenance === "compatibility"),
      true,
    );
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

test("discoverSandboxRuntimeLayout projects only the host global user.name/user.email, never the full config", () => {
  const configDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-host-global-identity-"));
  const globalConfigPath = path.join(configDirectory, "gitconfig");
  try {
    fs.writeFileSync(
      globalConfigPath,
      [
        "[user]",
        "\tname = Host Global Author",
        "\temail = host-global@example.invalid",
        "[credential]",
        "\thelper = store --file=/should/never/be/read",
        "[alias]",
        "\tco = checkout",
        "",
      ].join("\n"),
    );
    const layout = discoverSandboxRuntimeLayout({ ...process.env, GIT_CONFIG_GLOBAL: globalConfigPath });
    assert.equal(layout.git_user_name, "Host Global Author");
    assert.equal(layout.git_user_email, "host-global@example.invalid");
  } finally {
    fs.rmSync(configDirectory, { recursive: true, force: true });
  }
});

test("discoverSandboxRuntimeLayout reports null identity, not a fallback value, when no host global identity is set", () => {
  const layout = discoverSandboxRuntimeLayout({ ...process.env, GIT_CONFIG_GLOBAL: "/dev/null" });
  assert.equal(layout.git_user_name, null);
  assert.equal(layout.git_user_email, null);
});

test("resolveSandboxExecutionRequest carries the discovered host global Git identity onto the request", async () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-sandbox-git-identity`;
  try {
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repositoryPath },
      { branch: "feature/sandbox-git-identity", worktree: worktreePath, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;

    const layout = {
      ...discoverSandboxRuntimeLayout(),
      git_user_name: "Projected Author",
      git_user_email: "projected@example.invalid",
    };
    const result = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        enforce: true,
        runtime_policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
      },
      readyProbe(),
      layout,
    );

    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.value.git_identity, {
      host_global_name: "Projected Author",
      host_global_email: "projected@example.invalid",
    });
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
      {
        session_id: created.value.session_id,
        enforce: true,
        runtime_policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
        cgroups: { required: true, execution_id: "run-1" },
      },
      readyProbe({ hasCgroupsV2: () => false }),
    );
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");

    const available = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktreePath },
      {
        session_id: created.value.session_id,
        enforce: true,
        runtime_policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
        cgroups: { required: true, execution_id: "run-1" },
      },
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
