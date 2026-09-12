import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runCli } from "../cli.js";
import {
  materializePnpmMiddleware,
  PNPM_MIDDLEWARE_LAUNCHER_TARGET,
  PNPM_MIDDLEWARE_PROVIDER_IDS,
  PROJECTED_PNPM_TARGET,
} from "./runtime-provider-pnpm-middleware.js";
import {
  materializePnpmMiddlewareBackends,
  PNPM_BACKEND_EVIDENCE,
  PNPM_NIX_INSTALLABLE,
  PNPM_MIDDLEWARE_PNPM_BUNDLE_TARGET,
  PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
  PNPM_MIDDLEWARE_RTK_TARGET,
  RTK_NIX_INSTALLABLE,
  REAL_PNPM_BACKEND_PROVIDER,
  REAL_PNPM_BACKEND_REQUIREMENT,
  RTK_BACKEND_PROVIDER,
  RTK_BACKEND_REQUIREMENT,
  type PnpmMiddlewareBackendDescriptor,
} from "./pnpm-middleware-backend-materialization.js";
import type { NixCommandRunner } from "./nix-runtime-closure.js";
import {
  STRICT_RUNTIME_POLICY,
  validateSessionRuntimeProjection,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";
import { compileRuntimeExecutableProjection } from "./runtime-executable-projection.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { LocalSessionBackend } from "./session-backend.js";
import {
  defaultSandboxProbe,
  discoverSandboxRuntimeLayout,
  materializeFhsRuntime,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  sandboxDoctorReport,
  type SandboxProbe,
} from "./sandbox.js";

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

function runGit(args: readonly string[], cwd: string, throwOnError = true): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: throwOnError ? ["ignore", "pipe", "pipe"] : "ignore",
  });
}

function createRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-sandbox-"));
  runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
  runGit(["config", "user.name", "Nawabari Tests"], repository);
  runGit(["config", "user.email", "tests@nawabari.invalid"], repository);
  fs.writeFileSync(path.join(repository, "README.md"), "sandbox\n");
  runGit(["add", "README.md"], repository);
  runGit(["commit", "--quiet", "-m", "initial"], repository);
  return repository;
}

// The process running this test suite is whatever Node the invoking
// environment set up, which on hosted CI runners (actions/setup-node) lives
// under /opt/hostedtoolcache and is not a valid materializeFhsRuntime()
// source: the FHS materializer only ever accepts FHS_RUNTIME_ROOTS
// (/usr, /bin, /lib, /lib64), by design, and hostedtoolcache is not one of
// them. NAWABARI_TEST_FHS_NODE_INTERPRETER lets the CI job point this at a
// canonical, already-bounded Node artifact instead (see ci.yml); anywhere
// else, process.execPath is assumed to already resolve under an FHS root.
function resolveCanonicalNodeInterpreter(): string {
  const override = process.env.NAWABARI_TEST_FHS_NODE_INTERPRETER;
  return fs.realpathSync.native(override && override.length > 0 ? override : process.execPath);
}

function removeWorktree(repository: string, worktree: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktree], repository, false);
  } catch {
    // Best-effort cleanup: the repository directory is removed right after
    // this call regardless, so a worktree that is already gone or was never
    // fully registered must not mask the test's real pass/fail result.
  }
}

function executable(root: string, name: string, body: string): string {
  const result = path.join(root, name);
  fs.writeFileSync(result, body, { mode: 0o755 });
  fs.chmodSync(result, 0o755);
  return result;
}

function baseProjection(
  rtkSource: string,
  pnpmSource: string,
  nodeSource: string,
  options?: { readonly omitNodeExecutable?: boolean },
): SessionRuntimeProjection {
  const result = validateSessionRuntimeProjection({
    policy: STRICT_RUNTIME_POLICY,
    profile: { id: "pnpm-middleware-test", version: "1" },
    requirements: [
      { id: "node-runtime", kind: "runtime", name: "node", version: ">=24" },
      RTK_BACKEND_REQUIREMENT,
      REAL_PNPM_BACKEND_REQUIREMENT,
    ],
    filesystem: [
      {
        source: rtkSource,
        target: "/materialized/rtk",
        access_mode: "read-only",
        provenance: "package",
      },
      {
        source: pnpmSource,
        target: "/materialized/pnpm",
        access_mode: "read-only",
        provenance: "package",
      },
      {
        source: nodeSource,
        target: "/materialized/node",
        access_mode: "read-only",
        provenance: "package",
      },
    ],
    executables:
      options?.omitNodeExecutable === true
        ? []
        : [
            {
              name: "node",
              target: "/materialized/node",
              provider: { id: "node-runtime-provider", requirement_id: "node-runtime" },
              provenance: "package",
            },
          ],
  });
  if (!result.ok) throw result.error;
  return result.value;
}

function backend(
  pathInSandbox: string,
  source: string,
  providerId: string,
  requirementId: string,
): PnpmMiddlewareBackendDescriptor {
  return {
    path: pathInSandbox,
    source,
    provider: { id: providerId, requirement_id: requirementId },
  };
}

