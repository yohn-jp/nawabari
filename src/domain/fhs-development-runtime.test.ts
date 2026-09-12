import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import {
  defaultSandboxProbe,
  discoverSandboxRuntimeLayout,
  fhsDevelopmentRuntimeReadiness,
  resolveFhsDevelopmentRuntime,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  sandboxDoctorReport,
  type FhsRuntimeExecutableDeclaration,
  type SandboxProbe,
} from "./sandbox.js";
import { LocalSessionBackend } from "./session-backend.js";
import { compileSandboxInvocation } from "./sandbox-launcher.js";

function readyProbe(overrides: Partial<SandboxProbe> = {}): SandboxProbe {
  return {
    platform: () => "linux",
    uid: () => 1_000,
    gid: () => 1_000,
    hasBubblewrap: () => true,
    hasNamespaceSupport: () => true,
    hasCgroupsV2: () => true,
    hasLandlock: () => false,
    hasSeccomp: () => true,
    hasCapabilities: () => true,
    ...overrides,
  };
}

function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", [...args], { cwd, stdio: ["ignore", "ignore", "ignore"] });
}

function createRepository(): { readonly repository: string; readonly worktree: string } {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-fhs-development-repository-"));
  const worktree = `${repository}-worktree`;
  runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
  runGit(["config", "user.name", "Nawabari FHS development tests"], repository);
  runGit(["config", "user.email", "fhs-development@nawabari.invalid"], repository);
  fs.writeFileSync(path.join(repository, "README.md"), "fhs development runtime\n");
  runGit(["add", "README.md"], repository);
  runGit(["commit", "--quiet", "-m", "initial"], repository);
  return { repository, worktree };
}

type CandidateFixture = Readonly<{
  readonly root: string;
  readonly candidates: readonly FhsRuntimeExecutableDeclaration[];
  readonly cleanup: () => void;
}>;

function createCandidateFixture(): CandidateFixture | null {
  if (process.platform !== "linux") return null;
  let root: string | null = null;
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-fhs-development-"));
    const node = path.join(root, "node-runtime");
    const git = path.join(root, "git-package");
    const pnpm = path.join(root, "pnpm-package");
    fs.copyFileSync(process.execPath, node);
    fs.chmodSync(node, 0o755);
    fs.writeFileSync(git, "#!/bin/sh\nprintf 'git-package-ok\\n'\n", { mode: 0o755 });
    fs.writeFileSync(pnpm, "#!/bin/sh\nprintf 'pnpm-package-ok\\n'\n", { mode: 0o755 });
    const candidates = Object.freeze([
      Object.freeze({ requirement_id: "node-runtime", path: node }),
      Object.freeze({ requirement_id: "git-package", path: git }),
      Object.freeze({ requirement_id: "pnpm-package", path: pnpm }),
    ]);
    return Object.freeze({
      root: root as string,
      candidates,
      cleanup: () => fs.rmSync(root as string, { recursive: true, force: true }),
    });
  } catch {
    if (root !== null) fs.rmSync(root, { recursive: true, force: true });
    return null;
  }
}

function requireFixture(t: { skip: (reason?: string) => void }): CandidateFixture | null {
  const fixture = createCandidateFixture();
  if (fixture === null) t.skip("a writable standalone FHS fixture root is unavailable");
  return fixture;
}

function expectFailure(result: ReturnType<typeof resolveFhsDevelopmentRuntime>, code: string): void {
  assert.equal(result.ok, false, result.ok ? "expected failure" : JSON.stringify(result.error));
  if (!result.ok) assert.equal(result.error.code, code, result.error.message);
}

test("development FHS materialization resolves explicit candidates outside /usr/bin", (t) => {
  const fixture = requireFixture(t);
  if (fixture === null) return;
  try {
    const resolved = resolveFhsDevelopmentRuntime({ executable_candidates: fixture.candidates });
    assert.equal(resolved.ok, true, resolved.ok ? "" : JSON.stringify(resolved.error));
    if (!resolved.ok) return;

    assert.deepEqual(
      resolved.value.projection.executables.map((entrypoint) => entrypoint.name),
      ["git", "node", "pnpm"],
    );
    assert.deepEqual(
      resolved.value.executable_projection.map((entrypoint) => entrypoint.target),
      ["/nawabari/bin/git", "/nawabari/bin/node", "/nawabari/bin/pnpm"],
    );
    assert.ok(
      fixture.candidates.every((candidate) =>
        resolved.value.projection.filesystem.some((entry) => entry.source === candidate.path),
      ),
    );
    for (const root of ["/usr", "/bin", "/lib", "/lib64"]) {
      assert.equal(
        resolved.value.projection.filesystem.some((entry) => entry.source === root || entry.target === root),
        false,
        `broad FHS root ${root} must not be materialized`,
      );
    }
  } finally {
    fixture.cleanup();
  }
});

