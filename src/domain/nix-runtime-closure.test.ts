import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRuntimeProfile, type ResolvedRuntimeProfile } from "./runtime-profile.js";
import {
  DEFAULT_NIX_PACKAGE_ATTRIBUTES,
  materializeNixRuntimeClosure,
  type NixCommandRunner,
} from "./nix-runtime-closure.js";
import { EXPLICIT_COMPATIBILITY_RUNTIME_POLICY, STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import {
  SANDBOX_CONTRACT_ID,
  SANDBOX_CONTRACT_SCHEMA_VERSION,
  compileSandboxInvocation,
  sandboxCapabilityBaseline,
  sandboxSeccompProfileMetadata,
  type SandboxExecutionRequest,
} from "./sandbox.js";

type Fixture = {
  readonly store: string;
  readonly roots: Readonly<Record<string, string>>;
  readonly closures: Readonly<Record<string, readonly string[]>>;
  readonly cleanup: () => void;
};

function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join("/var/tmp", "nawabari-nix-closure-"));
  const store = path.join(root, "store");
  fs.mkdirSync(store);
  const roots = {
    node: path.join(store, "aaa-nodejs-24"),
    git: path.join(store, "bbb-git-2"),
    pnpm: path.join(store, "ccc-pnpm-11"),
  };
  const dependencies = {
    node: path.join(store, "ddd-node-runtime-dependency"),
    git: path.join(store, "eee-git-runtime-dependency"),
    pnpm: path.join(store, "fff-pnpm-runtime-dependency"),
  };
  const unrelated = path.join(store, "zzz-unrelated-host-package");
  for (const storePath of [...Object.values(roots), ...Object.values(dependencies), unrelated]) {
    fs.mkdirSync(path.join(storePath, "bin"), { recursive: true });
    fs.writeFileSync(path.join(storePath, "bin", path.basename(storePath)), "#!/bin/sh\n");
  }
  return {
    store,
    roots,
    closures: {
      node: [roots.node, dependencies.node],
      git: [roots.git, dependencies.git],
      pnpm: [roots.pnpm, dependencies.pnpm],
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function profile(): ResolvedRuntimeProfile {
  const result = resolveRuntimeProfile({ profiles: ["development"] });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  if (!result.ok) throw new Error("the canonical development profile could not be resolved");
  return result.value;
}

function runnerFor(fixture: Fixture, reverse = false): NixCommandRunner {
  const rootsByInstallable: Readonly<Record<string, keyof Fixture["roots"]>> = {
    "nixpkgs#nodejs": "node",
    "nixpkgs#git": "git",
    "nixpkgs#pnpm": "pnpm",
  };
  return (_executable, args) => {
    const installable = args[args.length - 1];
    const key = typeof installable === "string" ? rootsByInstallable[installable] : undefined;
    if (key === undefined) return { exit_code: 1, stdout: "", stderr: "unknown installable" };
    const paths = args.includes("--recursive") ? fixture.closures[key] : [fixture.roots[key]];
    const ordered = reverse ? [...paths].reverse() : [...paths];
    return {
      exit_code: 0,
      stdout: JSON.stringify(Object.fromEntries(ordered.map((storePath) => [storePath, null]))),
      stderr: "",
    };
  };
}

function sandboxRequest(projection: SandboxExecutionRequest["runtime_projection"]): SandboxExecutionRequest {
  const repository = fs.mkdtempSync(path.join("/var/tmp", "nawabari-nix-sandbox-"));
  const worktree = path.join(repository, "worktree");
  fs.mkdirSync(worktree);
  const filesystem = {
    owned_worktree: worktree,
    home: path.join(repository, "home"),
    cache: path.join(repository, "cache"),
    persistent_home: path.join(repository, "persistent"),
    git_metadata: path.join(repository, "git-metadata"),
    git_objects: path.join(repository, "git-objects"),
    user_tool_paths: [],
    user_tool_home: null,
    runtime_paths: [],
    system_paths: [],
  };
  fs.mkdirSync(filesystem.git_objects);
  return {
    schema_version: SANDBOX_CONTRACT_SCHEMA_VERSION,
    contract_id: SANDBOX_CONTRACT_ID,
    enforce: true,
    session_id: "nix-closure-test",
    repository,
    worktree,
    branch: "feature/nix-closure-test",
    network_mode: "inherited",
    sandbox_executable: "/bin/sh",
    identity: { real_uid: 1_000, real_gid: 1_000, namespace_uid: 0, namespace_gid: 0 },
    filesystem,
    required_capabilities: [],
    seccomp_profile: sandboxSeccompProfileMetadata(),
    capability_baseline: sandboxCapabilityBaseline,
    landlock_abi: null,
    landlock_required: false,
    landlock_executable: null,
    runtime_projection: projection,
  };
}

function cleanupSandboxRequest(request: SandboxExecutionRequest): void {
  fs.rmSync(request.repository, { recursive: true, force: true });
}

test("declared Nix packages resolve with their native closure dependencies only", () => {
  const fixture = makeFixture();
  try {
    const result = materializeNixRuntimeClosure(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture),
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;

    const expected = Object.values(fixture.closures).flat().sort();
    assert.deepEqual(result.value.store_paths, expected);
    assert.deepEqual(
      result.value.projection.filesystem.map((entry) => entry.source),
      expected,
    );
    assert.equal(result.value.projection.executables.length, 0);
    assert.equal(
      result.value.projection.filesystem.some((entry) => entry.source === "/run/current-system"),
      false,
    );
    assert.equal(
      result.value.projection.filesystem.some((entry) => entry.source === fixture.store),
      false,
    );
    assert.equal(
      result.value.projection.filesystem.some((entry) => entry.source.includes("unrelated")),
      false,
    );
    assert.deepEqual(DEFAULT_NIX_PACKAGE_ATTRIBUTES, {
      node: "nodejs",
      git: "git",
      pnpm: "pnpm",
      tgrep: "tgrep",
    });
  } finally {
    fixture.cleanup();
  }
});

test("strict closure projections compile through #289 without a broad store mount", () => {
  const fixture = makeFixture();
  let request: SandboxExecutionRequest | null = null;
  try {
    const materialized = materializeNixRuntimeClosure(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture),
    });
    assert.equal(materialized.ok, true, materialized.ok ? "" : JSON.stringify(materialized.error));
    if (!materialized.ok) return;
    request = sandboxRequest(materialized.value.projection);
    const undeclaredBinary = path.join(fixture.store, "zzz-unrelated-host-package", "bin", "host-tool");
    const compiled = compileSandboxInvocation(request, { command: undeclaredBinary });
    assert.equal(compiled.ok, true, compiled.ok ? "" : JSON.stringify(compiled.error));
    if (!compiled.ok) return;
    const terminator = compiled.value.args.indexOf("--");
    assert.ok(terminator > 0);
    const mountArgs = compiled.value.args.slice(0, terminator);
    assert.equal(
      mountArgs.some((value, index, args) => value === "--ro-bind" && args[index + 1] === fixture.store),
      false,
      "the whole store root must not be mounted",
    );
    assert.equal(mountArgs.includes(undeclaredBinary), false, "an undeclared absolute binary must not be mounted");
    assert.equal(
      mountArgs.some((value, index, args) => value === "--ro-bind" && args[index + 2] === undeclaredBinary),
      false,
    );
    for (const storePath of materialized.value.store_paths) {
      assert.equal(
        mountArgs.some((value, index, args) => value === "--ro-bind" && args[index + 1] === storePath),
        true,
        `missing closure projection for ${storePath}`,
      );
    }
  } finally {
    if (request !== null) cleanupSandboxRequest(request);
    fixture.cleanup();
  }
});

