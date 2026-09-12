import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { LocalSessionBackend } from "./session-backend.js";
import {
  compileSandboxInvocation,
  defaultSandboxProbe,
  materializeFhsRuntime,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
} from "./sandbox.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { EXPLICIT_COMPATIBILITY_RUNTIME_POLICY } from "./runtime-projection.js";

function runGit(args: readonly string[], cwd: string): void {
  execFileSync("git", [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
}

function createRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-fhs-runtime-"));
  runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
  runGit(["config", "user.name", "Nawabari FHS tests"], repository);
  runGit(["config", "user.email", "fhs@nawabari.invalid"], repository);
  fs.writeFileSync(path.join(repository, "README.md"), "fhs runtime\n");
  runGit(["add", "README.md"], repository);
  runGit(["commit", "--quiet", "-m", "initial"], repository);
  return repository;
}

function baseProfile() {
  const resolved = resolveRuntimeProfile({ profiles: ["base"] });
  if (!resolved.ok) throw resolved.error;
  return resolved.value;
}

function nodeArtifact(): string {
  const candidate = process.execPath;
  assert.ok(path.posix.normalize(candidate) === candidate && candidate.startsWith("/"));
  return candidate;
}

type FhsElfFixture = Readonly<{
  readonly root: string;
  readonly executable: string;
  readonly direct: string;
  readonly transitive: string;
  readonly escape: string;
}>;

function createFhsElfFixture(): FhsElfFixture | null {
  if (process.platform !== "linux") return null;
  const compiler = "cc";
  try {
    execFileSync(compiler, ["--version"], { stdio: "ignore" });
  } catch {
    return null;
  }
  let root: string;
  try {
    root = fs.mkdtempSync(path.join("/usr/local", "nawabari-fhs-elf-"));
  } catch {
    return null;
  }
  const transitiveSource = path.join(root, "transitive.c");
  const directSource = path.join(root, "direct.c");
  const executableSource = path.join(root, "main.c");
  const escapeSource = path.join(root, "escape.c");
  const transitive = path.join(root, "libnawabari-transitive.so");
  const direct = path.join(root, "libnawabari-direct.so");
  const executable = path.join(root, "nawabari-main");
  const escape = path.join(root, "nawabari-escape");
  try {
    fs.writeFileSync(transitiveSource, "int nawabari_transitive(void) { return 7; }\n");
    fs.writeFileSync(
      directSource,
      "extern int nawabari_transitive(void); int nawabari_direct(void) { return nawabari_transitive(); }\n",
    );
    fs.writeFileSync(
      executableSource,
      "extern int nawabari_direct(void); int main(void) { return nawabari_direct() != 7; }\n",
    );
    fs.writeFileSync(escapeSource, "int main(void) { return 0; }\n");
    execFileSync(compiler, [
      "-shared",
      "-fPIC",
      "-Wl,-soname,libnawabari-transitive.so",
      "-o",
      transitive,
      transitiveSource,
    ]);
    execFileSync(compiler, [
      "-shared",
      "-fPIC",
      "-Wl,-soname,libnawabari-direct.so",
      "-Wl,-rpath,$ORIGIN",
      "-L",
      root,
      "-o",
      direct,
      directSource,
      "-lnawabari-transitive",
    ]);
    execFileSync(compiler, ["-Wl,-rpath,$ORIGIN", "-L", root, "-o", executable, executableSource, "-lnawabari-direct"]);
    execFileSync(compiler, ["-Wl,-rpath,$ORIGIN/../../../../tmp", "-o", escape, escapeSource]);
    return Object.freeze({ root, executable, direct, transitive, escape });
  } catch {
    fs.rmSync(root, { recursive: true, force: true });
    return null;
  }
}

function systemOriginRunpathFixture(): string | null {
  if (process.platform !== "linux") return null;
  const directory = "/usr/lib/x86_64-linux-gnu";
  try {
    const candidate = fs
      .readdirSync(directory)
      .filter((name) => name.startsWith("libabsl_base.so."))
      .sort()
      .map((name) => path.join(directory, name))
      .find((candidate) => fs.statSync(candidate).isFile());
    return candidate ?? null;
  } catch {
    return null;
  }
}

function systemUnsupportedRunpathFixture(): string | null {
  const candidate = "/usr/lib/wsl/lib/libd3d12.so";
  try {
    return fs.statSync(candidate).isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function fixtureSearchPaths(): readonly string[] {
  return ["/lib", "/lib64", "/lib/x86_64-linux-gnu"];
}

test("resolves a direct DT_RUNPATH $ORIGIN dependency in the declaring object's directory", (t) => {
  if (process.platform !== "linux") {
    t.skip("ELF materialization is Linux-only");
    return;
  }
  const fixture = createFhsElfFixture();
  if (fixture !== null) {
    try {
      const result = materializeFhsRuntime({
        profile: baseProfile(),
        executables: [{ requirement_id: "node-runtime", path: fixture.executable }],
        library_search_paths: fixtureSearchPaths(),
      });
      assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
      if (result.ok) assert.ok(result.value.filesystem.some((entry) => entry.source === fixture.direct));
    } finally {
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
    return;
  }
  const systemFixture = systemOriginRunpathFixture();
  if (systemFixture === null) {
    t.skip("no writable FHS fixture root or bounded system RUNPATH fixture is available");
    return;
  }
  const result = materializeFhsRuntime({
    profile: baseProfile(),
    executables: [{ requirement_id: "node-runtime", path: systemFixture }],
    library_search_paths: fixtureSearchPaths(),
  });
  assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
  if (result.ok)
    assert.ok(result.value.filesystem.some((entry) => entry.source.includes("libabsl_raw_logging_internal")));
});

test("resolves a transitive colocated dependency through object-specific RUNPATH", (t) => {
  if (process.platform !== "linux") {
    t.skip("ELF materialization is Linux-only");
    return;
  }
  const fixture = createFhsElfFixture();
  if (fixture === null) {
    const systemFixture = systemOriginRunpathFixture();
    if (systemFixture === null) {
      t.skip("a writable FHS fixture root or bounded system RUNPATH fixture is unavailable");
      return;
    }
    const result = materializeFhsRuntime({
      profile: baseProfile(),
      executables: [{ requirement_id: "node-runtime", path: systemFixture }],
      library_search_paths: fixtureSearchPaths(),
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (result.ok) {
      const colocated = result.value.filesystem.filter((entry) => entry.source.includes("libabsl_"));
      assert.ok(colocated.some((entry) => entry.source.includes("libabsl_raw_logging_internal")));
      assert.ok(colocated.some((entry) => entry.source.includes("libabsl_spinlock_wait")));
    }
    return;
  }
  try {
    const result = materializeFhsRuntime({
      profile: baseProfile(),
      executables: [{ requirement_id: "node-runtime", path: fixture.executable }],
      library_search_paths: fixtureSearchPaths(),
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (result.ok) assert.ok(result.value.filesystem.some((entry) => entry.source === fixture.transitive));
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("rejects a DT_RUNPATH $ORIGIN escape before host fallback", (t) => {
  if (process.platform !== "linux") {
    t.skip("ELF materialization is Linux-only");
    return;
  }
  const fixture = createFhsElfFixture();
  if (fixture === null) {
    const systemFixture = systemUnsupportedRunpathFixture();
    if (systemFixture === null) {
      t.skip("a writable FHS fixture root or bounded system unsupported-token fixture is unavailable");
      return;
    }
    const result = materializeFhsRuntime({
      profile: baseProfile(),
      executables: [{ requirement_id: "node-runtime", path: systemFixture }],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.match(String(result.error.details?.reason), /unsupported token|escapes the bounded FHS roots/u);
    }
    return;
  }
  try {
    const result = materializeFhsRuntime({
      profile: baseProfile(),
      executables: [{ requirement_id: "node-runtime", path: fixture.escape }],
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.match(String(result.error.details?.reason), /escapes the bounded FHS roots/u);
    }
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("bounded FHS materialization is deterministic and projects loader/library files explicitly", (t) => {
  if (process.platform !== "linux") {
    t.skip("FHS materialization is Linux-only");
    return;
  }
  const profile = baseProfile();
  const first = materializeFhsRuntime({
    profile,
    executables: [{ requirement_id: "node-runtime", path: nodeArtifact() }],
  });
  const second = materializeFhsRuntime({
    profile,
    executables: [{ requirement_id: "node-runtime", path: nodeArtifact() }],
  });
  assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
  assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
  if (!first.ok || !second.ok) return;

  assert.deepEqual(first.value.filesystem, second.value.filesystem);
  assert.ok(first.value.filesystem.some((entry) => entry.target.includes("ld-linux")));
  assert.ok(first.value.filesystem.some((entry) => entry.target.includes("libc.so")));
  assert.ok(first.value.filesystem.every((entry) => entry.access_mode === "read-only"));
  const broadRoots = ["/usr", "/bin", "/lib", "/lib64"];
  assert.ok(broadRoots.every((root) => !first.value.filesystem.some((entry) => entry.target === root)));
  assert.ok(broadRoots.every((root) => !first.value.filesystem.some((entry) => entry.source === root)));

  const compatibility = materializeFhsRuntime({
    profile,
    policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
    executables: [{ requirement_id: "node-runtime", path: nodeArtifact() }],
  });
  assert.equal(compatibility.ok, true, compatibility.ok ? "" : JSON.stringify(compatibility.error));
  if (compatibility.ok) {
    assert.ok(compatibility.value.filesystem.every((entry) => entry.provenance === "compatibility"));
    assert.equal(compatibility.value.policy.mode, "compatibility");
    assert.ok(
      compatibility.value.filesystem.every((entry) => ["/usr", "/bin", "/lib", "/lib64"].includes(entry.target)),
    );
    assert.ok(compatibility.value.filesystem.some((entry) => entry.target === "/usr"));
  }
});

test("missing FHS dependencies use the canonical recoverable materialization failure", (t) => {
  if (process.platform !== "linux") {
    t.skip("FHS materialization is Linux-only");
    return;
  }
  const result = materializeFhsRuntime({
    profile: baseProfile(),
    executables: [{ requirement_id: "node-runtime", path: nodeArtifact() }],
    library_search_paths: [],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
    assert.equal(result.error.exitCode, 4);
    assert.equal(result.error.details?.requirement_id, "node-runtime");
  }
});

test("a strict FHS projection executes its declared runtime and hides absolute-path host tools", async (t) => {
  if (process.platform !== "linux") {
    t.skip("bubblewrap FHS integration is Linux-only");
    return;
  }
  const doctor = defaultSandboxProbe.hasNamespaceSupport() && defaultSandboxProbe.hasBubblewrap();
  if (!doctor) {
    t.skip("bubblewrap namespace support is unavailable");
    return;
  }
  const repository = createRepository();
  const worktree = `${repository}-worktree`;
  const backend = new LocalSessionBackend();
  try {
    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/fhs-runtime", worktree, label: null, base: null },
    );
    assert.equal(created.ok, true, created.ok ? "" : JSON.stringify(created.error));
    if (!created.ok) return;
    const request = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      { session_id: created.value.session_id, enforce: true },
      defaultSandboxProbe,
    );
    assert.equal(request.ok, true, request.ok ? "" : JSON.stringify(request.error));
    if (!request.ok) return;
    const projection = materializeFhsRuntime({
      profile: baseProfile(),
      executables: [{ requirement_id: "node-runtime", path: nodeArtifact() }],
    });
    assert.equal(projection.ok, true, projection.ok ? "" : JSON.stringify(projection.error));
    if (!projection.ok) return;

    const projectedRequest = { ...request.value, runtime_projection: projection.value };
    const invocation = compileSandboxInvocation(projectedRequest, { command: nodeArtifact() });
    assert.equal(invocation.ok, true, invocation.ok ? "" : JSON.stringify(invocation.error));
    if (!invocation.ok) return;
    for (const root of ["/usr", "/bin", "/lib", "/lib64"]) {
      assert.equal(
        invocation.value.args.some(
          (value, index, args) => (value === "--ro-bind" || value === "--bind") && args[index + 2] === root,
        ),
        false,
        `strict FHS projection must not bind ${root}`,
      );
    }
    assert.ok(
      projection.value.filesystem.every((entry) =>
        invocation.value.args.some(
          (value, index, args) =>
            value === "--ro-bind" && args[index + 1] === entry.source && args[index + 2] === entry.target,
        ),
      ),
      "materialized files must enter the existing projection mount primitive",
    );

    const runtime = await runSandboxedCommand(projectedRequest, {
      command: nodeArtifact(),
      args: ["-e", "process.stdout.write('fhs-node-ok')"],
    });
    assert.equal(runtime.ok, true, runtime.ok ? "" : JSON.stringify(runtime.error));
    if (runtime.ok) {
      assert.equal(runtime.value.exit_code, 0, JSON.stringify(runtime));
      assert.equal(runtime.value.stdout, "fhs-node-ok");
    }

    for (const undeclared of ["/usr/bin/sh", "/bin/sh"]) {
      const bypass = await runSandboxedCommand(projectedRequest, { command: undeclared });
      assert.ok(!bypass.ok || bypass.value.exit_code !== 0, `${undeclared} must be absent from strict FHS runtime`);
    }
  } finally {
    runGit(["worktree", "remove", "--force", worktree], repository);
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
