import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import { compileRuntimeExecutableProjection } from "./runtime-executable-projection.js";
import { resolveRuntimeProfile } from "./runtime-profile.js";
import {
  compileSandboxInvocation,
  SANDBOX_CONTRACT_ID,
  SANDBOX_CONTRACT_SCHEMA_VERSION,
  sandboxCapabilityBaseline,
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
