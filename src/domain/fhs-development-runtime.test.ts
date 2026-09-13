import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { test } from "node:test";

import {
  defaultSandboxProbe,
  discoverDefaultFhsDevelopmentExecutableCandidates,
  discoverSandboxRuntimeLayout,
  FHS_DEVELOPMENT_EXECUTABLE_ENVIRONMENT_KEYS,
  fhsDevelopmentRuntimeReadiness,
  readFhsDevelopmentExecutableCandidates,
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

/** A fixed-root fixture using the real binary names (`node`/`git`/`pnpm`) default discovery looks for. */
function createDefaultRootFixture(): CandidateFixture | null {
  if (process.platform !== "linux") return null;
  let root: string | null = null;
  try {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-fhs-development-default-root-"));
    const node = path.join(root, "node");
    const git = path.join(root, "git");
    const pnpm = path.join(root, "pnpm");
    fs.copyFileSync(process.execPath, node);
    fs.chmodSync(node, 0o755);
    fs.writeFileSync(git, "#!/bin/sh\nprintf 'git-package-ok\\n'\n", { mode: 0o755 });
    fs.writeFileSync(pnpm, "#!/bin/sh\nprintf 'pnpm-package-ok\\n'\n", { mode: 0o755 });
    return Object.freeze({
      root: root as string,
      candidates: Object.freeze([
        Object.freeze({ requirement_id: "node-runtime", path: node }),
        Object.freeze({ requirement_id: "git-package", path: git }),
        Object.freeze({ requirement_id: "pnpm-package", path: pnpm }),
      ]),
      cleanup: () => fs.rmSync(root as string, { recursive: true, force: true }),
    });
  } catch {
    if (root !== null) fs.rmSync(root, { recursive: true, force: true });
    return null;
  }
}

function requireDefaultRootFixture(t: { skip: (reason?: string) => void }): CandidateFixture | null {
  const fixture = createDefaultRootFixture();
  if (fixture === null) t.skip("a writable default-root FHS fixture root is unavailable");
  return fixture;
}

function expectFailure(result: ReturnType<typeof resolveFhsDevelopmentRuntime>, code: string): void {
  assert.equal(result.ok, false, result.ok ? "expected failure" : JSON.stringify(result.error));
  if (!result.ok) assert.equal(result.error.code, code, result.error.message);
}

function environmentWithFhsEvidence(
  candidates: readonly FhsRuntimeExecutableDeclaration[],
  pathValue = "/tmp/host-path-must-not-matter",
): NodeJS.ProcessEnv {
  const byRequirement = new Map(candidates.map((candidate) => [candidate.requirement_id, candidate.path]));
  return {
    PATH: pathValue,
    HOME: "/tmp/host-home-must-not-matter",
    COREPACK_HOME: "/tmp/host-corepack-must-not-matter",
    [FHS_DEVELOPMENT_EXECUTABLE_ENVIRONMENT_KEYS["node-runtime"]]: byRequirement.get("node-runtime"),
    [FHS_DEVELOPMENT_EXECUTABLE_ENVIRONMENT_KEYS["git-package"]]: byRequirement.get("git-package"),
    [FHS_DEVELOPMENT_EXECUTABLE_ENVIRONMENT_KEYS["pnpm-package"]]: byRequirement.get("pnpm-package"),
  };
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

    const garbageEnvironment = {
      HOME: "/tmp/fake-home",
      PATH: "/tmp/fake-path",
      COREPACK_HOME: "/tmp/fake-corepack",
      USER: "fake-user",
    };
    const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-fhs-development-empty-root-"));
    try {
      assert.deepEqual(readFhsDevelopmentExecutableCandidates(garbageEnvironment, [emptyRoot]), []);
      assert.deepEqual(discoverDefaultFhsDevelopmentExecutableCandidates([emptyRoot]), []);
    } finally {
      fs.rmSync(emptyRoot, { recursive: true, force: true });
    }

    const productionLayout = discoverSandboxRuntimeLayout(environmentWithFhsEvidence(fixture.candidates));
    assert.deepEqual(
      productionLayout.fhs_executable_candidates?.map((candidate) => candidate.requirement_id),
      ["git-package", "node-runtime", "pnpm-package"],
    );
    const materialized = resolveFhsDevelopmentRuntime({
      executable_candidates: productionLayout.fhs_executable_candidates,
    });
    assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));

    const readiness = fhsDevelopmentRuntimeReadiness("linux", productionLayout);
    assert.equal(readiness.strict_ready, true, readiness.reason ?? "strict FHS runtime was not ready");
    assert.equal(readiness.reason, null);

    const doctor = sandboxDoctorReport(readyProbe(), productionLayout);
    assert.equal(doctor.strict_ready, true, doctor.strict_ready_reason ?? "doctor did not consume host evidence");
  } finally {
    fixture.cleanup();
  }
});