function materializationInput(
  root: string,
  options?: { readonly omitNodeExecutable?: boolean },
): {
  readonly projection: SessionRuntimeProjection;
  readonly launcher_path: string;
  readonly rtk: PnpmMiddlewareBackendDescriptor;
  readonly real_pnpm: PnpmMiddlewareBackendDescriptor;
} {
  const rtkSource = executable(
    root,
    "rtk",
    '#!/bin/sh\nset -eu\ntest "$1" = proxy\nbackend=$2\nshift 2\nexec "$backend" "$@"\n',
  );
  const pnpmSource = executable(
    root,
    "real-pnpm",
    "#!/bin/sh\nprintf 'cwd=%s\\n' \"$PWD\"\nprintf 'argv=%s\\n' \"$*\"\nprintf 'path=%s\\n' \"$PATH\"\nprintf 'stderr=%s\\n' 'forwarded' >&2\n",
  );
  return {
    projection: baseProjection(rtkSource, pnpmSource, process.execPath, options),
    launcher_path: path.join(root, "launcher", "pnpm"),
    rtk: backend("/materialized/rtk", rtkSource, RTK_BACKEND_PROVIDER.id, RTK_BACKEND_REQUIREMENT.id),
    real_pnpm: backend(
      "/materialized/pnpm",
      pnpmSource,
      REAL_PNPM_BACKEND_PROVIDER.id,
      REAL_PNPM_BACKEND_REQUIREMENT.id,
    ),
  };
}

/** Build a hermetic #311-shaped handoff for transport coverage only. */
function syntheticBackendMaterialization(root: string) {
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  const roots = {
    rtk: path.join(store, "aaa-rtk-0.45.0"),
    pnpm: path.join(store, "bbb-pnpm-11.18.0"),
  } as const;
  const dependencies = {
    rtk: path.join(store, "ccc-rtk-runtime-dependency"),
    pnpm: path.join(store, "ddd-pnpm-runtime-dependency"),
  } as const;
  const rtkSource = path.join(roots.rtk, "bin", "rtk");
  const pnpmSource = path.join(roots.pnpm, "libexec", "pnpm", "bin", "pnpm.mjs");
  fs.mkdirSync(path.dirname(rtkSource), { recursive: true });
  fs.mkdirSync(path.dirname(pnpmSource), { recursive: true });
  fs.mkdirSync(path.join(roots.pnpm, "libexec", "pnpm", "dist"), { recursive: true });
  fs.writeFileSync(rtkSource, '#!/bin/sh\nset -eu\ntest "$1" = proxy\nbackend=$2\nshift 2\nexec "$backend" "$@"\n', {
    mode: 0o755,
  });
  fs.writeFileSync(pnpmSource, "#!/bin/sh\nprintf 'resolved-pnpm argv=%s\\n' \"$*\"\n", { mode: 0o755 });
  fs.writeFileSync(path.join(roots.pnpm, "libexec", "pnpm", "dist", "pnpm.mjs"), "bundle\n");
  for (const dependency of Object.values(dependencies)) fs.mkdirSync(dependency);

  const profileResult = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [
      { operation: "remove", requirement_id: "node-runtime" },
      { operation: "add", requirement: RTK_BACKEND_REQUIREMENT },
      { operation: "add", requirement: REAL_PNPM_BACKEND_REQUIREMENT },
    ],
  });
  if (!profileResult.ok) throw profileResult.error;
  assert.equal(profileResult.ok, true);

  const rootsByInstallable: Readonly<Record<string, "rtk" | "pnpm">> = {
    [RTK_NIX_INSTALLABLE]: "rtk",
    [PNPM_NIX_INSTALLABLE]: "pnpm",
  };
  const closures = {
    rtk: [roots.rtk, dependencies.rtk],
    pnpm: [roots.pnpm, dependencies.pnpm],
  } as const;
  const commandRunner: NixCommandRunner = (_executable, args) => {
    const installable = args.at(-1);
    const key = typeof installable === "string" ? rootsByInstallable[installable] : undefined;
    if (key === undefined) return { exit_code: 1, stdout: "", stderr: "unknown installable" };
    const selected = args.includes("--recursive") ? closures[key] : [roots[key]];
    return {
      exit_code: 0,
      stdout: JSON.stringify(Object.fromEntries(selected.map((storePath) => [storePath, null]))),
      stderr: "",
    };
  };
  const materialized = materializePnpmMiddlewareBackends(profileResult.value, {
    store_root: store,
    command_runner: commandRunner,
  });
  if (!materialized.ok) throw materialized.error;
  assert.equal(materialized.ok, true);
  assert.equal(materialized.value.rtk.path, PNPM_MIDDLEWARE_RTK_TARGET);
  assert.equal(materialized.value.real_pnpm.path, PNPM_MIDDLEWARE_REAL_PNPM_TARGET);
  return materialized.value;
}