test("FHS candidate ordering is deterministic and selection is independent of PATH/profile/Corepack state", (t) => {
  const fixture = requireFixture(t);
  if (fixture === null) return;
  try {
    const first = resolveFhsDevelopmentRuntime({ executable_candidates: fixture.candidates });
    const second = resolveFhsDevelopmentRuntime({ executable_candidates: [...fixture.candidates].reverse() });
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
    assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.value, second.value);

    const discovered = discoverSandboxRuntimeLayout({
      HOME: "/tmp/fake-home",
      PATH: "/tmp/fake-path",
      COREPACK_HOME: "/tmp/fake-corepack",
      USER: "fake-user",
    });
    assert.deepEqual(discovered.fhs_executable_candidates, []);

    const withEvidence = {
      ...discovered,
      fhs_executable_candidates: fixture.candidates,
    };
    const readiness = fhsDevelopmentRuntimeReadiness("linux", withEvidence);
    assert.equal(readiness.strict_ready, true, readiness.reason ?? "strict FHS runtime was not ready");
    assert.equal(readiness.reason, null);
  } finally {
    fixture.cleanup();
  }
});

test("missing, ambiguous, non-executable, and symlink FHS candidates fail closed", (t) => {
  const fixture = requireFixture(t);
  if (fixture === null) return;
  try {
    const missing = resolveFhsDevelopmentRuntime({
      executable_candidates: fixture.candidates.filter((candidate) => candidate.requirement_id !== "pnpm-package"),
    });
    expectFailure(missing, "RUNTIME_MATERIALIZATION_MISSING");
    if (!missing.ok) assert.equal(missing.error.details?.requirement_id, "pnpm-package");

    const ambiguous = resolveFhsDevelopmentRuntime({
      executable_candidates: [
        ...fixture.candidates,
        { requirement_id: "node-runtime", path: fixture.candidates[0]?.path ?? "" },
      ],
    });
    expectFailure(ambiguous, "RUNTIME_PROJECTION_AMBIGUOUS");

    const nonExecutable = fixture.candidates.find((candidate) => candidate.requirement_id === "git-package");
    assert.ok(nonExecutable);
    fs.chmodSync(nonExecutable.path, 0o644);
    const nonExecutableResult = resolveFhsDevelopmentRuntime({ executable_candidates: fixture.candidates });
    expectFailure(nonExecutableResult, "RUNTIME_MATERIALIZATION_MISSING");
    if (!nonExecutableResult.ok) assert.match(nonExecutableResult.error.message, /not executable/u);
    fs.chmodSync(nonExecutable.path, 0o755);

    const link = path.join(fixture.root, "pnpm-link");
    const pnpm = fixture.candidates.find((candidate) => candidate.requirement_id === "pnpm-package");
    assert.ok(pnpm);
    fs.symlinkSync(pnpm.path, link);
    const symlinkResult = resolveFhsDevelopmentRuntime({
      executable_candidates: fixture.candidates.map((candidate) =>
        candidate.requirement_id === "pnpm-package" ? { ...candidate, path: link } : candidate,
      ),
    });
    expectFailure(symlinkResult, "RUNTIME_MATERIALIZATION_MISSING");
    fs.rmSync(link, { force: true });
  } finally {
    fixture.cleanup();
  }
});

test("doctor strict_ready and its reason are projections of the same FHS resolver", (t) => {
  const fixture = requireFixture(t);
  if (fixture === null) return;
  try {
    const missingCandidates = fixture.candidates.filter((candidate) => candidate.requirement_id !== "git-package");
    const layout = { fhs_executable_candidates: missingCandidates };
    const readiness = fhsDevelopmentRuntimeReadiness("linux", layout);
    assert.equal(readiness.strict_ready, false);
    assert.equal(readiness.code, "RUNTIME_MATERIALIZATION_MISSING");
    assert.match(readiness.reason ?? "", /git-package/u);

    const doctor = sandboxDoctorReport(readyProbe(), { ...discoverSandboxRuntimeLayout(), ...layout });
    assert.equal(doctor.strict_ready, false);
    assert.equal(doctor.strict_ready_code, readiness.code);
    assert.equal(doctor.strict_ready_reason, readiness.reason);
    assert.deepEqual(doctor.strict_ready_details, readiness.details);

    const unsupported = fhsDevelopmentRuntimeReadiness("darwin", layout);
    assert.equal(unsupported.strict_ready, false);
    assert.equal(unsupported.code, "SANDBOX_UNSUPPORTED_PLATFORM");
  } finally {
    fixture.cleanup();
  }
});