test("compatibility broad-store behavior requires the explicit compatibility policy", () => {
  const fixture = makeFixture();
  try {
    const strict = materializeNixRuntimeClosure(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture),
    });
    assert.equal(strict.ok, true);
    if (!strict.ok) return;
    assert.equal(strict.value.policy.mode, "strict");
    assert.equal(
      strict.value.projection.filesystem.some((entry) => entry.source === fixture.store),
      false,
    );

    const compatibility = materializeNixRuntimeClosure(profile(), {
      policy: EXPLICIT_COMPATIBILITY_RUNTIME_POLICY,
      store_root: fixture.store,
      command_runner: runnerFor(fixture),
    });
    assert.equal(compatibility.ok, true, compatibility.ok ? "" : JSON.stringify(compatibility.error));
    if (!compatibility.ok) return;
    assert.deepEqual(compatibility.value.projection.filesystem, [
      {
        source: fixture.store,
        target: fixture.store,
        access_mode: "read-only",
        provenance: "compatibility",
      },
    ]);
  } finally {
    fixture.cleanup();
  }
});

test("missing or unresolvable closure material fails with the recoverable error", () => {
  const fixture = makeFixture();
  try {
    const missing = materializeNixRuntimeClosure(profile(), {
      store_root: fixture.store,
      command_runner: () => ({ exit_code: 1, stdout: "", stderr: "path is not valid" }),
    });
    assert.equal(missing.ok, false);
    if (!missing.ok) {
      assert.equal(missing.error.code, "RUNTIME_MATERIALIZATION_MISSING");
      assert.equal(missing.error.exitCode, 4);
      assert.equal(missing.error.details?.requirement_id, "git-package");
    }

    const link = path.join(fixture.store, "aaa-nodejs-24-link");
    fs.symlinkSync(fixture.roots.node, link, "dir");
    const unresolved = materializeNixRuntimeClosure(profile(), {
      store_root: fixture.store,
      command_runner: (_executable, args) => {
        const installable = args[args.length - 1];
        if (installable !== "nixpkgs#nodejs") return runnerFor(fixture)(_executable, args);
        const paths = args.includes("--recursive") ? [link] : [link];
        return {
          exit_code: 0,
          stdout: JSON.stringify(Object.fromEntries(paths.map((storePath) => [storePath, null]))),
          stderr: "",
        };
      },
    });
    assert.equal(unresolved.ok, false);
    if (!unresolved.ok) assert.equal(unresolved.error.code, "RUNTIME_MATERIALIZATION_MISSING");
  } finally {
    fixture.cleanup();
  }
});

test("closure evidence and projection serialization are deterministic", () => {
  const fixture = makeFixture();
  try {
    const first = materializeNixRuntimeClosure(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture),
    });
    const second = materializeNixRuntimeClosure(profile(), {
      store_root: fixture.store,
      command_runner: runnerFor(fixture, true),
    });
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    if (!first.ok || !second.ok) return;
    assert.deepEqual(first.value, second.value);
    assert.equal(JSON.stringify(first.value), JSON.stringify(second.value));
    assert.equal(first.value.policy, STRICT_RUNTIME_POLICY);
  } finally {
    fixture.cleanup();
  }
});
