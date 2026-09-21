import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import { resolveRepositoryContext } from "./git.js";
import { RepositoryLock } from "./registry/lock.js";
import { SessionRegistry, toPersistedSessionRecord, type PersistedRegistry } from "./session-registry.js";
import { withDirectoryFsyncFailure, withRegistryTempFileFsyncFailure } from "./testing/fs-fault-injection.js";

test("round-trips session metadata through common Git state", () => {
  const fixture = createRepositoryFixture();
  try {
    const clock = () => new Date("2026-01-02T03:04:05.006Z");
    const mainRegistry = new SessionRegistry({ cwd: fixture.repositoryPath, clock });
    const linkedRegistry = new SessionRegistry({ cwd: fixture.linkedWorktreePath, clock });

    const mainSession = mainRegistry.create({ label: "same human label" });
    const linkedSession = linkedRegistry.create({ label: "same human label" });

    assert.equal(mainSession.schemaVersion, 1);
    assert.equal(mainSession.state, "active");
    assert.equal(mainSession.repositoryId, mainRegistry.repository.repositoryId);
    assert.equal(mainSession.worktreePath, fixture.repositoryPath);
    assert.equal(mainSession.worktreeId, mainSession.worktreePath);
    assert.equal(mainSession.branchId, "refs/heads/main");
    assert.equal(mainSession.branchName, "main");
    assert.equal(mainSession.createdAt, "2026-01-02T03:04:05.006Z");
    assert.equal(mainSession.updatedAt, mainSession.createdAt);
    assert.equal(linkedSession.branchId, "refs/heads/feature/linked");

    assert.equal(mainRegistry.paths.registry, linkedRegistry.paths.registry);
    assert.deepEqual(
      mainRegistry.list().map((record) => record.sessionId),
      [mainSession.sessionId, linkedSession.sessionId],
    );
    assert.equal(linkedRegistry.resolveCurrentSession().sessionId, linkedSession.sessionId);
    assert.equal(mainRegistry.get(mainSession.sessionId)?.label, "same human label");

    const persisted = readJson(mainRegistry.paths.registry) as PersistedRegistry;
    assert.equal(persisted.schema_version, 2);
    assert.equal(registryRevision(mainRegistry), 2);
    assert.equal(persisted.runtime_epoch, 2);
    assert.deepEqual(persisted.required_features, []);
    assert.equal(persisted.repository_id, mainRegistry.repository.repositoryId);
    assert.equal(persisted.sessions.length, 2);
    assert.equal(persisted.sessions[0].session_id, mainSession.sessionId);
  } finally {
    fixture.cleanup();
  }
});

test("expands a governed working set atomically with revision CAS and claim checks", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = path.join(path.dirname(fixture.repositoryPath), "nawabari-expansion");
  try {
    const repository = resolveRepositoryContext({ cwd: fixture.repositoryPath });
    const revision = runGit(["rev-parse", "HEAD"], fixture.repositoryPath);
    const identity = { repositoryHost: "local", repositoryId: repository.repositoryId };
    const executionScope = {
      version: 1,
      kind: "implementation-execution-scope",
      authorization: {
        version: 1,
        kind: "implementation-authorization",
        contractVersion: 1,
        implementation: { ...identity, number: 376 },
        governedBodyDigest: "b".repeat(64),
      },
      repository: identity,
      base: { branch: "main", revision },
      scope: {
        readOnly: ["README.md", "src/**"],
        write: ["src/new.ts"],
        create: [],
        delete: [],
        deny: ["src/secret.ts"],
      },
    };
    const candidateWorkingSet = {
      kind: "candidate-working-set",
      schemaVersion: 1,
      workingSetId: "candidate-376",
      repository: { ...identity, repository: "local/nawabari" },
      revision,
      entries: [
        {
          state: "required",
          target: { kind: "file", locator: "README.md" },
          reason: { id: "test:bootstrap", summary: "bounded fixture" },
          evidence: [],
        },
      ],
    };
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({
      worktreePath,
      branchName: "feature/expansion",
      executionScope,
      candidateWorkingSet,
      initialClaims: [{ resource: "src/new.ts", mode: "write" }],
    });
    const expanded = registry.expandWorkingSet({
      sessionId: session.sessionId,
      repository: identity,
      currentRevision: 1,
      executionScope,
      entries: [{ path: "src/new.ts", operation: "WRITE", reason: "legitimate mutation context" }],
    });
    assert.equal(expanded.status, "granted");
    assert.equal(expanded.revision, 2);
    assert.deepEqual(expanded.workingSet.scope.write, ["src/new.ts"]);

    assertRegistryError(
      () =>
        registry.expandWorkingSet({
          sessionId: session.sessionId,
          repository: identity,
          currentRevision: 1,
          executionScope,
          entries: [{ path: "src/other.ts", operation: "READONLY", reason: "stale" }],
        }),
      "STALE_REGISTRY",
    );
    const denied = registry.expandWorkingSet({
      sessionId: session.sessionId,
      repository: identity,
      currentRevision: 2,
      executionScope,
      entries: [{ path: "src/secret.ts", operation: "READONLY", reason: "denied" }],
    });
    assert.equal(denied.status, "denied");
    assert.equal(denied.revision, 2);
    assert.equal(registry.get(session.sessionId)?.workingSet?.revision, 2);
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktreePath], fixture.repositoryPath);
    } catch {
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    fixture.cleanup();
  }
});

