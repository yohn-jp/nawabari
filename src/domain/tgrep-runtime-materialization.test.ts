import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

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
  sandboxSeccompProfileMetadata,
  sandboxDoctorReport,
  type SandboxExecutionRequest,
} from "./sandbox.js";
import { projectSessionRuntimeProjection, STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import {
  materializeTgrepFhsRuntime,
  materializeTgrepRuntime,
  TGREP_BACKEND_EVIDENCE,
  TGREP_BACKEND_PROVIDER,
  TGREP_BACKEND_REQUIREMENT,
  TGREP_BACKEND_REQUIREMENT_OPERATION,
  TGREP_NIX_INSTALLABLE,
  TGREP_NIXPKGS_REF,
  type TgrepRuntimeMaterialization,
} from "./tgrep-runtime-materialization.js";
import type { NixCommandRunner } from "./nix-runtime-closure.js";

const CONTROLLED_SANDBOX_EXECUTABLE_SOURCE = fileURLToPath(
  new URL("../../scripts/test-fixtures/sandbox-launcher-test-stub.sh", import.meta.url),
);

type Fixture = Readonly<{
  readonly store: string;
  readonly roots: Readonly<{ readonly node: string; readonly tgrep: string }>;
  readonly closures: Readonly<{ readonly node: readonly string[]; readonly tgrep: readonly string[] }>;
  readonly cleanup: () => void;
}>;

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join("/var/tmp", "nawabari-tgrep-materialization-"));
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  const roots = {
    node: path.join(store, "aaa-nodejs-24"),
    tgrep: path.join(store, "bbb-tgrep-1.0.4"),
  };
  const dependencies = {
    node: path.join(store, "ccc-node-runtime-dependency"),
    tgrep: path.join(store, "ddd-tgrep-runtime-dependency"),
  };
  fs.mkdirSync(path.join(roots.node, "bin"), { recursive: true });
  fs.writeFileSync(path.join(roots.node, "bin", "node"), "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(path.join(roots.tgrep, "bin"), { recursive: true });
  fs.writeFileSync(path.join(roots.tgrep, "bin", "tgrep"), "#!/bin/sh\nprintf 'tgrep 1.0.4\\n'\n", { mode: 0o755 });
  for (const dependency of Object.values(dependencies)) fs.mkdirSync(dependency);
  return {
    store,
    roots,
    closures: { node: [roots.node, dependencies.node], tgrep: [roots.tgrep, dependencies.tgrep] },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function profile() {
  const result = resolveRuntimeProfile({ profiles: ["base"], operations: [TGREP_BACKEND_REQUIREMENT_OPERATION] });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("the tgrep profile could not be resolved");
  return result.value;
}

function tgrepOnlyProfile() {
  const result = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [{ operation: "remove", requirement_id: "node-runtime" }, TGREP_BACKEND_REQUIREMENT_OPERATION],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("the tgrep-only profile could not be resolved");
  return result.value;
}

function runnerFor(fixture: Fixture, reverse = false, failTgrep = false): NixCommandRunner {
  const rootsByInstallable: Readonly<Record<string, string>> = {
    [`${TGREP_NIXPKGS_REF}#nodejs`]: "node",
    [TGREP_NIX_INSTALLABLE]: "tgrep",
  };
  return (_executable, args) => {
    const installable = args[args.length - 1];
    if (typeof installable !== "string" || rootsByInstallable[installable] === undefined) {
      return { exit_code: 1, stdout: "", stderr: "unknown installable" };
    }
    if (failTgrep && installable === TGREP_NIX_INSTALLABLE) {
      return { exit_code: 1, stdout: "", stderr: "tgrep is not materialized" };
    }
    const key = rootsByInstallable[installable] as "node" | "tgrep";
    const root = fixture.roots[key];
    const paths = reverse ? [...fixture.closures[key]].reverse() : fixture.closures[key];
    const selectedPaths = args.includes("--recursive") ? paths : [root];
    return {
      exit_code: 0,
      stdout: JSON.stringify(Object.fromEntries(selectedPaths.map((storePath) => [storePath, null]))),
      stderr: "",
    };
  };
}

function projectionWithRg(materialization: TgrepRuntimeMaterialization) {
  const result = projectSessionRuntimeProjection({
    ...materialization.projection,
    executables: [
      {
        name: "rg",
        target: materialization.executable_target,
        provider: materialization.provider,
        provenance: "package",
      },
    ],
  });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("the projected rg declaration is invalid");
  return result.value;
}

function sandboxRequest(runtimeProjection: SandboxExecutionRequest["runtime_projection"]): SandboxExecutionRequest {
  const repository = fs.mkdtempSync(path.join("/var/tmp", "nawabari-tgrep-sandbox-"));
  const worktree = path.join(repository, "worktree");
  const sandboxHome = path.join(repository, "sandbox-home");
  const sandboxBin = path.join(sandboxHome, ".local", "bin");
  fs.mkdirSync(sandboxBin, { recursive: true, mode: 0o700 });
  const sandboxExecutableSource = path.join(sandboxBin, "bwrap");
  fs.copyFileSync(CONTROLLED_SANDBOX_EXECUTABLE_SOURCE, sandboxExecutableSource);
  fs.chmodSync(sandboxExecutableSource, 0o700);
  const runtimeLayout = discoverSandboxRuntimeLayout({
    ...process.env,
    HOME: sandboxHome,
    PATH: sandboxBin,
  });
  assert.equal(runtimeLayout.bubblewrap, sandboxExecutableSource);
  const filesystem = {
    owned_worktree: worktree,
    home: path.join(repository, "home"),
    cache: path.join(repository, "cache"),
    persistent_home: path.join(repository, "persistent"),
    git_metadata: path.join(repository, "git-metadata"),
    git_objects: path.join(repository, "git-objects"),
    user_tool_paths: [],
    user_tool_home: sandboxHome,
    runtime_paths: [],
    system_paths: [],
  };
  fs.mkdirSync(worktree);
  for (const directory of [filesystem.home, filesystem.cache, filesystem.persistent_home, filesystem.git_metadata]) {
    fs.mkdirSync(directory);
  }
  fs.mkdirSync(filesystem.git_objects);
  return {
    schema_version: SANDBOX_CONTRACT_SCHEMA_VERSION,
    contract_id: SANDBOX_CONTRACT_ID,
    enforce: true,
    session_id: "tgrep-materialization-test",
    repository,
    worktree,
    branch: "feature/tgrep-materialization-test",
    network_mode: "inherited",
    sandbox_executable: runtimeLayout.bubblewrap,
    identity: { real_uid: 1_000, real_gid: 1_000, namespace_uid: 0, namespace_gid: 0 },
    filesystem,
    required_capabilities: [],
    seccomp_profile: sandboxSeccompProfileMetadata(),
    capability_baseline: sandboxCapabilityBaseline,
    landlock_abi: null,
    landlock_required: false,
    landlock_executable: null,
    runtime_projection: runtimeProjection,
  };
}

function removeSandboxRequest(request: SandboxExecutionRequest): void {
  fs.rmSync(request.repository, { recursive: true, force: true });
}

function evidenceBlock(markdown: string, heading: string): string {
  const fence = "```";
  const prefix = `## ${heading}\n\n${fence}text\n`;
  const start = markdown.indexOf(prefix);
  assert.notEqual(start, -1, `missing ${heading} evidence block`);
  const contentStart = start + prefix.length;
  const end = markdown.indexOf(`\n${fence}`, contentStart);
  assert.notEqual(end, -1, `unterminated ${heading} evidence block`);
  return `${markdown.slice(contentStart, end)}\n`;
}

function readEvidenceDocument(): { readonly version: string; readonly help: string } {
  const document = fs.readFileSync(
    new URL("../../docs/architecture/tgrep-runtime-materialization.md", import.meta.url),
    "utf8",
  );
  return {
    version: evidenceBlock(document, "Exact `--version` evidence"),
    help: evidenceBlock(document, "Exact `--help` evidence"),
  };
}

function runGit(arguments_: readonly string[], cwd: string): void {
  execFileSync("git", [...arguments_], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

type ProtectedRequestFixture = Readonly<{
  readonly backend: LocalSessionBackend;
  readonly repository: string;
  readonly worktree: string;
  readonly session_id: string;
  readonly request: SandboxExecutionRequest;
  readonly cleanup: () => void;
}>;

async function protectedRequest(
  runtimeProjection: SandboxExecutionRequest["runtime_projection"],
  runtimeLayout: ReturnType<typeof discoverSandboxRuntimeLayout>,
): Promise<ProtectedRequestFixture> {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-tgrep-nix-runtime-"));
  const worktree = `${repository}-worktree`;
  try {
    runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
    runGit(["config", "user.name", "Nawabari tgrep Conformance"], repository);
    runGit(["config", "user.email", "tgrep-conformance@nawabari.invalid"], repository);
    fs.writeFileSync(path.join(repository, "README.md"), "tgrep conformance\n");
    runGit(["add", "README.md"], repository);
    runGit(["commit", "--quiet", "-m", "fixture"], repository);

    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/tgrep-runtime-conformance", worktree, label: null, base: null },
    );
    if (!created.ok) throw created.error;
    const resolved = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      { session_id: created.value.session_id, enforce: true, runtime_projection: runtimeProjection },
      defaultSandboxProbe,
      runtimeLayout,
    );
    if (!resolved.ok) throw resolved.error;
    return {
      backend,
      repository,
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

test("materializes only the explicitly selected pinned tgrep package", () => {
  const fixture = makeFixture();
  try {
    const result = materializeTgrepRuntime(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture),
      nix_executable: "/nix/store/pinned-nix/bin/nix",
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;

    assert.equal(result.value.nix_installable, TGREP_NIX_INSTALLABLE);
    assert.equal(result.value.executable_source, path.join(fixture.roots.tgrep, "bin", "tgrep"));
    assert.deepEqual(result.value.provider_materialization, {
      provider: TGREP_BACKEND_PROVIDER,
      source: result.value.executable_source,
    });
    assert.equal(result.value.projection.executables.length, 0);
    assert.equal(result.value.projection.policy, STRICT_RUNTIME_POLICY);
    assert.equal(
      result.value.projection.filesystem.some((entry) => entry.source === fixture.store),
      false,
    );
    assert.equal(
      execFileSync(result.value.executable_source, ["--version"], {
        cwd: fixture.store,
        env: { PATH: "/host/path/must/not/matter" },
        encoding: "utf8",
      }),
      TGREP_BACKEND_EVIDENCE.version,
    );
  } finally {
    fixture.cleanup();
  }
});

test("pins package selection independently of PATH and rejects overrides or missing material", () => {
  const fixture = makeFixture();
  try {
    const calls: string[] = [];
    const runner: NixCommandRunner = (executable, args) => {
      calls.push(`${executable}\u0000${args.join("\u0000")}`);
      return runnerFor(fixture)(executable, args);
    };
    const result = materializeTgrepRuntime(profile(), {
      store_root: fixture.store,
      command_runner: runner,
      nix_executable: "/nix/store/pinned-nix/bin/nix",
    });
    assert.equal(result.ok, true, result.ok ? "" : result.error.message);
    assert.equal(
      calls.some((call) => call.includes("tgrep")),
      true,
    );
    assert.equal(
      calls.some((call) => call.includes("/host/path")),
      false,
    );

    const overridden = materializeTgrepRuntime(profile(), {
      store_root: fixture.store,
      command_runner: runner,
      package_attributes: { tgrep: "host-tgrep" },
    } as unknown as Parameters<typeof materializeTgrepRuntime>[1]);
    assert.equal(overridden.ok, false);
    if (!overridden.ok) assert.equal(overridden.error.code, "RUNTIME_MATERIALIZATION_MISSING");

    const missing = materializeTgrepRuntime(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture, false, true),
      nix_executable: "/nix/store/pinned-nix/bin/nix",
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.equal(missing.error.details?.requirement_id, TGREP_BACKEND_REQUIREMENT.id);
    }
  } finally {
    fixture.cleanup();
  }
});

test("closure ordering does not change the exact provider source", () => {
  const fixture = makeFixture();
  try {
    const first = materializeTgrepRuntime(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture),
      nix_executable: "/nix/store/pinned-nix/bin/nix",
    });
    const second = materializeTgrepRuntime(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture, true),
      nix_executable: "/nix/store/pinned-nix/bin/nix",
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.value, second.value);
  } finally {
    fixture.cleanup();
  }
});

test("#293 consumes the exact source as an rg provider without a tgrep public alias", () => {
  const fixture = makeFixture();
  let request: SandboxExecutionRequest | null = null;
  try {
    const materialized = materializeTgrepRuntime(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture),
      nix_executable: "/nix/store/pinned-nix/bin/nix",
    });
    assert.equal(materialized.ok, true, materialized.ok ? "" : materialized.error.message);
    if (!materialized.ok) return;

    const tgrepOnly = compileRuntimeExecutableProjection(materialized.value.projection);
    assert.equal(tgrepOnly.ok, true);
    if (!tgrepOnly.ok) return;
    assert.deepEqual(tgrepOnly.value, []);

    const projected = projectionWithRg(materialized.value);
    const compiledProvider = compileRuntimeExecutableProjection(
      projected,
      new Map([
        [runtimeExecutableProviderKey(materialized.value.provider), materialized.value.provider_materialization],
      ]),
    );
    assert.equal(compiledProvider.ok, true, compiledProvider.ok ? "" : compiledProvider.error.message);
    if (!compiledProvider.ok) return;
    assert.deepEqual(
      compiledProvider.value.map((entry) => [entry.source, entry.target]),
      [[materialized.value.executable_source, "/nawabari/bin/rg"]],
    );
    assert.equal(
      compiledProvider.value.some((entry) => entry.target === "/nawabari/bin/tgrep"),
      false,
    );

    request = sandboxRequest(projected);
    const invocation = compileSandboxInvocation(request, {
      command: materialized.value.executable_target,
      args: ["--version"],
    });
    assert.equal(invocation.ok, true, invocation.ok ? "" : invocation.error.message);
    if (!invocation.ok) return;
    assert.equal(invocation.value.env.PATH, "/nawabari/bin");
    const terminator = invocation.value.args.indexOf("--");
    assert.ok(terminator > 0);
    const mountArgs = invocation.value.args.slice(0, terminator);
    assert.equal(
      mountArgs.some((value, index) => value === "--ro-bind" && mountArgs[index + 1] === fixture.store),
      false,
    );
    assert.equal(
      mountArgs.some(
        (value, index) =>
          value === "--ro-bind" &&
          mountArgs[index + 1] === materialized.value.executable_source &&
          mountArgs[index + 2] === "/nawabari/bin/rg",
      ),
      true,
    );
    assert.equal(invocation.value.args.slice(terminator + 1).includes(materialized.value.executable_target), true);
  } finally {
    if (request !== null) removeSandboxRequest(request);
    fixture.cleanup();
  }
});

