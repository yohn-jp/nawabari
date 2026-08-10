import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import { SessionRegistry, toPersistedSessionRecord, type PersistedRegistry } from "./session-registry.js";

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
    assert.equal(persisted.schema_version, 1);
    assert.equal(persisted.repository_id, mainRegistry.repository.repositoryId);
    assert.equal(persisted.sessions.length, 2);
    assert.equal(persisted.sessions[0].session_id, mainSession.sessionId);
  } finally {
    fixture.cleanup();
  }
});

test("keeps human labels separate from session identity", () => {
  const fixture = createRepositoryFixture();
  const thirdWorktreePath = makeDirectory("git-paw-label-worktree-");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.create({ label: "worker" });
    const second = registry.create({ worktreePath: thirdWorktreePath, branchName: "feature/second", label: "worker" });

    assert.notEqual(first.sessionId, second.sessionId);
    assert.equal(first.label, second.label);
    assert.equal(registry.list().length, 2);
  } finally {
    fs.rmSync(thirdWorktreePath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("rejects duplicate worktree, branch, and session ownership", () => {
  const fixture = createRepositoryFixture();
  const thirdWorktreePath = makeDirectory("git-paw-duplicate-worktree-");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const first = registry.create({ label: "first" });

    assertRegistryError(() => registry.create({ branchName: "feature/other" }), "DUPLICATE_WORKTREE_OWNERSHIP");
    const second = registry.create({ worktreePath: thirdWorktreePath, branchName: "feature/second" });
    assertRegistryError(
      () => registry.create({ worktreePath: fixture.linkedWorktreePath, branchName: second.branchName }),
      "DUPLICATE_BRANCH_OWNERSHIP",
    );

    const duplicateIdRegistry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      idGenerator: () => first.sessionId,
    });
    assertRegistryError(
      () => duplicateIdRegistry.create({ worktreePath: thirdWorktreePath, branchName: "feature/third" }),
      "SESSION_ID_COLLISION",
    );
  } finally {
    fs.rmSync(thirdWorktreePath, { recursive: true, force: true });
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

test("serializes concurrent creates without losing updates or duplicating ownership", { timeout: 30_000 }, async () => {
  const fixture = createRepositoryFixture();
  const worktreePaths = Array.from({ length: 8 }, () => makeDirectory("git-paw-concurrent-worktree-"));
  try {
    const workerPath = fileURLToPath(new URL("../scripts/session-registry-worker.mjs", import.meta.url));
    const results = await Promise.all(
      worktreePaths.map((worktreePath, index) =>
        runWorker(workerPath, [fixture.repositoryPath, worktreePath, `feature/concurrent-${index}`]),
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

interface RepositoryFixture {
  readonly repositoryPath: string;
  readonly linkedWorktreePath: string;
  cleanup(): void;
}

function createRepositoryFixture(): RepositoryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-paw-registry-"));
  const linkedWorktreePath = path.join(path.dirname(repositoryPath), `${path.basename(repositoryPath)}-linked`);
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "git-paw-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "GitPaw Tests"], repositoryPath);
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
  return String(execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
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
