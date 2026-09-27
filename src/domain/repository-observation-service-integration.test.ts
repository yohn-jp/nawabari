import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { parseRepositoryRuntimeObservations } from "../repository-runtime-observations.js";
import {
  REPOSITORY_FILESYSTEM_OBSERVATION_V2,
  REPOSITORY_LIFECYCLE_OBSERVATION_V2,
  REPOSITORY_PROFILE_OBSERVATION_V1,
} from "../repository-runtime-observations.js";
import type { JsonObject, JsonValue } from "./errors.js";
import type { RepositoryRuntimeObservation } from "../repository-runtime-snapshot.js";
import { REPOSITORY_RUNTIME_SNAPSHOT_CONTRACT_ID } from "../repository-runtime-snapshot.js";
import { REGISTRY_FEATURES } from "../registry/runtime-records.js";
import { SessionRegistry } from "../session-registry.js";
import { collectRepositoryRuntimeSnapshot } from "./repository-observation-service.js";
import { builtinWorktreeProfileRevision, pinWorktreeProfile } from "./worktree-profile-pinning.js";
import { resolveBuiltinWorktreeProfile } from "./worktree-profile-builtins.js";

test("composes real repository observations, reobserves Git changes, and leaves canonical state untouched", () => {
  const fixture = createRepository(true);
  try {
    const beforeFirstRead = captureRepositoryState(fixture.root, fixture.registry);
    const firstResult = collectRepositoryRuntimeSnapshot(fixture.registry);
    assert.equal(firstResult.ok, true);
    if (!firstResult.ok) return;

    const first = firstResult.value;
    assert.equal(first.contract_id, REPOSITORY_RUNTIME_SNAPSHOT_CONTRACT_ID);
    assert.equal(first.schema_version, 1);
    assert.equal(first.observations.coordination.status, "available");
    assert.equal(first.observations.profiles.status, "available");
    assert.equal(first.observations.filesystem.status, "available");
    assert.equal(first.observations.lifecycle.status, "available");
    assert.equal(first.observations.processes.status, "available");

    const coordination = first.observations.coordination;
    assert.equal(coordination.status, "available");
    if (coordination.status !== "available") return;
    assert.equal((coordination.value as unknown as { complete: boolean }).complete, false);

    const profileContent = availableContent(first.observations.profiles);
    assert.equal(profileContent.contract_id, REPOSITORY_PROFILE_OBSERVATION_V1);
    assert.equal(profileContent.schema_version, 1);
    const filesystemContent = availableContent(first.observations.filesystem);
    assert.equal(filesystemContent.contract_id, REPOSITORY_FILESYSTEM_OBSERVATION_V2);
    assert.equal(filesystemContent.schema_version, 2);
    const lifecycleContent = availableContent(first.observations.lifecycle);
    assert.equal(lifecycleContent.contract_id, REPOSITORY_LIFECYCLE_OBSERVATION_V2);
    assert.equal(lifecycleContent.schema_version, 2);

    const firstParsed = parseRepositoryRuntimeObservations(first);
    assert.equal(firstParsed.ok, true);
    if (!firstParsed.ok) return;
    assert.equal(firstParsed.value.profiles.get(fixture.sessionId)?.profile_id, "minimal");
    assert.ok(firstParsed.value.filesystem.has(fixture.sessionId));
    assert.equal(firstParsed.value.processes.get(fixture.sessionId)?.status, "unknown");
    assert.equal(firstParsed.value.lifecycle.get(fixture.sessionId)?.recoverable_work, "absent");
    assert.deepEqual(captureRepositoryState(fixture.root, fixture.registry), beforeFirstRead);

    fs.writeFileSync(path.join(fixture.root, "live-change.txt"), "current worktree evidence\n");
    const gitStateBeforeSecondRead = captureRepositoryState(fixture.root, fixture.registry);
    assert.notEqual(gitStateBeforeSecondRead.status, beforeFirstRead.status);
    assert.equal(gitStateBeforeSecondRead.view.registryRevision, beforeFirstRead.view.registryRevision);

    const secondResult = collectRepositoryRuntimeSnapshot(fixture.registry);
    assert.equal(secondResult.ok, true);
    if (!secondResult.ok) return;
    const second = secondResult.value;
    assert.equal(second.registry.revision, first.registry.revision);
    const firstLifecycle = first.observations.lifecycle;
    const secondLifecycle = second.observations.lifecycle;
    const firstFilesystem = first.observations.filesystem;
    const secondFilesystem = second.observations.filesystem;
    assert.equal(firstLifecycle.status, "available");
    assert.equal(secondLifecycle.status, "available");
    assert.equal(firstFilesystem.status, "available");
    assert.equal(secondFilesystem.status, "available");
    if (
      firstLifecycle.status !== "available" ||
      secondLifecycle.status !== "available" ||
      firstFilesystem.status !== "available" ||
      secondFilesystem.status !== "available"
    ) {
      return;
    }
    assert.notDeepEqual(secondLifecycle.value, firstLifecycle.value);
    assert.notDeepEqual(secondFilesystem.value, firstFilesystem.value);

    const secondParsed = parseRepositoryRuntimeObservations(second);
    assert.equal(secondParsed.ok, true);
    if (!secondParsed.ok) return;
    assert.equal(secondParsed.value.lifecycle.get(fixture.sessionId)?.recoverable_work, "present");
    assert.equal(secondParsed.value.filesystem.get(fixture.sessionId)?.policy_status, "violation");
    assert.deepEqual(captureRepositoryState(fixture.root, fixture.registry), gitStateBeforeSecondRead);
  } finally {
    fixture.cleanup();
  }
});