test("standalone Linux protected execution runs the materialized Node/Git/pnpm baseline", async (t) => {
  if (process.platform !== "linux") {
    t.skip("protected FHS execution is Linux-only");
    return;
  }
  if (defaultSandboxProbe.hasBubblewrap() === false || defaultSandboxProbe.hasNamespaceSupport() === false) {
    t.skip("bubblewrap namespace support is unavailable");
    return;
  }
  const fixture = requireFixture(t);
  if (fixture === null) return;
  const { repository, worktree } = createRepository();
  const backend = new LocalSessionBackend();
  try {
    const materialized = resolveFhsDevelopmentRuntime({ executable_candidates: fixture.candidates });
    assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));
    if (!materialized.ok) return;

    const discovered = discoverSandboxRuntimeLayout();
    const layout = { ...discovered, fhs_executable_candidates: fixture.candidates };
    const doctor = sandboxDoctorReport(defaultSandboxProbe, layout);
    assert.equal(doctor.strict_ready, true, doctor.strict_ready_reason ?? "strict FHS runtime was not ready");

    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/fhs-development-conformance", worktree, label: null, base: null },
    );
    assert.equal(created.ok, true, created.ok ? "" : JSON.stringify(created.error));
    if (!created.ok) return;
    const request = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      {
        session_id: created.value.session_id,
        enforce: true,
        runtime_projection: materialized.value.projection,
      },
      defaultSandboxProbe,
      layout,
    );
    assert.equal(request.ok, true, request.ok ? "" : JSON.stringify(request.error));
    if (!request.ok) return;

    const invocation = compileSandboxInvocation(request.value, { command: "node", args: ["--version"] });
    assert.equal(invocation.ok, true, invocation.ok ? "" : JSON.stringify(invocation.error));
    if (!invocation.ok) return;
    for (const root of ["/usr", "/bin", "/lib", "/lib64"]) {
      assert.equal(
        invocation.value.args.some(
          (value, index, args) => (value === "--ro-bind" || value === "--bind") && args[index + 2] === root,
        ),
        false,
        `protected invocation must not bind broad FHS root ${root}`,
      );
    }
    assert.equal(invocation.value.env.PATH, "/nawabari/bin");

    for (const [command, expected] of [
      ["node", "node-ok"],
      ["git", "git-package-ok\n"],
      ["pnpm", "pnpm-package-ok\n"],
    ] as const) {
      const result = await runSandboxedCommand(request.value, {
        command,
        args:
          command === "node"
            ? ["-e", "process.stdout.write(process.execPath.startsWith('/nawabari/bin/') ? 'node-ok' : 'bad')"]
            : ["--version"],
      });
      assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
      if (!result.ok) continue;
      assert.equal(result.value.exit_code, 0, JSON.stringify(result.value));
      assert.equal(result.value.stdout, expected);
    }

    const visibility = await runSandboxedCommand(request.value, {
      command: "/bin/sh",
      args: [
        "-ceu",
        [
          "test ! -e /usr/bin/node",
          "test ! -e /usr/bin/git",
          "test ! -e /usr/bin/pnpm",
          "test ! -e /bin/ls",
          "test ! -e /nix/store",
          'test "$PATH" = /nawabari/bin',
          "printf protected-fhs-development-ok",
        ].join(";"),
      ],
    });
    assert.equal(visibility.ok, true, visibility.ok ? "" : JSON.stringify(visibility.error));
    if (visibility.ok) {
      assert.equal(visibility.value.exit_code, 0, JSON.stringify(visibility.value));
      assert.equal(visibility.value.stdout, "protected-fhs-development-ok");
    }
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktree], repository);
    } catch {
      // Cleanup below is sufficient if the session lifecycle already removed it.
    }
    fixture.cleanup();
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
