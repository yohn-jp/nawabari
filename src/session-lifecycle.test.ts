import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import { SessionRegistry } from "./session-registry.js";

test("close removes a clean provisioned worktree and merged branch, and repeats idempotently", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-clean-close`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/clean-close" });

    const result = registry.close(session.sessionId);
    assert.equal(result.session.state, "closed");
    assert.equal(result.worktreeRemoved, true);
    assert.equal(result.branchRemoved, true);
    assert.equal(result.idempotent, false);
    assert.equal(fs.existsSync(worktreePath), false);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), false);

    const repeated = registry.close(session.sessionId);
    assert.equal(repeated.idempotent, true);
    assert.equal(repeated.session.state, "closed");
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close refuses dirty worktrees without changing ownership", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-dirty-close`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/dirty-close" });
    fs.writeFileSync(path.join(worktreePath, "uncommitted.txt"), "recoverable\n");

    assertRegistryError(() => registry.close(session.sessionId), "DIRTY_WORKTREE");
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close refuses a clean branch containing commits not retained by the integration branch", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-recoverable-commit`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/recoverable-commit" });
    fs.writeFileSync(path.join(worktreePath, "committed.txt"), "recoverable\n");
    runGit(["add", "committed.txt"], worktreePath);
    runGit(["commit", "-m", "recoverable session work"], worktreePath);

    assertRegistryError(() => registry.close(session.sessionId), "RECOVERABLE_COMMITS");
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("close fails closed when Git moved the owned branch to another worktree", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-mismatched-close`;
  const movedPath = `${fixture.repositoryPath}-moved-close`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/mismatched-close" });
    runGit(["worktree", "move", worktreePath, movedPath], fixture.repositoryPath);

    assertRegistryError(() => registry.close(session.sessionId), "OWNERSHIP_MISMATCH");
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(movedPath), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    removeWorktree(fixture.repositoryPath, movedPath);
    fixture.cleanup();
  }
});

test("close safely releases registry state when Git already removed the worktree", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-missing-resource`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repositoryPath });
    const session = registry.provision({ worktreePath, branchName: "feature/missing-resource" });
    runGit(["worktree", "remove", "--force", worktreePath], fixture.repositoryPath);

    const result = registry.close(session.sessionId);
    assert.equal(result.session.state, "closed");
    assert.equal(result.worktreeRemoved, false);
    assert.equal(result.branchRemoved, true);
    assert.equal(hasLocalBranch(fixture.repositoryPath, session.branchName), false);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("gc detects stale metadata without mutation and applies only safe cleanup", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-stale-cleanup`;
  let now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      clock: () => now,
      staleAfterMs: 1_000,
    });
    const session = registry.provision({ worktreePath, branchName: "feature/stale-cleanup" });
    now = new Date("2026-01-01T00:00:02.000Z");

    const detected = registry.garbageCollect({ apply: false });
    assert.equal(detected.candidates.length, 1);
    assert.equal(detected.candidates[0].sessionId, session.sessionId);
    assert.equal(detected.cleaned.length, 0);
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(worktreePath), true);

    const applied = registry.garbageCollect({ apply: true });
    assert.equal(applied.candidates.length, 1);
    assert.equal(applied.cleaned.length, 1);
    assert.equal(applied.blocked.length, 0);
    assert.equal(applied.cleaned[0].state, "closed");
    assert.equal(fs.existsSync(worktreePath), false);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

test("gc marks stale dirty sessions but does not remove recoverable work", () => {
  const fixture = createRepositoryFixture();
  const worktreePath = `${fixture.repositoryPath}-stale-dirty`;
  let now = new Date("2026-01-01T00:00:00.000Z");
  try {
    const registry = new SessionRegistry({
      cwd: fixture.repositoryPath,
      clock: () => now,
      staleAfterMs: 1_000,
    });
    const session = registry.provision({ worktreePath, branchName: "feature/stale-dirty" });
    fs.writeFileSync(path.join(worktreePath, "dirty.txt"), "keep me\n");
    now = new Date("2026-01-01T00:00:02.000Z");

    const result = registry.garbageCollect({ apply: true });
    assert.equal(result.cleaned.length, 0);
    assert.equal(result.blocked.length, 1);
    assert.equal(result.blocked[0].sessionId, session.sessionId);
    assert.equal(result.blocked[0].code, "DIRTY_WORKTREE");
    assert.equal(registry.get(session.sessionId)?.state, "stale");
    assert.equal(fs.existsSync(worktreePath), true);
  } finally {
    removeWorktree(fixture.repositoryPath, worktreePath);
    fixture.cleanup();
  }
});

interface RepositoryFixture {
  readonly repositoryPath: string;
  cleanup(): void;
}

function createRepositoryFixture(): RepositoryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "git-paw-lifecycle-"));
  runGit(["init", "-b", "main", repositoryPath], repositoryPath);
  runGit(["config", "user.email", "git-paw-tests@example.invalid"], repositoryPath);
  runGit(["config", "user.name", "GitPaw Tests"], repositoryPath);
  fs.writeFileSync(path.join(repositoryPath, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repositoryPath);
  runGit(["commit", "-m", "initial"], repositoryPath);
  return {
    repositoryPath,
    cleanup(): void {
      fs.rmSync(repositoryPath, { recursive: true, force: true });
    },
  };
}

function removeWorktree(repositoryPath: string, worktreePath: string): void {
  runGitQuiet(["worktree", "remove", "--force", worktreePath], repositoryPath);
  fs.rmSync(worktreePath, { recursive: true, force: true });
}

function hasLocalBranch(repositoryPath: string, branchName: string): boolean {
  return runGitQuiet(["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`], repositoryPath);
}

function assertRegistryError(operation: () => unknown, code: SessionRegistryError["code"]): void {
  assert.throws(operation, (error: unknown) => error instanceof SessionRegistryError && error.code === code);
}

function runGit(args: readonly string[], cwd: string): string {
  return String(execFileSync("git", [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })).trim();
}

function runGitQuiet(args: readonly string[], cwd: string): boolean {
  try {
    runGit(args, cwd);
    return true;
  } catch {
    return false;
  }
}
