import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LocalSessionBackend } from "./session-backend.js";
import { deriveLandlockRules, LANDLOCK_ACCESS_FS, LANDLOCK_ABI_MINIMUM, LANDLOCK_TRAMPOLINE } from "./landlock.js";
import {
  compileSandboxInvocation,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  sandboxDoctorReport,
  sandboxCapabilityBaseline,
  sandboxSeccompProfileMetadata,
  type SandboxFilesystemTopology,
  type SandboxCapabilityId,
  type SandboxProbe,
} from "./sandbox.js";

function probe(overrides: Partial<SandboxProbe> = {}): SandboxProbe {
  return {
    platform: () => "linux",
    uid: () => 1_000,
    gid: () => 1_000,
    hasBubblewrap: () => true,
    hasNamespaceSupport: () => true,
    hasCgroupsV2: () => false,
    hasLandlock: () => true,
    landlockAbi: () => 3,
    hasSeccomp: () => true,
    hasCapabilities: () => true,
    ...overrides,
  };
}

function topology(root: string): SandboxFilesystemTopology {
  const hostHome = path.join(root, "host-home");
  return {
    owned_worktree: path.join(root, "worktree"),
    home: path.join(root, "state", "home"),
    cache: path.join(root, "state", "cache"),
    persistent_home: path.join(root, "state", "shared-home"),
    git_metadata: path.join(root, "state", "git"),
    git_objects: path.join(root, "objects"),
    user_tool_paths: [path.join(hostHome, ".local", "bin")],
    user_tool_home: hostHome,
    runtime_paths: ["/dev", "/proc", "/tmp"],
    system_paths: ["/usr", "/etc/passwd"],
  };
}

