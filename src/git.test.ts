import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import { listGitWorktrees, normalizeBranchId, resolveRepositoryContext, resolveWorktreeIdentity } from "./git.js";

test("resolves the same repository identity from linked worktrees", () => {
  const fixture = createRepositoryFixture();
  try {
    const main = resolveRepositoryContext({ cwd: fixture.repositoryPath });
    const linked = resolveRepositoryContext({ cwd: fixture.linkedWorktreePath });

    assert.equal(main.repositoryId, linked.repositoryId);
    assert.equal(main.commonGitDirectory, linked.commonGitDirectory);
    assert.notEqual(main.worktreePath, linked.worktreePath);

    const identity = resolveWorktreeIdentity({ cwd: fixture.linkedWorktreePath });
    assert.equal(identity.worktreePath, linked.worktreePath);
    assert.equal(identity.worktreeId, linked.worktreePath);
    assert.equal(identity.branchName, "feature/linked");
    assert.equal(identity.branchId, "refs/heads/feature/linked");
  } finally {
    fixture.cleanup();
  }
});

test("rejects a detached worktree as an ambiguous branch identity", () => {
  const fixture = createRepositoryFixture();
  const detachedPath = path.join(
    path.dirname(fixture.repositoryPath),
    `${path.basename(fixture.repositoryPath)}-detached`,
  );
  try {
    runGit(["worktree", "add", "--detach", detachedPath, "HEAD"], fixture.repositoryPath);

    assert.throws(
      () => resolveWorktreeIdentity({ cwd: detachedPath }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "WORKTREE_IDENTITY_AMBIGUOUS",
    );
  } finally {
    try {
      runGit(["worktree", "remove", "--force", detachedPath], fixture.repositoryPath);
    } catch {
      // Cleanup below is sufficient if the temporary worktree was already removed.
    }
    fs.rmSync(detachedPath, { recursive: true, force: true });
    fixture.cleanup();
  }
});

test("rejects a lock-suffixed component in a branch identity", () => {
  assert.throws(
    () => normalizeBranchId("feature/locked.lock/name"),
    (error: unknown) => error instanceof SessionRegistryError && error.code === "INVALID_BRANCH_ID",
  );
});

test("preserves prunable status from Git's porcelain worktree inventory", () => {
  const prunablePath = "/tmp/nawabari-prunable-parser";
  const healthyPath = "/tmp/nawabari-healthy-parser";
  const output = [
    `worktree ${prunablePath}`,
    "HEAD 0123456789012345678901234567890123456789",
    "branch refs/heads/feature/prunable",
    "prunable gitdir file points to non-existent location",
    "",
    `worktree ${healthyPath}`,
    "HEAD 0123456789012345678901234567890123456789",
    "branch refs/heads/main",
    "",
  ].join("\n");

  const worktrees = listGitWorktrees(
    {
      run(args: readonly string[], cwd: string): string {
        assert.deepEqual(args, ["worktree", "list", "--porcelain"]);
        assert.equal(cwd, process.cwd());
        return output;
      },
    },
    process.cwd(),
  );

  assert.deepEqual(worktrees, [
    { worktreePath: path.resolve(prunablePath), branchName: "feature/prunable", prunable: true },
    { worktreePath: path.resolve(healthyPath), branchName: "main", prunable: false },
  ]);
});

interface RepositoryFixture {
  readonly repositoryPath: string;
  readonly linkedWorktreePath: string;
  cleanup(): void;
}

function createRepositoryFixture(): RepositoryFixture {
  const repositoryPath = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-"));
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
