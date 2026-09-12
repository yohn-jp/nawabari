import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  materializePnpmMiddleware,
  PNPM_MIDDLEWARE_LAUNCHER_TARGET,
  PNPM_MIDDLEWARE_PROVIDER_IDS,
  PNPM_MIDDLEWARE_REQUIREMENTS,
  PROJECTED_PNPM_TARGET,
  type PnpmMiddlewareBackend,
} from "./runtime-provider-pnpm-middleware.js";
import {
  STRICT_RUNTIME_POLICY,
  validateSessionRuntimeProjection,
  type SessionRuntimeProjection,
} from "./runtime-projection.js";
import { compileRuntimeExecutableProjection } from "./runtime-executable-projection.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { LocalSessionBackend } from "./session-backend.js";
import {
  discoverSandboxRuntimeLayout,
  materializeFhsRuntime,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
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

function removeWorktree(repository: string, worktree: string): void {
  runGit(["worktree", "remove", "--force", worktree], repository, false);
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
      PNPM_MIDDLEWARE_REQUIREMENTS.rtk,
      PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm,
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
): PnpmMiddlewareBackend {
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
  readonly rtk: PnpmMiddlewareBackend;
  readonly real_pnpm: PnpmMiddlewareBackend;
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
    rtk: backend("/materialized/rtk", rtkSource, PNPM_MIDDLEWARE_PROVIDER_IDS.rtk, PNPM_MIDDLEWARE_REQUIREMENTS.rtk.id),
    real_pnpm: backend(
      "/materialized/pnpm",
      pnpmSource,
      PNPM_MIDDLEWARE_PROVIDER_IDS.real_pnpm,
      PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.id,
    ),
  };
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

test("the governed /nawabari/bin/pnpm -> pinned RTK -> pinned real pnpm path resolves under real isolation, with no host PATH fallback", async (t) => {
  if (process.platform !== "linux") {
    t.skip("bubblewrap profile is Linux-only");
    return;
  }
  const report = discoverSandboxRuntimeLayout();
  if (report.bubblewrap === null) {
    t.skip("bubblewrap is unavailable in this test environment");
    return;
  }
  // Proves the review gap raised on #306 is closed: the actual materialized
  // launcher (not a fake shell-script stand-in run directly on the host) is
  // exercised through the same production resolveSandboxExecutionRequest ->
  // runSandboxedCommand path used by `session run`/`session shell`, under a
  // strict projection that also carries a real canonical node entrypoint.
  //
  // The projection is bounded through #292's ELF-closure materializer
  // (materializeFhsRuntime): only the node/sh interpreters and their exact
  // computed shared-library closures are projected, never a wholesale
  // /usr, /lib, /lib64, or /bin host-root mount.
  const nodeInterpreter = fs.realpathSync.native(process.execPath);
  const shInterpreter = fs.realpathSync.native("/bin/sh");
  const repository = createRepository();
  const worktree = `${repository}-owned`;
  const undeclaredRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-undeclared-host-bin-"));
  const undeclaredExecutable = path.join(undeclaredRoot, "host-only-marker");
  fs.copyFileSync(shInterpreter, undeclaredExecutable);
  fs.chmodSync(undeclaredExecutable, 0o755);
  const originalHostPath = process.env.PATH;
  const materializationRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-materialization-"));
  try {
    fs.mkdirSync(path.join(materializationRoot, "launcher"));
    const rtkSource = executable(
      materializationRoot,
      "rtk",
      '#!/bin/sh\nset -eu\ntest "$1" = proxy\nbackend=$2\nshift 2\nexec "$backend" "$@"\n',
    );
    const pnpmSource = executable(
      materializationRoot,
      "real-pnpm",
      "#!/bin/sh\nprintf 'resolved-pnpm argv=%s\\n' \"$*\"\n",
    );

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
    for (const root of ["/usr", "/bin", "/lib", "/lib64"]) {
      assert.ok(
        fhsProjection.value.filesystem.every((entry) => entry.target !== root),
        `bounded FHS materialization must not project the whole ${root} root`,
      );
    }

    const preProjection = validateSessionRuntimeProjection({
      policy: STRICT_RUNTIME_POLICY,
      profile: { id: "pnpm-middleware-real-isolation", version: "1" },
      requirements: [
        ...fhsProjection.value.requirements,
        PNPM_MIDDLEWARE_REQUIREMENTS.rtk,
        PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm,
      ],
      filesystem: [
        ...fhsProjection.value.filesystem,
        {
          source: rtkSource,
          target: "/materialized/rtk",
          access_mode: "read-only" as const,
          provenance: "package" as const,
        },
        {
          source: pnpmSource,
          target: "/materialized/pnpm",
          access_mode: "read-only" as const,
          provenance: "package" as const,
        },
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
      rtk: {
        path: "/materialized/rtk",
        source: rtkSource,
        provider: { id: PNPM_MIDDLEWARE_PROVIDER_IDS.rtk, requirement_id: PNPM_MIDDLEWARE_REQUIREMENTS.rtk.id },
      },
      real_pnpm: {
        path: "/materialized/pnpm",
        source: pnpmSource,
        provider: {
          id: PNPM_MIDDLEWARE_PROVIDER_IDS.real_pnpm,
          requirement_id: PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.id,
        },
      },
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
      { session_id: created.value.session_id, enforce: true },
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