test("Landlock rules use fixed namespace destinations and omit host topology paths", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-landlock-rules-"));
  try {
    const rules = deriveLandlockRules(topology(root));
    const byPath = new Map(rules.map((rule) => [rule.path, rule.allowed_access]));
    assert.equal(byPath.has(path.join(root, "host-home", ".local", "bin")), false);
    assert.equal(byPath.has(path.join(root, "state", "home")), false);
    assert.equal(byPath.get("/home/nawabari"), allFilesystemAccess());
    assert.equal(byPath.get("/home"), LANDLOCK_ACCESS_FS.execute | LANDLOCK_ACCESS_FS.read_dir);
    assert.equal(
      byPath.get("/usr"),
      LANDLOCK_ACCESS_FS.execute | LANDLOCK_ACCESS_FS.read_file | LANDLOCK_ACCESS_FS.read_dir,
    );
    assert.equal(byPath.get("/etc/passwd"), LANDLOCK_ACCESS_FS.execute | LANDLOCK_ACCESS_FS.read_file);
    assert.equal(byPath.has("/"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Landlock capability reports exact ABI and reduced/incompatible states", () => {
  const supported = sandboxDoctorReport(probe());
  assert.deepEqual(supported.landlock, { abi: 3, supported: true, effective_state: "available" });
  const supportedCheck = supported.capabilities.find((candidate) => candidate.id === "landlock");
  assert.equal(supportedCheck?.details.abi, 3);
  assert.equal(supportedCheck?.details.effective_state, "available");

  const unavailable = sandboxDoctorReport(probe({ landlockAbi: () => null, hasLandlock: () => false }));
  assert.deepEqual(unavailable.landlock, {
    abi: null,
    supported: false,
    effective_state: "reduced-defense",
  });
  const incompatible = sandboxDoctorReport(probe({ landlockAbi: () => 0 }));
  assert.deepEqual(incompatible.landlock, { abi: 0, supported: false, effective_state: "incompatible" });
  const unsupportedPlatform = sandboxDoctorReport(probe({ platform: () => "darwin" }));
  assert.deepEqual(unsupportedPlatform.landlock, {
    abi: null,
    supported: false,
    effective_state: "not-applicable",
  });
});

test("unsupported optional Landlock leaves the bubblewrap command unchanged and reports reduced defense", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-landlock-optional-"));
  const bwrap = path.join(root, "host-home", ".local", "bin", "bwrap");
  const topologyValue = topology(root);
  try {
    for (const directory of [
      topologyValue.owned_worktree,
      topologyValue.home,
      topologyValue.cache,
      topologyValue.persistent_home,
      topologyValue.git_metadata,
      topologyValue.git_objects,
      path.join(root, "host-home", ".local", "bin"),
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(bwrap, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const request = {
      schema_version: 1,
      contract_id: "nawabari.sandbox-execution.v1",
      enforce: true,
      session_id: "session-optional",
      repository: root,
      worktree: topologyValue.owned_worktree,
      branch: "feature/landlock",
      network_mode: "inherited" as const,
      sandbox_executable: bwrap,
      identity: { real_uid: 1_000, real_gid: 1_000, namespace_uid: 0, namespace_gid: 0 },
      filesystem: topologyValue,
      required_capabilities: [
        "bubblewrap",
        "user_namespaces",
        "mount_namespaces",
        "pid_namespace",
        "ipc_namespace",
        "uts_namespace",
      ] as SandboxCapabilityId[],
      seccomp_profile: sandboxSeccompProfileMetadata(),
      capability_baseline: sandboxCapabilityBaseline,
      landlock_abi: null,
      landlock_executable: null,
    };
    const compiled = compileSandboxInvocation(request, { command: "printf", args: ["ok"] });
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.message);
    if (!compiled.ok) return;
    const terminator = compiled.value.args.indexOf("--");
    assert.deepEqual(compiled.value.args.slice(terminator), ["--", "printf", "ok"]);
    assert.deepEqual(compiled.value.landlock, {
      abi: null,
      state: "reduced-defense",
      rule_count: compiled.value.landlock.rule_count,
    });
    assert.equal(compiled.value.args.includes(LANDLOCK_TRAMPOLINE), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("required Landlock fails closed when ABI or the canonical runtime adapter is unavailable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-landlock-required-"));
  const topologyValue = topology(root);
  const bwrap = path.join(root, "host-home", ".local", "bin", "bwrap");
  try {
    for (const directory of [
      topologyValue.owned_worktree,
      topologyValue.home,
      topologyValue.cache,
      topologyValue.persistent_home,
      topologyValue.git_metadata,
      topologyValue.git_objects,
      path.join(root, "host-home", ".local", "bin"),
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(bwrap, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const baseRequest = {
      schema_version: 1,
      contract_id: "nawabari.sandbox-execution.v1",
      enforce: true,
      session_id: "session-required",
      repository: root,
      worktree: topologyValue.owned_worktree,
      branch: "feature/landlock",
      network_mode: "inherited" as const,
      sandbox_executable: bwrap,
      identity: { real_uid: 1_000, real_gid: 1_000, namespace_uid: 0, namespace_gid: 0 },
      filesystem: topologyValue,
      required_capabilities: [
        "bubblewrap",
        "user_namespaces",
        "mount_namespaces",
        "pid_namespace",
        "ipc_namespace",
        "uts_namespace",
      ] as SandboxCapabilityId[],
      seccomp_profile: sandboxSeccompProfileMetadata(),
      capability_baseline: sandboxCapabilityBaseline,
      landlock_required: true,
    };
    const unavailable = compileSandboxInvocation({ ...baseRequest, landlock_abi: null }, { command: "true" });
    assert.equal(unavailable.ok, false);
    if (!unavailable.ok) assert.equal(unavailable.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
    const noAdapter = compileSandboxInvocation(
      { ...baseRequest, landlock_abi: LANDLOCK_ABI_MINIMUM },
      { command: "true" },
    );
    assert.equal(noAdapter.ok, false);
    if (!noAdapter.ok) assert.equal(noAdapter.error.code, "SANDBOX_CAPABILITY_UNAVAILABLE");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Landlock setup failure is reported once with bounded diagnostics and never retries ambiently", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-landlock-failure-"));
  const bwrap = path.join(root, "host-home", ".local", "bin", "bwrap");
  const topologyValue = topology(root);
  try {
    for (const directory of [
      topologyValue.owned_worktree,
      topologyValue.home,
      topologyValue.cache,
      topologyValue.persistent_home,
      topologyValue.git_metadata,
      topologyValue.git_objects,
      path.join(root, "host-home", ".local", "bin"),
    ]) {
      fs.mkdirSync(directory, { recursive: true });
    }
    fs.writeFileSync(
      bwrap,
      "#!/bin/sh\nprintf 'nawabari-landlock: %s\\n' 'setup failed '$(printf x%.0s $(seq 1 1000)) >&2\nexit 125\n",
      { mode: 0o700 },
    );
    const request = {
      schema_version: 1,
      contract_id: "nawabari.sandbox-execution.v1",
      enforce: true,
      session_id: "session-failure",
      repository: root,
      worktree: topologyValue.owned_worktree,
      branch: "feature/landlock",
      network_mode: "inherited" as const,
      sandbox_executable: bwrap,
      identity: { real_uid: 1_000, real_gid: 1_000, namespace_uid: 0, namespace_gid: 0 },
      filesystem: topologyValue,
      required_capabilities: [
        "bubblewrap",
        "user_namespaces",
        "mount_namespaces",
        "pid_namespace",
        "ipc_namespace",
        "uts_namespace",
      ] as SandboxCapabilityId[],
      seccomp_profile: sandboxSeccompProfileMetadata(),
      capability_baseline: sandboxCapabilityBaseline,
      landlock_abi: 3,
      landlock_executable: "/bin/sh",
    };
    const result = await runSandboxedCommand(request, { command: "touch", args: ["ambient-marker"] });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "SANDBOX_EXECUTION_FAILED");
      assert.equal(result.error.details?.retryable, false);
      const diagnostic = result.error.details?.diagnostic;
      assert.equal(typeof diagnostic, "string");
      assert.ok((diagnostic as string).length <= 240);
    }
    assert.equal(fs.existsSync(path.join(topologyValue.owned_worktree, "ambient-marker")), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("supported Landlock denies a write outside the canonical topology", async (t) => {
  if (process.platform !== "linux") {
    t.skip("Landlock is Linux-only");
    return;
  }
  const doctor = sandboxDoctorReport();
  const layout = discoverSandboxRuntimeLayout();
  if (!doctor.ready || !doctor.landlock.supported || layout.bubblewrap === null || layout.landlock_helper === null) {
    t.skip("bubblewrap, required namespaces, or Landlock is unavailable");
    return;
  }
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-landlock-real-"));
  const worktree = `${repository}-worktree`;
  try {
    runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
    runGit(["config", "user.name", "Nawabari Tests"], repository);
    runGit(["config", "user.email", "tests@nawabari.invalid"], repository);
    fs.writeFileSync(path.join(repository, "README.md"), "landlock\n");
    runGit(["add", "README.md"], repository);
    runGit(["commit", "--quiet", "-m", "initial"], repository);
    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/landlock", worktree, label: null, base: null },
    );
    assert.equal(created.ok, true);
    if (!created.ok) return;
    const request = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      { session_id: created.value.session_id, enforce: true },
    );
    assert.equal(request.ok, true, request.ok ? "" : request.error.message);
    if (!request.ok) return;
    const result = await runSandboxedCommand(request.value, {
      command: "sh",
      args: [
        "-ceu",
        "touch landlock-owned; test -f landlock-owned; test ! -e /nawabari/landlock-outside; mkdir /nawabari/landlock-outside",
      ],
    });
    if (!result.ok) {
      if (result.error.code === "SANDBOX_EXECUTION_FAILED") {
        t.skip("Landlock is advertised by the host but unavailable inside the bubblewrap runtime");
        return;
      }
      assert.fail(JSON.stringify(result.error));
    }
    assert.equal(result.value.exit_code, 1, JSON.stringify(result.value));
    assert.equal(result.value.landlock?.state, "enforced");
    assert.equal(fs.existsSync(path.join(worktree, "landlock-owned")), true);
    assert.equal(fs.existsSync(path.join(repository, "nawabari", "landlock-outside")), false);
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktree], repository);
    } catch {
      // The directory cleanup below is sufficient when setup failed early.
    }
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

function allFilesystemAccess(): number {
  return Object.values(LANDLOCK_ACCESS_FS).reduce((mask, value) => mask | value, 0);
}

function runGit(args: readonly string[], cwd: string): string {
  return String(execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }));
}
