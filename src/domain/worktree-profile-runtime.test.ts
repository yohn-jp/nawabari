import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  RUNTIME_RESOLUTION_SERIALIZATION_KEY,
  resolveWorktreeProfileRuntime,
  selectProfileEntrypoints,
  serializeRuntimeResolution,
} from "./worktree-profile-runtime.js";
import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import type { NixCommandRunner } from "./nix-runtime-closure.js";
import type { SandboxRuntimeLayout } from "./sandbox.js";

function emptyLayout(overrides: Partial<SandboxRuntimeLayout> = {}): SandboxRuntimeLayout {
  return {
    bubblewrap: null,
    nix: null,
    landlock_helper: null,
    user_home: null,
    user_local_bin: null,
    user_local_lib: null,
    user_pnpm_bin: null,
    nix_store: null,
    nix_current_system: null,
    nix_wrappers: null,
    nix_user_profile: null,
    usr: "/usr",
    bin: "/bin",
    lib: "/lib",
    lib64: "/lib64",
    passwd: null,
    group: null,
    nsswitch: null,
    hosts: null,
    resolv_conf: null,
    alternatives: null,
    ssl_certs: null,
    pki_certs: null,
    ca_certificates: null,
    git_user_name: null,
    git_user_email: null,
    ...overrides,
  };
}

const NIX_RUNTIME_PROVIDER_IDS = Object.freeze({
  "node-runtime": "nix-node-runtime-provider",
  "git-package": "nix-git-package-provider",
});