test("keeps human labels separate from session identity", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.create({ label: "worker" });
    const second = registry.create({
      worktreePath: fixture.linkedWorktreePath,
      branchName: "feature/linked",
      label: "worker",
    });

    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(first.label, second.label);
    assert.equal(registry.list().length, 2);
  } finally {
    fixture.cleanup();
  }
});

test("rejects an empty label before writing unreadable registry state", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    assertRegistryError(() => registry.create({ label: "" }), "INVALID_SESSION_RECORD");
    assert.deepEqual(registry.list(), []);
  } finally {
    fixture.cleanup();
  }
});

test("rejects an empty label through register before writing unreadable registry state", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = makeDirectory("nawabari-register-label-");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    const candidate = {
      ...session,
      sessionId: "01936f5e-7b00-7abc-8def-0123456789ab",
      worktreeId: worktreePath,
      worktreePath,
      branchId: "refs/heads/feature/register-label",
      branchName: "feature/register-label",
      label: "",
    };

    assertRegistryError(() => registry.register(candidate), "INVALID_SESSION_RECORD");
    assert.equal(registry.list().length, 1);
    assert.equal(registry.list()[0]?.label, undefined);
  } finally {
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("rejects duplicate worktree, branch, and session ownership", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.create({ label: "first" });

    assertRegistryError(() => registry.create({ branchName: "feature/other" }), "BRANCH_MISMATCH");
    const second = registry.create({ worktreePath: fixture.linkedWorktreePath, branchName: "feature/linked" });
    assertRegistryError(
      () => registry.create({ worktreePath: fixture.linkedWorktreePath, branchName: "feature/other" }),
      "BRANCH_MISMATCH",
    );
    assertRegistryError(
      () => registry.create({ worktreePath: fixture.linkedWorktreePath, branchName: "feature/linked" }),
      "DUPLICATE_WORKTREE_OWNERSHIP",
    );

    const duplicateIdRegistry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      idGenerator: () => first.sessionId,
    });
    assertRegistryError(
      () => duplicateIdRegistry.create({ worktreePath: fixture.repositoryPath, branchName: "main" }),
      "SESSION_ID_COLLISION",
    );
  } finally {
    fixture.cleanup();
  }
});

test("fails closed for corrupt, unsupported, and repository-mismatched state", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    fs.mkdirSync(registry.paths.directory, { recursive: true });

    fs.writeFileSync(registry.paths.registry, "{not json\n");
    assertRegistryError(() => registry.list(), "REGISTRY_CORRUPT");

    writeRegistry(registry, {
      schema_version: 999,
      repository_id: registry.repository.repositoryId,
      sessions: [],
    } as unknown as PersistedRegistry);
    assertRegistryError(() => registry.list(), "UNSUPPORTED_SCHEMA_VERSION");

    writeRegistry(registry, {
      schema_version: 1,
      repository_id: path.join(registry.repository.commonGitDirectory, "different-repository"),
      sessions: [],
    });
    assertRegistryError(() => registry.list(), "REGISTRY_REPOSITORY_MISMATCH");
  } finally {
    fixture.cleanup();
  }
});