test("default strict execution succeeds out of the box from fixed-root discovery alone, no explicit evidence supplied", (t) => {
  const fixture = requireDefaultRootFixture(t);
  if (fixture === null) return;
  try {
    const discovered = discoverDefaultFhsDevelopmentExecutableCandidates([fixture.root]);
    assert.deepEqual(
      discovered.map((candidate) => candidate.requirement_id),
      ["git-package", "node-runtime", "pnpm-package"],
    );

    // No NAWABARI_FHS_*_EXECUTABLE evidence is supplied; the fixed root alone must be enough.
    const merged = readFhsDevelopmentExecutableCandidates({}, [fixture.root]);
    assert.deepEqual(merged, discovered);

    const resolved = resolveFhsDevelopmentRuntime({ executable_candidates: merged });
    assert.equal(resolved.ok, true, resolved.ok ? "" : JSON.stringify(resolved.error));

    const readiness = fhsDevelopmentRuntimeReadiness("linux", { fhs_executable_candidates: merged });
    assert.equal(
      readiness.strict_ready,
      true,
      readiness.reason ?? "default discovery did not satisfy strict readiness",
    );
  } finally {
    fixture.cleanup();
  }
});

test("an explicit NAWABARI_FHS_*_EXECUTABLE candidate always wins over fixed-root default discovery", (t) => {
  const fixture = requireDefaultRootFixture(t);
  if (fixture === null) return;
  const overrideRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-fhs-development-override-"));
  try {
    const overrideGit = path.join(overrideRoot, "git-override");
    fs.writeFileSync(overrideGit, "#!/bin/sh\nprintf 'git-override-ok\\n'\n", { mode: 0o755 });

    const merged = readFhsDevelopmentExecutableCandidates(
      { [FHS_DEVELOPMENT_EXECUTABLE_ENVIRONMENT_KEYS["git-package"]]: overrideGit },
      [fixture.root],
    );
    const gitCandidate = merged.find((candidate) => candidate.requirement_id === "git-package");
    assert.equal(gitCandidate?.path, overrideGit);
    const nodeCandidate = merged.find((candidate) => candidate.requirement_id === "node-runtime");
    assert.equal(nodeCandidate?.path, path.join(fixture.root, "node"));
  } finally {
    fixture.cleanup();
    fs.rmSync(overrideRoot, { recursive: true, force: true });
  }
});

test("a symlinked node/git/pnpm at a fixed default root is never discovered, and default resolution still fails closed", (t) => {
  const fixture = requireDefaultRootFixture(t);
  if (fixture === null) return;
  const symlinkRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-fhs-development-symlink-root-"));
  try {
    // Point every fixed-root binary name at a symlink to a genuine, otherwise-valid
    // executable target. Discovery must reject the symlink itself, not silently
    // follow it to the target, even though the target alone would be acceptable.
    for (const name of ["node", "git", "pnpm"]) {
      fs.symlinkSync(path.join(fixture.root, name), path.join(symlinkRoot, name));
    }

    const discovered = discoverDefaultFhsDevelopmentExecutableCandidates([symlinkRoot]);
    assert.deepEqual(discovered, []);

    const merged = readFhsDevelopmentExecutableCandidates({}, [symlinkRoot]);
    assert.deepEqual(merged, []);

    const resolved = resolveFhsDevelopmentRuntime({ executable_candidates: merged });
    expectFailure(resolved, "RUNTIME_MATERIALIZATION_MISSING");

    const readiness = fhsDevelopmentRuntimeReadiness("linux", { fhs_executable_candidates: merged });
    assert.equal(readiness.strict_ready, false);
  } finally {
    fixture.cleanup();
    fs.rmSync(symlinkRoot, { recursive: true, force: true });
  }
});

test("genuinely missing authority still fails closed with a single, well-formed diagnostic sentence", () => {
  const resolved = resolveFhsDevelopmentRuntime({ executable_candidates: [] });
  expectFailure(resolved, "RUNTIME_MATERIALIZATION_MISSING");
  if (resolved.ok) return;
  assert.doesNotMatch(resolved.error.message, /runtime runtime requirement/iu);
  assert.doesNotMatch(resolved.error.message, /\.\./u);
  assert.match(resolved.error.message, /was not materialized: no explicit candidate was supplied\.$/u);
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
    const layout = discoverSandboxRuntimeLayout(environmentWithFhsEvidence(fixture.candidates, process.env.PATH ?? ""));
    assert.deepEqual(
      layout.fhs_executable_candidates?.map((candidate) => candidate.requirement_id),
      ["git-package", "node-runtime", "pnpm-package"],
    );
    const materialized = resolveFhsDevelopmentRuntime({
      executable_candidates: layout.fhs_executable_candidates,
    });
    assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));
    if (!materialized.ok) return;

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
