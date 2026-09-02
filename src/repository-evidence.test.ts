import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistry } from "./session-registry.js";

test("captures a deterministic session-addressed snapshot and bounded diff", () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.create();
    const initialHead = runGit(["rev-parse", "HEAD"], repositoryPath);
    assert.equal(session.baseRevision, initialHead);

    fs.appendFileSync(path.join(repositoryPath, "README.md"), "changed\n");
    const first = registry.repositoryEvidence({ sessionId: session.sessionId });
    const second = registry.evidenceSnapshot({ sessionId: session.sessionId });

    assert.equal(first.baseRevision, initialHead);
    assert.equal(first.baseRevisionProven, true);
    assert.equal(first.headId, initialHead);
    assert.equal(first.clean, false);
    assert.equal(first.complete, true);
    assert.deepEqual(first.paths.changed, ["README.md"]);
    assert.deepEqual(first.paths.stats[0], {
      path: "README.md",
      additions: 1,
      deletions: 0,
      binary: false,
      available: true,
    });
    assert.equal(first.evidenceHash, second.evidenceHash);

    const diff = registry.repositoryDiff({
      sessionId: session.sessionId,
      paths: ["README.md"],
      includePatch: true,
      maxBytes: 4_096,
      maxHunks: 4,
    });
    assert.equal(diff.fromRevision, initialHead);
    assert.equal(diff.toRevision, null);
    assert.deepEqual(diff.paths, ["README.md"]);
    assert.match(diff.patch ?? "", /changed/u);
    assert.equal(diff.hunkCount, 1);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("managed commit advances session_updated_at before the resulting evidence snapshot", () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-worktree`;
  let now = new Date("2026-01-01T00:00:00.000Z");
  try {
    runGit(["worktree", "add", "--quiet", "-b", "feature/evidence-commit", worktreePath, "HEAD"], repositoryPath);
    const registry = new SessionRegistry({ cwd: worktreePath, clock: () => now });
    const session = registry.create();
    registry.claimResources({
      sessionId: session.sessionId,
      claims: [{ resource: "README.md", mode: "exclusive-write" }],
    });
    fs.appendFileSync(path.join(worktreePath, "README.md"), "managed commit\n");
    now = new Date("2026-01-01T00:00:01.000Z");

    const result = registry.commit({
      sessionId: session.sessionId,
      message: "record managed evidence",
      resources: ["README.md"],
    });
    const snapshot = registry.evidenceSnapshot({ sessionId: session.sessionId });

    assert.equal(snapshot.headId, result.commitSha);
    assert.equal(snapshot.sessionUpdatedAt, "2026-01-01T00:00:01.000Z");
    assert.equal(snapshot.sessionUpdatedAt, registry.get(session.sessionId)?.updatedAt);
    assert.equal(snapshot.clean, true);
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
    } catch {
      // The repository cleanup below remains sufficient after an idempotent removal.
    }
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("marks untracked stat evidence incomplete without dropping the path", () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.create();
    fs.writeFileSync(path.join(repositoryPath, "untracked.txt"), "untracked\n");

    const evidence = registry.repositoryEvidence({ sessionId: session.sessionId });

    assert.equal(evidence.complete, false);
    assert.deepEqual(evidence.incompleteReasons, ["STAT_UNAVAILABLE"]);
    assert.deepEqual(evidence.paths.untracked, ["untracked.txt"]);
    assert.deepEqual(evidence.paths.stats, [
      {
        path: "untracked.txt",
        additions: null,
        deletions: null,
        binary: null,
        available: false,
      },
    ]);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("does not infer a missing legacy base revision from a mutable HEAD", () => {
  const repositoryPath = createRepository();
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.create();
    const persisted = JSON.parse(fs.readFileSync(registry.paths.registry, "utf8")) as {
      sessions: Array<Record<string, unknown>>;
    };
    delete persisted.sessions[0]?.base_revision;
    fs.writeFileSync(registry.paths.registry, `${JSON.stringify(persisted, null, 2)}\n`);

    const evidence = new SessionRegistry({ cwd: repositoryPath }).repositoryEvidence({
      sessionId: session.sessionId,
    });

    assert.equal(evidence.baseRevision, null);
    assert.equal(evidence.baseRevisionProven, false);
  } finally {
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

test("resolves physical evidence through the selected owned worktree", () => {
  const repositoryPath = createRepository();
  const worktreePath = `${repositoryPath}-session`;
  try {
    const registry = new SessionRegistry({ cwd: repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/evidence" });
    const evidence = registry.repositoryEvidence({ sessionId: session.sessionId });

    assert.equal(evidence.sessionId, session.sessionId);
    assert.equal(evidence.worktreePath, fs.realpathSync.native(worktreePath));
    assert.equal(evidence.branchName, "feature/evidence");
    assert.equal(evidence.baseRevision, runGit(["rev-parse", "HEAD"], repositoryPath));

    registry.close(session.sessionId);
  } finally {
    try {
      runGit(["worktree", "remove", "--force", worktreePath], repositoryPath);
    } catch {
      // The repository cleanup below remains sufficient after an idempotent close.
    }
    fs.rmSync(worktreePath, { recursive: true, force: true });
    fs.rmSync(repositoryPath, { recursive: true, force: true });
  }
});

function createRepository(): string {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-evidence-"));
  runGit(["init", "-b", "main"], repositoryPath);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "Nawabari Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  return repositoryPath;
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