test("fails closed when persisted records contain duplicate ownership", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.create({ label: "first" });
    const persisted = toPersistedSessionRecord(first);
    writeRegistry(registry, {
      schema_version: 1,
      repository_id: registry.repository.repositoryId,
      sessions: [persisted, { ...persisted, session_id: "01936f5e-7b00-7abc-8def-0123456789ab" }],
    });

    assertRegistryError(() => registry.list(), "DUPLICATE_WORKTREE_OWNERSHIP");
  } finally {
    fixture.cleanup();
  }
});

test("migrates a legacy registry without changing session ownership or claim mode", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    const claim = registry.claimResources({
      sessionId: session.sessionId,
      claims: [{ resource: "README.md", mode: "write" }],
    }).claims[0];
    assert.ok(claim);

    const legacy = readJson(registry.paths.registry) as Record<string, unknown>;
    legacy.schema_version = 1;
    delete legacy.registry_revision;
    delete legacy.runtime_epoch;
    delete legacy.required_features;
    fs.writeFileSync(registry.paths.registry, `${JSON.stringify(legacy)}\n`);

    const result = registry.migrate();
    assert.equal(result.migrated, true);
    const migrated = readJson(registry.paths.registry) as PersistedRegistry;
    assert.equal(migrated.schema_version, 2);
    assert.equal(migrated.claims_schema_version, 2);
    assert.equal(migrated.sessions[0]?.session_id, session.sessionId);
    assert.equal((migrated.claims?.[0] as { mode?: string } | undefined)?.mode, "write");
    assert.equal(registry.listClaims()[0]?.sessionId, session.sessionId);
    assert.equal(registry.listClaims()[0]?.mode, "write");
  } finally {
    fixture.cleanup();
  }
});

test("close advances registry revision for both lifecycle writes", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.linkedWorktreePath });
    const session = registry.create();
    const before = registryRevision(registry);

    const result = registry.close(session.sessionId);

    assert.equal(result.session.state, "closed");
    const after = registryRevision(registry);
    assert.equal(after, before + 2);
  } finally {
    fixture.cleanup();
  }
});

test("discard advances registry revision for both lifecycle writes", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.linkedWorktreePath });
    const session = registry.create();
    const before = registryRevision(registry);

    const result = registry.discard(session.sessionId);

    assert.equal(result.session.state, "closed");
    const after = registryRevision(registry);
    assert.equal(after, before + 2);
  } finally {
    fixture.cleanup();
  }
});

test("garbage collection does not reuse a registry revision across stale candidates", () => {
  const fixture = createRepositoryFixture();
  const secondWorktreePath = path.join(
    path.dirname(fixture.repositoryPath),
    `${path.basename(fixture.repositoryPath)}-second`,
  );
  try {
    runGit(["worktree", "add", "-b", "feature/second", secondWorktreePath], fixture.repositoryPath);
    const linkedRegistry = new SessionRegistry({ cwd: fixture.linkedWorktreePath });
    const secondRegistry = new SessionRegistry({ cwd: secondWorktreePath });
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const linkedSession = linkedRegistry.create();
    const secondSession = secondRegistry.create();
    const before = registryRevision(registry);

    fs.rmSync(fixture.linkedWorktreePath, { recursive: true, force: true });
    fs.rmSync(secondWorktreePath, { recursive: true, force: true });

    const result = registry.garbageCollect({ apply: true, staleAfterMs: 0 });

    assert.deepEqual(
      result.cleaned.map((record) => record.sessionId).sort(),
      [linkedSession.sessionId, secondSession.sessionId].sort(),
    );
    assert.deepEqual(result.blocked, []);
    assert.equal(registryRevision(registry), before + 6);
    assert.equal(
      registry.list().every((record) => record.state === "closed"),
      true,
    );
  } finally {
    try {
      runGit(["worktree", "remove", "--force", secondWorktreePath], fixture.repositoryPath);
    } catch {
      // The fixture cleanup remains safe when GC already removed the branch.
    }
    fs.rmSync(secondWorktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("does not rewrite a registry containing an unsupported feature", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    registry.create();
    const unsupported = readJson(registry.paths.registry) as Record<string, unknown>;
    unsupported.required_features = ["future.v1"];
    fs.writeFileSync(registry.paths.registry, `${JSON.stringify(unsupported)}\n`);
    const before = fs.readFileSync(registry.paths.registry, "utf8");

    assertRegistryError(() => registry.create(), "REGISTRY_FEATURE_UNSUPPORTED");
    assert.equal(fs.readFileSync(registry.paths.registry, "utf8"), before);
  } finally {
    fixture.cleanup();
  }
});

test("toPersistedSessionRecord validates against the caller's expected repository", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.create();
    assertRegistryError(
      () =>
        toPersistedSessionRecord({ ...session, repositoryId: `${session.repositoryId}-other` }, session.repositoryId),
      "REGISTRY_REPOSITORY_MISMATCH",
    );
  } finally {
    fixture.cleanup();
  }
});