test("missing pinned policy remains explicit instead of becoming an empty policy", () => {
  const fixture = createRepository(false);
  try {
    const result = collectRepositoryRuntimeSnapshot(fixture.registry);
    assert.equal(result.ok, true);
    if (!result.ok) return;

    const parsed = parseRepositoryRuntimeObservations(result.value);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.value.filesystem.get(fixture.sessionId)?.policy_status, "unknown");
    assert.equal(parsed.value.filesystem.get(fixture.sessionId)?.owner, "unknown");
  } finally {
    fixture.cleanup();
  }
});

test("repeated registry changes leave every composed observation unknown", () => {
  const fixture = createRepository(true);
  try {
    let reads = 0;
    const changingRegistry = new Proxy(fixture.registry, {
      get(target, property) {
        if (property === "readRepositoryView") {
          return () => {
            reads += 1;
            const view = target.readRepositoryView();
            return { ...view, registryRevision: view.registryRevision + reads };
          };
        }
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

    const result = collectRepositoryRuntimeSnapshot(changingRegistry);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.value.complete, false);
    assert.ok(result.value.incomplete_reasons.length > 0);
    for (const observation of Object.values(result.value.observations)) {
      assert.equal(observation.status, "unknown");
      if (observation.status === "unknown") {
        assert.match(observation.reason, /registry changed during observation collection/u);
      }
    }
  } finally {
    fixture.cleanup();
  }
});

function createRepository(withPinnedProfile: boolean): {
  readonly root: string;
  readonly registry: SessionRegistry;
  readonly sessionId: string;
  readonly cleanup: () => void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-observation-service-"));
  runGit(["init", "--quiet", "--initial-branch=main"], root);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], root);
  runGit(["config", "user.name", "Nawabari Tests"], root);
  runGit(["config", "commit.gpgsign", "false"], root);
  runGit(["config", "core.hooksPath", "/dev/null"], root);
  fs.writeFileSync(path.join(root, "README.md"), "repository observation fixture\n");
  runGit(["add", "README.md"], root);
  runGit(["commit", "--quiet", "-m", "initial"], root);

  const registry = new SessionRegistry({ cwd: root });
  const session = registry.create();
  if (withPinnedProfile) pinBuiltinProfile(root, registry, session.sessionId);
  return {
    root,
    registry,
    sessionId: session.sessionId,
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function pinBuiltinProfile(root: string, registry: SessionRegistry, sessionId: string): void {
  const resolved = resolveBuiltinWorktreeProfile({ profile: "minimal" });
  if (!resolved.ok) throw resolved.error;
  const baseRevision = runGit(["rev-parse", "HEAD"], root);
  const pinned = pinWorktreeProfile(resolved.value, {
    repository: { id: registry.repository.repositoryId, revision: baseRevision },
    base: { revision: baseRevision },
    catalog: {
      kind: "builtin",
      id: "minimal",
      revision: builtinWorktreeProfileRevision("minimal"),
    },
    selection: { profile: "minimal", parameters: {} },
  });

  const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;
  const currentFeatures = Array.isArray(persisted.required_features)
    ? persisted.required_features.filter((value): value is string => typeof value === "string")
    : [];
  const required = new Set([...currentFeatures, "pinned-profiles.v1"]);
  persisted.required_features = REGISTRY_FEATURES.filter((feature) => required.has(feature));
  persisted.pinned_profiles = [{ ...pinned, session_id: sessionId }];
  fs.writeFileSync(registry.paths.registry, `${JSON.stringify(persisted, null, 2)}\n`);
  registry.readRepositoryView();
}

function captureRepositoryState(root: string, registry: SessionRegistry) {
  return {
    registryBytes: fs.readFileSync(registry.paths.registry),
    registryEntries: fs.readdirSync(registry.paths.directory).sort(),
    view: registry.readRepositoryView(),
    head: runGit(["rev-parse", "HEAD"], root),
    branch: runGit(["branch", "--show-current"], root),
    status: runGit(["status", "--porcelain=v1", "--untracked-files=all"], root),
    worktrees: runGit(["worktree", "list", "--porcelain"], root),
  };
}

function availableContent(observation: RepositoryRuntimeObservation<JsonValue>): JsonObject {
  assert.equal(observation.status, "available");
  if (observation.status !== "available") return {};
  assert.equal(typeof observation.value, "object");
  assert.ok(observation.value !== null && !Array.isArray(observation.value));
  return observation.value as JsonObject;
}

function runGit(args: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", [...args], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: {
        ...process.env,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_TERMINAL_PROMPT: "0",
      },
    }),
  ).trim();
}
