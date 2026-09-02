import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { SessionRegistryError } from "./errors.js";
import { defaultGit } from "./git.js";
import { runDoctor } from "./domain/doctor.js";
import { SessionRegistry } from "./session-registry.js";

test("cleanup decision and dry-run expose stable dirty blockers without mutation", () => {
  const fixture = createFixture("dirty-decision");
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({
      worktreePath: fixture.worktree,
      branchName: "feature/dirty-decision",
    });
    fs.writeFileSync(path.join(fixture.worktree, "recoverable.txt"), "preserve\n");

    const decision = registry.cleanupDecision(session.sessionId);
    assert.equal(decision.allowed, false);
    assert.equal(decision.code, "DIRTY_WORKTREE");
    const untrackedPaths = decision.blockers[0]?.details.untrackedPaths;
    assert.equal(Array.isArray(untrackedPaths) && untrackedPaths.includes("recoverable.txt"), true);
    assert.ok(decision.recoveryHints.length > 0);

    const dryRun = registry.garbageCollect({ apply: false, staleAfterMs: 0 });
    assert.equal(dryRun.candidates.length, 1);
    assert.equal(dryRun.candidates[0]?.suspicion, "age");
    assert.equal(dryRun.candidates[0]?.destructiveEligibility, "ineligible");
    assert.equal(dryRun.candidates[0]?.destructiveEligibilityReason, "age-only");
    assert.equal(dryRun.eligible.length, 0);
    assert.deepEqual(dryRun.blocked, []);
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(fs.existsSync(fixture.worktree), true);
  } finally {
    fixture.cleanup();
  }
});

test("cleanup blocks session stashes and nested repositories explicitly", () => {
  const stashFixture = createFixture("stash-block");
  try {
    const registry = new SessionRegistry({ cwd: stashFixture.repository });
    const session = registry.provision({
      worktreePath: stashFixture.worktree,
      branchName: "feature/stash-block",
    });
    fs.writeFileSync(path.join(stashFixture.worktree, "stashed.txt"), "recoverable\n");
    runGit(["stash", "push", "--include-untracked", "-m", "preserve"], stashFixture.worktree);

    const decision = registry.cleanupDecision(session.sessionId);
    assert.equal(decision.code, "RECOVERABLE_STASHES");
    const stashes = decision.blockers[0]?.details.stashes;
    assert.ok(Array.isArray(stashes) && stashes.length > 0);
    assert.throws(
      () => registry.close(session.sessionId),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "RECOVERABLE_STASHES",
    );
  } finally {
    stashFixture.cleanup();
  }

  const nestedFixture = createFixture("nested-block");
  try {
    const registry = new SessionRegistry({ cwd: nestedFixture.repository });
    const session = registry.provision({
      worktreePath: nestedFixture.worktree,
      branchName: "feature/nested-block",
    });
    const nested = path.join(nestedFixture.worktree, "nested");
    fs.mkdirSync(nested);
    runGit(["init", "--quiet", nested], nested);

    assert.throws(
      () => registry.close(session.sessionId),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "NESTED_REPOSITORY",
    );
    assert.equal(registry.get(session.sessionId)?.state, "active");
  } finally {
    nestedFixture.cleanup();
  }
});

test("reconciliation reports prunable and unregistered physical drift without repair", async () => {
  const fixture = createFixture("reconcile");
  const external = `${fixture.repository}-external`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({
      worktreePath: fixture.worktree,
      branchName: "feature/reconcile",
    });
    fs.rmSync(fixture.worktree, { recursive: true, force: true });
    runGit(["worktree", "add", "--quiet", "-b", "feature/unregistered", external], fixture.repository);

    const result = registry.reconcile();
    const sessionIssue = result.issues.find((issue) => issue.sessionId === session.sessionId);
    assert.equal(sessionIssue?.code, "MISSING_WORKTREE");
    assert.equal(
      result.sessions.find((item) => item.session.sessionId === session.sessionId)?.physicalState,
      "prunable-missing",
    );
    assert.equal(registry.get(session.sessionId)?.state, "active");
    assert.equal(
      result.issues.some((issue) => issue.worktreePath === path.resolve(external)),
      true,
    );

    const report = await runDoctor(fixture.repository);
    assert.equal(report.ok, true);
    if (!report.ok) return;
    assert.equal(report.value.checks.find((check) => check.name === "reconciliation")?.status, "warning");
    assert.equal(report.value.checks.find((check) => check.name === "reconciliation")?.code, "RECONCILIATION_DRIFT");
  } finally {
    removeWorktree(fixture.repository, fixture.worktree);
    removeWorktree(fixture.repository, external);
    fixture.cleanup();
  }
});

test("cleanup revalidates physical ownership immediately before removal", () => {
  const fixture = createFixture("revalidate");
  const moved = `${fixture.repository}-moved`;
  try {
    const registry = new SessionRegistry({ cwd: fixture.repository });
    const session = registry.provision({
      worktreePath: fixture.worktree,
      branchName: "feature/revalidate",
    });
    let worktreeListCalls = 0;
    const git = {
      run(args: readonly string[], cwd: string): string {
        if (args[0] === "worktree" && args[1] === "list") {
          worktreeListCalls += 1;
          if (worktreeListCalls === 3) {
            runGit(["worktree", "move", fixture.worktree, moved], fixture.repository);
          }
        }
        return defaultGit.run(args, cwd);
      },
    };
    const guarded = new SessionRegistry({ repository: registry.repository, git });

    assert.throws(
      () => guarded.close(session.sessionId),
      (error: unknown) => error instanceof SessionRegistryError && error.code === "OWNERSHIP_MISMATCH",
    );
    assert.equal(registry.get(session.sessionId)?.state, "closing");
    assert.equal(fs.existsSync(moved), true);
  } finally {
    removeWorktree(fixture.repository, fixture.worktree);
    removeWorktree(fixture.repository, moved);
    fixture.cleanup();
  }
});

interface Fixture {
  readonly repository: string;
  readonly worktree: string;
  cleanup(): void;
}

function createFixture(name: string): Fixture {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), `nawabari-cleanup-${name}-`));
  const worktree = `${repository}-worktree`;
  runGit(["init", "-b", "main", repository], repository);
  runGit(["config", "user.email", "nawabari-tests@example.invalid"], repository);
  runGit(["config", "user.name", "Nawabari Tests"], repository);
  runGit(["config", "commit.gpgsign", "false"], repository);
  fs.writeFileSync(path.join(repository, "README.md"), "fixture\n");
  runGit(["add", "README.md"], repository);
  runGit(["commit", "-m", "initial"], repository);
  return {
    repository,
    worktree,
    cleanup(): void {
      removeWorktree(repository, worktree);
      fs.rmSync(repository, { recursive: true, force: true });
    },
  };
}

function removeWorktree(repository: string, worktree: string): void {
  try {
    runGit(["worktree", "remove", "--force", worktree], repository);
  } catch {
    // The physical directory and Git metadata are removed below when possible.
  }
  fs.rmSync(worktree, { recursive: true, force: true });
}

function runGit(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}