test("recovers a stale session lock only when local process identity proves it dead", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      lockTimeoutMs: 50,
      lockStaleAfterMs: 0,
      lockMetadataGraceMs: 0,
    });
    fs.mkdirSync(registry.paths.directory, { recursive: true });
    fs.mkdirSync(registry.paths.lock, { recursive: true });
    fs.writeFileSync(
      path.join(registry.paths.lock, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        token: "dead-owner",
        pid: process.pid,
        hostname: os.hostname(),
        processStartTime: "0",
        acquiredAt: new Date(Date.now() - 10_000).toISOString(),
      })}\n`,
    );

    const session = registry.create({ label: "recovered" });
    assert.equal(session.label, "recovered");
    assert.equal(fs.existsSync(registry.paths.lock), false);
  } finally {
    fixture.cleanup();
  }
});

test("does not steal a stale session lock whose owner cannot be verified dead", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      lockTimeoutMs: 0,
      lockStaleAfterMs: 0,
      lockMetadataGraceMs: 0,
    });
    fs.mkdirSync(registry.paths.directory, { recursive: true });
    fs.mkdirSync(registry.paths.lock, { recursive: true });
    fs.writeFileSync(
      path.join(registry.paths.lock, "owner.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        token: "remote-owner",
        pid: 1,
        hostname: `${os.hostname()}-remote`,
        processStartTime: "1",
        acquiredAt: new Date(Date.now() - 10_000).toISOString(),
      })}\n`,
    );

    assertRegistryError(() => registry.create(), "REGISTRY_LOCK_TIMEOUT");
    assert.equal(fs.existsSync(registry.paths.lock), true);
  } finally {
    fixture.cleanup();
  }
});

test("shares the repository lock format with the generic mutation boundary", async () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath, lockTimeoutMs: 0 });
    const externalLock = new RepositoryLock({
      lockPath: registry.paths.lock,
      staleAfterMs: 60_000,
      acquireTimeoutMs: 0,
    });
    const lease = await externalLock.acquire();
    try {
      assertRegistryError(() => registry.create(), "REGISTRY_LOCK_TIMEOUT");
    } finally {
      await lease.release();
    }
    assert.equal(registry.create().state, "active");
  } finally {
    fixture.cleanup();
  }
});

test("serializes concurrent creates without losing updates or duplicating ownership", { timeout: 30_000 }, async () => {
  const fixture = createRepositoryFixture();
  const worktreePaths = Array.from({ length: 8 }, (_, index) =>
    path.join(path.dirname(fixture.repositoryPath), `${path.basename(fixture.repositoryPath)}-concurrent-${index}`),
  );
  try {
    for (const [index, worktreePath] of worktreePaths.entries()) {
      runGit(["worktree", "add", "-b", `feature/concurrent-${index}`, worktreePath], fixture.repositoryPath);
    }
    const workerPath = fileURLToPath(new URL("../scripts/session-registry-worker.mjs", import.meta.url));
    const results = await Promise.all(
      worktreePaths.map((worktreePath, index) =>
        runWorker(workerPath, [fixture.repositoryPath, worktreePath, `feature/concurrent-${index}`, "25000"]),
      ),
    );
    assert.equal(new Set(results).size, worktreePaths.length);

    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const records = registry.list();
    assert.equal(records.length, worktreePaths.length);
    assert.equal(new Set(records.map((record) => record.worktreeId)).size, records.length);
    assert.equal(new Set(records.map((record) => record.branchId)).size, records.length);
  } finally {
    for (const worktreePath of worktreePaths) {
      try {
        runGit(["worktree", "remove", "--force", worktreePath], fixture.repositoryPath);
      } catch {
        // The directory cleanup below is sufficient if creation failed.
      }
      fs.rmSync(worktreePath, { recursive: true, force: true });
    }
    fixture.cleanup();
  }
});

