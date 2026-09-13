import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  defaultSandboxProbe,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  type SandboxRuntimeLayout,
  type SandboxProbe,
} from "./sandbox.js";
import { LocalSessionBackend } from "./session-backend.js";
import {
  resolveRuntimeProjection,
  runtimeDoctorReport,
  runtimeMaterializerAvailability,
} from "./runtime-resolution.js";
import { compileRuntimeExecutableProjection } from "./runtime-executable-projection.js";
import { EXPLICIT_COMPATIBILITY_RUNTIME_POLICY, STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import type { NixCommandRunner } from "./nix-runtime-closure.js";

function emptyLayout(overrides: Partial<SandboxRuntimeLayout> = {}): SandboxRuntimeLayout {
  return {
    bubblewrap: null,
    nix: null,
    landlock_helper: null,
    user_home: null,
    user_local_bin: null,
    user_local_lib: null,
    user_pnpm_bin: null,
    nix_store: null,
    nix_current_system: null,
    nix_wrappers: null,
    nix_user_profile: null,
    usr: null,
    bin: null,
    lib: null,
    lib64: null,
    passwd: null,
    group: null,
    nsswitch: null,
    hosts: null,
    resolv_conf: null,
    alternatives: null,
    ssl_certs: null,
    pki_certs: null,
    ca_certificates: null,
    git_user_name: null,
    git_user_email: null,
    ...overrides,
  };
}

type CandidateFixture = Readonly<{
  readonly root: string;
  readonly candidates: readonly { readonly requirement_id: string; readonly path: string }[];
  readonly cleanup: () => void;
}>;

function deterministicReadySandboxProbe(): SandboxProbe {
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

/**
 * Real, bounded FHS development-baseline executables. `runtimeMaterializerAvailability`
 * now calls the same resolver used for execution (#314), so a bare `usr: "/usr"`
 * host-layout hint is no longer sufficient to make FHS available in tests.
 */
function createCandidateFixture(): CandidateFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-resolution-fhs-"));
  const node = path.join(root, "node-runtime");
  const git = path.join(root, "git-package");
  const ls = path.join(root, "ls-runtime");
  const pnpm = path.join(root, "pnpm-package");
  fs.copyFileSync(process.execPath, node);
  fs.chmodSync(node, 0o755);
  fs.writeFileSync(git, "#!/bin/sh\nprintf 'git-package-ok\\n'\n", { mode: 0o755 });
  fs.writeFileSync(ls, "#!/bin/sh\nprintf 'ls-runtime-ok\\n'\n", { mode: 0o755 });
  fs.writeFileSync(pnpm, "#!/bin/sh\nprintf 'pnpm-package-ok\\n'\n", { mode: 0o755 });
  return {
    root,
    candidates: Object.freeze([
      Object.freeze({ requirement_id: "node-runtime", path: node }),
      Object.freeze({ requirement_id: "git-package", path: git }),
      Object.freeze({ requirement_id: "ls-runtime", path: ls }),
      Object.freeze({ requirement_id: "pnpm-package", path: pnpm }),
    ]),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

type NixFixture = Readonly<{
  readonly root: string;
  readonly store: string;
  readonly layout: SandboxRuntimeLayout;
  readonly runner: NixCommandRunner;
  readonly cleanup: () => void;
}>;

function nixFixture(): NixFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-resolution-nix-"));
  const store = path.join(root, "store");
  const currentSystem = path.join(root, "current-system");
  fs.mkdirSync(store);
  fs.mkdirSync(currentSystem);

  const roots = {
    node: path.join(store, "aaa-nodejs-24"),
    git: path.join(store, "bbb-git-2"),
    ls: path.join(store, "ccc-coreutils-9"),
    pnpm: path.join(store, "ddd-pnpm-11"),
  };
  const dependencies = {
    node: path.join(store, "ddd-node-dependency"),
    git: path.join(store, "eee-git-dependency"),
    ls: path.join(store, "fff-coreutils-dependency"),
    pnpm: path.join(store, "ggg-pnpm-dependency"),
  };
  const attributes: Readonly<Record<string, keyof typeof roots>> = {
    "nixpkgs#nodejs": "node",
    "nixpkgs#git": "git",
    "nixpkgs#coreutils": "ls",
    "nixpkgs#pnpm": "pnpm",
  };
  for (const [key, storePath] of Object.entries(roots)) {
    const executable = path.join(storePath, "bin", key);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n");
    fs.chmodSync(executable, 0o755);
  }
  for (const storePath of Object.values(dependencies)) fs.mkdirSync(storePath);

  const runner: NixCommandRunner = (_executable, args) => {
    const installable = args[args.length - 1];
    const key = typeof installable === "string" ? attributes[installable] : undefined;
    if (key === undefined) return { exit_code: 1, stdout: "", stderr: "unknown installable" };
    const selected = args.includes("--recursive") ? [roots[key], dependencies[key]] : [roots[key]];
    return {
      exit_code: 0,
      stdout: JSON.stringify(Object.fromEntries(selected.map((storePath) => [storePath, null]))),
      stderr: "",
    };
  };
  return {
    root,
    store,
    layout: emptyLayout({
      nix: path.join(root, "nix"),
      nix_store: store,
      nix_current_system: currentSystem,
      user_home: "/home/sophia",
      user_local_bin: "/home/sophia/.local/bin",
      user_local_lib: "/home/sophia/.local/lib",
      user_pnpm_bin: "/home/sophia/.local/share/pnpm",
      // Keep both materializers discoverable; Nix must win deterministically.
      usr: "/usr",
    }),
    runner,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test("the default resolution is development + strict and contains only the canonical baseline", () => {
  const fixture = nixFixture();
  try {
    const result = resolveRuntimeProjection({
      platform: "linux",
      runtime_layout: fixture.layout,
      nix: { store_root: fixture.store, command_runner: fixture.runner },
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;

    assert.deepEqual(result.value.policy, STRICT_RUNTIME_POLICY);
    assert.deepEqual(result.value.profile, { id: "development", version: "1" });
    assert.equal(result.value.materializer, "nix");
    assert.deepEqual(
      result.value.projection.requirements.map((requirement) => requirement.id),
      ["git-package", "ls-runtime", "node-runtime"],
    );
    assert.deepEqual(
      result.value.projection.executables.map((executable) => executable.name),
      ["git", "ls", "node"],
    );
    assert.equal(
      result.value.projection.filesystem.some((entry) => entry.source === fixture.store),
      false,
    );
    assert.equal(
      result.value.projection.filesystem.some((entry) => entry.target === "/usr"),
      false,
    );
    assert.equal(
      result.value.projection.filesystem.some((entry) => entry.target === "/bin"),
      false,
    );
    assert.equal(
      result.value.projection.filesystem.some((entry) => entry.target === "/nix/store"),
      false,
    );
    const ambientPaths = [
      fixture.layout.user_home,
      fixture.layout.user_local_bin,
      fixture.layout.user_local_lib,
      fixture.layout.user_pnpm_bin,
    ].filter((candidate): candidate is string => candidate !== null && candidate !== undefined);
    assert.ok(
      result.value.projection.filesystem.every((entry) =>
        ambientPaths.every((ambient) => entry.source !== ambient && entry.target !== ambient),
      ),
    );
    const executableSurface = compileRuntimeExecutableProjection(result.value.projection);
    assert.equal(executableSurface.ok, true, executableSurface.ok ? "" : JSON.stringify(executableSurface.error));
    if (!executableSurface.ok) return;
    assert.deepEqual(
      executableSurface.value.map((executable) => executable.target),
      ["/nawabari/bin/git", "/nawabari/bin/ls", "/nawabari/bin/node"],
    );
  } finally {
    fixture.cleanup();
  }
});

test("a plain non-pnpm repository resolves the default strict profile without pnpm evidence", async () => {
  const fixture = createCandidateFixture();
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-resolution-plain-repository-"));
  const worktree = `${repository}-worktree`;
  const git = (args: readonly string[], cwd = repository): void => {
    execFileSync("git", [...args], { cwd, stdio: ["ignore", "ignore", "ignore"] });
  };
  git(["init", "--quiet", "--initial-branch", "main", repository]);
  git(["config", "user.name", "Nawabari plain repository"]);
  git(["config", "user.email", "plain-repository@nawabari.invalid"]);
  fs.writeFileSync(path.join(repository, "README.md"), "plain repository\n");
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "initial"]);

  try {
    const backend = new LocalSessionBackend();
    const sandboxProbe = deterministicReadySandboxProbe();
    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/plain-non-pnpm", worktree, label: null, base: null },
    );
    assert.equal(created.ok, true, created.ok ? "" : JSON.stringify(created.error));
    if (!created.ok) return;

    const discovered = discoverSandboxRuntimeLayout();
    const layout = {
      ...discovered,
      bubblewrap: discovered.bubblewrap,
      nix: null,
      nix_store: null,
      nix_current_system: null,
      nix_wrappers: null,
      nix_user_profile: null,
      usr: "/usr",
      fhs_executable_candidates: fixture.candidates.filter((candidate) => candidate.requirement_id !== "pnpm-package"),
    } satisfies SandboxRuntimeLayout;
    const request = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      { session_id: created.value.session_id, enforce: true },
      sandboxProbe,
      layout,
    );
    assert.equal(request.ok, true, request.ok ? "" : JSON.stringify(request.error));
    if (!request.ok) return;
    assert.deepEqual(request.value.runtime_resolution, {
      policy: STRICT_RUNTIME_POLICY,
      profile: { id: "development", version: "1" },
      materializer: "fhs",
    });
    assert.deepEqual(
      request.value.runtime_projection?.executables.map((entrypoint) => entrypoint.name),
      ["git", "ls", "node"],
    );
    if (
      process.platform === "linux" &&
      defaultSandboxProbe.hasBubblewrap() &&
      defaultSandboxProbe.hasNamespaceSupport()
    ) {
      const ls = await runSandboxedCommand(request.value, { command: "ls" });
      assert.equal(ls.ok, true, ls.ok ? "" : JSON.stringify(ls.error));
      if (ls.ok) {
        assert.equal(ls.value.exit_code, 0, JSON.stringify(ls.value));
        assert.equal(ls.value.stdout, "ls-runtime-ok\n");
      }
    }
  } finally {
    try {
      git(["worktree", "remove", "--force", worktree]);
    } catch {
      // Cleanup is best-effort after a failed protected setup.
    }
    fixture.cleanup();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});

test("materializer selection is deterministic and does not use an installed standalone Nix store as FHS fallback", () => {
  const candidates = createCandidateFixture();
  try {
    const fhs = emptyLayout({
      usr: "/usr",
      nix_store: "/nix/store",
      nix: "/usr/bin/nix",
      fhs_executable_candidates: candidates.candidates,
    });
    const selected = runtimeMaterializerAvailability("linux", fhs);
    assert.deepEqual(selected.available, ["fhs"]);
    assert.equal(selected.selected, "fhs");

    const nix = emptyLayout({
      nix: "/usr/bin/nix",
      nix_store: "/nix/store",
      nix_current_system: "/run/current-system",
      usr: "/usr",
      fhs_executable_candidates: candidates.candidates,
    });
    const native = runtimeMaterializerAvailability("linux", nix);
    assert.deepEqual(native.available, ["nix", "fhs"]);
    assert.equal(native.selected, "nix");
  } finally {
    candidates.cleanup();
  }
});

test("materializer selection reports FHS unavailable when no real development baseline evidence exists", () => {
  const fhs = emptyLayout({ usr: "/usr", nix_store: "/nix/store", nix: "/usr/bin/nix" });
  const selected = runtimeMaterializerAvailability("linux", fhs);
  assert.deepEqual(selected.available, []);
  assert.equal(selected.selected, null);
  assert.equal(selected.strict_ready, false);
  assert.match(selected.reason ?? "", /candidate/u);
});

test("failure of the selected strict materializer is fail-closed without trying FHS", () => {
  const fixture = nixFixture();
  const calls: string[] = [];
  try {
    const result = resolveRuntimeProjection({
      platform: "linux",
      runtime_layout: fixture.layout,
      nix: {
        store_root: fixture.store,
        command_runner: (executable, args) => {
          calls.push(executable);
          return { exit_code: 1, stdout: "", stderr: "offline closure unavailable" };
        },
      },
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
    assert.ok(calls.length > 0);
    assert.deepEqual([...new Set(calls)], [fixture.layout.nix]);
  } finally {
    fixture.cleanup();
  }
});

test("failure of the selected FHS materializer is fail-closed without trying Nix", () => {
  const result = resolveRuntimeProjection({
    platform: "linux",
    runtime_layout: emptyLayout({ usr: "/usr", nix: null }),
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
});

test("no strict materializer available produces a single well-formed diagnostic, not a duplicated/double-punctuated one", () => {
  const result = resolveRuntimeProjection({
    platform: "linux",
    runtime_layout: emptyLayout({ usr: "/usr", nix: null }),
  });
  assert.equal(result.ok, false);
  if (result.ok) return;
  assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
  assert.doesNotMatch(result.error.message, /runtime runtime requirement/iu);
  assert.doesNotMatch(result.error.message, /'runtime-profile'/u);
  assert.doesNotMatch(result.error.message, /\.\./u);
  assert.match(result.error.message, /^Strict runtime materialization is unavailable: .+\.$/u);
});

test("the canonical development baseline succeeds by default from fixed-root FHS discovery alone", () => {
  const fixture = createCandidateFixture();
  try {
    const result = resolveRuntimeProjection({
      platform: "linux",
      runtime_layout: emptyLayout({ usr: "/usr", fhs_executable_candidates: fixture.candidates }),
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;
    assert.deepEqual(result.value.policy, STRICT_RUNTIME_POLICY);
    assert.equal(result.value.materializer, "fhs");
  } finally {
    fixture.cleanup();
  }
});

test("explicit compatibility produces a complete compatibility projection instead of an omitted projection", () => {
  if (process.platform !== "linux") return;
  const layout = discoverSandboxRuntimeLayout();
  const result = resolveRuntimeProjection({
    platform: "linux",
    runtime_layout: layout,
    policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
  });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
  if (!result.ok) return;
  assert.deepEqual(result.value.policy, EXPLICIT_COMPATIBILITY_RUNTIME_POLICY);
  assert.equal(result.value.materializer, "compatibility");
  assert.equal(result.value.projection.executables.length, 0);
  assert.ok(result.value.projection.filesystem.length > 0);
  assert.ok(result.value.projection.filesystem.every((entry) => entry.provenance === "compatibility"));
  assert.ok(result.value.projection.filesystem.some((entry) => entry.target === "/usr"));
});

test("compatibility remains explicit and unavailable layouts fail closed", () => {
  const result = resolveRuntimeProjection({
    platform: "linux",
    runtime_layout: emptyLayout(),
    policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
  });
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");

  const unsupported = resolveRuntimeProjection({
    platform: "darwin",
    runtime_layout: emptyLayout(),
    policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
  });
  assert.equal(unsupported.ok, false);
  if (!unsupported.ok) assert.equal(unsupported.error.code, "SANDBOX_UNSUPPORTED_PLATFORM");
});

test("doctor exposes the strict default, canonical profile, selected materializer, and explicit compatibility policy", () => {
  const candidates = createCandidateFixture();
  try {
    const report = runtimeDoctorReport(
      "linux",
      emptyLayout({ usr: "/usr", fhs_executable_candidates: candidates.candidates }),
    );
    assert.deepEqual(report.default_policy, STRICT_RUNTIME_POLICY);
    assert.deepEqual(report.default_profile, { id: "development", version: "1" });
    assert.equal(report.selected, "fhs");
    assert.deepEqual(report.available, ["fhs"]);
    assert.equal(report.strict_ready, true);
    assert.equal(report.compatibility_available, true);
    assert.deepEqual(report.compatibility_policy, EXPLICIT_COMPATIBILITY_RUNTIME_POLICY);
  } finally {
    candidates.cleanup();
  }
});

test("doctor reports strict_ready false with an actionable reason when /usr exists but no development baseline evidence does", () => {
  const report = runtimeDoctorReport("linux", emptyLayout({ usr: "/usr" }));
  assert.equal(report.selected, null);
  assert.deepEqual(report.available, []);
  assert.equal(report.strict_ready, false);
  assert.match(report.reason ?? "", /candidate/u);
});

test("the default strict FHS projection keeps the development baseline functional without host visibility", async (t) => {
  if (process.platform !== "linux") {
    t.skip("strict FHS protected execution is Linux-only");
    return;
  }
  const discovered = discoverSandboxRuntimeLayout();
  if (discovered.bubblewrap === null || !defaultSandboxProbe.hasNamespaceSupport()) {
    t.skip("bubblewrap namespace support is unavailable");
    return;
  }

  let materialRoot: string;
  try {
    materialRoot = fs.mkdtempSync("/usr/local/nawabari-runtime-resolution-");
  } catch {
    t.skip("a writable FHS fixture root is unavailable");
    return;
  }

  const executables = {
    "node-runtime": path.join(materialRoot, "node"),
    "git-package": path.join(materialRoot, "git"),
    "ls-runtime": path.join(materialRoot, "ls"),
    "pnpm-package": path.join(materialRoot, "pnpm"),
  };
  for (const [name, executable] of Object.entries(executables)) {
    fs.writeFileSync(executable, `#!/bin/sh\nprintf '%s-ok\\n' '${name}'\n`, { mode: 0o755 });
  }

  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-resolution-fhs-"));
  const worktree = `${repository}-worktree`;
  const git = (args: readonly string[], cwd = repository): void => {
    execFileSync("git", [...args], { cwd, stdio: ["ignore", "ignore", "ignore"] });
  };
  git(["init", "--quiet", "--initial-branch", "main", repository]);
  git(["config", "user.name", "Nawabari runtime resolution"]);
  git(["config", "user.email", "runtime-resolution@nawabari.invalid"]);
  fs.writeFileSync(path.join(repository, "README.md"), "runtime resolution\n");
  git(["add", "README.md"]);
  git(["commit", "--quiet", "-m", "initial"]);

  const backend = new LocalSessionBackend();
  try {
    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/runtime-resolution", worktree, label: null, base: null },
    );
    assert.equal(created.ok, true, created.ok ? "" : JSON.stringify(created.error));
    if (!created.ok) return;

    const fhsLayout = {
      ...discovered,
      nix: null,
      nix_store: null,
      nix_current_system: null,
      nix_wrappers: null,
      nix_user_profile: null,
      usr: "/usr",
      fhs_executable_candidates: [
        { requirement_id: "node-runtime", path: executables["node-runtime"], target: "/usr/local/bin/node" },
        { requirement_id: "git-package", path: executables["git-package"], target: "/usr/local/bin/git" },
        { requirement_id: "ls-runtime", path: executables["ls-runtime"], target: "/usr/local/bin/ls" },
        { requirement_id: "pnpm-package", path: executables["pnpm-package"], target: "/usr/local/bin/pnpm" },
      ],
    } satisfies SandboxRuntimeLayout;
    const request = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      {
        session_id: created.value.session_id,
        enforce: true,
      },
      defaultSandboxProbe,
      fhsLayout,
    );
    if (!request.ok) {
      if (request.error.code === "SANDBOX_CAPABILITY_UNAVAILABLE") {
        t.skip(`protected FHS execution unavailable: ${request.error.code}`);
        return;
      }
      throw request.error;
    }

    assert.deepEqual(request.value.runtime_resolution, {
      policy: STRICT_RUNTIME_POLICY,
      profile: { id: "development", version: "1" },
      materializer: "fhs",
    });
    assert.deepEqual(
      request.value.runtime_projection?.executables.map((entrypoint) => entrypoint.name),
      ["git", "ls", "node"],
    );

    for (const command of ["node", "git", "ls"] as const) {
      const result = await runSandboxedCommand(request.value, { command, args: ["--version"] });
      assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
      if (!result.ok) continue;
      assert.equal(result.value.exit_code, 0, JSON.stringify(result.value));
      assert.equal(
        result.value.stdout,
        `${command === "node" ? "node-runtime" : command === "git" ? "git-package" : "ls-runtime"}-ok\n`,
      );
    }

    const hostHome = discovered.user_home ?? "/home/host-user";
    const userToolPath = discovered.user_local_bin ?? path.join(hostHome, ".local", "bin");
    const visibility = await runSandboxedCommand(request.value, {
      command: "/bin/sh",
      args: [
        "-ceu",
        ["test ! -e /usr/bin/sh", "test ! -e /bin/ls", "test ! -e /nix/store", 'test ! -e "$1"', 'test ! -e "$2"'].join(
          ";",
        ),
        "strict-visibility",
        hostHome,
        userToolPath,
      ],
    });
    assert.equal(visibility.ok, true, visibility.ok ? "" : JSON.stringify(visibility.error));
    if (visibility.ok) assert.equal(visibility.value.exit_code, 0, JSON.stringify(visibility.value));
  } finally {
    try {
      git(["worktree", "remove", "--force", worktree]);
    } catch {
      // Cleanup is best-effort after a failed protected setup.
    }
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(materialRoot, { recursive: true, force: true });
  }
});
