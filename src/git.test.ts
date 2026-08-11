import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import {
  createGitCommandRunner,
  defaultGit,
  listGitWorktrees,
  normalizeBranchId,
  resolveRepositoryContext,
  resolveWorktreeIdentity,
  verifyPhysicalExecutionContext,
} from "./git.js";

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

test("verifies repository, worktree, branch, and HEAD from physical Git state", () => {
  const fixture = createRepositoryFixture();
  const other = createRepositoryFixture();
  const detachedPath = path.join(
    path.dirname(fixture.repositoryPath),
    `${path.basename(fixture.repositoryPath)}-verify-detached`,
  );
  try {
    const repository = resolveRepositoryContext({ cwd: fixture.repositoryPath });
    const verified = verifyPhysicalExecutionContext({ cwd: fixture.linkedWorktreePath });
    assert.equal(verified.repositoryId, repository.repositoryId);
    assert.equal(verified.worktreePath, fs.realpathSync.native(fixture.linkedWorktreePath));
    assert.equal(verified.branchName, "feature/linked");
    assert.equal(verified.headId, runGit(["rev-parse", "HEAD"], fixture.linkedWorktreePath));

    assert.throws(
      () => verifyPhysicalExecutionContext({ cwd: other.repositoryPath, repository }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "REPOSITORY_MISMATCH",
    );
    assert.throws(
      () =>
        verifyPhysicalExecutionContext({
          cwd: fixture.linkedWorktreePath,
          expectedWorktreePath: fixture.repositoryPath,
        }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "WORKTREE_MISMATCH",
    );
    assert.throws(
      () => verifyPhysicalExecutionContext({ cwd: fixture.linkedWorktreePath, branchName: "main" }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "BRANCH_MISMATCH",
    );

    runGit(["worktree", "add", "--detach", detachedPath, "HEAD"], fixture.repositoryPath);
    assert.throws(
      () => verifyPhysicalExecutionContext({ cwd: detachedPath }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "DETACHED_HEAD",
    );
    assert.throws(
      () => verifyPhysicalExecutionContext({ repository, worktreePath: `${fixture.repositoryPath}-missing` }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "MISSING_WORKTREE",
    );
  } finally {
    try {
      runGit(["worktree", "remove", "--force", detachedPath], fixture.repositoryPath);
    } catch {
      // Cleanup below is sufficient if the temporary worktree was already removed.
    }
    fs.rmSync(detachedPath, { recursive: true, force: true });
    fixture.cleanup();
    other.cleanup();
  }
});

test("keeps bounded Git subprocess failures distinct", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nawabari-git-process-"));
  try {
    assert.throws(
      () => createGitCommandRunner({ executable: path.join(directory, "missing-git") }).run([], directory),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_SPAWN_FAILED",
    );
    assert.throws(
      () =>
        createGitCommandRunner({ executable: process.execPath, timeoutMs: 250 }).run(
          ["-e", "setTimeout(() => {}, 2_000)"],
          directory,
        ),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_TIMEOUT",
    );
    assert.throws(
      () =>
        createGitCommandRunner({ executable: process.execPath, maxOutputBytes: 16 }).run(
          ["-e", "process.stdout.write('x'.repeat(10_000))"],
          directory,
        ),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "GIT_OUTPUT_LIMIT",
    );
    assert.throws(
      () => createGitCommandRunner({ executable: process.execPath }).run(["-e", "process.exit(7)"], directory),
      (error: unknown) =>
        error instanceof SessionRegistryError && error.code === "GIT_COMMAND_FAILED" && error.details.exitCode === 7,
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("does not collapse unexpected Git exits or unavailable observations", () => {
  const fixture = createRepositoryFixture();
  try {
    const unexpectedExitGit = {
      run(args: readonly string[], cwd: string): string {
        if (args[0] === "rev-parse" && args[1] === "--git-common-dir") {
          throw new SessionRegistryError("GIT_COMMAND_FAILED", "injected unexpected exit", { exitCode: 7 });
        }
        return defaultGit.run(args, cwd);
      },
    };
    assert.throws(
      () => resolveRepositoryContext({ cwd: fixture.repositoryPath, git: unexpectedExitGit }),
      (error: unknown) =>
        error instanceof SessionRegistryError && error.code === "GIT_COMMAND_FAILED" && error.details.exitCode === 7,
    );

    const unavailableGit = {
      run(args: readonly string[], cwd: string): string {
        if (args[0] === "worktree" && args[1] === "list") throw new Error("injected physical observation failure");
        return defaultGit.run(args, cwd);
      },
    };
    assert.throws(
      () => verifyPhysicalExecutionContext({ cwd: fixture.repositoryPath, git: unavailableGit }),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "PHYSICAL_OBSERVATION_UNAVAILABLE",
    );
  } finally {
    fixture.cleanup();
  }
});

test("rejects a lock-suffixed component in a branch identity", () => {
  assert.throws(
    () => normalizeBranchId("feature/locked.lock/name"),
    (error: unknown) => error instanceof SessionRegistryError && error.code === "INVALID_BRANCH_ID",
  );
  assert.throws(
    () => normalizeBranchId("feature/ends-at@"),
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