test("does not resolve a closed record as the current owner", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      clock: () => new Date("2026-01-01T00:00:00.000Z"),
    });
    const session = registry.create();
    const persisted = toPersistedSessionRecord({ ...session, state: "closed", updatedAt: "2026-01-01T00:00:01.000Z" });
    writeRegistry(registry, {
      schema_version: 1,
      repository_id: registry.repository.repositoryId,
      sessions: [persisted],
    });

    assertRegistryError(() => registry.resolveCurrentSession(), "SESSION_NOT_FOUND");
  } finally {
    fixture.cleanup();
  }
});

test("an unexpected post-rename directory-sync failure is reported durability-uncertain, not an ordinary IO failure", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    assert.throws(
      () => withDirectoryFsyncFailure(registry.paths.directory, "EIO", () => registry.create()),
      (error: unknown) => {
        assert.ok(error instanceof SessionRegistryError);
        assert.equal(error.code, "REGISTRY_DURABILITY_UNCERTAIN");
        return true;
      },
    );
    // The rename already committed the document; the failure only means
    // directory durability could not be proven, not that nothing happened.
    assert.equal(new SessionRegistry({ cwd: fixture.repositoryPath }).list().length, 1);
    assert.equal(fs.existsSync(registry.paths.registry), true);
  } finally {
    fixture.cleanup();
  }
});

test("a known unsupported directory-fsync condition does not fail an ordinary mutation", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = withDirectoryFsyncFailure(registry.paths.directory, "EINVAL", () => registry.create());
    assert.equal(registry.list().length, 1);
    assert.equal(registry.get(session.sessionId)?.sessionId, session.sessionId);
  } finally {
    fixture.cleanup();
  }
});

test("an unexpected pre-rename write failure never produces a successful mutation", () => {
  const fixture = createRepositoryFixture();
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    // Targets only the registry's own temporary-file fsync: an unconditional
    // override would also fail RepositoryLock.acquireSync()'s owner.json
    // write, which happens first, and the resulting lock failure would
    // incidentally normalize to the same REGISTRY_IO_FAILURE code without
    // ever exercising writeUnsafe()'s pre-rename path at all.
    assertRegistryError(
      () => withRegistryTempFileFsyncFailure(registry.paths.directory, "EIO", () => registry.create()),
      "REGISTRY_IO_FAILURE",
    );
    assert.deepEqual(registry.list(), []);
    assert.equal(fs.existsSync(registry.paths.registry), false);
  } finally {
    fixture.cleanup();
  }
});

interface RepositoryFixture {
  readonly repositoryPath: string;
  readonly linkedWorktreePath: string;
  cleanup(): void;
}

function createRepositoryFixture(): RepositoryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-registry-"));
  const linkedWorktreePath = path.join(path.dirname(repositoryPath), `${path.basename(repositoryPath)}-linked`);
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  runGit(["worktree", "add", "-b", "feature/linked", linkedWorktreePath], repositoryPath);

  return {
    repositoryPath,
    linkedWorktreePath,
    cleanup(): void {
      try {
        runGit(["worktree", "remove", "--force", linkedWorktreePath], repositoryPath);
      } catch {
        // The directory cleanup remains safe when Git metadata was already removed.
      }
      fs.rmSync(linkedWorktreePath, { recursive: true, force: true });
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

function makeDirectory(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
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

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
}

function registryRevision(registry: SessionRegistry): number {
  const persisted = readJson(registry.paths.registry) as PersistedRegistry;
  if (!("registry_revision" in persisted) || typeof persisted.registry_revision !== "number") {
    throw new Error("Expected a v2 registry revision");
  }
  return persisted.registry_revision;
}

function writeRegistry(registry: SessionRegistry, value: PersistedRegistry): void {
  fs.mkdirSync(registry.paths.directory, { recursive: true });
  fs.writeFileSync(registry.paths.registry, `${JSON.stringify(value, null, 2)}\n`);
}

function assertRegistryError(operation: () => unknown, code: SessionRegistryError["code"]): void {
  assert.throws(operation, (error: unknown) => error instanceof SessionRegistryError && error.code === code);
}

function runWorker(workerPath: string, arguments_: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", "tsx", workerPath, ...arguments_], {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("close", (exitCode) => {
      if (exitCode === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(`registry worker exited with ${exitCode}: ${stderr}`));
      }
    });
  });
}
