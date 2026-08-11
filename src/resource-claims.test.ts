import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import {
  claimsConflict,
  createResourceClaim,
  RESOURCE_CLAIM_COMPATIBILITY_MATRIX,
  RESOURCE_CLAIM_MODES,
} from "./resource-claims.js";
import { SessionRegistry, type PersistedRegistry } from "./session-registry.js";

test("defines every overlapping mode combination in the compatibility matrix", () => {
  assert.deepEqual(RESOURCE_CLAIM_COMPATIBILITY_MATRIX, {
    read: { read: "compatible", write: "conflict", "exclusive-write": "conflict" },
    write: { read: "conflict", write: "conflict", "exclusive-write": "conflict" },
    "exclusive-write": { read: "conflict", write: "conflict", "exclusive-write": "conflict" },
  });

  const owner = {
    sessionId: "0190f1e0-0000-7000-8000-000000000001",
    repositoryId: "/repo/.git",
    worktreePath: "/repo",
    state: "active",
  };
  const claims = new Map(
    RESOURCE_CLAIM_MODES.map((mode) => [
      mode,
      createResourceClaim({ resource: "src/file.ts", mode }, owner, "2026-01-01T00:00:00.000Z"),
    ]),
  );
  for (const leftMode of RESOURCE_CLAIM_MODES) {
    for (const rightMode of RESOURCE_CLAIM_MODES) {
      assert.equal(
        claimsConflict(claims.get(leftMode)!, claims.get(rightMode)!),
        RESOURCE_CLAIM_COMPATIBILITY_MATRIX[leftMode][rightMode] === "conflict",
        `${leftMode}/${rightMode}`,
      );
    }
  }

  // Identical all-wildcard final segments overlap and conflict when modes differ
  const srcStarA = createResourceClaim({ resource: "src/*", mode: "write" }, owner, "2026-01-01T00:00:00.000Z");
  const srcStarB = createResourceClaim({ resource: "src/*", mode: "write" }, owner, "2026-01-01T00:00:00.000Z");
  const srcStarExclusive = createResourceClaim({ resource: "src/*", mode: "exclusive-write" }, owner, "2026-01-01T00:00:00.000Z");
  assert.equal(claimsConflict(srcStarA, srcStarB), true, "src/* write vs src/* write");
  assert.equal(claimsConflict(srcStarA, srcStarExclusive), true, "src/* write vs src/* exclusive-write");

  const starA = createResourceClaim({ resource: "*", mode: "write" }, owner, "2026-01-01T00:00:00.000Z");
  const starB = createResourceClaim({ resource: "*", mode: "write" }, owner, "2026-01-01T00:00:00.000Z");
  const starExclusive = createResourceClaim({ resource: "*", mode: "exclusive-write" }, owner, "2026-01-01T00:00:00.000Z");
  assert.equal(claimsConflict(starA, starB), true, "* write vs * write");
  assert.equal(claimsConflict(starA, starExclusive), true, "* write vs * exclusive-write");
});

test("migrates a v0.1.0 registry to the canonical claim section", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    const legacy = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as PersistedRegistry;
    delete (legacy as { claims?: unknown }).claims;
    delete (legacy as { claims_schema_version?: unknown }).claims_schema_version;
    fs.writeFileSync(registry.paths.registry, `${JSON.stringify(legacy)}\n`);

    assert.deepEqual(registry.listClaims(), []);
    const migration = registry.migrate();
    assert.deepEqual(migration, {
      migrated: true,
      registrySchemaVersion: 1,
      claimSchemaVersion: 1,
    });
    const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as PersistedRegistry;
    assert.equal(persisted.claims_schema_version, 1);
    assert.deepEqual(persisted.claims, []);
    assert.equal(registry.get(session.sessionId)?.sessionId, session.sessionId);
  } finally {
    fixture.cleanup();
  }
});

