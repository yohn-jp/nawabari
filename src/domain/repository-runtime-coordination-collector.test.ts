import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import type { ResourceCoordinationSnapshot } from "../resource-coordination-snapshot.js";
import { getNawabariRepositoryRuntimeSnapshot } from "../repository-runtime-snapshot.js";
import { SessionRegistry } from "../session-registry.js";
import { collectRepositoryRuntimeCoordinationObservation } from "./repository-runtime-coordination-collector.js";

const FIXED_TIME = new Date("2026-09-27T00:00:00.000Z");

test("collects actual claim state with source identity and leaves repository state unchanged", () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.create();
    registry.claimResources({
      sessionId: session.sessionId,
      claims: [{ resource: "README.md", mode: "write" }],
    });

    const source = registry.readRepositoryView();
    const persistedBefore = fs.readFileSync(registry.paths.registry);
    const gitStatusBefore = runGit(["status", "--porcelain=v1"], repositoryPath);
    const observation = collectRepositoryRuntimeCoordinationObservation(registry, {
      now: () => new Date(FIXED_TIME),
    });

    assert.equal(observation.status, "available");
    if (observation.status !== "available") return;
    assert.equal(observation.observed_at, FIXED_TIME.toISOString());

    const value = observation.value as unknown as ResourceCoordinationSnapshot;
    assert.equal(value.schemaVersion, 1);
    assert.equal(value.contract.id, "resource-coordination-snapshot");
    assert.equal(value.registry.repositoryId, source.repositoryId);
    assert.equal(value.registry.registryRevision, source.registryRevision);
    assert.equal(value.registry.claimSetGeneration, source.claimSetGeneration);
    assert.equal(value.complete, false);
    assert.ok(value.incompleteReasons.includes("INCOMPLETE_AUTHORITY_EVIDENCE"));
    assert.equal(value.truncated, false);
    assert.deepEqual(
      value.resources.map((resource) => resource.resource),
      ["README.md"],
    );

    const projected = getNawabariRepositoryRuntimeSnapshot({
      registry: source,
      captured_at: FIXED_TIME.toISOString(),
      coordination: observation,
    });
    assert.equal(projected.ok, true);
    if (!projected.ok) return;
    assert.deepEqual(projected.value.observations.coordination, observation);

    assert.deepEqual(fs.readFileSync(registry.paths.registry), persistedBefore);
    assert.equal(runGit(["status", "--porcelain=v1"], repositoryPath), gitStatusBefore);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("a real claim mutation changes the observed value and bounds remain explicit", () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.create();
    const beforeSource = registry.readRepositoryView();
    const before = collectRepositoryRuntimeCoordinationObservation(registry, {
      now: () => new Date(FIXED_TIME),
    });

    registry.claimResources({
      sessionId: session.sessionId,
      claims: [
        { resource: "a.md", mode: "write" },
        { resource: "b.md", mode: "write" },
      ],
    });
    const afterSource = registry.readRepositoryView();
    const after = collectRepositoryRuntimeCoordinationObservation(registry, {
      bounds: { maxResources: 1 },
      now: () => new Date(FIXED_TIME),
    });

    assert.equal(before.status, "available");
    assert.equal(after.status, "available");
    if (before.status !== "available" || after.status !== "available") return;

    const beforeValue = before.value as unknown as ResourceCoordinationSnapshot;
    const afterValue = after.value as unknown as ResourceCoordinationSnapshot;
    assert.deepEqual(beforeValue.resources, []);
    assert.equal(afterValue.registry.repositoryId, afterSource.repositoryId);
    assert.equal(afterValue.registry.claimSetGeneration, afterSource.claimSetGeneration);
    assert.equal(afterValue.registry.registryRevision, afterSource.registryRevision);
    assert.ok(afterSource.claimSetGeneration > beforeSource.claimSetGeneration);
    assert.ok(afterSource.registryRevision > beforeSource.registryRevision);
    assert.equal(afterValue.truncated, true);
    assert.equal(afterValue.complete, false);
    assert.ok(afterValue.incompleteReasons.includes("RESOURCE_BOUND_EXCEEDED"));
    assert.deepEqual(
      afterValue.resources.map((resource) => resource.resource),
      ["a.md"],
    );
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("an unreadable registry is reported as unknown without exposing source errors", () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    registry.create();
    fs.writeFileSync(registry.paths.registry, "not-json\n");

    assert.deepEqual(collectRepositoryRuntimeCoordinationObservation(registry), {
      status: "unknown",
      observed_at: null,
      reason: "coordination source unavailable",
    });
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-runtime-coordination-"));
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "coordination collector test\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "test: seed coordination collector repository"], repositoryPath);
  return repositoryPath;
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 10_000,
  });
}