test("materializes one exact pnpm launcher through the canonical executable projection", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);
    const result = materializePnpmMiddleware(input);
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;

    assert.equal(result.value.executable_target, PROJECTED_PNPM_TARGET);
    assert.equal(result.value.launcher_target, PNPM_MIDDLEWARE_LAUNCHER_TARGET);
    assert.notEqual(fs.statSync(result.value.launcher_source).mode & 0o111, 0);

    const launcher = fs.readFileSync(result.value.launcher_source, "utf8");
    assert.match(launcher, /spawn\(rtkPath, \["proxy", realPnpmPath, \.\.\.process\.argv\.slice\(2\)\]/u);
    assert.match(launcher, /shell: false/u);
    assert.match(launcher, /stdio: "inherit"/u);
    assert.doesNotMatch(launcher, /command -v|which|env pnpm/u);
    assert.equal(result.value.projection.executables.at(-1)?.target, PNPM_MIDDLEWARE_LAUNCHER_TARGET);

    const compiled = compileRuntimeExecutableProjection(result.value.projection);
    assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.error));
    if (compiled.ok) {
      const pnpmEntry = compiled.value.find((entry) => entry.target === PROJECTED_PNPM_TARGET);
      assert.equal(pnpmEntry?.source, result.value.launcher_source);
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the fixed launcher preserves argv, cwd, inherited PATH, stdout, and stderr without host fallback", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-cwd-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);
    const runnableProjection = validateSessionRuntimeProjection({
      ...input.projection,
      filesystem: input.projection.filesystem.map((entry) => ({ ...entry, target: entry.source })),
      executables: input.projection.executables.map((entry) => ({
        ...entry,
        target: entry.name === "node" ? process.execPath : entry.target,
      })),
    });
    assert.equal(runnableProjection.ok, true, runnableProjection.ok ? "" : JSON.stringify(runnableProjection.error));
    if (!runnableProjection.ok) return;
    const runnable = materializePnpmMiddleware({
      ...input,
      projection: runnableProjection.value,
      rtk: { ...input.rtk, path: input.rtk.source },
      real_pnpm: { ...input.real_pnpm, path: input.real_pnpm.source },
    });
    assert.equal(runnable.ok, true, runnable.ok ? "" : JSON.stringify(runnable.error));
    if (!runnable.ok) return;

    const child = spawnSync(
      process.execPath,
      [runnable.value.launcher_source, "run", "arg with spaces", "--flag=value"],
      {
        cwd,
        env: { ...process.env, PATH: "/nawabari/bin", NAWABARI_PNPM_TEST: "selected" },
        input: "stdin is inherited by the fixed process chain\n",
        encoding: "utf8",
      },
    );
    assert.equal(child.status, 0, child.stderr);
    assert.equal(child.signal, null);
    assert.match(child.stdout, new RegExp(`^cwd=${cwd.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}\\n`, "u"));
    assert.match(child.stdout, /argv=run arg with spaces --flag=value\n/u);
    assert.match(child.stdout, /path=\/nawabari\/bin\n/u);
    assert.match(child.stderr, /stderr=forwarded\n/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});