test("pinned Nix tgrep materializes through the canonical protected runtime", async (t) => {
  if (process.env.NAWABARI_TGREP_RUNTIME_CONFORMANCE !== "1") {
    t.skip("set NAWABARI_TGREP_RUNTIME_CONFORMANCE=1 in the Nix materialization conformance environment");
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

  // This profile intentionally contains only the backend requirement so the
  // conformance job can prove tgrep's own Nix closure without building an
  // unrelated development runtime. #295's caller may compose it with base.
  const materialized = materializeTgrepRuntime(tgrepOnlyProfile());
  assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));
  if (!materialized.ok) return;

  const tgrepPackage = materialized.value.closure.packages.find(
    (candidate) => candidate.requirement_id === TGREP_BACKEND_REQUIREMENT.id,
  );
  assert.ok(tgrepPackage, "the pinned tgrep package must be present in the #291 closure");
  assert.equal(tgrepPackage?.installable, TGREP_NIX_INSTALLABLE);
  assert.equal(materialized.value.executable_source, path.join(tgrepPackage?.root ?? "", "bin", "tgrep"));
  assert.ok(tgrepPackage?.closure.includes(tgrepPackage.root));
  assert.ok(
    tgrepPackage?.closure.every((storePath) =>
      materialized.value.projection.filesystem.some(
        (entry) => entry.source === storePath && entry.target === storePath,
      ),
    ),
  );
  assert.equal(
    materialized.value.projection.filesystem.some((entry) => entry.source === "/nix/store"),
    false,
  );

  const checkedInEvidence = readEvidenceDocument();
  const fixture = await protectedRequest(materialized.value.projection, runtimeLayout);
  try {
    const invocation = compileSandboxInvocation(fixture.request, {
      command: materialized.value.executable_source,
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
          mountArgs[index + 1] === tgrepPackage?.root &&
          mountArgs[index + 2] === tgrepPackage?.root,
      ),
      true,
    );

    const version = await runSandboxedCommand(fixture.request, {
      command: materialized.value.executable_source,
      args: ["--version"],
    });
    assert.equal(version.ok, true, version.ok ? "" : JSON.stringify(version.error));
    if (!version.ok) return;
    assert.equal(version.value.exit_code, 0, JSON.stringify(version.value));
    assert.equal(version.value.stdout, checkedInEvidence.version);
    assert.equal(version.value.stdout, TGREP_BACKEND_EVIDENCE.version);

    const help = await runSandboxedCommand(fixture.request, {
      command: materialized.value.executable_source,
      args: ["--help"],
    });
    assert.equal(help.ok, true, help.ok ? "" : JSON.stringify(help.error));
    if (!help.ok) return;
    assert.equal(help.value.exit_code, 0, JSON.stringify(help.value));
    assert.equal(help.value.stdout, checkedInEvidence.help);
    assert.equal(Buffer.byteLength(help.value.stdout, "utf8"), TGREP_BACKEND_EVIDENCE.help_bytes);
    assert.equal(
      createHash("sha256").update(help.value.stdout, "utf8").digest("hex"),
      TGREP_BACKEND_EVIDENCE.help_sha256,
    );

    const projected = projectionWithRg(materialized.value);
    const providerRequest = await resolveSandboxExecutionRequest(
      fixture.backend,
      { cwd: fixture.worktree },
      {
        session_id: fixture.session_id,
        enforce: true,
        runtime_projection: projected,
      },
      defaultSandboxProbe,
      runtimeLayout,
    );
    assert.equal(providerRequest.ok, true, providerRequest.ok ? "" : JSON.stringify(providerRequest.error));
    if (!providerRequest.ok) return;
    const providerVersion = await runSandboxedCommand(providerRequest.value, {
      command: "/nawabari/bin/rg",
      args: ["--version"],
    });
    assert.equal(providerVersion.ok, true, providerVersion.ok ? "" : JSON.stringify(providerVersion.error));
    if (!providerVersion.ok) return;
    assert.equal(providerVersion.value.exit_code, 0, JSON.stringify(providerVersion.value));
    assert.equal(providerVersion.value.stdout, version.value.stdout);
  } finally {
    fixture.cleanup();
  }
});

test("FHS tgrep materialization fails closed because #292 has no deterministic pinned artifact input", () => {
  const result = materializeTgrepFhsRuntime({
    profile: profile(),
    executables: [{ requirement_id: TGREP_BACKEND_REQUIREMENT.id, path: "/usr/bin/tgrep" }],
  });
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
    assert.equal(result.error.details?.requirement_id, TGREP_BACKEND_REQUIREMENT.id);
    assert.match(result.error.message, /unsupported/u);
  }
});
