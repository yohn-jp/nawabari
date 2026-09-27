import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getNawabariRepositoryRuntimeSnapshot } from "../repository-runtime-snapshot.js";
import { parseRepositoryRuntimeObservations } from "../repository-runtime-observations.js";
import { SessionRegistry } from "../session-registry.js";
import { REGISTRY_FEATURES } from "../registry/runtime-records.js";
import { STRICT_RUNTIME_POLICY } from "./runtime-projection.js";
import type { NixCommandRunner } from "./nix-runtime-closure.js";
import type { SandboxRuntimeLayout } from "./sandbox.js";
import { pinWorktreeProfile } from "./worktree-profile-pinning.js";
import { collectRepositoryRuntimeProfileObservation } from "./repository-runtime-profile-collector.js";
import type { WorktreeProfileRuntimeLayout } from "./worktree-profile-runtime.js";

const FIXED_TIME = new Date("2026-09-27T04:05:06.000Z");
const CATALOG_PATH = "nawabari.profiles.json";

function catalogProfile(version: string) {
  return {
    contract_id: "nawabari.worktree-runtime-profile.v1",
    schema_version: 1,
    id: "standard",
    version,
    materialSelection: { profiles: ["development"] },
    filesystem: { readOnly: ["src/**"], write: [], create: [], delete: [], deny: [".git/**"], immutable: [".git/**"] },
    tools: [
      { entrypoint: "git", provider: { id: "nix-git-package-provider", requirement_id: "git-package" } },
      { entrypoint: "node", provider: { id: "nix-node-runtime-provider", requirement_id: "node-runtime" } },
    ],
    shell: { entrypoint: "node" },
    environment: {
      home: "session",
      xdg: { config: "session", cache: "session", data: "session", state: "session" },
      tmp: "execution",
    },
    git: { config: "session-private", globalConfig: "excluded", credentialHelpers: "disabled", hooks: "disabled" },
    execution: { policy: STRICT_RUNTIME_POLICY, processTracking: "optional" },
  } as const;
}

function catalogText(version: string): string {
  return `${JSON.stringify({ profiles: [{ ...catalogProfile(version), extends: [] }] }, null, 2)}\n`;
}

function runtimeFixture(): {
  readonly layout: WorktreeProfileRuntimeLayout;
  readonly store: string;
  readonly commandRunner: NixCommandRunner;
  readonly cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-profile-observation-runtime-"));
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
  for (const [name, storePath] of Object.entries(roots)) {
    const executable = path.join(storePath, "bin", name);
    fs.mkdirSync(path.dirname(executable), { recursive: true });
    fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  }
  for (const storePath of Object.values(dependencies)) fs.mkdirSync(storePath);

  const commandRunner: NixCommandRunner = (_executable, args) => {
    const installable = args.at(-1);
    const name = typeof installable === "string" ? attributes[installable] : undefined;
    if (name === undefined) return { exit_code: 1, stdout: "", stderr: "unknown installable" };
    const selected = args.includes("--recursive") ? [roots[name], dependencies[name]] : [roots[name]];
    return {
      exit_code: 0,
      stdout: JSON.stringify(Object.fromEntries(selected.map((storePath) => [storePath, null]))),
      stderr: "",
    };
  };
  const layoutBase: SandboxRuntimeLayout = {
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
    usr: null,
    bin: null,
    lib: null,
    lib64: null,
    passwd: null,
    group: null,
    nsswitch: null,
    hosts: null,
    resolv_conf: null,
    alternatives: null,
    ssl_certs: null,
    pki_certs: null,
    ca_certificates: null,
    fhs_executable_candidates: [],
    git_user_name: null,
    git_user_email: null,
  };
  const layout: WorktreeProfileRuntimeLayout = {
    ...layoutBase,
    platform: "linux",
    nix: path.join(root, "nix"),
    nix_store: store,
    nix_current_system: currentSystem,
  };
  return { layout, store, commandRunner, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

function createRepository(): { readonly root: string; readonly registry: SessionRegistry; readonly sessionId: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-profile-observation-repository-"));
  runGit(["init", "--quiet", "--initial-branch=main"], root);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], root);
  runGit(["config", "user.name", "Nawabari Tests"], root);
  runGit(["config", "commit.gpgsign", "false"], root);
  runGit(["config", "core.hooksPath", "/dev/null"], root);
  fs.writeFileSync(path.join(root, CATALOG_PATH), catalogText("1"));
  fs.writeFileSync(path.join(root, "README.md"), "profile collector fixture\n");
  runGit(["add", CATALOG_PATH, "README.md"], root);
  runGit(["commit", "--quiet", "-m", "initial profile catalog"], root);

  const registry = new SessionRegistry({ cwd: root });
  const session = registry.create();
  const revision = runGit(["rev-parse", "HEAD"], root);
  const catalogBlob = runGit(["rev-parse", `HEAD:${CATALOG_PATH}`], root);
  const pinned = pinWorktreeProfile(catalogProfile("1"), {
    repository: { id: registry.repository.repositoryId, revision },
    base: { revision },
    catalog: { kind: "repository", path: CATALOG_PATH, blob_oid: catalogBlob },
    selection: { profile: "standard", parameters: {} },
  });
  const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;
  const requiredFeatures = new Set([...(persisted.required_features as string[]), "pinned-profiles.v1"]);
  persisted.required_features = REGISTRY_FEATURES.filter((feature) => requiredFeatures.has(feature));
  persisted.pinned_profiles = [{ ...pinned, session_id: session.sessionId }];
  fs.writeFileSync(registry.paths.registry, `${JSON.stringify(persisted)}\n`);
  registry.readRepositoryView();
  return { root, registry, sessionId: session.sessionId };
}