test("failed claim persistence preserves the prior registry and permits a safe retry", () => {
  const fixture = createRepositoryFixture();
  const backupPath = `${fixture.repositoryPath}-registry-backup`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    fs.renameSync(registry.paths.registry, backupPath);
    fs.mkdirSync(registry.paths.registry);
    try {
      assertRegistryError(
        () =>
          registry.claimResources({ sessionId: session.sessionId, claims: [{ resource: "README.md", mode: "read" }] }),
        "REGISTRY_IO_FAILURE",
      );
    } finally {
      fs.rmSync(registry.paths.registry, { recursive: true, force: true });
      fs.renameSync(backupPath, registry.paths.registry);
    }

    assert.equal(registry.get(session.sessionId)?.sessionId, session.sessionId);
    const retried = registry.claimResources({
      sessionId: session.sessionId,
      claims: [{ resource: "README.md", mode: "read" }],
    });
    assert.equal(retried.added.length, 1);
  } finally {
    fs.rmSync(backupPath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("rejects corrupt or unsupported persisted claim state instead of dropping it", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    registry.claimResources({ sessionId: session.sessionId, claims: [{ resource: "README.md", mode: "read" }] });
    const original = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as Record<string, unknown>;

    fs.writeFileSync(
      registry.paths.registry,
      `${JSON.stringify({ ...original, claims_schema_version: 99 }, null, 2)}\n`,
    );
    assertRegistryError(() => registry.listClaims(), "UNSUPPORTED_CLAIM_SCHEMA_VERSION");

    fs.writeFileSync(
      registry.paths.registry,
      `${JSON.stringify({ ...original, claims: [{ ...(original.claims as Array<Record<string, unknown>>)[0], resource: "../escape" }] }, null, 2)}\n`,
    );
    assertRegistryError(() => registry.listClaims(), "CLAIM_PATH_TRAVERSAL");

    fs.writeFileSync(registry.paths.registry, `${JSON.stringify(original, null, 2)}\n`);
    assert.equal(registry.listClaims().length, 1);
  } finally {
    fixture.cleanup();
  }
});

test("applies the documented overlap matrix and makes retries idempotent", () => {
  const fixture = createRepositoryFixture(true);
  try {
    const firstRegistry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = firstRegistry.create();
    const secondRegistry = new SessionRegistry({ cwd: fixture.linkedWorktreePath });
    const second = secondRegistry.create();

    const firstRead = firstRegistry.claimResources({
      sessionId: first.sessionId,
      claims: [{ resource: "src/**/*.ts", mode: "read" }],
    });
    assert.equal(firstRead.added.length, 1);
    assert.equal(firstRead.claims[0]?.resource, "src/**/*.ts");
    assert.equal(firstRead.claims[0]?.claimId, firstRead.added[0]?.claimId);

    const secondRead = secondRegistry.claimResources({
      sessionId: second.sessionId,
      claims: [{ resource: "src/file.ts", mode: "read" }],
    });
    assert.equal(secondRead.added.length, 1);

    const retry = firstRegistry.claimResources({
      sessionId: first.sessionId,
      claims: [{ resource: "src/**/*.ts", mode: "read" }],
    });
    assert.equal(retry.idempotent, true);
    assert.equal(retry.added.length, 0);
    assert.equal(retry.claims[0]?.claimId, firstRead.claims[0]?.claimId);

    assertRegistryError(
      () =>
        firstRegistry.claimResources({
          sessionId: first.sessionId,
          claims: [{ resource: "src/other.ts", mode: "write" }],
        }),
      "CONTRADICTORY_CLAIM",
    );
    assertRegistryError(
      () =>
        secondRegistry.claimResources({
          sessionId: second.sessionId,
          claims: [{ resource: "src/file.ts", mode: "write" }],
        }),
      "RESOURCE_CLAIM_CONFLICT",
    );
    assertRegistryError(
      () =>
        secondRegistry.claimResources({
          sessionId: second.sessionId,
          claims: [{ resource: "src/file.ts", mode: "exclusive-write" }],
        }),
      "RESOURCE_CLAIM_CONFLICT",
    );

    const update = firstRegistry.updateClaims({
      sessionId: first.sessionId,
      claims: [{ resource: "docs/**", mode: "write" }],
    });
    assert.equal(update.released.length, 1);
    assert.equal(update.added.length, 1);
    assert.deepEqual(
      firstRegistry.listClaims(first.sessionId).map((claim) => claim.resource),
      ["docs/**"],
    );

    const released = firstRegistry.releaseClaims(first.sessionId);
    assert.equal(released.released.length, 1);
    assert.equal(released.remaining.length, 0);
    assert.equal(firstRegistry.releaseClaims(first.sessionId).idempotent, true);

    const retryClaim = firstRegistry.claimResources({
      sessionId: first.sessionId,
      claims: [{ resource: "src/retry.ts", mode: "write" }],
    }).added[0];
    assert.ok(retryClaim);
    assert.equal(firstRegistry.releaseClaims(first.sessionId, [retryClaim.claimId]).idempotent, false);
    assert.equal(firstRegistry.releaseClaims(first.sessionId, [retryClaim.claimId]).idempotent, true);
  } finally {
    fixture.cleanup();
  }
});

test("rejects traversal, ambiguous normalization, unsupported globs, symlinks, and identity mismatch", () => {
  const fixture = createRepositoryFixture();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-claim-outside-"));
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    fs.symlinkSync(outside, path.join(fixture.repositoryPath, "escape"), "dir");

    for (const [resource, code] of [
      ["../outside.txt", "CLAIM_PATH_TRAVERSAL"],
      ["src/../outside.txt", "CLAIM_PATH_TRAVERSAL"],
      ["/absolute.txt", "CLAIM_PATH_TRAVERSAL"],
      ["C:outside.txt", "CLAIM_PATH_TRAVERSAL"],
      ["src//file.ts", "CLAIM_AMBIGUOUS_PATH"],
      ["src/./file.ts", "CLAIM_AMBIGUOUS_PATH"],
      ["src\\file.ts", "CLAIM_AMBIGUOUS_PATH"],
      ["src/[a].ts", "UNSUPPORTED_CLAIM_GLOB"],
      ["src/**/file**.ts", "UNSUPPORTED_CLAIM_GLOB"],
      ["escape/file.ts", "CLAIM_SYMLINK_ESCAPE"],
    ] as const) {
      assertRegistryError(
        () => registry.claimResources({ sessionId: session.sessionId, claims: [{ resource, mode: "read" }] }),
        code,
      );
    }
    assertRegistryError(
      () =>
        registry.claimResources({
          sessionId: session.sessionId,
          repositoryId: `${registry.repository.repositoryId}-other`,
          claims: [{ resource: "src/file.ts", mode: "read" }],
        }),
      "CLAIM_REPOSITORY_MISMATCH",
    );
    assertRegistryError(
      () =>
        registry.claimResources({
          sessionId: session.sessionId,
          claims: [{ resource: "src/file.ts", mode: "read", sessionId: "0190f1e0-0000-7000-8000-000000000001" }],
        }),
      "CLAIM_SESSION_MISMATCH",
    );
    assert.deepEqual(registry.listClaims(), []);
  } finally {
    fs.rmSync(outside, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("close releases claims only after conservative cleanup succeeds", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(
    path.dirname(fixture.repositoryPath),
    `${path.basename(fixture.repositoryPath)}-claim-close`,
  );
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/claim-close" });
    const worktreeRegistry = new SessionRegistry({ cwd: worktreePath });
    worktreeRegistry.claimResources({
      sessionId: session.sessionId,
      claims: [{ resource: "src/file.ts", mode: "write" }],
    });
    assert.equal(worktreeRegistry.listClaims(session.sessionId).length, 1);

    const closed = registry.close(session.sessionId);
    assert.equal(closed.session.state, "closed");
    assert.deepEqual(registry.listClaims(), []);
    assert.equal(closed.idempotent, false);
    assert.equal(registry.close(session.sessionId).idempotent, true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("GC releases claims when a session worktree is externally pruned", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(
    path.dirname(fixture.repositoryPath),
    `${path.basename(fixture.repositoryPath)}-claim-gc`,
  );
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/claim-gc" });
    const worktreeRegistry = new SessionRegistry({ cwd: worktreePath });
    worktreeRegistry.claimResources({
      sessionId: session.sessionId,
      claims: [{ resource: "src/file.ts", mode: "write" }],
    });

    fs.rmSync(worktreePath, { recursive: true, force: true });
    const collected = registry.garbageCollect({ apply: true });
    assert.deepEqual(collected.blocked, []);
    assert.deepEqual(
      collected.cleaned.map((record) => record.sessionId),
      [session.sessionId],
    );
    assert.deepEqual(registry.listClaims(), []);
    assert.equal(registry.get(session.sessionId)?.state, "closed");
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("concurrent conflicting acquisitions serialize to one winner without corrupting ownership", async () => {
  const fixture = createRepositoryFixture(true);
  const worktreePaths = [fixture.repositoryPath, fixture.linkedWorktreePath];
  try {
    const first = new SessionRegistry({ cwd: fixture.repositoryPath }).create();
    const second = new SessionRegistry({ cwd: fixture.linkedWorktreePath }).create();
    const worker = fileURLToPath(new URL("../scripts/resource-claim-worker.mjs", import.meta.url));
    const results = await Promise.all([
      runWorker(worker, [fixture.repositoryPath, first.sessionId, "src/shared.ts", "write"]),
      runWorker(worker, [fixture.repositoryPath, second.sessionId, "src/shared.ts", "write"]),
    ]);
    assert.equal(results.filter((result) => result.ok).length, 1, JSON.stringify(results));
    assert.equal(
      results.filter((result) => result.code === "RESOURCE_CLAIM_CONFLICT").length,
      1,
      JSON.stringify(results),
    );
    const claims = new SessionRegistry({ cwd: fixture.repositoryPath }).listClaims();
    assert.equal(claims.length, 1);
    assert.equal(new Set(claims.map((claim) => claim.sessionId)).size, 1);
    assert.equal(new SessionRegistry({ cwd: fixture.repositoryPath }).list().length, 2);
  } finally {
    for (const worktreePath of worktreePaths.slice(1)) {
      removeWorktree(fixture.repositoryPath, worktreePath);
    }
    fixture.cleanup();
  }
});

interface RepositoryFixture {
  readonly repositoryPath: string;
  readonly linkedWorktreePath: string;
  cleanup(): void;
}

function createRepositoryFixture(withLinkedWorktree = false): RepositoryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-claims-"));
  const linkedWorktreePath = path.join(path.dirname(repositoryPath), `${path.basename(repositoryPath)}-linked`);
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.mkdirSync(path.join(repositoryPath, "src"), { recursive: true });
  fs.writeFileSync(path.join(repositoryPath, "src", "file.ts"), "export {}\n");
  runGit(["add", "src/file.ts"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  if (withLinkedWorktree) runGit(["worktree", "add", "-b", "feature/linked", linkedWorktreePath], repositoryPath);

  return {
    repositoryPath,
    linkedWorktreePath,
    cleanup(): void {
      if (withLinkedWorktree) removeWorktree(repositoryPath, linkedWorktreePath);
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
  } catch {
    // The directory cleanup below remains safe after external removal.
  }
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function runGit(args: readonly string[], cwd: string): string {
  return String(
    execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 10_000,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null", GIT_TERMINAL_PROMPT: "0" },
    }),
  ).trim();
}

function assertRegistryError(operation: () => unknown, code: SessionRegistryError["code"]): void {
  assert.throws(operation, (error: unknown) => error instanceof SessionRegistryError && error.code === code);
}

function runWorker(worker: string, args: readonly string[]): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", worker, ...args], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (stdout += chunk));
    child.stderr.on("data", (chunk: string) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => {
      try {
        resolve(JSON.parse(stdout) as { ok: boolean; code?: string });
      } catch {
        reject(new Error(`claim worker exited with ${code}: ${stderr}`));
      }
    });
  });
}