test("signal termination is forwarded through the fixed launcher chain", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);
    const hangingPnpm = executable(root, "hanging-pnpm", "#!/bin/sh\nwhile :; do sleep 1; done\n");
    const projection = baseProjection(input.rtk.source, hangingPnpm, process.execPath);
    const runnableProjection = validateSessionRuntimeProjection({
      ...projection,
      filesystem: projection.filesystem.map((entry) => ({ ...entry, target: entry.source })),
      executables: projection.executables.map((entry) => ({
        ...entry,
        target: entry.name === "node" ? process.execPath : entry.target,
      })),
    });
    assert.equal(runnableProjection.ok, true, runnableProjection.ok ? "" : JSON.stringify(runnableProjection.error));
    if (!runnableProjection.ok) return;
    const result = materializePnpmMiddleware({
      ...input,
      projection: runnableProjection.value,
      rtk: { ...input.rtk, path: input.rtk.source },
      real_pnpm: { ...input.real_pnpm, path: hangingPnpm, source: hangingPnpm },
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;

    const child = spawn(process.execPath, [result.value.launcher_source], {
      cwd: root,
      env: { ...process.env, PATH: "/nawabari/bin" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const closed = new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>((resolve) => {
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    child.kill("SIGTERM");
    const outcome = await closed;
    assert.equal(outcome.code, null);
    assert.equal(outcome.signal, "SIGTERM");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects projected, relative, equal, missing, non-executable, and mismatched backends before writing", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);

    const relative = materializePnpmMiddleware({ ...input, rtk: { ...input.rtk, path: "rtk" } });
    assert.equal(relative.ok, false);
    if (!relative.ok) assert.equal(relative.error.code, "RUNTIME_PROJECTION_INVALID");

    const projected = materializePnpmMiddleware({ ...input, rtk: { ...input.rtk, path: PROJECTED_PNPM_TARGET } });
    assert.equal(projected.ok, false);
    if (!projected.ok) assert.equal(projected.error.code, "RUNTIME_PROJECTION_INVALID");

    const equal = materializePnpmMiddleware({
      ...input,
      real_pnpm: { ...input.real_pnpm, path: input.rtk.path, source: input.rtk.source },
    });
    assert.equal(equal.ok, false);
    if (!equal.ok) assert.equal(equal.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");

    const missing = materializePnpmMiddleware({
      ...input,
      real_pnpm: { ...input.real_pnpm, source: path.join(root, "missing-pnpm") },
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.equal(missing.error.code, "RUNTIME_MATERIALIZATION_MISSING");

    const nonExecutable = path.join(root, "non-executable-pnpm");
    fs.writeFileSync(nonExecutable, "not executable\n", { mode: 0o644 });
    const nonExecutableProjection = baseProjection(input.rtk.source, nonExecutable, process.execPath);
    const rejectedMode = materializePnpmMiddleware({
      ...input,
      projection: nonExecutableProjection,
      real_pnpm: { ...input.real_pnpm, source: nonExecutable },
    });
    assert.equal(rejectedMode.ok, false);
    if (!rejectedMode.ok) assert.equal(rejectedMode.error.code, "RUNTIME_MATERIALIZATION_MISSING");

    const mismatch = materializePnpmMiddleware({
      ...input,
      rtk: { ...input.rtk, provider: { ...input.rtk.provider, id: "not-rtk" } },
    });
    assert.equal(mismatch.ok, false);
    if (!mismatch.ok) assert.equal(mismatch.error.code, "RUNTIME_PROJECTION_INVALID");

    assert.equal(fs.existsSync(input.launcher_path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("requires exact read-only materialization and never falls back to an ambient host executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);
    const missingProjection = validateSessionRuntimeProjection({
      ...input.projection,
      filesystem: [
        {
          source: input.rtk.source,
          target: input.rtk.path,
          access_mode: "read-only",
          provenance: "package",
        },
      ],
    });
    assert.equal(missingProjection.ok, true, missingProjection.ok ? "" : JSON.stringify(missingProjection.error));
    if (!missingProjection.ok) return;
    const result = materializePnpmMiddleware({ ...input, projection: missingProjection.value });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.match(result.error.message, /exact read-only source-to-target materialization/u);
    }
    assert.equal(fs.existsSync(input.launcher_path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a projection carrying the node-runtime requirement but no projected node executable", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root, { omitNodeExecutable: true });
    const result = materializePnpmMiddleware(input);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "RUNTIME_PROVIDER_MISSING");
    }
    assert.equal(fs.existsSync(input.launcher_path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("rejects a declared node executable that does not resolve to a materialized backing file", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-middleware-"));
  try {
    fs.mkdirSync(path.join(root, "launcher"));
    const input = materializationInput(root);
    const unresolvedProjection = validateSessionRuntimeProjection({
      ...input.projection,
      filesystem: input.projection.filesystem.filter((entry) => entry.target !== "/materialized/node"),
    });
    assert.equal(
      unresolvedProjection.ok,
      true,
      unresolvedProjection.ok ? "" : JSON.stringify(unresolvedProjection.error),
    );
    if (!unresolvedProjection.ok) return;
    const result = materializePnpmMiddleware({ ...input, projection: unresolvedProjection.value });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "RUNTIME_PROVIDER_MISSING");
    }
    assert.equal(fs.existsSync(input.launcher_path), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the launcher transport stays isolated under a bounded real runtime with synthetic backend fixtures", async (t) => {
  if (process.platform !== "linux") {
    t.skip("bubblewrap profile is Linux-only");
    return;
  }
  const report = discoverSandboxRuntimeLayout();
  if (report.bubblewrap === null) {
    t.skip("bubblewrap is unavailable in this test environment");
    return;
  }
  // This is transport coverage only: the backend files are synthetic and the
  // pinned artifact acceptance evidence is the conformance-gated test below.
  // The launcher itself is still exercised through the same production
  // resolveSandboxExecutionRequest -> runSandboxedCommand path used by
  // `session run`/`session shell`, under a strict projection that also carries
  // a real canonical node entrypoint.
  //
  // The projection is bounded through #292's ELF-closure materializer
  // (materializeFhsRuntime): only the node/sh interpreters and their exact
  // computed shared-library closures are projected, never a wholesale
  // /usr, /lib, /lib64, or /bin host-root mount.
  const nodeInterpreter = resolveCanonicalNodeInterpreter();
  const shInterpreter = fs.realpathSync.native("/bin/sh");
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const undeclaredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-undeclared-host-bin-"));
  const undeclaredExecutable = path.join(undeclaredRoot, "host-only-marker");
  fs.copyFileSync(shInterpreter, undeclaredExecutable);
  fs.chmodSync(undeclaredExecutable, 0o755);
  executable(undeclaredRoot, "pnpm", "#!/bin/sh\necho host-pnpm\n");
  executable(undeclaredRoot, "rtk", "#!/bin/sh\necho host-rtk\n");
  const originalHostPath = process.env.PATH;
  const materializationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-materialization-"));
  try {
    fs.mkdirSync(path.join(materializationRoot, "launcher"));
    const backendMaterialization = syntheticBackendMaterialization(materializationRoot);

    const shRequirement = { id: "sh-runtime", kind: "runtime" as const, name: "sh", version: "1" };
    const profile = resolveRuntimeProfile({
      profiles: ["base"],
      operations: [{ operation: "add", requirement: shRequirement }],
    });
    assert.equal(profile.ok, true, profile.ok ? "" : JSON.stringify(profile.error));
    if (!profile.ok) return;

    const fhsProjection = materializeFhsRuntime({
      profile: profile.value,
      executables: [
        { requirement_id: "node-runtime", path: nodeInterpreter },
        { requirement_id: "sh-runtime", path: "/bin/sh" },
      ],
    });
    assert.equal(fhsProjection.ok, true, fhsProjection.ok ? "" : JSON.stringify(fhsProjection.error));
    if (!fhsProjection.ok) return;
    for (const root of ["/usr", "/bin", "/lib", "/lib64", "/nix/store"]) {
      assert.ok(
        fhsProjection.value.filesystem.every((entry) => entry.target !== root),
        `bounded FHS/backend materialization must not project the whole ${root} root`,
      );
    }

    const preProjection = validateSessionRuntimeProjection({
      policy: STRICT_RUNTIME_POLICY,
      profile: { id: "pnpm-middleware-real-isolation", version: "1" },
      requirements: [...fhsProjection.value.requirements, ...backendMaterialization.requirements],
      filesystem: [
        ...fhsProjection.value.filesystem,
        // The hermetic fake outputs are shell scripts and need only the exact
        // file-level handoff. #311's conformance test covers its full Nix
        // closure projection against /nix/store.
        ...backendMaterialization.projection.filesystem.filter((entry) =>
          new Set<string>([
            PNPM_MIDDLEWARE_RTK_TARGET,
            PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
            PNPM_MIDDLEWARE_PNPM_BUNDLE_TARGET,
          ]).has(entry.target),
        ),
      ],
      executables: [
        {
          name: "node",
          target: nodeInterpreter,
          provider: { id: "node-runtime-provider", requirement_id: "node-runtime" },
          provenance: "runtime-profile" as const,
        },
        {
          name: "sh",
          target: "/bin/sh",
          provider: { id: "sh-provider", requirement_id: "sh-runtime" },
          provenance: "runtime-profile" as const,
        },
      ],
    });
    assert.equal(preProjection.ok, true, preProjection.ok ? "" : JSON.stringify(preProjection.error));
    if (!preProjection.ok) return;

    const materialized = materializePnpmMiddleware({
      projection: preProjection.value,
      launcher_path: path.join(materializationRoot, "launcher", "pnpm"),
      rtk: backendMaterialization.rtk,
      real_pnpm: backendMaterialization.real_pnpm,
    });
    assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));
    if (!materialized.ok) return;

    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/pnpm-middleware-real-isolation", worktree, label: null, base: null },
    );
    if (!created.ok) throw created.error;
    const request = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      {
        session_id: created.value.session_id,
        enforce: true,
        runtime_policy: STRICT_RUNTIME_POLICY,
        runtime_projection: preProjection.value,
      },
      readyProbe(),
      discoverSandboxRuntimeLayout(),
    );
    if (!request.ok) throw request.error;
    const projectedRequest = { ...request.value, runtime_projection: materialized.value.projection };

    const direct = await runSandboxedCommand(projectedRequest, {
      command: "pnpm",
      args: ["run", "build"],
    });
    assert.equal(direct.ok, true, direct.ok ? "" : JSON.stringify(direct.error));
    if (direct.ok) {
      assert.equal(direct.value.exit_code, 0, JSON.stringify(direct.value));
      assert.match(direct.value.stdout, /^resolved-pnpm argv=run build\n/u);
    }

    const viaBasenameLookup = await runSandboxedCommand(projectedRequest, {
      command: "sh",
      args: ["-c", 'exec "$(command -v pnpm)" run build'],
    });
    assert.equal(viaBasenameLookup.ok, true, viaBasenameLookup.ok ? "" : JSON.stringify(viaBasenameLookup.error));
    if (viaBasenameLookup.ok) {
      assert.equal(viaBasenameLookup.value.exit_code, 0, JSON.stringify(viaBasenameLookup.value));
      assert.match(viaBasenameLookup.value.stdout, /^resolved-pnpm argv=run build\n/u);
    }

    process.env.PATH = `${originalHostPath ?? ""}:${path.dirname(undeclaredExecutable)}`;
    const sessionRunOutput: string[] = [];
    const sessionRunExit = await runCli(
      ["--json", "session", "run", "--session", created.value.session_id, "--", "pnpm", "run", "session-run"],
      {
        backend,
        cwd: worktree,
        io: { stdout: (line) => sessionRunOutput.push(line), stderr: () => {} },
        sandboxProbe: readyProbe(),
        sandboxRuntimeLayout: report,
        sandboxRuntimeProjection: materialized.value.projection,
      },
    );
    assert.equal(sessionRunExit, 0, sessionRunOutput.join("\n"));
    const sessionRunResult = JSON.parse(sessionRunOutput[0] ?? "{}") as { stdout?: string; stderr?: string };
    assert.match(sessionRunResult.stdout ?? "", /^resolved-pnpm argv=run session-run\n/u);
    assert.equal(sessionRunResult.stderr, "");

    const basenameRunOutput: string[] = [];
    const basenameRunExit = await runCli(
      [
        "--json",
        "session",
        "run",
        "--session",
        created.value.session_id,
        "--",
        "sh",
        "-c",
        'printf "resolved=%s\\n" "$(command -v pnpm)"; exec "$(command -v pnpm)" run basename-run',
      ],
      {
        backend,
        cwd: worktree,
        io: { stdout: (line) => basenameRunOutput.push(line), stderr: () => {} },
        sandboxProbe: readyProbe(),
        sandboxRuntimeLayout: report,
        sandboxRuntimeProjection: materialized.value.projection,
      },
    );
    assert.equal(basenameRunExit, 0, basenameRunOutput.join("\n"));
    const basenameRunResult = JSON.parse(basenameRunOutput[0] ?? "{}") as { stdout?: string };
    assert.match(
      basenameRunResult.stdout ?? "",
      /^resolved=\/nawabari\/bin\/pnpm\nresolved-pnpm argv=run basename-run\n/u,
    );

    const shellEvidence = path.join(worktree, "pnpm-session-shell-evidence.txt");
    const shellExit = await runCli(
      [
        "session",
        "shell",
        "--session",
        created.value.session_id,
        "--",
        "sh",
        "-c",
        [
          "set -eu",
          `printf 'provider=%s\\n' \"$(command -v pnpm)\" > ${JSON.stringify(shellEvidence)}`,
          `pnpm shell-run >> ${JSON.stringify(shellEvidence)} 2>&1`,
          `printf 'path=%s\\n' \"$PATH\" >> ${JSON.stringify(shellEvidence)}`,
        ].join("\n"),
      ],
      {
        backend,
        cwd: worktree,
        sandboxProbe: readyProbe(),
        sandboxRuntimeLayout: report,
        sandboxRuntimeProjection: materialized.value.projection,
      },
    );
    assert.equal(shellExit, 0);
    assert.equal(
      fs.readFileSync(shellEvidence, "utf8"),
      "provider=/nawabari/bin/pnpm\nresolved-pnpm argv=shell-run\npath=/nawabari/bin\n",
    );

    const hostPathProofOutput: string[] = [];
    const hostPathProofExit = await runCli(
      [
        "--json",
        "session",
        "run",
        "--session",
        created.value.session_id,
        "--",
        "sh",
        "-c",
        'printf "pnpm=%s\\n" "$(command -v pnpm)"; if command -v rtk >/dev/null 2>&1; then echo rtk=visible; else echo rtk=hidden; fi; printf "path=%s\\n" "$PATH"',
      ],
      {
        backend,
        cwd: worktree,
        io: { stdout: (line) => hostPathProofOutput.push(line), stderr: () => {} },
        sandboxProbe: readyProbe(),
        sandboxRuntimeLayout: report,
        sandboxRuntimeProjection: materialized.value.projection,
      },
    );
    assert.equal(hostPathProofExit, 0, hostPathProofOutput.join("\n"));
    const hostPathProof = JSON.parse(hostPathProofOutput[0] ?? "{}") as { stdout?: string };
    assert.equal(hostPathProof.stdout, "pnpm=/nawabari/bin/pnpm\nrtk=hidden\npath=/nawabari/bin\n");

    const ambientPathIsolated = await runSandboxedCommand(projectedRequest, {
      command: "sh",
      args: ["-c", "command -v host-only-marker >/dev/null 2>&1 && echo leaked || echo isolated"],
    });
    assert.equal(ambientPathIsolated.ok, true, ambientPathIsolated.ok ? "" : JSON.stringify(ambientPathIsolated.error));
    if (ambientPathIsolated.ok) assert.equal(ambientPathIsolated.value.stdout.trim(), "isolated");
  } finally {
    process.env.PATH = originalHostPath;
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(undeclaredRoot, { recursive: true, force: true });
    fs.rmSync(materializationRoot, { recursive: true, force: true });
  }
});

test("the canonical #311 artifacts execute through the #306 launcher under protected session paths", async (t) => {
  if (process.env.NAWABARI_PNPM_MIDDLEWARE_RUNTIME_CONFORMANCE !== "1") {
    t.skip("set NAWABARI_PNPM_MIDDLEWARE_RUNTIME_CONFORMANCE=1 for pinned artifact conformance");
    return;
  }
  if (process.platform !== "linux") {
    t.skip("canonical protected execution is Linux-only");
    return;
  }

  const doctor = sandboxDoctorReport(defaultSandboxProbe);
  const runtimeLayout = discoverSandboxRuntimeLayout();
  if (!doctor.ready || runtimeLayout.bubblewrap === null) {
    t.skip(`protected execution unavailable: ${doctor.missing_required.join(", ") || "bubblewrap"}`);
    return;
  }

  const backendProfileResult = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [
      { operation: "remove", requirement_id: "node-runtime" },
      { operation: "add", requirement: RTK_BACKEND_REQUIREMENT },
      { operation: "add", requirement: REAL_PNPM_BACKEND_REQUIREMENT },
    ],
  });
  assert.equal(
    backendProfileResult.ok,
    true,
    backendProfileResult.ok ? "" : JSON.stringify(backendProfileResult.error),
  );
  if (!backendProfileResult.ok) return;
  const backendResult = materializePnpmMiddlewareBackends(backendProfileResult.value);
  // The conformance gate runs only with the canonical profile above. Keep a
  // failure explicit here so a resolver regression cannot be mistaken for a
  // protected-runtime skip.
  assert.equal(backendResult.ok, true, backendResult.ok ? "" : JSON.stringify(backendResult.error));
  if (!backendResult.ok) return;

  const nodeInterpreter = resolveCanonicalNodeInterpreter();
  const shInterpreter = fs.realpathSync.native("/bin/sh");
  const runtimeProfileResult = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [{ operation: "add", requirement: { id: "sh-runtime", kind: "runtime", name: "sh", version: "1" } }],
  });
  assert.equal(
    runtimeProfileResult.ok,
    true,
    runtimeProfileResult.ok ? "" : JSON.stringify(runtimeProfileResult.error),
  );
  if (!runtimeProfileResult.ok) return;
  const fhsResult = materializeFhsRuntime({
    policy: STRICT_RUNTIME_POLICY,
    profile: runtimeProfileResult.value,
    executables: [
      { requirement_id: "node-runtime", path: nodeInterpreter },
      { requirement_id: "sh-runtime", path: shInterpreter },
    ],
  });
  assert.equal(fhsResult.ok, true, fhsResult.ok ? "" : JSON.stringify(fhsResult.error));
  if (!fhsResult.ok) return;

  const broadRoots = ["/usr", "/bin", "/lib", "/lib64", "/nix/store"];
  for (const root of broadRoots) {
    assert.equal(
      fhsResult.value.filesystem.some((entry) => entry.target === root),
      false,
      `bounded FHS materialization must not project the whole ${root} root`,
    );
    assert.equal(
      backendResult.value.projection.filesystem.some((entry) => entry.target === root),
      false,
      `canonical backend materialization must not project the whole ${root} root`,
    );
  }

  const combinedProjection = validateSessionRuntimeProjection({
    policy: STRICT_RUNTIME_POLICY,
    profile: { id: "pnpm-middleware-pinned-conformance", version: "1" },
    requirements: [...fhsResult.value.requirements, ...backendResult.value.requirements],
    filesystem: [...fhsResult.value.filesystem, ...backendResult.value.projection.filesystem],
    executables: [
      {
        name: "node",
        target: nodeInterpreter,
        provider: { id: "node-runtime-provider", requirement_id: "node-runtime" },
        provenance: "runtime-profile" as const,
      },
      {
        name: "sh",
        target: shInterpreter,
        provider: { id: "sh-provider", requirement_id: "sh-runtime" },
        provenance: "runtime-profile" as const,
      },
    ],
  });
  assert.equal(combinedProjection.ok, true, combinedProjection.ok ? "" : JSON.stringify(combinedProjection.error));
  if (!combinedProjection.ok) return;

  const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-pinned-launcher-"));
  fs.mkdirSync(path.join(launcherRoot, "launcher"));
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const undeclaredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-pinned-host-bin-"));
  const originalHostPath = process.env.PATH;
  try {
    executable(undeclaredRoot, "pnpm", "#!/bin/sh\necho host-pnpm\n");
    executable(undeclaredRoot, "rtk", "#!/bin/sh\necho host-rtk\n");
    const materialized = materializePnpmMiddleware({
      projection: combinedProjection.value,
      launcher_path: path.join(launcherRoot, "launcher", "pnpm"),
      rtk: backendResult.value.rtk,
      real_pnpm: backendResult.value.real_pnpm,
    });
    assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));
    if (!materialized.ok) return;

    const launcher = fs.readFileSync(materialized.value.launcher_source, "utf8");
    assert.equal(launcher.includes(`const rtkPath = ${JSON.stringify(backendResult.value.rtk.path)};`), true);
    assert.equal(
      launcher.includes(`const realPnpmPath = ${JSON.stringify(backendResult.value.real_pnpm.path)};`),
      true,
    );
    assert.match(launcher, /spawn\(rtkPath, \["proxy", realPnpmPath, \.\.\.process\.argv\.slice\(2\)\]/u);

    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/pnpm-pinned-conformance", worktree, label: null, base: null },
    );
    if (!created.ok) throw created.error;
    const request = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      { session_id: created.value.session_id, enforce: true, runtime_projection: materialized.value.projection },
      defaultSandboxProbe,
      runtimeLayout,
    );
    assert.equal(request.ok, true, request.ok ? "" : JSON.stringify(request.error));
    if (!request.ok) return;

    process.env.PATH = `${undeclaredRoot}:${originalHostPath ?? ""}`;
    const direct = await runSandboxedCommand(request.value, {
      command: "/nawabari/bin/pnpm",
      args: ["--version"],
    });
    assert.equal(direct.ok, true, direct.ok ? "" : JSON.stringify(direct.error));
    if (!direct.ok) return;
    assert.equal(direct.value.exit_code, 0, JSON.stringify(direct.value));
    assert.equal(direct.value.stdout, PNPM_BACKEND_EVIDENCE.version);

    const basename = await runSandboxedCommand(request.value, {
      command: "sh",
      args: ["-c", 'printf "resolved=%s\\n" "$(command -v pnpm)"; exec "$(command -v pnpm)" --version'],
    });
    assert.equal(basename.ok, true, basename.ok ? "" : JSON.stringify(basename.error));
    if (!basename.ok) return;
    assert.equal(basename.value.exit_code, 0, JSON.stringify(basename.value));
    assert.equal(basename.value.stdout, `resolved=/nawabari/bin/pnpm\n${PNPM_BACKEND_EVIDENCE.version}`);

    const runOutput: string[] = [];
    const runExit = await runCli(
      ["--json", "session", "run", "--session", created.value.session_id, "--", "pnpm", "--version"],
      {
        backend,
        cwd: worktree,
        io: { stdout: (line) => runOutput.push(line), stderr: () => {} },
        sandboxProbe: defaultSandboxProbe,
        sandboxRuntimeLayout: runtimeLayout,
        sandboxRuntimeProjection: materialized.value.projection,
      },
    );
    assert.equal(runExit, 0, runOutput.join("\n"));
    const runResult = JSON.parse(runOutput[0] ?? "{}") as { stdout?: string; stderr?: string };
    assert.equal(runResult.stdout, PNPM_BACKEND_EVIDENCE.version);
    assert.equal(runResult.stderr, "");

    const shellEvidence = path.join(worktree, "pnpm-pinned-session-shell-evidence.txt");
    const shellExit = await runCli(
      [
        "session",
        "shell",
        "--session",
        created.value.session_id,
        "--",
        "sh",
        "-c",
        [
          "set -eu",
          `printf 'provider=%s\\n' \"$(command -v pnpm)\" > ${JSON.stringify(shellEvidence)}`,
          `pnpm --version >> ${JSON.stringify(shellEvidence)} 2>&1`,
          `printf 'path=%s\\n' \"$PATH\" >> ${JSON.stringify(shellEvidence)}`,
        ].join("\n"),
      ],
      {
        backend,
        cwd: worktree,
        sandboxProbe: defaultSandboxProbe,
        sandboxRuntimeLayout: runtimeLayout,
        sandboxRuntimeProjection: materialized.value.projection,
      },
    );
    assert.equal(shellExit, 0);
    assert.equal(
      fs.readFileSync(shellEvidence, "utf8"),
      `provider=/nawabari/bin/pnpm\n${PNPM_BACKEND_EVIDENCE.version}path=/nawabari/bin\n`,
    );

    const hostPathOutput: string[] = [];
    const hostPathExit = await runCli(
      [
        "--json",
        "session",
        "run",
        "--session",
        created.value.session_id,
        "--",
        "sh",
        "-c",
        'printf "pnpm=%s\\n" "$(command -v pnpm)"; if command -v rtk >/dev/null 2>&1; then echo rtk=visible; else echo rtk=hidden; fi; printf "path=%s\\n" "$PATH"',
      ],
      {
        backend,
        cwd: worktree,
        io: { stdout: (line) => hostPathOutput.push(line), stderr: () => {} },
        sandboxProbe: defaultSandboxProbe,
        sandboxRuntimeLayout: runtimeLayout,
        sandboxRuntimeProjection: materialized.value.projection,
      },
    );
    assert.equal(hostPathExit, 0, hostPathOutput.join("\n"));
    const hostPathResult = JSON.parse(hostPathOutput[0] ?? "{}") as { stdout?: string };
    assert.equal(hostPathResult.stdout, "pnpm=/nawabari/bin/pnpm\nrtk=hidden\npath=/nawabari/bin\n");
  } finally {
    process.env.PATH = originalHostPath;
    removeWorktree(repository, worktree);
    fs.rmSync(repository, { recursive: true, force: true });
    fs.rmSync(launcherRoot, { recursive: true, force: true });
    fs.rmSync(undeclaredRoot, { recursive: true, force: true });
  }
});