function candidateFixture(): {
  readonly root: string;
  readonly store: string;
  readonly layout: SandboxRuntimeLayout;
  readonly runner: NixCommandRunner;
  readonly cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-worktree-profile-runtime-"));
  const store = path.join(root, "store");
  const currentSystem = path.join(root, "current-system");
  fs.mkdirSync(store);
  fs.mkdirSync(currentSystem);
  const roots = {
    node: path.join(store, "aaa-nodejs-24"),
    git: path.join(store, "bbb-git-2"),
    ls: path.join(store, "ccc-coreutils-9"),
  };
  const dependencies = {
    node: path.join(store, "ddd-node-dependency"),
    git: path.join(store, "eee-git-dependency"),
    ls: path.join(store, "fff-coreutils-dependency"),
  };
  const attributes: Readonly<Record<string, keyof typeof roots>> = {
    "nixpkgs#nodejs": "node",
    "nixpkgs#git": "git",
    "nixpkgs#coreutils": "ls",
  };
  for (const [key, storePath] of Object.entries(roots)) {
    const executable = path.join(storePath, "bin", key);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  for (const storePath of Object.values(dependencies)) fs.mkdirSync(storePath);
  const runner: NixCommandRunner = (_executable, args) => {
    const installable = args[args.length - 1];
    const key = typeof installable === "string" ? attributes[installable] : undefined;
    if (key === undefined) return { exit_code: 1, stdout: "", stderr: "unknown installable" };
    const selected = args.includes("--recursive") ? [roots[key], dependencies[key]] : [roots[key]];
    return {
      exit_code: 0,
      stdout: JSON.stringify(Object.fromEntries(selected.map((storePath) => [storePath, null]))),
      stderr: "",
    };
  };
  return {
    root,
    store,
    layout: emptyLayout({ nix: path.join(root, "nix"), nix_store: store, nix_current_system: currentSystem }),
    runner,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function profile(
  tools: readonly unknown[] = [
    { entrypoint: "node", provider: { id: NIX_RUNTIME_PROVIDER_IDS["node-runtime"], requirement_id: "node-runtime" } },
    { entrypoint: "git", provider: { id: NIX_RUNTIME_PROVIDER_IDS["git-package"], requirement_id: "git-package" } },
  ],
): Record<string, unknown> {
  return {
    id: "standard",
    version: "1",
    materialSelection: { profiles: ["development"] },
    filesystem: { readOnly: [], write: [], create: [], delete: [], deny: [], immutable: [] },
    tools,
    shell: { entrypoint: "node" },
    environment: {
      home: "session",
      xdg: { config: "session", cache: "session", data: "session", state: "session" },
      tmp: "execution",
    },
    git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "disabled" },
    execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "optional" },
  };
}

test("resolves one profile deterministically and exposes only its selected tools", () => {
  const fixture = candidateFixture();
  try {
    const first = resolveWorktreeProfileRuntime(profile(), fixture.layout, {
      platform: "linux",
      nix: { store_root: fixture.store, command_runner: fixture.runner },
    });
    const second = resolveWorktreeProfileRuntime(profile(), fixture.layout, {
      platform: "linux",
      nix: { store_root: fixture.store, command_runner: fixture.runner },
    });
    assert.equal(first.ok, true, first.ok ? "" : JSON.stringify(first.error));
    assert.equal(second.ok, true, second.ok ? "" : JSON.stringify(second.error));
    if (!first.ok || !second.ok) return;

    assert.deepEqual(first.value, second.value);
    assert.equal(first.value.materializer, "nix");
    assert.deepEqual(
      first.value.projection.executables.map((entrypoint) => entrypoint.name),
      ["git", "node"],
    );
    assert.equal(
      first.value.projection.executables.some((entrypoint) => entrypoint.name === "ls"),
      false,
    );
    assert.equal(
      first.value.projection.filesystem.some((entry) => entry.source === path.join(fixture.store, "ccc-coreutils-9")),
      true,
    );
    assert.equal(
      first.value.projection.filesystem.some((entry) => entry.target === "/usr"),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test("unselected pnpm evidence does not affect an unrelated shell surface", () => {
  const fixture = candidateFixture();
  try {
    const result = resolveWorktreeProfileRuntime(profile(), fixture.layout, {
      platform: "linux",
      nix: { store_root: fixture.store, command_runner: fixture.runner },
    });
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;
    assert.equal(
      result.value.projection.executables.some((entrypoint) => entrypoint.name === "pnpm"),
      false,
    );
  } finally {
    fixture.cleanup();
  }
});

test("a selected but unmaterialized provider fails with the canonical missing-provider error", () => {
  const fixture = candidateFixture();
  try {
    const result = resolveWorktreeProfileRuntime(
      profile([
        {
          entrypoint: "node",
          provider: { id: NIX_RUNTIME_PROVIDER_IDS["node-runtime"], requirement_id: "node-runtime" },
        },
        { entrypoint: "pnpm", provider: { id: "fhs-pnpm-package-provider", requirement_id: "pnpm-package" } },
      ]),
      fixture.layout,
      {
        platform: "linux",
        nix: { store_root: fixture.store, command_runner: fixture.runner },
      },
    );
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error.code, "RUNTIME_PROVIDER_MISSING");
      assert.equal(result.error.details?.requirement_id, "pnpm-package");
    }
  } finally {
    fixture.cleanup();
  }
});

test("entrypoint selection matches exact provider identity and serialization uses runtime-resolution", () => {
  const fixture = candidateFixture();
  try {
    const resolved = resolveWorktreeProfileRuntime(profile(), fixture.layout, {
      platform: "linux",
      nix: { store_root: fixture.store, command_runner: fixture.runner },
    });
    assert.equal(resolved.ok, true, resolved.ok ? "" : JSON.stringify(resolved.error));
    if (!resolved.ok) return;
    const selected = selectProfileEntrypoints(resolved.value, [
      {
        entrypoint: "node",
        provider: { id: NIX_RUNTIME_PROVIDER_IDS["node-runtime"], requirement_id: "node-runtime" },
      },
    ]);
    assert.equal(selected.ok, true, selected.ok ? "" : JSON.stringify(selected.error));
    if (!selected.ok) return;
    assert.deepEqual(
      selected.value.map((entrypoint) => entrypoint.name),
      ["node"],
    );

    const serialized = serializeRuntimeResolution(resolved.value);
    assert.equal(serialized.ok, true, serialized.ok ? "" : JSON.stringify(serialized.error));
    if (!serialized.ok) return;
    assert.deepEqual(Object.keys(JSON.parse(serialized.value) as object), [RUNTIME_RESOLUTION_SERIALIZATION_KEY]);
  } finally {
    fixture.cleanup();
  }
});

test("declared material is selected by provider id and exact requirement identity", () => {
  const fixture = candidateFixture();
  const executable = path.join(fixture.root, "declared-node");
  try {
    const fd = fs.openSync(executable, "w+", 0o755);
    let stat: fs.BigIntStats;
    let bytes: Buffer;
    try {
      fs.writeFileSync(fd, "#!/bin/sh\nexit 0\n");
      stat = fs.fstatSync(fd, { bigint: true });
      bytes = Buffer.alloc(Number(stat.size));
      fs.readSync(fd, bytes, 0, bytes.length, 0);
    } finally {
      fs.closeSync(fd);
    }
    const evidence = {
      source: executable,
      digest: createHash("sha256").update(bytes).digest("hex"),
      identity: { dev: stat.dev.toString(10), ino: stat.ino.toString(10) },
    };
    const result = resolveWorktreeProfileRuntime(
      profile([{ entrypoint: "node", provider: { id: "declared-node", requirement_id: "node-runtime" } }]),
      fixture.layout,
      {
        platform: "linux",
        nix: { store_root: fixture.store, command_runner: fixture.runner },
        declared_materials: [
          {
            id: "declared-node",
            requirement_id: "node-runtime",
            version: ">=24",
            entrypoint: "node",
            executable: evidence,
            source_closure: [evidence],
          },
        ],
      },
    );
    assert.equal(result.ok, true, result.ok ? "" : JSON.stringify(result.error));
    if (!result.ok) return;
    assert.deepEqual(
      result.value.projection.executables.map((entrypoint) => entrypoint.provider),
      [{ id: "declared-node", requirement_id: "node-runtime" }],
    );
    assert.equal(
      result.value.projection.filesystem.some((entry) => entry.source === executable),
      true,
    );

    const duplicate = resolveWorktreeProfileRuntime(profile(), fixture.layout, {
      platform: "linux",
      nix: { store_root: fixture.store, command_runner: fixture.runner },
      declared_materials: [{ id: "duplicate" }, { id: "duplicate" }],
    });
    assert.equal(duplicate.ok, false);
    if (!duplicate.ok) assert.equal(duplicate.error.code, "RUNTIME_PROJECTION_AMBIGUOUS");
  } finally {
    fixture.cleanup();
  }
});

test("runtime-resolution serialization rejects contradictory materializer evidence", () => {
  const fixture = candidateFixture();
  try {
    const resolved = resolveWorktreeProfileRuntime(profile(), fixture.layout, {
      platform: "linux",
      nix: { store_root: fixture.store, command_runner: fixture.runner },
    });
    assert.equal(resolved.ok, true, resolved.ok ? "" : JSON.stringify(resolved.error));
    if (!resolved.ok) return;

    const compatibilityLabel = serializeRuntimeResolution({
      ...resolved.value,
      materializer: "compatibility",
    });
    assert.equal(compatibilityLabel.ok, false);

    const fhsProvider = serializeRuntimeResolution({
      ...resolved.value,
      projection: {
        ...resolved.value.projection,
        executables: resolved.value.projection.executables.map((entrypoint) => ({
          ...entrypoint,
          provider: { ...entrypoint.provider, id: `fhs-${entrypoint.provider.requirement_id}-provider` },
        })),
      },
    });
    assert.equal(fhsProvider.ok, false);

    const sessionFilesystem = serializeRuntimeResolution({
      ...resolved.value,
      projection: {
        ...resolved.value.projection,
        filesystem: resolved.value.projection.filesystem.map((entry) => ({
          ...entry,
          provenance: "session" as const,
        })),
      },
    });
    assert.equal(sessionFilesystem.ok, false);
  } finally {
    fixture.cleanup();
  }
});
