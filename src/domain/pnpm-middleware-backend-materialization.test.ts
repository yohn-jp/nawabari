import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileRuntimeExecutableProjection, runtimeExecutableProviderKey } from "./runtime-executable-projection.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import { LocalSessionBackend } from "./session-backend.js";
import {
  compileSandboxInvocation,
  defaultSandboxProbe,
  discoverSandboxRuntimeLayout,
  resolveSandboxExecutionRequest,
  runSandboxedCommand,
  SANDBOX_CONTRACT_ID,
  SANDBOX_CONTRACT_SCHEMA_VERSION,
  sandboxCapabilityBaseline,
  sandboxDoctorReport,
  sandboxSeccompProfileMetadata,
  type SandboxExecutionRequest,
} from "./sandbox.js";
import { projectSessionRuntimeProjection, STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import type { NixCommandRunner } from "./nix-runtime-closure.js";
import {
  materializePnpmMiddlewareBackends,
  materializePnpmMiddlewareFhsRuntime,
  PNPM_BACKEND_EVIDENCE,
  PNPM_BUNDLE_RELATIVE_PATH,
  PNPM_EXECUTABLE_RELATIVE_PATH,
  PNPM_MIDDLEWARE_LAUNCHER_TARGET,
  PNPM_MIDDLEWARE_LAUNCHER_NODE_TARGET,
  PNPM_MIDDLEWARE_PNPM_BUNDLE_TARGET,
  PNPM_MIDDLEWARE_PROVIDER_IDS,
  PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
  PNPM_MIDDLEWARE_REQUIREMENTS,
  PNPM_MIDDLEWARE_RTK_TARGET,
  PNPM_NIX_INSTALLABLE,
  PNPM_NIXPKGS_REF,
  PROJECTED_PNPM_TARGET,
  REAL_PNPM_BACKEND_PROVIDER,
  RTK_BACKEND_EVIDENCE,
  RTK_BACKEND_PROVIDER,
  RTK_NIX_INSTALLABLE,
  RTK_NIXPKGS_REF,
  type PnpmMiddlewareBackendMaterialization,
} from "./pnpm-middleware-backend-materialization.js";

type Fixture = Readonly<{
  readonly store: string;
  readonly roots: Readonly<{ readonly rtk: string; readonly pnpm: string }>;
  readonly closures: Readonly<{ readonly rtk: readonly string[]; readonly pnpm: readonly string[] }>;
  readonly cleanup: () => void;
}>;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-backend-materialization-"));
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  const roots = {
    rtk: path.join(store, "aaa-rtk-0.45.0"),
    pnpm: path.join(store, "bbb-pnpm-11.18.0"),
  };
  const dependencies = {
    rtk: path.join(store, "ccc-rtk-runtime-dependency"),
    pnpm: path.join(store, "ddd-pnpm-runtime-dependency"),
  };
  fs.mkdirSync(path.join(roots.rtk, "bin"), { recursive: true });
  fs.writeFileSync(path.join(roots.rtk, "bin", "rtk"), "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(roots.pnpm, "libexec", "pnpm", "bin"), { recursive: true });
  fs.mkdirSync(path.join(roots.pnpm, "libexec", "pnpm", "dist"), { recursive: true });
  fs.writeFileSync(path.join(roots.pnpm, PNPM_EXECUTABLE_RELATIVE_PATH), "#!/bin/sh\nprintf '11.18.0\\n'\n", {
    mode: 0o755,
  });
  fs.writeFileSync(path.join(roots.pnpm, PNPM_BUNDLE_RELATIVE_PATH), "export default undefined;\n");
  for (const dependency of Object.values(dependencies)) fs.mkdirSync(dependency);
  return {
    store,
    roots,
    closures: {
      rtk: [roots.rtk, dependencies.rtk],
      pnpm: [roots.pnpm, dependencies.pnpm],
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function profile() {
  const result = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [
      { operation: "remove", requirement_id: "node-runtime" },
      { operation: "add", requirement: PNPM_MIDDLEWARE_REQUIREMENTS.rtk },
      { operation: "add", requirement: PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm },
    ],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("the pnpm middleware profile could not be resolved");
  return result.value;
}

function runnerFor(fixture: Fixture, reverse = false, failPnpm = false): NixCommandRunner {
  const rootsByInstallable: Readonly<Record<string, "rtk" | "pnpm">> = {
    [RTK_NIX_INSTALLABLE]: "rtk",
    [PNPM_NIX_INSTALLABLE]: "pnpm",
  };
  return (_executable, args) => {
    const installable = args.at(-1);
    if (typeof installable !== "string" || rootsByInstallable[installable] === undefined) {
      return { exit_code: 1, stdout: "", stderr: "unknown installable" };
    }
    if (failPnpm && installable === PNPM_NIX_INSTALLABLE) {
      return { exit_code: 1, stdout: "", stderr: "pnpm is not materialized" };
    }
    const key = rootsByInstallable[installable] as "rtk" | "pnpm";
    const paths = reverse ? [...fixture.closures[key]].reverse() : fixture.closures[key];
    const selected = args.includes("--recursive") ? paths : [fixture.roots[key]];
    return {
      exit_code: 0,
      stdout: JSON.stringify(Object.fromEntries(selected.map((storePath) => [storePath, null]))),
      stderr: "",
    };
  };
}

function materializeFixture(
  fixture: Fixture,
  runner: NixCommandRunner = runnerFor(fixture),
): ReturnType<typeof materializePnpmMiddlewareBackends> {
  return materializePnpmMiddlewareBackends(profile(), {
    store_root: fixture.store,
    command_runner: runner,
    nix_executable: "/nix/store/pinned-nix/bin/nix",
  });
}

function evidenceBlock(markdown: string, heading: string): string {
  const fence = "```";
  const prefix = `## ${heading}\n\n${fence}text\n`;
  const start = markdown.indexOf(prefix);
  assert.notEqual(start, -1, `missing ${heading} evidence`);
  const contentStart = start + prefix.length;
  const end = markdown.indexOf(`\n${fence}`, contentStart);
  assert.notEqual(end, -1, `unterminated ${heading} evidence`);
  return `${markdown.slice(contentStart, end)}\n`;
}

function checkedInEvidence(): Readonly<Record<string, string>> {
  const document = fs.readFileSync(
    new URL("../../docs/architecture/pnpm-middleware-backend-materialization.md", import.meta.url),
    "utf8",
  );
  return {
    rtk_version: evidenceBlock(document, "Exact RTK `--version` evidence"),
    rtk_proxy_help: evidenceBlock(document, "Exact RTK `proxy --help` evidence"),
    pnpm_version: evidenceBlock(document, "Exact pnpm `--version` evidence"),
    pnpm_help: evidenceBlock(document, "Exact pnpm `--help` evidence"),
  };
}

test("materializes exact RTK and real pnpm sources for #306", () => {
  const fixture = makeFixture();
  try {
    const result = materializeFixture(fixture);
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;

    assert.deepEqual(result.value.requirements, [
      PNPM_MIDDLEWARE_REQUIREMENTS.rtk,
      PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm,
    ]);
    assert.equal(result.value.rtk.path, PNPM_MIDDLEWARE_RTK_TARGET);
    assert.equal(result.value.rtk.source, path.join(fixture.roots.rtk, "bin", "rtk"));
    assert.equal(result.value.rtk.provider.id, PNPM_MIDDLEWARE_PROVIDER_IDS.rtk);
    assert.equal(result.value.real_pnpm.path, PNPM_MIDDLEWARE_REAL_PNPM_TARGET);
    assert.equal(result.value.real_pnpm.source, path.join(fixture.roots.pnpm, PNPM_EXECUTABLE_RELATIVE_PATH));
    assert.equal(result.value.real_pnpm.provider.id, PNPM_MIDDLEWARE_PROVIDER_IDS.real_pnpm);
    assert.equal(result.value.projection.policy, STRICT_RUNTIME_POLICY);
    assert.equal(result.value.projection.executables.length, 0);
    assert.equal(
      result.value.projection.filesystem.some(
        (entry) => entry.source === fixture.store || entry.target === fixture.store,
      ),
      false,
    );
    assert.ok(
      result.value.projection.filesystem.some(
        (entry) => entry.source === result.value.rtk.source && entry.target === PNPM_MIDDLEWARE_RTK_TARGET,
      ),
    );
    assert.ok(
      result.value.projection.filesystem.some(
        (entry) => entry.source === result.value.real_pnpm.source && entry.target === PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
      ),
    );
    assert.ok(
      result.value.projection.filesystem.some(
        (entry) =>
          entry.source === path.join(fixture.roots.pnpm, PNPM_BUNDLE_RELATIVE_PATH) &&
          entry.target === PNPM_MIDDLEWARE_PNPM_BUNDLE_TARGET,
      ),
    );
    assert.ok(result.value.rtk_closure.store_paths.includes(fixture.roots.rtk));
    assert.ok(result.value.real_pnpm_closure.store_paths.includes(fixture.roots.pnpm));
    assert.equal(result.value.real_pnpm.source.endsWith("/bin/pnpm"), false);
    assert.deepEqual(result.value.rtk_provider_materialization, {
      provider: RTK_BACKEND_PROVIDER,
      source: result.value.rtk.source,
    });
    assert.deepEqual(result.value.real_pnpm_provider_materialization, {
      provider: REAL_PNPM_BACKEND_PROVIDER,
      source: result.value.real_pnpm.source,
    });
  } finally {
    fixture.cleanup();
  }
});

test("#293 consumes the exact file sources without creating backend aliases", () => {
  const fixture = makeFixture();
  try {
    const materialized = materializeFixture(fixture);
    assert.equal(materialized.ok, true, materialized.ok ? "" : materialized.error.message);
    if (!materialized.ok) return;

    const withBackendEntrypoints = projectSessionRuntimeProjection({
      ...materialized.value.projection,
      executables: [
        {
          name: "rtk-backend",
          target: PNPM_MIDDLEWARE_RTK_TARGET,
          provider: RTK_BACKEND_PROVIDER,
          provenance: "package" as const,
        },
        {
          name: "pnpm-real-backend",
          target: PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
          provider: REAL_PNPM_BACKEND_PROVIDER,
          provenance: "package" as const,
        },
      ],
    });
    assert.equal(
      withBackendEntrypoints.ok,
      true,
      withBackendEntrypoints.ok ? "" : withBackendEntrypoints.error.message,
    );
    if (!withBackendEntrypoints.ok) return;
    const compiled = compileRuntimeExecutableProjection(
      withBackendEntrypoints.value,
      new Map([
        [runtimeExecutableProviderKey(RTK_BACKEND_PROVIDER), materialized.value.rtk_provider_materialization],
        [
          runtimeExecutableProviderKey(REAL_PNPM_BACKEND_PROVIDER),
          materialized.value.real_pnpm_provider_materialization,
        ],
      ]),
    );
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.message);
    if (!compiled.ok) return;
    assert.deepEqual(
      compiled.value.map((entry) => [entry.source, entry.target]),
      [
        [materialized.value.real_pnpm.source, "/nawabari/bin/pnpm-real-backend"],
        [materialized.value.rtk.source, "/nawabari/bin/rtk-backend"],
      ].sort((left, right) => left[1].localeCompare(right[1])),
    );
    assert.equal(
      compiled.value.some((entry) => entry.target === PROJECTED_PNPM_TARGET),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test("pins both immutable sources, canonicalizes ordering, and fails closed on drift or absence", () => {
  const fixture = makeFixture();
  try {
    const first = materializeFixture(fixture, runnerFor(fixture));
    const second = materializeFixture(fixture, runnerFor(fixture, true));
    assert.equal(first.ok, true, first.ok ? "" : first.error.message);
    assert.equal(second.ok, true, second.ok ? "" : second.error.message);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.value, second.value);

    const calls: string[] = [];
    const observingRunner: NixCommandRunner = (executable, args) => {
      calls.push(`${executable}\u0000${args.join("\u0000")}`);
      return runnerFor(fixture)(executable, args);
    };
    const observed = materializeFixture(fixture, observingRunner);
    assert.equal(observed.ok, true);
    assert.equal(
      calls.some((call) => call.includes("/host/path")),
      false,
    );
    assert.equal(
      calls.some((call) => call.includes(RTK_NIXPKGS_REF)),
      true,
    );
    assert.equal(
      calls.some((call) => call.includes(PNPM_NIXPKGS_REF)),
      true,
    );

    const overridden = materializePnpmMiddlewareBackends(profile(), {
      store_root: fixture.store,
      command_runner: observingRunner,
      package_attributes: { rtk: "host-rtk" },
    } as unknown as Parameters<typeof materializePnpmMiddlewareBackends>[1]);
    assert.equal(overridden.ok, false);
    if (!overridden.ok) assert.equal(overridden.error.code, "RUNTIME_MATERIALIZATION_MISSING");

    const missing = materializeFixture(fixture, runnerFor(fixture, false, true));
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.equal(missing.error.details?.requirement_id, PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.id);
    }

    const driftRoot = path.join(fixture.store, "eee-pnpm-11.19.0");
    fs.cpSync(fixture.roots.pnpm, driftRoot, { recursive: true });
    const driftRunner: NixCommandRunner = (executable, args) => {
      const result = runnerFor(fixture)(executable, args);
      if (args.at(-1) !== PNPM_NIX_INSTALLABLE) return result;
      const selected = args.includes("--recursive") ? [driftRoot] : [driftRoot];
      return { ...result, stdout: JSON.stringify(Object.fromEntries(selected.map((item) => [item, null]))) };
    };
    const drifted = materializeFixture(fixture, driftRunner);
    assert.equal(drifted.ok, false);
    if (!drifted.ok) {
      assert.equal(drifted.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.match(drifted.error.message, /version/u);
    }
  } finally {
    fixture.cleanup();
  }
});

test("#292 FHS input fails closed with the precise missing immutable binding", () => {
  const result = materializePnpmMiddlewareFhsRuntime({
    executables: [{ requirement_id: PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.id, path: "/usr/bin/pnpm" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
    assert.equal(result.error.details?.missing_primitive, "immutable package source/version/provenance binding");
    assert.equal(result.error.details?.authority, "nawabari.fhs-runtime-materialization.v1");
  }
});

function runGit(arguments_: readonly string[], cwd: string): void {
  execFileSync("git", [...arguments_], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

type ProtectedRequestFixture = Readonly<{
  readonly backend: LocalSessionBackend;
  readonly worktree: string;
  readonly session_id: string;
  readonly request: SandboxExecutionRequest;
  readonly cleanup: () => void;
}>;

async function protectedRequest(
  projection: SandboxExecutionRequest["runtime_projection"],
  runtimeLayout: ReturnType<typeof discoverSandboxRuntimeLayout>,
): Promise<ProtectedRequestFixture> {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-backend-runtime-"));
  const worktree = `${repository}-worktree`;
  try {
    runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
    runGit(["config", "user.name", "Nawabari pnpm conformance"], repository);
    runGit(["config", "user.email", "pnpm-conformance@nawabari.invalid"], repository);
    fs.writeFileSync(path.join(repository, "README.md"), "pnpm backend conformance\n");
    runGit(["add", "README.md"], repository);
    runGit(["commit", "--quiet", "-m", "fixture"], repository);

    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/pnpm-backend-conformance", worktree, label: null, base: null },
    );
    if (!created.ok) throw created.error;
    const resolved = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      { session_id: created.value.session_id, enforce: true, runtime_projection: projection },
      defaultSandboxProbe,
      runtimeLayout,
    );
    if (!resolved.ok) throw resolved.error;
    return {
      backend,
      worktree,
      session_id: created.value.session_id,
      request: resolved.value,
      cleanup: () => {
        try {
          runGit(["worktree", "remove", "--force", worktree], repository);
        } catch {
          // The bounded filesystem cleanup below remains authoritative.
        }
        fs.rmSync(worktree, { recursive: true, force: true });
        fs.rmSync(repository, { recursive: true, force: true });
      },
    };
  } catch (error) {
    fs.rmSync(worktree, { recursive: true, force: true });
    fs.rmSync(repository, { recursive: true, force: true });
    throw error;
  }
}

function renderLauncher(rtkPath: string, realPnpmPath: string): string {
  return `#!${PNPM_MIDDLEWARE_LAUNCHER_NODE_TARGET}
import { spawn } from "node:child_process";
import process from "node:process";

const child = spawn(${JSON.stringify(rtkPath)}, ["proxy", ${JSON.stringify(realPnpmPath)}, ...process.argv.slice(2)], {
  cwd: process.cwd(),
  env: process.env,
  shell: false,
  stdio: "inherit",
});
child.once("error", (error) => {
  process.stderr.write("pnpm middleware could not start RTK: " + error.message + "\\n");
});
child.once("close", (code, signal) => {
  if (signal !== null) process.kill(process.pid, signal);
  else process.exitCode = code ?? 127;
});
`;
}

function addLauncherAndNode(
  materialized: PnpmMiddlewareBackendMaterialization,
  launcherSource: string,
): ReturnType<typeof projectSessionRuntimeProjection> {
  const nodeRoots = materialized.real_pnpm_closure.store_paths.filter((candidate) =>
    path.posix.basename(candidate).endsWith("-nodejs-slim-24.18.0"),
  );
  assert.deepEqual(nodeRoots.length, 1, "the exact pnpm closure must contain one Node 24.18.0 output");
  const nodeRoot = nodeRoots[0] as string;
  const nodeSource = path.posix.join(nodeRoot, "bin/node");
  const nodeRequirement = { id: "node-runtime", kind: "runtime" as const, name: "node", version: ">=24" };
  return projectSessionRuntimeProjection({
    policy: STRICT_RUNTIME_POLICY,
    profile: materialized.projection.profile,
    requirements: [...materialized.projection.requirements, nodeRequirement],
    filesystem: [
      ...materialized.projection.filesystem,
      {
        source: launcherSource,
        target: PNPM_MIDDLEWARE_LAUNCHER_TARGET,
        access_mode: "read-only" as const,
        provenance: "package" as const,
      },
    ],
    executables: [
      {
        name: "node",
        target: nodeSource,
        provider: { id: "node-runtime-provider", requirement_id: nodeRequirement.id },
        provenance: "runtime-profile" as const,
      },
      {
        name: "pnpm",
        target: PNPM_MIDDLEWARE_LAUNCHER_TARGET,
        provider: {
          id: PNPM_MIDDLEWARE_PROVIDER_IDS.launcher,
          requirement_id: PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.id,
        },
        provenance: "package" as const,
      },
    ],
  });
}

test("executes exact RTK -> real pnpm through the strict protected runtime", async (t) => {
  if (process.env.NAWABARI_PNPM_MIDDLEWARE_RUNTIME_CONFORMANCE !== "1") {
    t.skip("set NAWABARI_PNPM_MIDDLEWARE_RUNTIME_CONFORMANCE=1 in the Nix materialization conformance environment");
    return;
  }
  if (process.platform !== "linux") {
    t.skip("protected execution is Linux-only");
    return;
  }
  const doctor = sandboxDoctorReport(defaultSandboxProbe);
  const runtimeLayout = discoverSandboxRuntimeLayout();
  if (!doctor.ready || runtimeLayout.bubblewrap === null) {
    t.skip(`protected execution unavailable: ${doctor.missing_required.join(", ") || "bubblewrap"}`);
    return;
  }

  const materialized = materializePnpmMiddlewareBackends(profile());
  assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));
  if (!materialized.ok) return;

  const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-pnpm-launcher-"));
  const launcherSource = path.join(launcherRoot, "pnpm-launcher");
  fs.writeFileSync(launcherSource, renderLauncher(materialized.value.rtk.path, materialized.value.real_pnpm.path), {
    mode: 0o755,
  });
  fs.chmodSync(launcherSource, 0o755);
  let fixture: ProtectedRequestFixture | null = null;
  try {
    const projected = addLauncherAndNode(materialized.value, launcherSource);
    assert.equal(projected.ok, true, projected.ok ? "" : JSON.stringify(projected.error));
    if (!projected.ok) return;
    fixture = await protectedRequest(projected.value, runtimeLayout);
    const evidence = checkedInEvidence();

    assert.equal(
      createHash("sha256").update(fs.readFileSync(materialized.value.rtk.source)).digest("hex"),
      RTK_BACKEND_EVIDENCE.executable_sha256,
    );
    assert.equal(
      createHash("sha256").update(fs.readFileSync(materialized.value.real_pnpm.source)).digest("hex"),
      PNPM_BACKEND_EVIDENCE.executable_sha256,
    );
    const pnpmBundleSource = path.posix.join(
      materialized.value.real_pnpm_closure.packages.find(
        (candidate) => candidate.requirement_id === PNPM_MIDDLEWARE_REQUIREMENTS.real_pnpm.id,
      )?.root ?? "",
      PNPM_BUNDLE_RELATIVE_PATH,
    );
    assert.equal(
      createHash("sha256").update(fs.readFileSync(pnpmBundleSource)).digest("hex"),
      PNPM_BACKEND_EVIDENCE.bundle_sha256,
    );

    const invocation = compileSandboxInvocation(fixture.request, {
      command: PROJECTED_PNPM_TARGET,
      args: ["--version"],
    });
    assert.equal(invocation.ok, true, invocation.ok ? "" : JSON.stringify(invocation.error));
    if (!invocation.ok) return;
    assert.equal(invocation.value.env.PATH, "/nawabari/bin");
    const terminator = invocation.value.args.indexOf("--");
    assert.ok(terminator > 0);
    const mountArgs = invocation.value.args.slice(0, terminator);
    assert.equal(
      mountArgs.some((value, index) => value === "--ro-bind" && mountArgs[index + 1] === "/nix/store"),
      false,
    );
    assert.equal(
      mountArgs.some(
        (value, index) =>
          value === "--ro-bind" &&
          mountArgs[index + 1] === materialized.value.rtk.source &&
          mountArgs[index + 2] === PNPM_MIDDLEWARE_RTK_TARGET,
      ),
      true,
    );
    assert.equal(
      mountArgs.some(
        (value, index) =>
          value === "--ro-bind" &&
          mountArgs[index + 1] === materialized.value.real_pnpm.source &&
          mountArgs[index + 2] === PNPM_MIDDLEWARE_REAL_PNPM_TARGET,
      ),
      true,
    );

    const rtkVersion = await runSandboxedCommand(fixture.request, {
      command: materialized.value.rtk.path,
      args: ["--version"],
    });
    assert.equal(rtkVersion.ok, true, rtkVersion.ok ? "" : JSON.stringify(rtkVersion.error));
    if (!rtkVersion.ok) return;
    assert.equal(rtkVersion.value.exit_code, 0, JSON.stringify(rtkVersion.value));
    assert.equal(rtkVersion.value.stdout, RTK_BACKEND_EVIDENCE.version);
    assert.equal(rtkVersion.value.stdout, evidence.rtk_version);
    assert.equal(Buffer.byteLength(rtkVersion.value.stdout), RTK_BACKEND_EVIDENCE.version_bytes);

    const rtkProxyHelp = await runSandboxedCommand(fixture.request, {
      command: materialized.value.rtk.path,
      args: ["proxy", "--help"],
    });
    assert.equal(rtkProxyHelp.ok, true, rtkProxyHelp.ok ? "" : JSON.stringify(rtkProxyHelp.error));
    if (!rtkProxyHelp.ok) return;
    assert.equal(rtkProxyHelp.value.exit_code, 0, JSON.stringify(rtkProxyHelp.value));
    assert.equal(Buffer.byteLength(rtkProxyHelp.value.stdout), RTK_BACKEND_EVIDENCE.proxy_help_bytes);
    assert.equal(rtkProxyHelp.value.stdout, evidence.rtk_proxy_help);
    assert.equal(
      createHash("sha256").update(rtkProxyHelp.value.stdout).digest("hex"),
      RTK_BACKEND_EVIDENCE.proxy_help_sha256,
    );

    const throughPnpm = await runSandboxedCommand(fixture.request, {
      command: PROJECTED_PNPM_TARGET,
      args: ["--version"],
    });
    assert.equal(throughPnpm.ok, true, throughPnpm.ok ? "" : JSON.stringify(throughPnpm.error));
    if (!throughPnpm.ok) return;
    assert.equal(throughPnpm.value.exit_code, 0, JSON.stringify(throughPnpm.value));
    assert.equal(throughPnpm.value.stdout, PNPM_BACKEND_EVIDENCE.version);
    assert.equal(throughPnpm.value.stdout, evidence.pnpm_version);
    assert.equal(Buffer.byteLength(throughPnpm.value.stdout), PNPM_BACKEND_EVIDENCE.version_bytes);
    assert.equal(
      createHash("sha256").update(throughPnpm.value.stdout).digest("hex"),
      PNPM_BACKEND_EVIDENCE.version_sha256,
    );

    const pnpmHelp = await runSandboxedCommand(fixture.request, {
      command: PROJECTED_PNPM_TARGET,
      args: ["--help"],
    });
    assert.equal(pnpmHelp.ok, true, pnpmHelp.ok ? "" : JSON.stringify(pnpmHelp.error));
    if (!pnpmHelp.ok) return;
    assert.equal(pnpmHelp.value.exit_code, 0, JSON.stringify(pnpmHelp.value));
    assert.equal(pnpmHelp.value.stdout, evidence.pnpm_help);
    assert.equal(Buffer.byteLength(pnpmHelp.value.stdout), PNPM_BACKEND_EVIDENCE.help_bytes);
    assert.equal(createHash("sha256").update(pnpmHelp.value.stdout).digest("hex"), PNPM_BACKEND_EVIDENCE.help_sha256);
  } finally {
    fixture?.cleanup();
    fs.rmSync(launcherRoot, { recursive: true, force: true });
  }
});
