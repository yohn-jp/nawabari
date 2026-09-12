import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { compileRuntimeExecutableProjection } from "./runtime-executable-projection.js";
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
import {
  materializeTgrepRuntime,
  TGREP_BACKEND_EVIDENCE,
  TGREP_BACKEND_PROVIDER,
  TGREP_BACKEND_REQUIREMENT_OPERATION,
  TGREP_NIX_INSTALLABLE,
  TGREP_NIXPKGS_REF,
  type TgrepRuntimeMaterialization,
} from "./tgrep-runtime-materialization.js";
import {
  materializeTgrepRgProvider,
  TGREP_RG_ADAPTER_TARGET,
  TGREP_RG_COMPATIBILITY_MATRIX,
  TGREP_RG_ENTRYPOINT_NAME,
  TGREP_RG_PROVIDER,
  translateTgrepRgArguments,
} from "./runtime-provider-tgrep.js";
import { withRuntimeFileIdentityTestHooks } from "./runtime-file-identity.js";
import type { NixCommandRunner } from "./nix-runtime-closure.js";

type Fixture = Readonly<{
  readonly root: string;
  readonly materialization: TgrepRuntimeMaterialization;
  readonly cleanup: () => void;
}>;

function makeMaterializationFixture(): Fixture {
  const root = fs.mkdtempSync(path.join("/var/tmp", "nawabari-tgrep-provider-"));
  const store = path.join(root, "store");
  const nodeRoot = path.join(store, "aaa-nodejs-24");
  const tgrepRoot = path.join(store, "bbb-tgrep-1.0.4");
  const nodeDependency = path.join(store, "ccc-node-runtime-dependency");
  const tgrepDependency = path.join(store, "ddd-tgrep-runtime-dependency");
  const node = path.join(nodeRoot, "bin", "node");
  const backend = path.join(tgrepRoot, "bin", "tgrep");
  fs.mkdirSync(path.dirname(node), { recursive: true });
  fs.mkdirSync(path.dirname(backend), { recursive: true });
  fs.copyFileSync(process.execPath, node);
  fs.chmodSync(node, 0o755);
  fs.writeFileSync(
    backend,
    `#!${process.execPath}\n` +
      "const args = process.argv.slice(2);\n" +
      "process.stdout.write(JSON.stringify(args) + '\\n');\n" +
      "if (args.includes('no-match')) process.exitCode = 1;\n" +
      "if (args.includes('signal')) process.kill(process.pid, 'SIGTERM');\n" +
      "if (args.includes('backend-error')) { process.stderr.write('backend failure\\n'); process.exitCode = 23; }\n",
    { mode: 0o755 },
  );
  fs.mkdirSync(nodeDependency);
  fs.mkdirSync(tgrepDependency);

  const profileResult = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [TGREP_BACKEND_REQUIREMENT_OPERATION],
  });
  if (!profileResult.ok) throw profileResult.error;
  const roots: Readonly<Record<string, string>> = {
    [`${TGREP_NIXPKGS_REF}#nodejs`]: nodeRoot,
    [TGREP_NIX_INSTALLABLE]: tgrepRoot,
  };
  const runner: NixCommandRunner = (_executable, args) => {
    const installable = args[args.length - 1];
    const selectedRoot = typeof installable === "string" ? roots[installable] : undefined;
    if (selectedRoot === undefined) return { exit_code: 1, stdout: "", stderr: "unknown installable" };
    const dependency = selectedRoot === nodeRoot ? nodeDependency : tgrepDependency;
    const paths = args.includes("--recursive") ? [selectedRoot, dependency] : [selectedRoot];
    return {
      exit_code: 0,
      stdout: JSON.stringify(Object.fromEntries(paths.map((value) => [value, null]))),
      stderr: "",
    };
  };
  const materialized = materializeTgrepRuntime(profileResult.value, {
    store_root: store,
    command_runner: runner,
    nix_executable: "/nix/store/pinned-nix/bin/nix",
  });
  if (!materialized.ok) throw materialized.error;
  return {
    root,
    materialization: materialized.value,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function sandboxRequest(projection: TgrepRuntimeMaterialization["projection"]): SandboxExecutionRequest {
  const root = fs.mkdtempSync(path.join("/var/tmp", "nawabari-tgrep-provider-sandbox-"));
  const repository = path.join(root, "repository");
  const worktree = path.join(repository, "worktree");
  const home = path.join(repository, "home");
  const cache = path.join(repository, "cache");
  const persistentHome = path.join(repository, "persistent");
  const gitMetadata = path.join(repository, "git-metadata");
  const gitObjects = path.join(repository, "git-objects");
  const userHome = path.join(root, "user-home");
  const userBin = path.join(userHome, ".local", "bin");
  const bwrap = path.join(userBin, "bwrap");
  fs.mkdirSync(worktree, { recursive: true });
  for (const directory of [home, cache, persistentHome, gitMetadata, gitObjects, userBin])
    fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(bwrap, `#!${process.execPath}\n`, { mode: 0o755 });
  return {
    schema_version: SANDBOX_CONTRACT_SCHEMA_VERSION,
    contract_id: SANDBOX_CONTRACT_ID,
    enforce: true,
    session_id: "tgrep-provider-test",
    repository,
    worktree,
    branch: "feature/tgrep-provider-test",
    network_mode: "inherited",
    sandbox_executable: bwrap,
    identity: { real_uid: 1_000, real_gid: 1_000, namespace_uid: 0, namespace_gid: 0 },
    git_identity: { host_global_name: null, host_global_email: null },
    filesystem: {
      owned_worktree: worktree,
      home,
      cache,
      persistent_home: persistentHome,
      git_metadata: gitMetadata,
      git_objects: gitObjects,
      user_tool_paths: [userBin],
      user_tool_home: userHome,
      runtime_paths: [],
      system_paths: [],
    },
    required_capabilities: [],
    seccomp_profile: sandboxSeccompProfileMetadata(),
    capability_baseline: sandboxCapabilityBaseline,
    landlock_abi: null,
    landlock_required: false,
    landlock_executable: null,
    runtime_projection: projection,
  };
}

function providerProjection(materialization: TgrepRuntimeMaterialization, artifactRoot: string) {
  const result = materializeTgrepRgProvider(materialization, { artifact_root: artifactRoot });
  if (!result.ok) throw result.error;
  return result.value;
}

function runGit(arguments_: readonly string[], cwd: string): void {
  execFileSync("git", [...arguments_], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

type ProtectedRequestFixture = Readonly<{
  readonly repository: string;
  readonly worktree: string;
  readonly request: SandboxExecutionRequest;
  readonly cleanup: () => void;
}>;

/**
 * A real repository fixture with a tracked file, an ignored file, and a
 * hidden file, so the supported matrix's ignore/hidden semantics can be
 * proven against the real backend rather than asserted from documentation.
 */
async function protectedRgRequest(
  runtimeProjection: SandboxExecutionRequest["runtime_projection"],
  runtimeLayout: ReturnType<typeof discoverSandboxRuntimeLayout>,
): Promise<ProtectedRequestFixture> {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-tgrep-rg-conformance-"));
  const worktree = `${repository}-worktree`;
  try {
    runGit(["init", "--quiet", "--initial-branch", "main", repository], repository);
    runGit(["config", "user.name", "Nawabari tgrep rg Conformance"], repository);
    runGit(["config", "user.email", "tgrep-rg-conformance@nawabari.invalid"], repository);
    fs.writeFileSync(path.join(repository, ".gitignore"), "ignored.txt\n");
    fs.writeFileSync(path.join(repository, "tracked.txt"), "Needle here\nno match line\n");
    fs.writeFileSync(path.join(repository, "ignored.txt"), "needle in ignored\n");
    fs.mkdirSync(path.join(repository, ".hidden"));
    fs.writeFileSync(path.join(repository, ".hidden", "secret.txt"), "needle in hidden\n");
    fs.mkdirSync(path.join(repository, "sub"));
    fs.writeFileSync(path.join(repository, "sub", "b.log"), "another needle\nNEEDLE\n");
    fs.writeFileSync(path.join(repository, "words.txt"), "sub-needle-word\nneedleword\nanother needle line\n");
    fs.writeFileSync(path.join(repository, "literal.txt"), "a.b\naxb\n");
    fs.writeFileSync(path.join(repository, "smartcase.txt"), "Needle here\nneedle lower\nNEEDLE UPPER\n");
    fs.mkdirSync(path.join(repository, "globcase"));
    fs.writeFileSync(path.join(repository, "globcase", "FILE.TXT"), "needle in upper ext\n");
    fs.writeFileSync(path.join(repository, "globcase", "file2.txt"), "needle in lower ext\n");
    runGit(
      ["add", "tracked.txt", ".gitignore", "sub/b.log", "words.txt", "literal.txt", "smartcase.txt", "globcase"],
      repository,
    );
    runGit(["commit", "--quiet", "-m", "fixture"], repository);

    const backend = new LocalSessionBackend();
    const created = await backend.createSession(
      { cwd: repository },
      { branch: "feature/tgrep-rg-conformance", worktree, label: null, base: null },
    );
    if (!created.ok) throw created.error;
    for (const [name, content] of [
      ["ignored.txt", "needle in ignored\n"],
      [".hidden/secret.txt", "needle in hidden\n"],
    ] as const) {
      const target = path.join(worktree, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content);
    }
    const resolved = await resolveSandboxExecutionRequest(
      backend,
      { cwd: worktree },
      { session_id: created.value.session_id, enforce: true, runtime_projection: runtimeProjection },
      defaultSandboxProbe,
      runtimeLayout,
    );
    if (!resolved.ok) throw resolved.error;
    return {
      repository,
      worktree,
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

test("#308 evidence and a closed matrix are explicit provider authority", () => {
  assert.equal(TGREP_BACKEND_PROVIDER.requirement_id, "tgrep-backend");
  assert.equal(TGREP_BACKEND_EVIDENCE.version, "tgrep 1.0.4\n");
  assert.equal(TGREP_BACKEND_EVIDENCE.help_bytes, 9_103);
  assert.equal(TGREP_RG_ENTRYPOINT_NAME, "rg");
  assert.equal(
    TGREP_RG_COMPATIBILITY_MATRIX.some((entry) => entry.status === "supported"),
    true,
  );
  assert.equal(
    TGREP_RG_COMPATIBILITY_MATRIX.some((entry) => entry.status === "rejected"),
    true,
  );
  assert.equal(
    TGREP_RG_COMPATIBILITY_MATRIX.some((entry) => entry.rg.includes("grep")),
    false,
  );
  for (const entry of TGREP_RG_COMPATIBILITY_MATRIX.filter((candidate) => candidate.status === "supported")) {
    assert.notEqual(entry.backend.length, 0, entry.id);
  }
});

test("supported argv preserves positional values and maps only declared spellings", () => {
  const result = translateTgrepRgArguments([
    "-i",
    "-F",
    "-g=*.ts",
    "--iglob=-weird glob",
    "needle with space",
    "src/日本語",
  ]);
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) return;
  assert.deepEqual(result.value.argv, [
    "--ignore-case",
    "--fixed-strings",
    "--glob",
    "*.ts",
    "--iglob",
    "-weird glob",
    "--",
    "needle with space",
    "src/日本語",
  ]);

  const leadingDash = translateTgrepRgArguments(["--", "-pattern", "-path"]);
  assert.equal(leadingDash.ok, true, leadingDash.ok ? "" : leadingDash.error.message);
  if (leadingDash.ok) assert.deepEqual(leadingDash.value.argv, ["--", "-pattern", "-path"]);

  const files = translateTgrepRgArguments(["--files", "-g", "*.ts", "src"]);
  assert.equal(files.ok, true, files.ok ? "" : files.error.message);
  if (files.ok) assert.deepEqual(files.value.argv, ["--files", "--glob", "*.ts", "--", "src"]);
});

test("every supported matrix spelling has one tested backend mapping", () => {
  for (const entry of TGREP_RG_COMPATIBILITY_MATRIX.filter((candidate) => candidate.status === "supported")) {
    if (entry.id === "pattern-and-paths") continue;
    for (const spelling of entry.rg) {
      const value = entry.value === "required" ? "value with space" : null;
      const raw = [
        spelling,
        ...(value === null ? [] : [value]),
        ...(entry.id === "files-mode" ? [] : ["needle"]),
      ] as const;
      const result = translateTgrepRgArguments(raw);
      assert.equal(result.ok, true, `${entry.id}:${spelling}`);
      if (!result.ok) continue;
      assert.deepEqual(
        result.value.argv,
        [...entry.backend, ...(value === null ? [] : [value]), "--", ...(entry.id === "files-mode" ? [] : ["needle"])],
        `${entry.id}:${spelling}`,
      );
    }
  }
});

test("unsupported, ambiguous, combined, stdin, and non-relative forms fail deterministically", () => {
  for (const argv of [
    ["--pcre2", "needle"],
    ["--json", "needle"],
    ["-in", "needle"],
    ["-"],
    ["--unknown", "needle"],
    ["-i", "-s", "needle"],
    ["--files", "-i"],
    ["--glob"],
    ["needle", "-"],
    ["needle", "/etc/passwd"],
    ["needle", "../outside"],
  ]) {
    const result = translateTgrepRgArguments(argv);
    assert.equal(result.ok, false, argv.join(" "));
    if (!result.ok) {
      assert.equal(result.error.code, "INVALID_ARGUMENT", argv.join(" "));
      assert.match(
        result.error.message,
        /backend was not invoked|before invoking|requires a value|repository-relative/u,
        argv.join(" "),
      );
    }
  }
  for (const entry of TGREP_RG_COMPATIBILITY_MATRIX.filter((candidate) => candidate.status === "rejected")) {
    for (const spelling of entry.rg) {
      const result = translateTgrepRgArguments(spelling === "-" ? ["--", "-"] : [spelling, "needle"]);
      assert.equal(result.ok, false, `${entry.id}:${spelling}`);
      if (!result.ok) assert.equal(result.error.code, "INVALID_ARGUMENT", `${entry.id}:${spelling}`);
    }
  }
});

test("generated rg artifact is projected once and is shared by direct, child, and session-shell command paths", () => {
  const fixture = makeMaterializationFixture();
  const sandboxRoot = fs.mkdtempSync(path.join("/var/tmp", "nawabari-tgrep-provider-artifact-"));
  try {
    const recursive = materializeTgrepRgProvider(
      { ...fixture.materialization, executable_source: "/nawabari/bin/rg" },
      { artifact_root: path.join(sandboxRoot, "recursive") },
    );
    assert.equal(recursive.ok, false);
    if (!recursive.ok) assert.equal(recursive.error.code, "RUNTIME_MATERIALIZATION_MISSING");

    const provider = providerProjection(fixture.materialization, path.join(sandboxRoot, "adapter"));
    assert.equal(provider.backend_source, fixture.materialization.executable_source);
    assert.equal(provider.projection.executables.length, 1);
    assert.equal(provider.projection.executables[0]?.name, "rg");
    assert.equal(provider.projection.executables[0]?.target, TGREP_RG_ADAPTER_TARGET);
    assert.equal(provider.projection.executables[0]?.provider.id, TGREP_RG_PROVIDER.id);
    assert.equal(
      provider.projection.executables.some((entry) => entry.name === "grep"),
      false,
    );

    const compiled = compileRuntimeExecutableProjection(provider.projection);
    assert.equal(compiled.ok, true, compiled.ok ? "" : compiled.error.message);
    if (compiled.ok) {
      assert.deepEqual(
        compiled.value.map((entry) => [entry.name, entry.source, entry.target]),
        [["rg", provider.adapter_source, "/nawabari/bin/rg"]],
      );
    }

    const request = sandboxRequest(provider.projection);
    const direct = compileSandboxInvocation(request, { command: "rg", args: ["needle", "src"] });
    const child = compileSandboxInvocation(request, { command: "shell", args: ["-c", "rg needle src"] });
    const shell = compileSandboxInvocation(request, {
      command: "/nawabari/bin/shell",
      args: ["-c", "rg needle src"],
    });
    for (const invocation of [direct, child, shell]) {
      assert.equal(invocation.ok, true, invocation.ok ? "" : invocation.error.message);
      if (!invocation.ok) continue;
      assert.equal(invocation.value.env.PATH, "/nawabari/bin");
      const bind = invocation.value.args.findIndex(
        (value, index, args) =>
          value === "--ro-bind" &&
          args[index + 1] === provider.adapter_source &&
          args[index + 2] === "/nawabari/bin/rg",
      );
      assert.ok(bind > 0);
      assert.equal(invocation.value.args.includes("/usr/bin/rg"), false);
      assert.equal(invocation.value.args.includes("/usr/bin/grep"), false);
    }
    assert.deepEqual(direct.ok ? direct.value.args.slice(direct.value.args.indexOf("--")).slice(-3) : [], [
      "rg",
      "needle",
      "src",
    ]);
    assert.deepEqual(child.ok ? child.value.args.slice(child.value.args.indexOf("--")).slice(-3) : [], [
      "shell",
      "-c",
      "rg needle src",
    ]);
    assert.deepEqual(shell.ok ? shell.value.args.slice(shell.value.args.indexOf("--")).slice(-3) : [], [
      "/nawabari/bin/shell",
      "-c",
      "rg needle src",
    ]);

    const generated = execFileSync(provider.adapter_source, ["-s", "needle", "src"], {
      cwd: fixture.root,
      env: { ...process.env, PATH: "/host/path/must/not/matter" },
      encoding: "utf8",
      shell: false,
    });
    assert.deepEqual(JSON.parse(generated), ["--case-sensitive", "--", "needle", "src"]);

    const noMatch = spawnSync(provider.adapter_source, ["no-match"], {
      cwd: fixture.root,
      env: { ...process.env, PATH: "/host/path/must/not/matter" },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(noMatch.status, 1);
    assert.deepEqual(JSON.parse(noMatch.stdout), ["--", "no-match"]);
    assert.equal(noMatch.stderr, "");

    const backendError = spawnSync(provider.adapter_source, ["backend-error"], {
      cwd: fixture.root,
      env: { ...process.env, PATH: "/host/path/must/not/matter" },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(backendError.status, 23);
    assert.equal(backendError.stderr, "backend failure\n");

    const signaled = spawnSync(provider.adapter_source, ["signal"], {
      cwd: fixture.root,
      env: { ...process.env, PATH: "/host/path/must/not/matter" },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(signaled.signal, "SIGTERM");

    const rejected = spawnSync(provider.adapter_source, ["--pcre2", "needle"], {
      cwd: fixture.root,
      env: { ...process.env, PATH: "/host/path/must/not/matter" },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(rejected.status, 2);
    assert.match(rejected.stderr, /before backend execution/u);

    const absolutePath = spawnSync(provider.adapter_source, ["needle", "/etc/passwd"], {
      cwd: fixture.root,
      env: { ...process.env, PATH: "/host/path/must/not/matter" },
      encoding: "utf8",
      shell: false,
    });
    assert.equal(absolutePath.status, 2);
    assert.match(absolutePath.stderr, /repository-relative paths/u);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("tgrep adapter materialization fails closed when its created file is replaced before identity verification", () => {
  const fixture = makeMaterializationFixture();
  const sandboxRoot = fs.mkdtempSync(path.join("/var/tmp", "nawabari-tgrep-provider-identity-"));
  const artifactRoot = path.join(sandboxRoot, "adapter");
  const adapterSource = path.join(artifactRoot, "rg");
  const displaced = `${adapterSource}.created`;
  const replacement = "competing rg adapter\n";
  try {
    fs.mkdirSync(artifactRoot, { recursive: true });
    const result = withRuntimeFileIdentityTestHooks(
      {
        beforeFinalIdentityCheck: (checkedPath) => {
          if (checkedPath !== adapterSource) return;
          fs.renameSync(checkedPath, displaced);
          fs.writeFileSync(checkedPath, replacement, { mode: 0o644 });
        },
      },
      () => materializeTgrepRgProvider(fixture.materialization, { artifact_root: artifactRoot }),
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error.code, "RUNTIME_MATERIALIZATION_MISSING");
    assert.equal(fs.readFileSync(adapterSource, "utf8"), replacement);
  } finally {
    fs.rmSync(sandboxRoot, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("projected rg preserves rg semantics against the real pinned tgrep backend across direct, interactive, and child-process PATH lookup execution", async (t) => {
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

  const profileResult = resolveRuntimeProfile({
    profiles: ["base"],
    operations: [TGREP_BACKEND_REQUIREMENT_OPERATION],
  });
  assert.equal(profileResult.ok, true, profileResult.ok ? "" : profileResult.error.message);
  if (!profileResult.ok) return;

  // Real Nix materialization of #308's pinned tgrep and node-runtime; no
  // stub backend is involved from here on.
  const materialized = materializeTgrepRuntime(profileResult.value);
  assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));
  if (!materialized.ok) return;

  const artifactRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-tgrep-rg-adapter-"));
  let fixture: ProtectedRequestFixture | null = null;
  try {
    const provider = providerProjection(materialized.value, artifactRoot);

    // Add a second, test-only entrypoint that runs the same exact
    // node-runtime already present in the #308 closure, so a real child
    // process (not this test's own harness process) can resolve `rg` by
    // basename through the strict PATH=/nawabari/bin, exactly as a program
    // spawned inside a session would. `node_source` is the shebang path (a
    // Nix symlink into a separate closure member); the executable
    // projection requires a resolved regular-file target.
    const withNodeLauncher = projectSessionRuntimeProjection({
      ...provider.projection,
      executables: [
        ...provider.projection.executables,
        {
          name: "node",
          target: fs.realpathSync.native(provider.node_source),
          provider: { id: "test-node-launcher", requirement_id: "node-runtime" },
          provenance: "package" as const,
        },
      ],
    });
    assert.equal(withNodeLauncher.ok, true, withNodeLauncher.ok ? "" : withNodeLauncher.error.message);
    if (!withNodeLauncher.ok) return;

    fixture = await protectedRgRequest(withNodeLauncher.value, runtimeLayout);
    const { request, worktree } = fixture;

    const childLookupScript = path.join(worktree, "child-rg-lookup.mjs");
    fs.writeFileSync(
      childLookupScript,
      "const { execFileSync } = await import('node:child_process');\n" +
        "const args = process.argv.slice(2);\n" +
        "const output = execFileSync('rg', args, { encoding: 'utf8' });\n" +
        "process.stdout.write(output);\n",
    );

    async function rg(args: readonly string[], interactive = false) {
      const result = await runSandboxedCommand(request, { command: "rg", args }, { interactive });
      if (!result.ok) throw new Error(JSON.stringify(result.error));
      return result.value;
    }

    // Case-sensitive default matches rg: "Needle" (capitalized) hits, plain
    // lowercase search misses it.
    const caseSensitive = await rg(["-s", "Needle", "."]);
    assert.equal(caseSensitive.exit_code, 0);
    assert.match(caseSensitive.stdout, /tracked\.txt:Needle here/u);
    assert.doesNotMatch(caseSensitive.stderr, /error|panic/iu);

    const caseSensitiveMiss = await rg(["-s", "needle-not-present", "."]);
    assert.equal(caseSensitiveMiss.exit_code, 1);
    assert.equal(caseSensitiveMiss.stdout, "");

    // -i ignore-case widens the match across mixed-case content.
    const ignoreCase = await rg(["-i", "needle", "sub"]);
    assert.equal(ignoreCase.exit_code, 0);
    assert.match(ignoreCase.stdout, /another needle/u);
    assert.match(ignoreCase.stdout, /NEEDLE/u);

    // --files lists the discoverable tree without searching.
    const filesMode = await rg(["--files"]);
    assert.equal(filesMode.exit_code, 0);
    assert.match(filesMode.stdout, /tracked\.txt/u);
    assert.match(filesMode.stdout, /sub\/b\.log/u);

    // Default projection respects .gitignore: the untracked-but-ignored file
    // is invisible; --no-ignore reveals it.
    const respectsIgnore = await rg(["-i", "needle", "."]);
    assert.equal(respectsIgnore.exit_code, 0);
    assert.doesNotMatch(respectsIgnore.stdout, /ignored\.txt/u);

    const noIgnore = await rg(["-i", "--no-ignore", "needle", "."]);
    assert.equal(noIgnore.exit_code, 0);
    assert.match(noIgnore.stdout, /ignored\.txt/u);

    // Hidden files are excluded by default and included with --hidden.
    const withoutHidden = await rg(["-i", "needle", "."]);
    assert.doesNotMatch(withoutHidden.stdout, /\.hidden/u);
    const withHidden = await rg(["-i", "--hidden", "needle", "."]);
    assert.match(withHidden.stdout, /\.hidden\/secret\.txt/u);

    // -S/--smart-case is case-insensitive for an all-lowercase pattern and
    // case-sensitive once the pattern contains an uppercase character.
    const smartCaseLower = await rg(["-S", "needle", "smartcase.txt"]);
    assert.equal(smartCaseLower.exit_code, 0);
    assert.equal(smartCaseLower.stdout.trim().split("\n").length, 3);
    const smartCaseMixed = await rg(["-S", "Needle", "smartcase.txt"]);
    assert.equal(smartCaseMixed.stdout.trim(), "Needle here");

    // -F/--fixed-strings treats '.' as a literal character, not a wildcard.
    const fixedStrings = await rg(["-s", "-F", "a.b", "literal.txt"]);
    assert.equal(fixedStrings.stdout.trim(), "a.b");
    assert.doesNotMatch(fixedStrings.stdout, /axb/u);

    // -w/--word-regexp matches only at word boundaries: a hyphen is a
    // boundary but a bare substring inside another word is not.
    const wordRegexp = await rg(["-s", "-w", "needle", "words.txt"]);
    assert.match(wordRegexp.stdout, /sub-needle-word/u);
    assert.match(wordRegexp.stdout, /another needle line/u);
    assert.doesNotMatch(wordRegexp.stdout, /needleword$/mu);

    // -v/--invert-match prints only non-matching lines.
    const invertMatch = await rg(["-s", "-v", "Needle", "tracked.txt"]);
    assert.equal(invertMatch.stdout.trim(), "no match line");

    // --iglob matches a glob case-insensitively, unlike --glob.
    const iglob = await rg(["-i", "--iglob", "*.txt", "needle", "globcase"]);
    assert.match(iglob.stdout, /FILE\.TXT/u);
    assert.match(iglob.stdout, /file2\.txt/u);

    // --no-messages suppresses the backend's own diagnostic for an
    // unreadable path while the exit code is unaffected.
    const withMessages = await rg(["-s", "needle", "does-not-exist.txt"]);
    assert.equal(withMessages.exit_code, 2);
    assert.match(withMessages.stderr, /does-not-exist\.txt/u);
    const noMessages = await rg(["-s", "--no-messages", "needle", "does-not-exist.txt"]);
    assert.equal(noMessages.exit_code, 2);
    assert.doesNotMatch(noMessages.stderr, /does-not-exist\.txt/u);

    // -H/-I filename mode and -n/-N line-number mode toggle rg-shaped output
    // prefixes rather than search results.
    const noFilename = await rg(["-s", "-I", "Needle", "tracked.txt"]);
    assert.equal(noFilename.exit_code, 0);
    assert.equal(noFilename.stdout.trim(), "Needle here");
    const withFilename = await rg(["-s", "-H", "Needle", "tracked.txt"]);
    assert.equal(withFilename.stdout.trim(), "tracked.txt:Needle here");
    const lineNumber = await rg(["-s", "-n", "Needle", "tracked.txt"]);
    assert.equal(lineNumber.stdout.trim(), "1:Needle here");
    const noLineNumber = await rg(["-s", "-N", "Needle", "tracked.txt"]);
    assert.equal(noLineNumber.stdout.trim(), "Needle here");

    // -l/--files-with-matches and --files-without-match report file identity,
    // not line content.
    const filesWithMatches = await rg(["-i", "-l", "needle", "sub"]);
    assert.match(filesWithMatches.stdout, /b\.log/u);
    const filesWithoutMatch = await rg(["-i", "--files-without-match", "needle", "."]);
    assert.doesNotMatch(filesWithoutMatch.stdout, /tracked\.txt/u);

    // -c/--count reports a per-file match count, not the matched lines.
    const count = await rg(["-i", "-c", "needle", "sub"]);
    assert.match(count.stdout, /:2\s*$/mu);

    // -o/--only-matching prints only the matched span per line.
    const onlyMatching = await rg(["-i", "-o", "needle", "sub"]);
    assert.match(onlyMatching.stdout, /:needle$/mu);
    assert.doesNotMatch(onlyMatching.stdout, /another/u);

    // -m/--max-count bounds matches per file.
    const maxCount = await rg(["-i", "-m", "1", "needle", "sub"]);
    assert.equal(maxCount.stdout.trim().split("\n").length, 1);

    // -g/--glob restricts the searched file set by pattern.
    const glob = await rg(["-i", "--glob", "*.log", "needle", "."]);
    assert.match(glob.stdout, /b\.log/u);
    assert.doesNotMatch(glob.stdout, /tracked\.txt/u);

    // -q/--quiet reports match presence via exit code only.
    const quietMatch = await rg(["-i", "-q", "needle", "."]);
    assert.equal(quietMatch.exit_code, 0);
    assert.equal(quietMatch.stdout, "");
    const quietNoMatch = await rg(["-i", "-q", "zzz-not-present", "."]);
    assert.equal(quietNoMatch.exit_code, 1);

    // --max-depth bounds recursion depth.
    const maxDepth = await rg(["-i", "--max-depth", "1", "needle", "."]);
    assert.doesNotMatch(maxDepth.stdout, /sub\/b\.log/u);

    // Rejected argv never reaches the backend.
    const rejected = await rg(["--pcre2", "needle"]);
    assert.equal(rejected.exit_code, 2);
    assert.match(rejected.stderr, /before backend execution/u);

    // Direct `session run -- rg ...` and an interactive execution (the same
    // `interactive` flag #294's `session shell` sets on this launcher) must
    // reach the identical projected adapter with identical exit behavior.
    // Interactive execution inherits stdio rather than capturing it (see
    // `sandbox-launcher.test.ts`), so only the match/no-match exit code is
    // comparable here; `src/cli.test.ts` proves the CLI-level `session run` /
    // `session shell` dispatch reaches this same `runSandboxedCommand` seam.
    const direct = await rg(["-s", "Needle", "."]);
    assert.equal(direct.exit_code, 0);
    assert.match(direct.stdout, /tracked\.txt:Needle here/u);
    const shell = await rg(["-s", "Needle", "."], true);
    assert.equal(shell.exit_code, 0);
    const shellNoMatch = await rg(["-s", "zzz-not-present", "."], true);
    assert.equal(shellNoMatch.exit_code, 1);

    // A real child process spawned inside the protected runtime (not this
    // test's own harness process, and not `runSandboxedCommand`'s own
    // top-level `command`) must resolve `rg` by basename through the strict
    // PATH=/nawabari/bin, exactly like a program running inside a session.
    const childLookup = await runSandboxedCommand(request, {
      command: "node",
      args: [childLookupScript, "-s", "Needle", "tracked.txt"],
    });
    if (!childLookup.ok) throw new Error(JSON.stringify(childLookup.error));
    assert.equal(childLookup.value.exit_code, 0);
    assert.equal(childLookup.value.stdout.trim(), "Needle here");

    assert.equal(fs.existsSync(path.join(worktree, ".hidden", "secret.txt")), true);
  } finally {
    fixture?.cleanup();
    fs.rmSync(artifactRoot, { recursive: true, force: true });
  }
});