function collectParsedProfile(
  registry: SessionRegistry,
  sessionId: string,
  options: Parameters<typeof collectRepositoryRuntimeProfileObservation>[1],
) {
  const observation = collectRepositoryRuntimeProfileObservation(registry, options);
  const projected = getNawabariRepositoryRuntimeSnapshot({
    registry: registry.readRepositoryView(),
    captured_at: FIXED_TIME.toISOString(),
    profiles: observation,
  });
  if (!projected.ok) throw projected.error;
  const parsed = parseRepositoryRuntimeObservations(projected.value);
  if (!parsed.ok) throw parsed.error;
  const profile = parsed.value.profiles.get(sessionId);
  assert.ok(profile);
  return { observation, profile };
}

function captureRepositoryState(root: string, registry: SessionRegistry) {
  return {
    registry: fs.readFileSync(registry.paths.registry, "utf8"),
    catalog: fs.existsSync(path.join(root, CATALOG_PATH))
      ? fs.readFileSync(path.join(root, CATALOG_PATH), "utf8")
      : null,
    worktrees: runGit(["worktree", "list", "--porcelain"], root),
    view: registry.readRepositoryView(),
  };
}

function runGit(args: readonly string[], cwd: string): string {
  return String(execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
}

test("profile collection observes a current catalog change without changing registry revision or repository state", () => {
  const repository = createRepository();
  const runtime = runtimeFixture();
  try {
    const options = {
      clock: () => new Date(FIXED_TIME),
      runtimeLayout: runtime.layout,
      nix: { store_root: runtime.store, command_runner: runtime.commandRunner },
    };
    const revision = repository.registry.readRepositoryView().registryRevision;
    const firstBefore = captureRepositoryState(repository.root, repository.registry);
    const first = collectParsedProfile(repository.registry, repository.sessionId, options);
    assert.equal(first.observation.status, "available");
    assert.equal(first.observation.observed_at, FIXED_TIME.toISOString());
    assert.equal(first.profile.status, "current");
    assert.equal(first.profile.profile_id, "standard");
    assert.equal(first.profile.reason, null);
    assert.deepEqual(captureRepositoryState(repository.root, repository.registry), firstBefore);

    fs.writeFileSync(path.join(repository.root, CATALOG_PATH), catalogText("2"));
    const changedBefore = captureRepositoryState(repository.root, repository.registry);
    const changed = collectParsedProfile(repository.registry, repository.sessionId, options);
    assert.equal(changed.observation.status, "available");
    assert.equal(changed.profile.status, "drift");
    assert.equal(changed.profile.profile_id, "standard");
    assert.equal(changed.profile.reason, "profile catalog drift");
    assert.notDeepEqual(changed.observation, first.observation);
    assert.equal(repository.registry.readRepositoryView().registryRevision, revision);
    assert.deepEqual(captureRepositoryState(repository.root, repository.registry), changedBefore);
  } finally {
    runtime.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("unavailable and over-bound catalog or runtime evidence stays unknown", () => {
  const repository = createRepository();
  const runtime = runtimeFixture();
  try {
    const baseOptions = {
      clock: () => new Date(FIXED_TIME),
      runtimeLayout: runtime.layout,
      nix: { store_root: runtime.store, command_runner: runtime.commandRunner },
    };
    const unavailableRuntimeLayout: WorktreeProfileRuntimeLayout = {
      ...runtime.layout,
      platform: "unsupported-platform",
    };
    const unavailableRuntime = collectParsedProfile(repository.registry, repository.sessionId, {
      ...baseOptions,
      runtimeLayout: unavailableRuntimeLayout,
    });
    assert.equal(unavailableRuntime.observation.status, "available");
    assert.equal(unavailableRuntime.profile.status, "unknown");
    assert.equal(unavailableRuntime.profile.reason, "profile runtime evidence is unavailable");

    fs.unlinkSync(path.join(repository.root, CATALOG_PATH));
    const unavailableCatalog = collectParsedProfile(repository.registry, repository.sessionId, baseOptions);
    assert.equal(unavailableCatalog.observation.status, "available");
    assert.equal(unavailableCatalog.profile.status, "unknown");
    assert.equal(unavailableCatalog.profile.reason, "current profile catalog evidence is unavailable");

    const tooManyProfiles = Array.from({ length: 65 }, (_, index) => ({
      ...catalogProfile("1"),
      id: `profile-${index}`,
      extends: [],
    }));
    fs.writeFileSync(path.join(repository.root, CATALOG_PATH), `${JSON.stringify({ profiles: tooManyProfiles })}\n`);
    const overBoundCatalog = collectParsedProfile(repository.registry, repository.sessionId, baseOptions);
    assert.equal(overBoundCatalog.profile.status, "unknown");
    assert.equal(overBoundCatalog.profile.reason, "current profile catalog evidence is unavailable");

    fs.writeFileSync(path.join(repository.root, CATALOG_PATH), `${" ".repeat(1_048_577)}${catalogText("1")}`);
    const oversizedCatalog = collectParsedProfile(repository.registry, repository.sessionId, baseOptions);
    assert.equal(oversizedCatalog.profile.status, "unknown");
    assert.equal(oversizedCatalog.profile.reason, "current profile catalog evidence is unavailable");
  } finally {
    runtime.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});

test("profile collection rejects a registry identity change between source reads", () => {
  const repository = createRepository();
  const runtime = runtimeFixture();
  try {
    const view = repository.registry.readRepositoryView();
    let reads = 0;
    const changingRegistry = {
      repository: repository.registry.repository,
      readRepositoryView: () => {
        reads += 1;
        return reads === 1 ? view : { ...view, registryRevision: view.registryRevision + 1 };
      },
    } as unknown as SessionRegistry;
    const result = collectRepositoryRuntimeProfileObservation(changingRegistry, {
      clock: () => new Date(FIXED_TIME),
      runtimeLayout: { ...runtime.layout, platform: "unsupported-platform" },
    });
    assert.deepEqual(result, {
      status: "unknown",
      observed_at: null,
      reason: "profile observation sources changed during collection",
    });
  } finally {
    runtime.cleanup();
    fs.rmSync(repository.root, { recursive: true, force: true });
  }
});
